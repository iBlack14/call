import express from "express";
import cors from "cors";
import http from "http";
import path from "path";
import fs from "fs";
import os from "os";
import dgram from "dgram";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import { nanoid } from "nanoid";
import QRCode from "qrcode";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import dotenv from "dotenv";
dotenv.config({ path: path.join(__dirname, "..", ".env") });

import { SessionPersistence } from "./persistence.js";
import {
  ensureCampaign,
  getCampaignSnapshot,
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  assignNextContact,
  updateActiveCallState,
  markContactResult,
  skipActiveContact,
  getActiveContact,
  getActiveContacts
} from "./campaign-manager.js";
const persistence = new SessionPersistence(path.join(__dirname, "sessions.json"));

const app = express();
app.set("trust proxy", true);
const server = http.createServer(app);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "https://llamada.viacomunicativa.com,https://lm.viacomunicativa.com,http://localhost:3000";
const corsOptions = {
  origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",").map(s => s.trim()).filter(Boolean),
  methods: ["GET", "POST", "OPTIONS"],
  credentials: false
};
app.use(cors(corsOptions));

const io = new Server(server, {
  cors: corsOptions,
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000
});


app.use((req, res, next) => {
  const allowedOrigin = CORS_ORIGIN;
  if (allowedOrigin === "*") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else {
    const allowed = allowedOrigin.split(",").map(s => s.trim()).filter(Boolean);
    const origin = req.headers.origin || "";
    if (allowed.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, ngrok-skip-browser-warning");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});


app.use(express.json());

let sessions = new Map();

async function bootstrap() {
  sessions = await persistence.load();
  // Post-load cleanup to avoid stuck campaigns
  for (const session of sessions.values()) {
    if (session.campaign) {
        const active = getActiveContact(session);
        if (active) {
            session.campaign.activeContactId = active.id;
        } else if (session.campaign.status === "running") {
            session.campaign.activeContactId = null;
        }
    }
  }
  console.log(`[PERSISTENCE] Loaded ${sessions.size} sessions.`);

  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`Call bridge running on http://localhost:${port}`);
  });
}

function saveSoon() {
  persistence.save(sessions);
}

function createPhoneWorker({ socketId = null, deviceId = "", deviceName = "Android bridge", pairingSlotId = "", linkedAt, connected = false, callState = "idle", currentNumber = "" } = {}) {
  return {
    socketId,
    id: deviceId || "android-worker",
    name: deviceName || "Android bridge",
    pairingSlotId: pairingSlotId || "",
    linkedAt: linkedAt || new Date().toISOString(),
    connected: Boolean(connected),
    callState: callState || "idle",
    currentNumber: currentNumber || ""
  };
}

function normalizeSessionShape(session = {}) {
  const normalized = {
    dashboardSocketId: null,
    phoneSocketId: null,
    activePhoneSocketId: null,
    callState: "idle",
    lastNumber: "",
    lastCompanyName: "",
    lastContactName: "",
    lastImageUrl: "",
    pairingToken: nanoid(20),
    phoneDevice: null,
    phoneWorkers: [],
    pairingSlots: [],
    micMuted: true,
    isSpeakerOn: false,
    pbx: {
      activeChannelId: "",
      activeBridgeId: "",
      externalMediaChannelId: "",
      externalMediaHost: "",
      externalMediaPort: 0,
      lastPlaybackId: "",
      endpoint: "",
      callerId: "",
      appArgs: "",
      lastTtsMedia: "",
      updatedAt: 0
    },
    workerCursor: 0,
    updatedAt: Date.now(),
    ...session
  };

  if (!Array.isArray(normalized.phoneWorkers)) normalized.phoneWorkers = [];
  normalized.phoneWorkers = normalized.phoneWorkers.map((worker) => createPhoneWorker(worker));
  if (!Array.isArray(normalized.pairingSlots)) normalized.pairingSlots = [];

  if (!normalized.phoneWorkers.length && normalized.phoneDevice) {
    normalized.phoneWorkers.push(createPhoneWorker({
      deviceId: normalized.phoneDevice.id,
      deviceName: normalized.phoneDevice.name,
      linkedAt: normalized.phoneDevice.linkedAt,
      connected: Boolean(normalized.phoneSocketId),
      socketId: normalized.phoneSocketId || null
    }));
  }

  return normalized;
}

function getConnectedPhoneWorkers(session) {
  return (session.phoneWorkers || []).filter((worker) => worker.connected && worker.socketId);
}

function getPhoneWorkerBySocketId(session, socketId) {
  return (session.phoneWorkers || []).find((worker) => worker.socketId === socketId) || null;
}

function upsertPhoneWorker(session, { socketId, deviceId, deviceName, pairingSlotId = "" }) {
  const workers = session.phoneWorkers || (session.phoneWorkers = []);
  // Primary match: deviceId. Secondary match: socketId.
  const existingIndex = workers.findIndex((worker) => (deviceId && worker.id === deviceId) || (socketId && worker.socketId === socketId));
  
  if (existingIndex !== -1) {
    const existing = workers[existingIndex];
    existing.socketId = socketId;
    existing.id = deviceId || existing.id;
    existing.name = deviceName || existing.name;
    existing.pairingSlotId = pairingSlotId || existing.pairingSlotId || "";
    existing.connected = Boolean(socketId);
    existing.linkedAt = existing.linkedAt || new Date().toISOString();
    existing.callState = existing.callState || "idle";
    return existing;
  }

  const worker = createPhoneWorker({
    socketId,
    deviceId,
    deviceName,
    pairingSlotId,
    connected: Boolean(socketId)
  });
  workers.push(worker);
  return worker;
}

function removePhoneWorker(session, socketId) {
  const workers = session.phoneWorkers || [];
  const index = workers.findIndex((worker) => worker.socketId === socketId);
  if (index === -1) return null;

  const worker = workers[index];
  worker.socketId = null;
  worker.connected = false;
  worker.callState = "offline";
  return worker;
}

function selectPhoneWorker(session, preferredSocketId = "") {
  const workers = getConnectedPhoneWorkers(session);
  if (!workers.length) return null;
  const isAvailable = (worker) =>
    ["idle", "ended", "failed"].includes(worker.callState || "idle");

  if (preferredSocketId) {
    const preferred = workers.find((worker) => worker.socketId === preferredSocketId);
    if (preferred && isAvailable(preferred)) return preferred;
  }

  const idleWorkers = workers.filter(isAvailable);
  const candidates = idleWorkers;
  if (!candidates.length) return null;
  const start = Number(session.workerCursor || 0) % candidates.length;
  const chosen = candidates[start] || candidates[0];
  session.workerCursor = (start + 1) % candidates.length;
  return chosen;
}

function createPairingSlot(session, label = "") {
  const slots = session.pairingSlots || (session.pairingSlots = []);
  const slot = {
    id: nanoid(10),
    token: nanoid(24),
    label: String(label || "").trim() || `Dispositivo ${slots.length + 1}`,
    deviceId: "",
    deviceName: "",
    createdAt: new Date().toISOString(),
    linkedAt: null
  };
  slots.push(slot);
  return slot;
}

function getPairingSlotByToken(session, token) {
  return (session.pairingSlots || []).find((slot) => slot.token === token) || null;
}

function ensureLegacyPairingSlot(session) {
  const slots = session.pairingSlots || (session.pairingSlots = []);
  if (!slots.length) {
    slots.push({
      id: nanoid(10),
      token: session.pairingToken || nanoid(24),
      label: "Dispositivo 1",
      deviceId: "",
      deviceName: "",
      createdAt: new Date().toISOString(),
      linkedAt: null
    });
  }
  return slots[0];
}

function getActivePhoneWorker(session) {
  const workers = getConnectedPhoneWorkers(session);
  return workers.find((worker) => worker.socketId === session.activePhoneSocketId)
    || workers.find((worker) => worker.socketId === session.phoneSocketId)
    || workers[0]
    || null;
}

function syncSessionPhoneState(session) {
  const activeWorker = getActivePhoneWorker(session);
  const connectedWorkers = getConnectedPhoneWorkers(session);
  session.phoneSocketId = activeWorker?.socketId || null;
  session.activePhoneSocketId = activeWorker?.socketId || null;
  session.phoneDevice = activeWorker
    ? {
        id: activeWorker.id,
        name: activeWorker.name,
        linkedAt: activeWorker.linkedAt
      }
    : connectedWorkers[0]
      ? {
          id: connectedWorkers[0].id,
          name: connectedWorkers[0].name,
          linkedAt: connectedWorkers[0].linkedAt
        }
    : null;
}

function emitCampaignState(code) {
  const session = sessions.get(code);
  if (!session) return;
  io.to(code).emit("campaign:state", getCampaignSnapshot(session));
}

function detachSocketFromCurrentSession(socket) {
  const previousCode = socket.data.code;
  const previousRole = socket.data.role;
  if (!previousCode || !previousRole) return;

  const previousSession = sessions.get(previousCode);
  if (!previousSession) {
    socket.data.code = null;
    socket.data.role = null;
    return;
  }

  if (previousRole === "dashboard" && previousSession.dashboardSocketId === socket.id) {
    previousSession.dashboardSocketId = null;
  }

  if (previousRole === "phone") {
    const removed = removePhoneWorker(previousSession, socket.id);
    if (previousSession.activePhoneSocketId === socket.id) {
      previousSession.activePhoneSocketId = null;
    }
    syncSessionPhoneState(previousSession);

    if (removed && previousSession.callState !== "idle" && !previousSession.phoneSocketId) {
      previousSession.callState = "idle";
    }
  }

  previousSession.updatedAt = Date.now();
  socket.leave(previousCode);

  if (
    !previousSession.dashboardSocketId
    && !getConnectedPhoneWorkers(previousSession).length
    && !(previousSession.pairingSlots || []).length
  ) {
    sessions.delete(previousCode);
  } else {
    emitState(previousCode);
    emitCampaignState(previousCode);
  }

  saveSoon();
  socket.data.code = null;
  socket.data.role = null;
}

function dispatchNextCampaignCall(code) {
  const session = sessions.get(code);
  if (!session) return null;

  const campaign = ensureCampaign(session);
  if (campaign.status !== "running") {
    emitCampaignState(code);
    return null;
  }

  // La campaña es una cola estrictamente secuencial: nunca se inicia otro
  // contacto mientras exista una llamada activa, aunque haya más celulares.
  if (getActiveContact(session)) {
    emitCampaignState(code);
    return null;
  }

  // Los dispositivos vinculados se seleccionan por turnos para cada llamada.
  const worker = selectPhoneWorker(session);
  if (!worker) {
    emitCampaignState(code);
    return null;
  }
  const next = assignNextContact(session, worker || {});
  session.updatedAt = Date.now();
  saveSoon();

  if (!next) {
    emitCampaignState(code);
    return null;
  }

  session.callState = "dialing";
  session.lastNumber = next.phone;
  session.lastContactName = next.name;
  session.lastCompanyName = next.name;
  
  if (worker) {
    worker.callState = "dialing";
    worker.currentNumber = next.phone;
    console.log(`[CAMPAIGN] Marcado directo a ${next.phone} vía worker ${worker.name}`);
    io.to(worker.socketId).emit("call:action", {
      action: "dial",
      phoneNumber: next.phone,
      contactId: next.id,
      companyName: next.name,
      contactName: next.name,
      commandId: nanoid()
    });
    saveSoon();
    emitState(code);
    emitCampaignState(code);
  } else {
    console.log(`[CAMPAIGN] Omitido ${next.phone} (No hay worker)`);
    session.callState = "ended";
    markContactResult(session, next.id, "failed", { callbackReason: "Sin celular vinculado" });
    saveSoon();
    emitState(code);
    emitCampaignState(code);
  }

  emitState(code);
  emitCampaignState(code);
  return next;
}

function fillAvailableCampaignWorkers(code) {
  const next = dispatchNextCampaignCall(code);
  return next ? [next] : [];
}

function getOrCreateSession(code) {
  if (!sessions.has(code)) {
    sessions.set(code, normalizeSessionShape());
    saveSoon();
  }

  const session = sessions.get(code);
  const normalized = normalizeSessionShape(session);
  ensureCampaign(normalized);
  sessions.set(code, normalized);
  return normalized;
}

function getPeer(session, role) {
  syncSessionPhoneState(session);
  if (role === "dashboard") return session.activePhoneSocketId || session.phoneSocketId;
  if (role === "phone") return session.dashboardSocketId;
  return null;
}

function emitState(code) {
  const session = sessions.get(code);
  if (!session) return;
  syncSessionPhoneState(session);
  const phoneWorkers = (session.phoneWorkers || []).map((worker) => ({
    id: worker.id,
    name: worker.name,
    linkedAt: worker.linkedAt,
    connected: Boolean(worker.connected && worker.socketId),
    callState: worker.callState || "idle",
    currentNumber: worker.currentNumber || "",
    active: worker.socketId === session.activePhoneSocketId
  }));

  io.to(code).emit("state:changed", {
    connected: {
      dashboard: Boolean(session.dashboardSocketId),
      phone: Boolean(session.phoneSocketId),
      phoneCount: phoneWorkers.filter((worker) => worker.connected).length,
      linking: Boolean(session.phoneDevice) && !session.phoneSocketId
    },
    phoneDevice: session.phoneDevice,
    phoneWorkers,
    callState: session.callState,
    lastNumber: session.lastNumber,
    lastCompanyName: session.lastCompanyName,
    lastContactName: session.lastContactName,
    lastImageUrl: session.lastImageUrl,
    micMuted: session.micMuted,
    isSpeakerOn: session.isSpeakerOn,
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

function getRequestBaseUrl(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const proto = forwardedProto || req.protocol || "http";
  const host = forwardedHost || req.get("host") || "";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function getHostName(urlValue) {
  try {
    return new URL(urlValue).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isLoopbackHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function isLikelyVirtualInterface(name) {
  const value = String(name || "").toLowerCase();
  return ["vethernet", "virtual", "vmware", "hyper-v", "loopback", "docker", "wsl"].some((part) => value.includes(part));
}

function rankLanAddress(address, interfaceName) {
  const ip = String(address || "").trim();
  const iface = String(interfaceName || "").trim().toLowerCase();

  let score = 0;
  if (/^192\.168\./.test(ip)) score += 50;
  else if (/^10\./.test(ip)) score += 40;
  else if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) score += 30;

  if (iface.includes("wi-fi") || iface.includes("wifi") || iface.includes("wlan")) score += 15;
  if (iface === "ethernet" || iface.includes("ethernet")) score += 12;
  if (isLikelyVirtualInterface(iface)) score -= 100;

  return score;
}

function getFirstLanAddress() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.internal || entry.family !== "IPv4") continue;
      candidates.push({
        name,
        address: entry.address,
        score: rankLanAddress(entry.address, name)
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address || "";
}

function getLocalLanBaseUrl(req) {
  const envCandidates = parseEnvUrlCandidates(process.env.LOCAL_LAN_BASE_URL);
  if (envCandidates.length) return envCandidates[0];

  const reqBase = getRequestBaseUrl(req);
  const reqUrl = new URL(reqBase);
  if (!isLoopbackHost(reqUrl.hostname)) return reqBase;

  const lanAddress = getFirstLanAddress();
  if (!lanAddress) return "";
  const port = reqUrl.port ? `:${reqUrl.port}` : "";
  return `${reqUrl.protocol}//${lanAddress}${port}`;
}

function pickConfiguredBase(req, envName) {
  const reqBase = getRequestBaseUrl(req);
  const reqHost = String(req.get("host") || "").toLowerCase();
  const candidates = parseEnvUrlCandidates(process.env[envName]);
  if (!candidates.length) return "";

  const byHost = candidates.find((candidate) => {
    try {
      return new URL(candidate).host.toLowerCase() === reqHost;
    } catch {
      return false;
    }
  });

  return byHost || candidates[0] || "";
}

function getAndroidApiBaseUrl(req) {
  const publicBase = pickConfiguredBase(req, "PUBLIC_BASE_URL");
  if (publicBase) return publicBase;

  const localLanBase = getLocalLanBaseUrl(req);
  if (localLanBase) return localLanBase;

  const reqBase = getRequestBaseUrl(req);
  const reqHost = getHostName(reqBase);
  if (reqBase) return reqBase;

  return "https://lm.viacomunicativa.com";
}

function getWebBaseUrl(req) {
  const publicWebBase = pickConfiguredBase(req, "PUBLIC_WEB_BASE_URL");
  if (publicWebBase) return publicWebBase;

  const reqBase = getRequestBaseUrl(req);
  if (reqBase) return reqBase;

  return "https://llamada.viacomunicativa.com";
}

function getPairingLink(req, code, token) {
  const webBase = getWebBaseUrl(req);
  const apiBase = getAndroidApiBaseUrl(req);
  return `${webBase}/pairing?code=${encodeURIComponent(code)}&token=${encodeURIComponent(token)}&apiBase=${encodeURIComponent(apiBase)}`;
}

io.on("connection", (socket) => {
  socket.on("session:create", () => {
    detachSocketFromCurrentSession(socket);
    const code = nanoid(6).toUpperCase();
    const session = getOrCreateSession(code);
    session.updatedAt = Date.now();

    // Auto-join as dashboard so state:changed fires without a manual join click
    socket.data.code = code;
    socket.data.role = "dashboard";
    socket.join(code);
    session.dashboardSocketId = socket.id;

    socket.emit("session:created", { code });
    emitState(code);
    emitCampaignState(code);
  });


  socket.on("session:join", ({ code, role, token, deviceName, deviceId }) => {
    if (!code || !role) return;

    const normalizedCode = String(code).toUpperCase().trim();
    const session = getOrCreateSession(normalizedCode);
    const normalizedToken = token ? String(token).trim() : "";

    const pairingSlot = role === "phone" ? getPairingSlotByToken(session, normalizedToken) : null;
    if (role === "phone" && (!pairingSlot || (pairingSlot.deviceId && pairingSlot.deviceId !== String(deviceId || "")))) {
      socket.emit("session:error", { message: "Token de vinculacion invalido." });
      return;
    }

    detachSocketFromCurrentSession(socket);

    socket.data.code = normalizedCode;
    socket.data.role = role;
    socket.join(normalizedCode);

    if (role === "dashboard") session.dashboardSocketId = socket.id;
    if (role === "phone") {
      const worker = upsertPhoneWorker(session, {
        socketId: socket.id,
        deviceId: deviceId || "web-phone",
        deviceName: deviceName || "Android bridge",
        pairingSlotId: pairingSlot?.id || ""
      });
      session.activePhoneSocketId ||= worker.socketId;
      syncSessionPhoneState(session);
      saveSoon();
    }

    session.updatedAt = Date.now();
    socket.emit("session:joined", { code: normalizedCode, role });
    emitState(normalizedCode);
    emitCampaignState(normalizedCode);

    // If a phone joined and a campaign is running but idle, kickstart it
    if (role === "phone") {
        const campaign = ensureCampaign(session);
        if (campaign.status === "running" && !getActiveContact(session)) {
            setTimeout(() => fillAvailableCampaignWorkers(normalizedCode), 1000);
        }
    }
  });

  socket.on("call:action", ({ action, phoneNumber, companyName, contactName, imageUrl, commandId, contactId }) => {
    const code = socket.data.code;
    const role = socket.data.role;
    if (!code || role !== "dashboard") return;

    const session = sessions.get(code);
    if (!session) return;

  if (action === "dial") {
      session.lastNumber = phoneNumber || "";
      session.lastCompanyName = companyName || "";
      session.lastContactName = contactName || "";
      session.lastImageUrl = imageUrl || "";

      const worker = selectPhoneWorker(session);
      if (contactId) {
        const campaign = ensureCampaign(session);
        campaign.activeContactId = contactId;
        if (worker) campaign.activeWorkerSocketId = worker.socketId;
      }
      session.updatedAt = Date.now();
      saveSoon();
      
      if (worker) {
        worker.callState = "dialing";
        worker.currentNumber = phoneNumber || "";
        console.log(`[MANUAL] Marcado directo a ${phoneNumber} vía worker ${worker.name}`);
        io.to(worker.socketId).emit("call:action", {
          action: "dial",
          phoneNumber: phoneNumber || "",
          companyName: companyName || "",
          contactName: contactName || "",
          imageUrl: imageUrl || "",
          contactId: contactId || "",
          commandId: commandId || nanoid()
        });
        saveSoon();
        emitState(code);
      } else {
        console.log(`[MANUAL] Intento fallido para ${phoneNumber} (No hay worker activo)`);
        session.callState = "failed";
        saveSoon();
        emitState(code);
      }
    }

    if (action === "hangup") {
      const worker = contactId
        ? getConnectedPhoneWorkers(session).find((item) => item.id === ensureCampaign(session).contacts.find((contact) => contact.id === contactId)?.assignedWorkerId)
        : getActivePhoneWorker(session);
      if (worker) {
        io.to(worker.socketId).emit("call:action", { 
          action: "hangup", 
          from: "dashboard", 
          contactId 
        });
      }
      session.callState = "ended";
      saveSoon();
    }

    if (action === "mute" || action === "unmute" || action === "speaker_on" || action === "speaker_off" || action === "answer") {
      const worker = contactId
        ? getConnectedPhoneWorkers(session).find((item) => item.id === ensureCampaign(session).contacts.find((contact) => contact.id === contactId)?.assignedWorkerId)
        : getActivePhoneWorker(session);
      if (worker) {
        io.to(worker.socketId).emit("call:action", { 
          action, 
          commandId,
          contactId 
        });
      }
    }

    session.updatedAt = Date.now();
    emitState(code);
    emitCampaignState(code);
  });

  socket.on("phone:status", ({ callState, phoneNumber, contactName, companyName, micMuted, speakerOn, lineLabel, lastError }) => {
    const code = socket.data.code;
    const role = socket.data.role;
    if (!code || role !== "phone") return;

    const session = sessions.get(code);
    if (!session) return;

    const worker = getPhoneWorkerBySocketId(session, socket.id);
    if (worker) {
      worker.callState = callState || worker.callState || "idle";
      worker.currentNumber = ["idle", "ended", "failed"].includes(callState)
        ? ""
        : (phoneNumber || worker.currentNumber || "");
      worker.connected = true;
      if (lineLabel) worker.lineLabel = String(lineLabel).trim();
      if (lastError) worker.lastError = String(lastError).trim();
      session.activePhoneSocketId = socket.id;
    }
    session.callState = callState || session.callState;
    if (typeof phoneNumber === "string" && phoneNumber.trim()) {
      session.lastNumber = phoneNumber.trim();
    }
    if (typeof contactName === "string" && contactName.trim()) {
      session.lastContactName = contactName.trim();
    }
    if (typeof companyName === "string" && companyName.trim()) {
      session.lastCompanyName = companyName.trim();
    }
    session.micMuted = Boolean(micMuted);
    session.isSpeakerOn = Boolean(speakerOn);
    session.updatedAt = Date.now();
    updateActiveCallState(session, callState, worker || {});
    syncSessionPhoneState(session);
    saveSoon();
    emitState(code);
    emitCampaignState(code);

    const campaign = ensureCampaign(session);
    if ((callState === "idle" || callState === "ended") && campaign.status === "running") {
      fillAvailableCampaignWorkers(code);
    }
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
    session.activePhoneSocketId = socket.id;
    const worker = getPhoneWorkerBySocketId(session, socket.id);
    if (worker) worker.callState = session.callState || worker.callState || "idle";
    syncSessionPhoneState(session);
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
    if (role === "phone") {
      const removed = removePhoneWorker(session, socket.id);
      if (session.activePhoneSocketId === socket.id) {
        session.activePhoneSocketId = null;
      }
      
      // If the disconnecting worker was in a call, cleanup campaign
      if (removed) {
          updateActiveCallState(session, "ended", removed);
      }

      syncSessionPhoneState(session);
      // Let the dashboard keep the call window open during micro-cuts.
      // The user can manually click 'Cortar' if the phone never reconnects.
      /*
      if (removed && session.callState !== "idle" && !session.phoneSocketId) {
        session.callState = "idle";
        const dash = session.dashboardSocketId;
        if (dash) io.to(dash).emit("state:changed", { ...session, connected: { dashboard: true, phone: false, phoneCount: 0 } });
      }
      */
    }

    session.updatedAt = Date.now();

    if (
      !session.dashboardSocketId
      && !getConnectedPhoneWorkers(session).length
      && !(session.pairingSlots || []).length
    ) {
      sessions.delete(code);
      saveSoon();
      return;
    }

    emitState(code);
    emitCampaignState(code);
  });
});

app.get("/api/pairing/:code", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });

  const session = getOrCreateSession(code);
  const slotId = String(req.query.slotId || "").trim();
  const slot = (session.pairingSlots || []).find((item) => item.id === slotId) || ensureLegacyPairingSlot(session);
  const link = getPairingLink(req, code, slot.token);

  return res.json({
    ok: true,
    code,
    token: slot.token,
    slotId: slot.id,
    label: slot.label,
    link,
    phoneDevice: session.phoneDevice,
    workers: (session.phoneWorkers || []).map((worker) => ({
      id: worker.id,
      name: worker.name,
      linkedAt: worker.linkedAt,
      connected: Boolean(worker.connected && worker.socketId),
      callState: worker.callState || "idle",
      active: worker.socketId === session.activePhoneSocketId
    }))
  });
});

app.get("/api/session/:code/pairing-slots", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  ensureLegacyPairingSlot(session);
  return res.json({
    ok: true,
    slots: session.pairingSlots.map((slot) => ({
      id: slot.id,
      label: slot.label,
      deviceId: slot.deviceId,
      deviceName: slot.deviceName,
      linkedAt: slot.linkedAt,
      link: getPairingLink(req, code, slot.token)
    }))
  });
});

app.post("/api/session/:code/pairing-slots", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const slot = createPairingSlot(session, req.body?.label);
  saveSoon();
  return res.status(201).json({
    ok: true,
    slot: { id: slot.id, label: slot.label, link: getPairingLink(req, code, slot.token) }
  });
});

app.get("/api/session/:code/workers", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });

  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  syncSessionPhoneState(session);

  return res.json({
    ok: true,
    code,
    activePhoneSocketId: session.activePhoneSocketId,
    workers: (session.phoneWorkers || []).map((worker) => ({
      id: worker.id,
      name: worker.name,
      linkedAt: worker.linkedAt,
      connected: Boolean(worker.connected && worker.socketId),
      callState: worker.callState || "idle",
      active: worker.socketId === session.activePhoneSocketId
    }))
  });
});

