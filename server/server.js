import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import dns from "dns/promises";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import { nanoid } from "nanoid";
import QRCode from "qrcode";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Fallback for .env loading if --env-file is not supported or fails
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  envContent.split("\n").forEach(line => {
    const [key, ...value] = line.split("=");
    if (key && value.length > 0 && !process.env[key.trim()]) {
      process.env[key.trim()] = value.join("=").trim().replace(/^["'](.*)["']$/, '$1');
    }
  });
}

import { SessionPersistence } from "./persistence.js";
const persistence = new SessionPersistence(path.join(__dirname, "sessions.json"));

const app = express();
app.disable("x-powered-by");
const trustProxyRaw = process.env.TRUST_PROXY;
const trustProxy = trustProxyRaw == null
  ? true
  : /^(false|0|off|no)$/i.test(String(trustProxyRaw).trim())
    ? false
    : /^\d+$/.test(String(trustProxyRaw).trim())
      ? Number(trustProxyRaw)
      : String(trustProxyRaw).trim();
app.set("trust proxy", trustProxy);
const server = http.createServer(app);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 24 * 30);
const DISCONNECTED_SESSION_TTL_MS = Number(process.env.DISCONNECTED_SESSION_TTL_MS || 1000 * 60 * 60 * 24);
const MAX_JSON_SIZE = process.env.MAX_JSON_SIZE || "256kb";
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 10000);
const ALLOWED_ORIGINS = CORS_ORIGIN === "*"
  ? null
  : CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
const requestBuckets = new Map();
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS || true,
    methods: ["GET", "POST", "OPTIONS"],
    credentials: false
  },
  maxHttpBufferSize: Number(process.env.SOCKET_MAX_HTTP_BUFFER_SIZE || 1024 * 1024),
  pingInterval: Number(process.env.SOCKET_PING_INTERVAL_MS || 25000),
  pingTimeout: Number(process.env.SOCKET_PING_TIMEOUT_MS || 20000)
});

server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 65000);
server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS || 66000);
server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 30000);

app.use((req, res, next) => {
  if (!ALLOWED_ORIGINS) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else {
    const origin = req.headers.origin || "";
    if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, ngrok-skip-browser-warning");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  if (req.secure || String(req.headers["x-forwarded-proto"] || "").includes("https")) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: MAX_JSON_SIZE }));
app.use(express.urlencoded({ extended: false, limit: MAX_JSON_SIZE }));

let sessions = await persistence.load();
console.log(`[PERSISTENCE] Loaded ${sessions.size} sessions.`);

function saveSoon() {
  persistence.save(sessions);
}

function getClientIp(reqOrSocket) {
  const forwardedFor = reqOrSocket?.headers?.["x-forwarded-for"];
  const remoteAddress = reqOrSocket?.ip || reqOrSocket?.handshake?.address || reqOrSocket?.socket?.remoteAddress;
  const firstForwarded = typeof forwardedFor === "string" ? forwardedFor.split(",")[0].trim() : "";
  return firstForwarded || remoteAddress || "unknown";
}

function rateLimit({ key, windowMs, limit }) {
  const now = Date.now();
  const bucket = requestBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    requestBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1 };
  }

  if (bucket.count >= limit) {
    return { ok: false, retryAfterMs: Math.max(bucket.resetAt - now, 1000) };
  }

  bucket.count += 1;
  return { ok: true, remaining: limit - bucket.count };
}

function enforceHttpRateLimit(req, res, options) {
  const ip = getClientIp(req);
  const result = rateLimit({ key: `${options.name}:${ip}`, windowMs: options.windowMs, limit: options.limit });
  if (result.ok) return true;
  res.setHeader("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
  res.status(429).json({ ok: false, error: "Demasiadas solicitudes. Intenta de nuevo en unos segundos." });
  return false;
}

function enforceSocketRateLimit(socket, name, windowMs, limit) {
  const ip = getClientIp(socket.handshake);
  const result = rateLimit({ key: `socket:${name}:${ip}`, windowMs, limit });
  if (result.ok) return true;
  socket.emit("session:error", { message: "Demasiados intentos. Espera unos segundos." });
  return false;
}

function sanitizeText(value, maxLen = 200) {
  return String(value || "").trim().slice(0, maxLen);
}

function createSessionCode() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = nanoid(6).toUpperCase();
    if (!sessions.has(code)) return code;
  }
  throw new Error("No se pudo generar un codigo de sesion unico");
}

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
    saveSoon();
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

