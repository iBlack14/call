import express from "express";
import cors from "cors";
import multer from "multer";
import mime from "mime-types";
import pino from "pino";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3010);
const HOST = process.env.HOST || "0.0.0.0";
const SESSION_DIR = path.resolve(__dirname, "../session");
const APP_ORIGIN = process.env.APP_ORIGIN || "http://localhost:3000";

if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

app.use(cors({
  origin: [APP_ORIGIN, "http://127.0.0.1:3000"],
  methods: ["GET", "POST", "OPTIONS"]
}));
app.use(express.json({ limit: "5mb" }));

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const SAFE_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const JPEG_ALIASES = new Set(["image/jpg", "image/pjpeg", "image/jfif"]);
const OUTGOING_TRACK_LIMIT = 300;
const OUTGOING_STATUSES = new Map();
const OUTGOING_WAITERS = new Map();
const DELIVERY_ACK_STATUS = 2;
const DELIVERY_WAIT_MS = Number(process.env.WA_DELIVERY_WAIT_MS || 25000);

let sock = null;
let linked = false;
let connecting = false;
let currentQrText = "";
let currentQrDataUrl = "";
let linkedPhoneJid = "";
let linkedName = "";

function normalizePhone(input) {
  const raw = String(input || "").trim();
  let digits = raw.replace(/\D/g, "");
  if (!digits) return "";

  // Si ya tiene 51 al inicio y tiene una longitud razonable (11 o más)
  if (digits.startsWith("51") && digits.length >= 11) {
    return digits;
  }

  // Caso Perú: Si tiene 9 dígitos y empieza con 9
  if (digits.length === 9 && digits.startsWith("9")) {
    digits = "51" + digits;
  }

  return digits;
}

function toJid(phone) {
  const digits = normalizePhone(phone);
  if (!digits) return "";
  return `${digits}@s.whatsapp.net`;
}

async function refreshQrDataUrl(qrText) {
  if (!qrText) {
    currentQrDataUrl = "";
    return;
  }
  currentQrDataUrl = await QRCode.toDataURL(qrText, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 360
  });
}

function currentStatus() {
  return {
    ok: true,
    linked,
    connecting,
    phone: linkedPhoneJid || null,
    name: linkedName || null,
    hasQr: Boolean(currentQrDataUrl),
    timestamp: new Date().toISOString()
  };
}

function rememberOutgoing(result, meta) {
  const msgId = result?.key?.id;
  if (!msgId) return msgId || null;

  OUTGOING_STATUSES.set(msgId, {
    jid: result?.key?.remoteJid || meta?.jid || "",
    kind: meta?.kind || "unknown",
    fileName: meta?.fileName || null,
    status: 0,
    createdAt: Date.now()
  });

  if (OUTGOING_STATUSES.size > OUTGOING_TRACK_LIMIT) {
    const oldest = OUTGOING_STATUSES.keys().next().value;
    if (oldest) OUTGOING_STATUSES.delete(oldest);
  }

  return msgId;
}

function statusToText(status) {
  if (status === 0) return "PENDING";
  if (status === 1) return "SERVER_ACK";
  if (status === 2) return "DELIVERY_ACK";
  if (status === 3) return "READ";
  if (status === 4) return "PLAYED";
  return `UNKNOWN_${status}`;
}

function resolveStatusWaiters(msgId, status) {
  const waiters = OUTGOING_WAITERS.get(msgId);
  if (!waiters?.length) return;

  const pending = [];
  for (const waiter of waiters) {
    if (status >= waiter.targetStatus) {
      clearTimeout(waiter.timer);
      waiter.resolve(status);
    } else {
      pending.push(waiter);
    }
  }

  if (!pending.length) {
    OUTGOING_WAITERS.delete(msgId);
  } else {
    OUTGOING_WAITERS.set(msgId, pending);
  }
}

function rejectAllStatusWaiters(reason) {
  for (const waiters of OUTGOING_WAITERS.values()) {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
  }
  OUTGOING_WAITERS.clear();
}