app.get("/api/session/:code/campaign", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });

  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  return res.json({
    ok: true,
    code,
    campaign: getCampaignSnapshot(session)
  });
});



app.post("/api/session/:code/campaign/start", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const contacts = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });
  if (!contacts.length) return res.status(400).json({ ok: false, error: "contacts requeridos" });

  const session = getOrCreateSession(code);
  startCampaign(session, contacts);
  session.updatedAt = Date.now();
  saveSoon();
  emitCampaignState(code);
  const dispatched = fillAvailableCampaignWorkers(code);

  return res.json({
    ok: true,
    code,
    dispatched: dispatched.length,
    campaign: getCampaignSnapshot(session)
  });
});

app.get("/api/session/:code/campaign", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  return res.json({ ok: true, code, campaign: getCampaignSnapshot(session) });
});

app.post("/api/session/:code/campaign/pause", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  pauseCampaign(session);
  saveSoon();
  emitCampaignState(code);
  return res.json({ ok: true, code, campaign: getCampaignSnapshot(session) });
});

app.post("/api/session/:code/campaign/resume", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  resumeCampaign(session);
  saveSoon();
  emitCampaignState(code);
  const dispatched = fillAvailableCampaignWorkers(code);
  return res.json({ ok: true, code, dispatched: dispatched.length, campaign: getCampaignSnapshot(session) });
});