function parseEnvUrlCandidates(rawValue) {
  const raw = String(rawValue || "").trim().replace(/^=+/, "");
  if (!raw) return [];
  return raw
    .split(",")
    .map(s => s.trim().replace(/\/+$/, ""))
    .filter(Boolean)
    .filter((v) => /^https?:\/\//i.test(v));
}

function getBaseUrl(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const proto = forwardedProto || req.protocol || "http";
  const host = forwardedHost || req.get("host") || "";
  const reqBase = `${proto}://${host}`.replace(/\/+$/, "");
  const reqHost = String(req.get("host") || "").toLowerCase();
  const candidates = parseEnvUrlCandidates(process.env.PUBLIC_BASE_URL);
  if (!candidates.length) return reqBase;

  const byHost = candidates.find((candidate) => {
    try {
      return new URL(candidate).host.toLowerCase() === reqHost;
    } catch {
      return false;
    }
  });

  return byHost || candidates[0] || reqBase;
}

function getWebBaseUrl(req) {
  const candidates = parseEnvUrlCandidates(process.env.PUBLIC_WEB_BASE_URL);
  return candidates[0] || getBaseUrl(req);
}

function isPrivateOrLocalAddress(hostValue) {
  const host = String(hostValue || "").trim().toLowerCase();
  if (!host) return true;
  if (["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"].includes(host)) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;

  if (/^10\./.test(host)) return true;
  if (/^127\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  if (host === "::" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;

  return false;
}

async function validateExternalFetchUrl(rawUrl) {
  const normalized = String(rawUrl || "").trim();
  if (!normalized) return { ok: false, error: "url requerida" };

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return { ok: false, error: "URL invalida" };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, error: "Solo se permiten URLs HTTP/HTTPS" };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: "URL con credenciales no permitida" };
  }

  const hostname = String(parsed.hostname || "").toLowerCase();
  if (isPrivateOrLocalAddress(hostname)) {
    return { ok: false, error: "Host privado/local no permitido" };
  }

  try {
    const addresses = await dns.lookup(hostname, { all: true });
    if (!addresses.length) return { ok: false, error: "No se pudo resolver el host" };
    if (addresses.some((entry) => isPrivateOrLocalAddress(entry.address))) {
      return { ok: false, error: "Destino resuelto a IP privada/local no permitido" };
    }
  } catch {
    return { ok: false, error: "No se pudo resolver el host" };
  }

  return { ok: true, url: parsed.toString() };
}

function pruneExpiredSessions() {
  const now = Date.now();
  let removed = 0;
  for (const [code, session] of sessions.entries()) {
    const age = now - Number(session.updatedAt || 0);
    const ttl = session.dashboardSocketId || session.phoneSocketId
      ? SESSION_TTL_MS
      : DISCONNECTED_SESSION_TTL_MS;
    if (age > ttl) {
      sessions.delete(code);
      removed += 1;
    }
  }
  if (removed > 0) {
    console.log(`[SESSIONS] Removed ${removed} expired sessions.`);
    saveSoon();
  }
}

setInterval(() => {
  pruneExpiredSessions();
  const now = Date.now();
  for (const [key, bucket] of requestBuckets.entries()) {
    if (bucket.resetAt <= now) requestBuckets.delete(key);
  }
}, 60_000).unref();

io.on("connection", (socket) => {
  socket.on("session:create", () => {
    if (!enforceSocketRateLimit(socket, "session:create", 60_000, 12)) return;
    const code = createSessionCode();
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
    if (!enforceSocketRateLimit(socket, "session:join", 60_000, 30)) return;
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
        id: sanitizeText(deviceId || "web-phone", 120),
        name: sanitizeText(deviceName || "Android bridge", 120),
        linkedAt: new Date().toISOString()
      };
      saveSoon();
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
      session.lastNumber = sanitizeText(phoneNumber, 40);
      session.lastCompanyName = sanitizeText(companyName);
      session.lastContactName = sanitizeText(contactName);
      session.lastImageUrl = sanitizeText(imageUrl, 500);
      saveSoon();
    }

    if (action === "hangup") {
      session.callState = "ended";
      saveSoon();
    }

    session.updatedAt = Date.now();

    const peerId = getPeer(session, role);
    if (peerId) {
      io.to(peerId).emit("call:action", {
        action,
        phoneNumber: sanitizeText(phoneNumber, 40),
        companyName: sanitizeText(companyName),
        contactName: sanitizeText(contactName),
        imageUrl: sanitizeText(imageUrl, 500),
        commandId: sanitizeText(commandId, 80),
        from: "dashboard"
      });
    }

    emitState(code);
  });

  socket.on("phone:status", ({ callState, phoneNumber, contactName, companyName }) => {
    const code = socket.data.code;
    const role = socket.data.role;
    if (!code || role !== "phone") return;

    const session = sessions.get(code);
    if (!session) return;

    session.callState = sanitizeText(callState, 40) || session.callState;
    if (typeof phoneNumber === "string" && phoneNumber.trim()) {
      session.lastNumber = sanitizeText(phoneNumber, 40);
    }
    if (typeof contactName === "string" && contactName.trim()) {
      session.lastContactName = sanitizeText(contactName);
    }
    if (typeof companyName === "string" && companyName.trim()) {
      session.lastCompanyName = sanitizeText(companyName);
    }
    session.updatedAt = Date.now();
    saveSoon();
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
      commandId: sanitizeText(commandId, 80),
      action: sanitizeText(action, 80),
      ok: Boolean(ok),
      message: sanitizeText(message, 240),
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
      saveSoon();
      return;
    }

    emitState(code);
  });
});

