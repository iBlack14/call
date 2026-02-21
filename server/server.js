import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import { nanoid } from "nanoid";
import QRCode from "qrcode";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const WHATSAPP_LOCAL_BASE = process.env.WHATSAPP_LOCAL_BASE || "http://127.0.0.1:3010";

// ── WhatsApp proxy (Mover ANTES de body-parser para relay de streams de archivos) ──
async function proxyToWhatsApp(req, res, pathSuffix) {
  const targetUrl = `${WHATSAPP_LOCAL_BASE}${pathSuffix}`;
  const method = req.method || "GET";
  console.log(`[PROXY] ${method} ${pathSuffix} -> ${targetUrl}`);

  const headers = {};
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
  headers["ngrok-skip-browser-warning"] = "1";

  try {
    let upstream;
    const fetchOptions = {
      method,
      headers,
      signal: AbortSignal.timeout(60000) // 60s para archivos pesados
    };

    if (method === "GET" || method === "HEAD") {
      upstream = await fetch(targetUrl, fetchOptions);
    } else {
      upstream = await fetch(targetUrl, {
        ...fetchOptions,
        body: req,
        duplex: "half"
      });
    }

    const contentType = upstream.headers.get("content-type") || "";
    const text = await upstream.text();
    res.status(upstream.status);
    if (contentType) res.setHeader("Content-Type", contentType);
    return res.send(text);
  } catch (e) {
    console.error(`Proxy Error (${method} ${pathSuffix}):`, e);
    return res.status(502).json({ ok: false, error: "Error en el puente de WhatsApp.", details: e.message });
  }
}

app.get("/api/whatsapp/status", (req, res) => proxyToWhatsApp(req, res, "/status"));
app.get("/api/whatsapp/qr", (req, res) => proxyToWhatsApp(req, res, "/qr"));
app.post("/api/whatsapp/send", (req, res) => proxyToWhatsApp(req, res, "/send"));
app.post("/api/whatsapp/send-message", (req, res) => proxyToWhatsApp(req, res, "/send-message"));
app.post("/api/whatsapp/logout", (req, res) => proxyToWhatsApp(req, res, "/logout"));

app.use(express.json());

const sessions = new Map();

function getOrCreateSession(code) {
  if (!sessions.has(code)) {
    sessions.set(code, {
      dashboardSocketId: null,
      phoneSocketId: null,
      callState: "idle",
      lastNumber: "",
      lastCompanyName: "",
      lastContactName: "",
      lastImageUrl: "",
      pairingToken: nanoid(20),
      phoneDevice: null,
      updatedAt: Date.now()
    });
  }

  return sessions.get(code);
}

function getPeer(session, role) {
  if (role === "dashboard") return session.phoneSocketId;
  if (role === "phone") return session.dashboardSocketId;
  return null;
}

function emitState(code) {
  const session = sessions.get(code);
  if (!session) return;

  io.to(code).emit("state:changed", {
    code,
    connected: {
      dashboard: Boolean(session.dashboardSocketId),
      phone: Boolean(session.phoneSocketId)
    },
    phoneDevice: session.phoneDevice,
    callState: session.callState,
    lastNumber: session.lastNumber,
    lastCompanyName: session.lastCompanyName,
    lastContactName: session.lastContactName,
    lastImageUrl: session.lastImageUrl,
    updatedAt: session.updatedAt
  });
}

function getBaseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
}