app.post("/api/session/:code/campaign/dispatch", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  const dispatched = fillAvailableCampaignWorkers(code);
  saveSoon();
  emitCampaignState(code);
  return res.json({ ok: true, code, dispatched: dispatched.length, nextContacts: dispatched, campaign: getCampaignSnapshot(session) });
});

app.post("/api/session/:code/campaign/skip", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  const activeBeforeSkip = getActiveContact(session);
  const workerSocketId = getConnectedPhoneWorkers(session)
    .find((worker) => worker.id === activeBeforeSkip?.assignedWorkerId)?.socketId;
  const skipped = skipActiveContact(session);
  if (workerSocketId && skipped) {
    io.to(workerSocketId).emit("call:action", {
      action: "hangup",
      from: "dashboard",
      contactId: skipped.id
    });
  }
  saveSoon();
  emitCampaignState(code);
  // Si había una llamada, esperamos su estado "ended/idle" antes de avanzar.
  if (!workerSocketId && ensureCampaign(session).status === "running") {
    fillAvailableCampaignWorkers(code);
  }
  return res.json({ ok: true, code, skipped, campaign: getCampaignSnapshot(session) });
});

app.post("/api/session/:code/campaign/result", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const contactId = String(req.body?.contactId || "").trim();
  const result = String(req.body?.result || "").trim();
  if (!code || !contactId || !result) {
    return res.status(400).json({ ok: false, error: "code, contactId y result son requeridos" });
  }

  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  const targetBeforeUpdate = ensureCampaign(session).contacts.find((contact) => contact.id === contactId);
  const hangupWorkerSocketId = getConnectedPhoneWorkers(session)
    .find((worker) => worker.id === targetBeforeUpdate?.assignedWorkerId)?.socketId;
  const updated = markContactResult(session, contactId, result, {
    callbackReason: req.body?.callbackReason,
    assignedAdvisor: req.body?.assignedAdvisor,
    transcriptSummary: req.body?.transcriptSummary
  });
  if (!updated) return res.status(404).json({ ok: false, error: "Contacto no encontrado" });

  if (hangupWorkerSocketId && ["agendado", "no_interesado", "requiere_asesor", "sin_respuesta"].includes(updated.result)) {
    io.to(hangupWorkerSocketId).emit("call:action", { action: "hangup", from: "dashboard", contactId });
  }

  saveSoon();
  emitCampaignState(code);
  // El comando hangup termina de forma asíncrona. La siguiente llamada se
  // despacha desde phone:status cuando el dispositivo confirma ended/idle.
  if (!hangupWorkerSocketId && ensureCampaign(session).status === "running") {
    fillAvailableCampaignWorkers(code);
  }
  return res.json({ ok: true, code, contact: updated, campaign: getCampaignSnapshot(session) });
});

