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

  // Si tiene 9 dígitos (común en Perú), agregar el código de país 51
  if (digits.length === 9) {
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
      log.info({ jid, msgId: result?.key?.id }, "Texto enviado con exito");
      return;
    }

    const fileName = file.originalname || `archivo-${Date.now()}`;
    const fileMime = file.mimetype || mime.lookup(fileName) || "application/octet-stream";
    const buf = file.buffer;

    log.info({ jid, fileName, fileMime, size: buf.length }, "Enviando archivo");

    if (String(fileMime).startsWith("image/")) {
      const result = await sock.sendMessage(jid, { image: buf, caption: text || undefined, mimetype: fileMime });
      log.info({ jid, msgId: result?.key?.id }, "Imagen enviada con exito");
      return;
    }
    if (String(fileMime).startsWith("video/")) {
      const result = await sock.sendMessage(jid, { video: buf, caption: text || undefined, mimetype: fileMime });
      log.info({ jid, msgId: result?.key?.id }, "Video enviado con exito");
      return;
    }
    if (String(fileMime).startsWith("audio/")) {
      const result = await sock.sendMessage(jid, { audio: buf, mimetype: fileMime, ptt: false });
      log.info({ jid, msgId: result?.key?.id }, "Audio enviado con exito");
      if (text) await sock.sendMessage(jid, { text });
      return;
    }

    const result = await sock.sendMessage(jid, {
      document: buf,
      fileName,
      mimetype: fileMime,
      caption: text || undefined
    });
    log.info({ jid, msgId: result?.key?.id }, "Documento enviado con exito");
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

      await sendMessage({ to, message, file: req.file || null });
      return res.json({ ok: true, to, sentAt: new Date().toISOString() });
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
      await sendMessage({ to, message, file: req.file || null });
      return res.json({ ok: true, to, sentAt: new Date().toISOString() });
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