io.on("connection", (socket) => {
  socket.on("session:create", () => {
    const code = nanoid(6).toUpperCase();
    const session = getOrCreateSession(code);
    session.updatedAt = Date.now();

    // Auto-join as dashboard so state:changed fires without a manual join click
    socket.data.code = code;
    socket.data.role = "dashboard";
    socket.join(code);
    session.dashboardSocketId = socket.id;

    socket.emit("session:created", { code });
  });


  socket.on("session:join", ({ code, role, token, deviceName, deviceId }) => {
    if (!code || !role) return;

    const normalizedCode = String(code).toUpperCase().trim();
    const session = getOrCreateSession(normalizedCode);
    const normalizedToken = token ? String(token).trim() : "";

    if (role === "phone" && normalizedToken !== session.pairingToken) {
      socket.emit("session:error", { message: "Token de vinculacion invalido." });
      return;
    }

    socket.data.code = normalizedCode;
    socket.data.role = role;
    socket.join(normalizedCode);

    if (role === "dashboard") session.dashboardSocketId = socket.id;
    if (role === "phone") {
      session.phoneSocketId = socket.id;
      session.phoneDevice = {
        id: deviceId || "web-phone",
        name: deviceName || "Android bridge",
        linkedAt: new Date().toISOString()
      };
    }

    session.updatedAt = Date.now();
    socket.emit("session:joined", { code: normalizedCode, role });
    emitState(normalizedCode);
  });

  socket.on("call:action", ({ action, phoneNumber, companyName, contactName, imageUrl, commandId }) => {
    const code = socket.data.code;
    const role = socket.data.role;
    if (!code || role !== "dashboard") return;

    const session = sessions.get(code);
    if (!session) return;

    if (action === "dial") {
      session.callState = "dialing";
      session.lastNumber = phoneNumber || "";
      session.lastCompanyName = companyName || "";
      session.lastContactName = contactName || "";
      session.lastImageUrl = imageUrl || "";
    }

    if (action === "hangup") {
      session.callState = "ended";
    }

    session.updatedAt = Date.now();

    const peerId = getPeer(session, role);
    if (peerId) {
      io.to(peerId).emit("call:action", {
        action,
        phoneNumber,
        companyName,
        contactName,
        imageUrl,
        commandId,
        from: "dashboard"
      });
    }

    emitState(code);
  });

  socket.on("phone:status", ({ callState }) => {
    const code = socket.data.code;
    const role = socket.data.role;
    if (!code || role !== "phone") return;

    const session = sessions.get(code);
    if (!session) return;

    session.callState = callState || session.callState;
    session.updatedAt = Date.now();
    emitState(code);
  });

  socket.on("phone:command_ack", ({ commandId, action, ok, message }) => {
    const code = socket.data.code;
    const role = socket.data.role;
    if (!code || role !== "phone") return;

    const session = sessions.get(code);
    if (!session) return;

    const peerId = getPeer(session, "phone");
    if (!peerId) return;

    io.to(peerId).emit("phone:command_ack", {
      commandId: commandId || "",
      action: action || "",
      ok: Boolean(ok),
      message: message || "",
      at: new Date().toISOString()
    });
  });

  // ── Audio relay (binary PCM frames, 16kHz mono PCM16) ───────────────────
  // Phone mic → dashboard speaker
  socket.on("audio:phone", (data) => {
    const { code, role } = socket.data;
    if (!code || role !== "phone") return;
    const session = sessions.get(code);
    if (!session) return;
    const peerId = getPeer(session, "phone");  // gets dashboardSocketId
    if (peerId) io.to(peerId).emit("audio:phone", data);
  });

  // Dashboard mic → phone speaker
  socket.on("audio:dashboard", (data) => {
    const { code, role } = socket.data;
    if (!code || role !== "dashboard") return;
    const session = sessions.get(code);
    if (!session) return;
    const peerId = getPeer(session, "dashboard");  // gets phoneSocketId
    if (peerId) io.to(peerId).emit("audio:dashboard", data);
  });


  socket.on("disconnect", () => {
    const { code, role } = socket.data;
    if (!code || !role) return;

    const session = sessions.get(code);
    if (!session) return;

    if (role === "dashboard" && session.dashboardSocketId === socket.id) session.dashboardSocketId = null;
    if (role === "phone" && session.phoneSocketId === socket.id) {
      session.phoneSocketId = null;
      // If phone disconnects, force end call so dashboard doesn't get stuck
      if (session.callState !== "idle") {
        session.callState = "idle";
        const dash = session.dashboardSocketId;
        if (dash) io.to(dash).emit("state:changed", { ...session, connected: { dashboard: true, phone: false } });
      }
    }

    session.updatedAt = Date.now();

    if (!session.dashboardSocketId && !session.phoneSocketId) {
      sessions.delete(code);
      return;
    }

    emitState(code);
  });
});

app.get("/api/pairing/:code", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });

  const session = getOrCreateSession(code);
  const baseUrl = getBaseUrl(req);
  const link = `${baseUrl}/phone?code=${encodeURIComponent(code)}&token=${encodeURIComponent(session.pairingToken)}`;

  return res.json({
    ok: true,
    code,
    token: session.pairingToken,
    link
  });
});

app.get("/api/pairing-qr/:code.svg", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).send("Code requerido");

  const session = getOrCreateSession(code);
  const baseUrl = getBaseUrl(req);
  const link = `${baseUrl}/phone?code=${encodeURIComponent(code)}&token=${encodeURIComponent(session.pairingToken)}`;

  try {
    const svg = await QRCode.toString(link, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
      width: 320
    });

    res.setHeader("Content-Type", "image/svg+xml");
    return res.send(svg);
  } catch {
    return res.status(500).send("No se pudo generar QR");
  }
});

app.post("/api/android/pair", (req, res) => {
  const code = String(req.body?.code || "").toUpperCase().trim();
  const token = String(req.body?.token || "").trim();
  const deviceId = String(req.body?.deviceId || "").trim();
  const deviceName = String(req.body?.deviceName || "").trim() || "Android bridge";

  if (!code || !token || !deviceId) {
    return res.status(400).json({ ok: false, error: "code, token y deviceId son requeridos" });
  }

  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  if (session.pairingToken !== token) return res.status(401).json({ ok: false, error: "Token invalido" });

  session.phoneDevice = {
    id: deviceId,
    name: deviceName,
    linkedAt: new Date().toISOString()
  };
  session.updatedAt = Date.now();
  emitState(code);

  const baseUrl = getBaseUrl(req);
  return res.json({
    ok: true,
    code,
    socket: {
      url: baseUrl,
      role: "phone",
      token
    }
  });
});