app.post("/api/session/:code/campaign/callback", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const contactId = String(req.body?.contactId || "").trim();
  if (!code || !contactId) {
    return res.status(400).json({ ok: false, error: "code y contactId son requeridos" });
  }

  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  const contact = markContactResult(session, contactId, "requiere_asesor", {
    callbackReason: req.body?.callbackReason,
    assignedAdvisor: req.body?.assignedAdvisor,
    transcriptSummary: req.body?.transcriptSummary
  });
  if (!contact) return res.status(404).json({ ok: false, error: "Contacto no encontrado" });

  saveSoon();
  emitCampaignState(code);
  if (ensureCampaign(session).status === "running") fillAvailableCampaignWorkers(code);
  return res.json({ ok: true, code, contact, campaign: getCampaignSnapshot(session) });
});

app.get("/api/pairing-qr/:code.svg", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).send("Code requerido");

  const session = getOrCreateSession(code);
  const slotId = String(req.query.slotId || "").trim();
  const slot = (session.pairingSlots || []).find((item) => item.id === slotId) || ensureLegacyPairingSlot(session);
  const link = getPairingLink(req, code, slot.token);

  try {
    const svg = await QRCode.toString(link, {
      type: "svg",
      errorCorrectionLevel: "L",
      margin: 1,
      width: 320
    });

    res.setHeader("Content-Type", "image/svg+xml");
    return res.send(svg);
  } catch {
    return res.status(500).send("No se pudo generar QR");
  }
});