app.get("/api/pairing/:code", (req, res) => {
  if (!enforceHttpRateLimit(req, res, { name: "api:pairing", windowMs: 60_000, limit: 60 })) return;
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });

  const session = getOrCreateSession(code);
  const webBase = getWebBaseUrl(req);
  const apiBase = getBaseUrl(req);
  const link = `${webBase}/phone?code=${encodeURIComponent(code)}&token=${encodeURIComponent(session.pairingToken)}&apiBase=${encodeURIComponent(apiBase)}`;

  return res.json({
    ok: true,
    code,
    token: session.pairingToken,
    link
  });
});

app.get("/api/pairing-qr/:code.svg", async (req, res) => {
  if (!enforceHttpRateLimit(req, res, { name: "api:pairing-qr", windowMs: 60_000, limit: 30 })) return;
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).send("Code requerido");

  const session = getOrCreateSession(code);
  const webBase = getWebBaseUrl(req);
  const apiBase = getBaseUrl(req);
  const link = `${webBase}/phone?code=${encodeURIComponent(code)}&token=${encodeURIComponent(session.pairingToken)}&apiBase=${encodeURIComponent(apiBase)}`;

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
  if (!enforceHttpRateLimit(req, res, { name: "api:android-pair", windowMs: 60_000, limit: 40 })) return;
  const code = sanitizeText(req.body?.code, 20).toUpperCase();
  const token = sanitizeText(req.body?.token, 120);
  const deviceId = sanitizeText(req.body?.deviceId, 120);
  const deviceName = sanitizeText(req.body?.deviceName, 120) || "Android bridge";

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
  saveSoon();
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
  if (!enforceHttpRateLimit(req, res, { name: "api:fetch-url", windowMs: 60_000, limit: 20 })) return;
  const rawUrl = req.query.url;
  const validation = await validateExternalFetchUrl(rawUrl);
  if (!validation.ok) return res.status(400).json({ ok: false, error: validation.error });
  try {
    const { default: fetch } = await import("node-fetch").catch(() => ({ default: globalThis.fetch }));
    const fetchFn = fetch || globalThis.fetch;
    const r = await fetchFn(validation.url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; VOIP VC/1.0)" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!r.ok) return res.status(502).json({ ok: false, error: `HTTP ${r.status} al obtener la URL` });
    const html = await r.text();
    return res.json({ ok: true, html });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.use(express.static(path.join(__dirname, "../web")));
app.get("/phone", (req, res) => {
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  return res.redirect(`/${query}`);
});
app.get("/health", (_, res) => res.json({
  ok: true,
  uptimeSeconds: Math.round(process.uptime()),
  sessions: sessions.size,
  timestamp: new Date().toISOString()
}));

app.use((error, _req, res, _next) => {
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ ok: false, error: "Payload demasiado grande" });
  }
  console.error("[HTTP] Unhandled error:", error);
  return res.status(500).json({ ok: false, error: "Error interno del servidor" });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SERVER] Received ${signal}. Closing gracefully...`);

  io.close();
  server.close(async (error) => {
    if (error) {
      console.error("[SERVER] Error while closing HTTP server:", error);
      process.exitCode = 1;
    }
    await persistence.flush();
    process.exit();
  });

  setTimeout(async () => {
    console.error("[SERVER] Forced shutdown after timeout.");
    await persistence.flush();
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(PORT, HOST, () => {
  console.log(`Call bridge skeleton running on http://${HOST}:${PORT}`);
});