function waitForOutgoingStatus(msgId, targetStatus = DELIVERY_ACK_STATUS, timeoutMs = DELIVERY_WAIT_MS) {
  if (!msgId) {
    throw new Error("No se pudo esperar confirmacion: msgId vacio.");
  }

  const tracked = OUTGOING_STATUSES.get(msgId);
  if (typeof tracked?.status === "number" && tracked.status >= targetStatus) {
    return Promise.resolve(tracked.status);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const list = OUTGOING_WAITERS.get(msgId) || [];
      const next = list.filter((item) => item.resolve !== resolve);
      if (next.length) OUTGOING_WAITERS.set(msgId, next);
      else OUTGOING_WAITERS.delete(msgId);
      const err = new Error(`Tiempo agotado esperando estado ${statusToText(targetStatus)} para msgId ${msgId}`);
      err.code = "DELIVERY_TIMEOUT";
      reject(err);
    }, timeoutMs);

    const list = OUTGOING_WAITERS.get(msgId) || [];
    list.push({ targetStatus, resolve, reject, timer });
    OUTGOING_WAITERS.set(msgId, list);
  });
}

async function sendAndConfirmDelivery({ jid, payload, kind, fileName = null, timeoutMs = DELIVERY_WAIT_MS }) {
  const result = await sock.sendMessage(jid, payload);
  const msgId = rememberOutgoing(result, { jid, kind, fileName });
  await waitForOutgoingStatus(msgId, DELIVERY_ACK_STATUS, timeoutMs);
  return {
    jid,
    msgId,
    kind,
    deliveryStatus: DELIVERY_ACK_STATUS,
    deliveryStatusText: statusToText(DELIVERY_ACK_STATUS)
  };
}

async function startWhatsApp() {
  if (connecting) return;
  connecting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: "silent" });

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      logger
    });

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("messages.update", (updates) => {
      for (const item of updates || []) {
        const key = item?.key;
        const update = item?.update || {};
        if (!key?.fromMe) continue;
        if (typeof update.status !== "number") continue;

        const msgId = key.id || "";
        const tracked = OUTGOING_STATUSES.get(msgId);
        const statusText = statusToText(update.status);
        if (tracked) tracked.status = update.status;
        resolveStatusWaiters(msgId, update.status);
        log.info({
          jid: key.remoteJid || tracked?.jid || "",
          msgId,
          status: update.status,
          statusText,
          kind: tracked?.kind || null,
          fileName: tracked?.fileName || null
        }, "Estado mensaje saliente");

        if (update.status >= 3) {
          OUTGOING_STATUSES.delete(msgId);
        }
      }
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQrText = qr;
        try {
          await refreshQrDataUrl(qr);
        } catch (err) {
          log.error({ err }, "Error generando QR");
        }
      }

      if (connection === "open") {
        linked = true;
        connecting = false;
        currentQrText = "";
        currentQrDataUrl = "";
        linkedPhoneJid = sock.user?.id || "";
        linkedName = sock.user?.name || "";
        log.info({ user: linkedPhoneJid, name: linkedName }, "WhatsApp vinculado");
      }

      if (connection === "close") {
        linked = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        log.warn({ statusCode, shouldReconnect }, "Conexion WhatsApp cerrada");

        if (statusCode === DisconnectReason.loggedOut) {
          linkedPhoneJid = "";
          linkedName = "";
          currentQrText = "";
          currentQrDataUrl = "";
        }

        connecting = false;
        rejectAllStatusWaiters("Conexion WhatsApp cerrada antes de confirmar entrega.");
        sock = null;
        if (shouldReconnect) {
          setTimeout(() => {
            startWhatsApp().catch((err) => {
              log.error({ err }, "Error reconectando WhatsApp");
            });
          }, 1500);
        }
      }
    });
  } catch (err) {
    connecting = false;
    log.error({ err }, "No se pudo iniciar WhatsApp");
    throw err;
  }
}