app.get("/api/server-info", (req, res) => {
  const requestBase = getRequestBaseUrl(req);
  const androidApiBase = getAndroidApiBaseUrl(req);
  const webBase = getWebBaseUrl(req);
  const requestHost = getHostName(requestBase);
  const usingPublicBase = Boolean(pickConfiguredBase(req, "PUBLIC_BASE_URL"));
  const usingPublicWebBase = Boolean(pickConfiguredBase(req, "PUBLIC_WEB_BASE_URL"));
  const usingLocalLanBase = Boolean(parseEnvUrlCandidates(process.env.LOCAL_LAN_BASE_URL).length);

  return res.json({
    ok: true,
    requestBase,
    androidApiBase,
    webBase,
    isLocalhostRequest: isLoopbackHost(requestHost),
    usingPublicBase,
    usingPublicWebBase,
    usingLocalLanBase
  });
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
  const pairingSlot = getPairingSlotByToken(session, token);
  if (!pairingSlot) return res.status(401).json({ ok: false, error: "Token invalido" });
  if (pairingSlot.deviceId && pairingSlot.deviceId !== deviceId) {
    return res.status(409).json({ ok: false, error: "Este QR ya pertenece a otro dispositivo" });
  }
  pairingSlot.deviceId = deviceId;
  pairingSlot.deviceName = deviceName;
  pairingSlot.linkedAt ||= new Date().toISOString();

  upsertPhoneWorker(session, {
    socketId: null,
    deviceId,
    deviceName,
    pairingSlotId: pairingSlot.id
  });
  syncSessionPhoneState(session);
  session.updatedAt = Date.now();
  saveSoon();
  emitState(code);

  const baseUrl = getAndroidApiBaseUrl(req);
  return res.json({
    ok: true,
    code,
    workers: (session.phoneWorkers || []).map((worker) => ({
      id: worker.id,
      name: worker.name,
      linkedAt: worker.linkedAt,
      connected: Boolean(worker.connected && worker.socketId)
    })),
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
      headers: { "User-Agent": "Mozilla/5.0 (compatible; VOIP VC/1.0)" },
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) return res.status(502).json({ ok: false, error: `HTTP ${r.status} al obtener la URL` });
    const html = await r.text();
    return res.json({ ok: true, html });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/twilio/status", async (req, res) => {
  return res.status(501).json({
    ok: false,
    error: "Twilio deshabilitado en este despliegue."
  });
});

app.post("/api/twilio/configure", async (req, res) => {
  return res.status(501).json({
    ok: false,
    error: "Twilio deshabilitado en este despliegue."
  });
});

app.post("/api/twilio/webhook/voice", express.urlencoded({ extended: false }), (req, res) => {
  return res.status(501).type("text/plain").send("Twilio deshabilitado en este despliegue.");
});

app.use(express.static(path.join(__dirname, "../web")));
app.get("/health", (_, res) => res.json({ ok: true }));

bootstrap().catch(err => {
  console.error("Fallo critico al iniciar el servidor:", err);
  process.exit(1);
});