// ── APK download ────────────────────────────────────────────────────────
const APK_PATHS = [
  path.join(__dirname, "../android-app/app/build/outputs/apk/release/Phone-VC-release.apk"),
  path.join(__dirname, "../android-app/app/build/outputs/apk/debug/Phone-VC-debug.apk"),
  path.join(__dirname, "../android-app/app/build/intermediates/apk/debug/app-debug.apk")
];

const APK_SEARCH_DIRS = [
  path.join(__dirname, "../android-app/app/build/outputs/apk"),
  path.join(__dirname, "../android-app/releases")
];

function walkDirForApk(dir, out) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDirForApk(full, out);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".apk")) {
      out.push(full);
    }
  }
}

function parseApkVersion(fileName) {
  const base = fileName.replace(/\.apk$/i, "");
  const semver = base.match(/(\d+\.\d+\.\d+(?:[-+._]?[a-zA-Z0-9]+)*)/);
  if (semver) return semver[1].replace(/_/g, ".");

  const vTag = base.match(/(?:^|[-_])v(\d+(?:[._]\d+)*)/i);
  if (vTag) return `v${vTag[1].replace(/_/g, ".")}`;

  if (/release/i.test(base)) return "release";
  if (/debug/i.test(base)) return "debug";
  return "custom";
}

function getAvailableApks() {
  const found = [];
  for (const dir of APK_SEARCH_DIRS) {
    walkDirForApk(dir, found);
  }
  for (const p of APK_PATHS) {
    if (fs.existsSync(p)) found.push(p);
  }

  const unique = [...new Set(found.map(p => path.resolve(p)))];
  const versions = unique
    .filter(p => fs.existsSync(p))
    .map((p) => {
      const stat = fs.statSync(p);
      const file = path.basename(p);
      const version = parseApkVersion(file);
      const type = /release/i.test(file) ? "release" : (/debug/i.test(file) ? "debug" : "custom");
      return {
        id: Buffer.from(p).toString("base64url"),
        name: file,
        version,
        type,
        size: stat.size,
        sizeKb: Math.round(stat.size / 1024),
        modified: stat.mtime,
        fullPath: p
      };
    })
    .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

  return versions;
}

function getApkById(id) {
  if (!id) return null;
  const versions = getAvailableApks();
  return versions.find(v => v.id === id) || null;
}

app.get("/api/apk/versions", (_, res) => {
  const versions = getAvailableApks();
  if (!versions.length) {
    return res.json({ ok: false, versions: [], error: "APK no encontrada. Compila el proyecto Android primero." });
  }
  return res.json({
    ok: true,
    latestId: versions[0].id,
    versions: versions.map(v => ({
      id: v.id,
      name: v.name,
      version: v.version,
      type: v.type,
      size: v.size,
      sizeKb: v.sizeKb,
      modified: v.modified
    }))
  });
});

app.get("/api/apk/info", (_, res) => {
  const versions = getAvailableApks();
  if (!versions.length) {
    return res.json({ ok: false, error: "APK no encontrada. Compila el proyecto Android primero." });
  }
  const top = versions[0];
  return res.json({
    ok: true,
    id: top.id,
    name: top.name,
    version: top.version,
    size: top.size,
    sizeKb: top.sizeKb,
    type: top.type,
    modified: top.modified
  });
});

app.get("/api/apk/download", (_, res) => {
  const versions = getAvailableApks();
  if (!versions.length) {
    return res.status(404).json({ ok: false, error: "APK no encontrada." });
  }
  const latest = versions[0];
  res.setHeader("Content-Disposition", `attachment; filename="${latest.name}"`);
  res.setHeader("Content-Type", "application/vnd.android.package-archive");
  return res.sendFile(path.resolve(latest.fullPath));
});

app.get("/api/apk/download/:id", (req, res) => {
  const apk = getApkById(String(req.params.id || "").trim());
  if (!apk) return res.status(404).json({ ok: false, error: "Versión APK no encontrada." });
  res.setHeader("Content-Disposition", `attachment; filename="${apk.name}"`);
  res.setHeader("Content-Type", "application/vnd.android.package-archive");
  return res.sendFile(path.resolve(apk.fullPath));
});

// ── URL proxy for contact import ─────────────────────────────────────────
app.get("/api/fetch-url", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ ok: false, error: "url requerida" });
  try {
    const { default: fetch } = await import("node-fetch").catch(() => ({ default: globalThis.fetch }));
    const fetchFn = fetch || globalThis.fetch;
    const r = await fetchFn(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KENIA/1.0)" },
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) return res.status(502).json({ ok: false, error: `HTTP ${r.status} al obtener la URL` });
    const html = await r.text();
    return res.json({ ok: true, html });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.use(express.static(path.join(__dirname, "../web")));
app.get("/phone", (_, res) => res.sendFile(path.join(__dirname, "../web/phone.html")));
app.get("/health", (_, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Call bridge skeleton running on http://localhost:${port}`);
});