async function sendMessage({ to, message, file }) {
  if (!sock || !linked) {
    throw new Error("WhatsApp no vinculado.");
  }

  const jid = toJid(to);
  if (!jid) throw new Error("Numero invalido.");

  const text = String(message || "").trim();
  const hasFile = Boolean(file?.buffer?.length);

  log.info({ jid, text, hasFile, fileName: file?.originalname }, "Intentando enviar mensaje");

  if (!text && !hasFile) throw new Error("Mensaje y archivo vacios.");

  try {
    if (!hasFile) {
      const result = await sock.sendMessage(jid, { text });
      const msgId = rememberOutgoing(result, { jid, kind: "text" });
      log.info({ jid, msgId }, "Texto enviado con exito");
      return { jid, msgId, kind: "text", deliveryStatus: 1, deliveryStatusText: statusToText(1) };
    }

    const fileName = file.originalname || `archivo-${Date.now()}`;
    const inferredMime = mime.lookup(fileName) || "application/octet-stream";
    const rawMime = String(file.mimetype || inferredMime || "application/octet-stream").toLowerCase();
    const fileMime = JPEG_ALIASES.has(rawMime) ? "image/jpeg" : rawMime;
    const buf = file.buffer;

    log.info({ jid, fileName, fileMime, rawMime, size: buf.length }, "Enviando archivo");

    if (String(fileMime).startsWith("image/")) {
      if (!SAFE_IMAGE_MIMES.has(fileMime)) {
        log.warn({ jid, fileName, fileMime }, "Imagen con MIME no recomendado. Se envia como documento para evitar perdida");
        const sent = await sendAndConfirmDelivery({
          jid,
          kind: "image-as-document",
          fileName,
          payload: {
            document: buf,
            fileName,
            mimetype: fileMime,
            caption: text || undefined
          }
        });
        log.info({ jid, msgId: sent.msgId }, "Imagen enviada como documento y entregada");
        return sent;
      }
      try {
        const sent = await sendAndConfirmDelivery({
          jid,
          kind: "image",
          fileName,
          payload: { image: buf, caption: text || undefined, mimetype: fileMime }
        });
        log.info({ jid, msgId: sent.msgId }, "Imagen enviada y entregada");
        return sent;
      } catch (primaryErr) {
        log.warn({ jid, fileName, err: primaryErr?.message }, "No se confirmo entrega de imagen. Reintento como documento");
        const sent = await sendAndConfirmDelivery({
          jid,
          kind: "image-fallback-document",
          fileName,
          payload: {
            document: buf,
            fileName,
            mimetype: fileMime,
            caption: text || undefined
          }
        });
        log.info({ jid, msgId: sent.msgId }, "Imagen entregada en fallback como documento");
        return sent;
      }
    }
    if (String(fileMime).startsWith("video/")) {
      const sent = await sendAndConfirmDelivery({
        jid,
        kind: "video",
        fileName,
        payload: { video: buf, caption: text || undefined, mimetype: fileMime }
      });
      log.info({ jid, msgId: sent.msgId }, "Video enviado y entregado");
      return sent;
    }
    if (String(fileMime).startsWith("audio/")) {
      const result = await sock.sendMessage(jid, { audio: buf, mimetype: fileMime, ptt: false });
      const msgId = rememberOutgoing(result, { jid, kind: "audio", fileName });
      log.info({ jid, msgId }, "Audio enviado con exito");
      let textMsgId = null;
      if (text) {
        const textResult = await sock.sendMessage(jid, { text });
        textMsgId = rememberOutgoing(textResult, { jid, kind: "text" });
      }
      return { jid, msgId, kind: "audio", textMsgId, deliveryStatus: 1, deliveryStatusText: statusToText(1) };
    }

    const sent = await sendAndConfirmDelivery({
      jid,
      kind: fileMime === "application/pdf" ? "pdf" : "document",
      fileName,
      payload: {
        document: buf,
        fileName,
        mimetype: fileMime,
        caption: text || undefined
      }
    });
    log.info({ jid, msgId: sent.msgId }, "Documento enviado y entregado");
    return sent;
  } catch (err) {
    log.error({ err, jid }, "Error critico al enviar via Baileys");
    throw err;
  }
}

function registerStatusRoutes(base) {
  app.get(`${base}/status`, (_, res) => {
    res.json(currentStatus());
  });
}

function registerQrRoutes(base) {
  app.get(`${base}/qr`, async (_, res) => {
    if (linked) {
      return res.json({ ok: true, linked: true, qr: "", dataUrl: "" });
    }
    if (!currentQrDataUrl && !connecting) {
      try {
        await startWhatsApp();
      } catch (err) {
        return res.status(500).json({ ok: false, error: err.message || "No se pudo iniciar WhatsApp." });
      }
    }
    return res.json({
      ok: true,
      linked: false,
      qr: currentQrDataUrl.replace(/^data:image\/png;base64,/, ""),
      dataUrl: currentQrDataUrl || ""
    });
  });
}

function registerSendRoutes(base) {
  app.post(`${base}/send`, (req, res, next) => {
    log.info({ method: req.method, url: req.url, headers: req.headers }, "Incoming WhatsApp send request");
    next();
  }, upload.single("file"), async (req, res) => {
    try {
      const to = req.body?.to || req.body?.phone || req.body?.number;
      const message = req.body?.message || req.body?.text || "";
      const hasFile = Boolean(req.file);

      log.info({ to, messageLength: message.length, hasFile }, "Processing WhatsApp send request");

      const sent = await sendMessage({ to, message, file: req.file || null });
      return res.json({ ok: true, to, sentAt: new Date().toISOString(), sent });
    } catch (err) {
      log.error({ err }, "Error in WhatsApp send route");
      return res.status(400).json({ ok: false, error: err.message || "No se pudo enviar mensaje." });
    }
  });

  app.post(`${base}/send-message`, (req, res, next) => {
    log.info({ method: req.method, url: req.url }, "Incoming WhatsApp send-message request");
    next();
  }, upload.single("file"), async (req, res) => {
    try {
      const to = req.body?.to || req.body?.phone || req.body?.number;
      const message = req.body?.message || req.body?.text || "";
      const sent = await sendMessage({ to, message, file: req.file || null });
      return res.json({ ok: true, to, sentAt: new Date().toISOString(), sent });
    } catch (err) {
      log.error({ err }, "Error in WhatsApp send-message route");
      return res.status(400).json({ ok: false, error: err.message || "No se pudo enviar mensaje." });
    }
  });
}

registerStatusRoutes("");
registerStatusRoutes("/whatsapp");
registerStatusRoutes("/api/whatsapp");

registerQrRoutes("");
registerQrRoutes("/whatsapp");
registerQrRoutes("/api/whatsapp");

registerSendRoutes("");
registerSendRoutes("/whatsapp");
registerSendRoutes("/api/whatsapp");

app.post("/logout", async (_, res) => {
  try {
    if (sock) {
      await sock.logout();
      sock.end(new Error("logout"));
      sock = null;
    }
    linked = false;
    linkedPhoneJid = "";
    linkedName = "";
    currentQrText = "";
    currentQrDataUrl = "";
    connecting = false;
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    }
    startWhatsApp().catch((err) => log.error({ err }, "Error reiniciando tras logout"));
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "No se pudo cerrar sesion." });
  }
});

app.get("/health", (_, res) => {
  res.json({ ok: true, service: "whatsapp-backend", ...currentStatus() });
});

app.listen(PORT, HOST, () => {
  log.info(`WhatsApp backend escuchando en http://${HOST}:${PORT}`);
  startWhatsApp().catch((err) => {
    log.error({ err }, "Fallo inicializando WhatsApp");
  });
});
