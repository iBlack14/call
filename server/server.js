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
  buildStatusSignature,
  createPhoneWorker,
  isActiveCallState,
  isAllowedCampaignTransition,
  isCampaignStatusCorrelated,
  isTerminalCallState,
  normalizePhoneNumber
} from "./phone-worker.js";
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
const sessionFilePath = process.env.SESSION_FILE_PATH
  || (process.env.NODE_ENV === "production"
    ? "/data/sessions.json"
    : path.join(__dirname, "sessions.json"));
const persistence = new SessionPersistence(sessionFilePath);
function positiveDuration(value, fallback, minimum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(minimum, parsed) : fallback;
}
const CAMPAIGN_DISCONNECT_GRACE_MS = positiveDuration(
  process.env.CAMPAIGN_DISCONNECT_GRACE_MS,
  15_000,
  5_000
);
const CAMPAIGN_COMMAND_TIMEOUT_MS = positiveDuration(
  process.env.CAMPAIGN_COMMAND_TIMEOUT_MS,
  30_000,
  10_000
);
const CAMPAIGN_HANGUP_TIMEOUT_MS = positiveDuration(
  process.env.CAMPAIGN_HANGUP_TIMEOUT_MS,
  10_000,
  3_000
);
const workerDisconnectTimers = new Map();
const campaignCommandTimers = new Map();
const campaignHangupTimers = new Map();

const app = express();
app.set("trust proxy", true);
const server = http.createServer(app);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "https://llamada.viacomunicativa.com,https://lm.viacomunicativa.com,http://localhost:3000";
const corsOptions = {
  origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",").map(s => s.trim()).filter(Boolean),
  methods: ["GET", "POST", "PUT", "OPTIONS"],
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


app.use(express.json({
  limit: process.env.MAX_JSON_SIZE || "5mb"
}));

let sessions = new Map();
const normalizedSessions = new WeakSet();

async function bootstrap() {
  sessions = await persistence.load();
  // Post-load cleanup to avoid stuck campaigns
  for (const [code, loadedSession] of sessions.entries()) {
    const session = normalizeSessionShape(loadedSession);
    sessions.set(code, session);
    if (session.campaign) {
        const campaign = ensureCampaign(session);
        const assignedContactIds = new Set(
          (session.phoneWorkers || []).map((worker) => worker.campaignContactId).filter(Boolean)
        );
        for (const contact of campaign.contacts) {
          if (["dialing", "ringing", "in_call"].includes(contact.status) && !assignedContactIds.has(contact.id)) {
            contact.status = "pending";
            contact.assignedWorkerId = null;
          }
        }
        const active = getActiveContact(session);
        if (active) {
            session.campaign.activeContactId = active.id;
        } else if (session.campaign.status === "running") {
            session.campaign.activeContactId = null;
        }
        for (const worker of session.phoneWorkers || []) {
          if (worker.campaignContactId) scheduleWorkerDisconnectGrace(code, worker);
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
  return persistence.save(sessions);
}

function normalizeSessionShape(session = {}) {
  if (session && typeof session === "object" && normalizedSessions.has(session)) return session;
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

  if (!Array.isArray(normalized.pairingSlots)) normalized.pairingSlots = [];
  if (!Array.isArray(normalized.phoneWorkers)) normalized.phoneWorkers = [];
  const persistedWorkers = normalized.phoneWorkers;
  const workerIdTargets = new Map();
  normalized.phoneWorkers = persistedWorkers.map((worker) => {
    const slot = normalized.pairingSlots.find((item) => item.id === worker?.pairingSlotId);
    const legacyId = String(worker?.id || "").trim();
    const restored = createPhoneWorker({
      ...worker,
      deviceId: legacyId && legacyId !== "android-worker" ? legacyId : (slot?.deviceId || legacyId),
      deviceName: String(worker?.name || "").trim() !== "Android bridge"
        ? worker.name
        : (slot?.deviceName || worker?.name)
    });
    if (legacyId && restored.id !== legacyId) {
      const targets = workerIdTargets.get(legacyId) || new Set();
      targets.add(restored.id);
      workerIdTargets.set(legacyId, targets);
    }
    if (worker?.campaignContactId && Array.isArray(normalized.campaign?.contacts)) {
      const bound = normalized.campaign.contacts.find((contact) => contact.id === worker.campaignContactId);
      if (bound) bound.assignedWorkerId = restored.id;
      if (normalized.campaign.activeContactId === worker.campaignContactId) {
        normalized.campaign.activeWorkerId = restored.id;
      }
    }
    return restored;
  });
  if (Array.isArray(normalized.campaign?.contacts)) {
    for (const [oldId, targets] of workerIdTargets.entries()) {
      if (targets.size !== 1) continue;
      const [newId] = targets;
      for (const contact of normalized.campaign.contacts) {
        if (contact.assignedWorkerId === oldId) contact.assignedWorkerId = newId;
      }
      if (normalized.campaign.activeWorkerId === oldId) normalized.campaign.activeWorkerId = newId;
    }
  }
  // Keep a single row per pairing slot/device when loading snapshots produced
  // by the legacy normalizer.
  normalized.phoneWorkers = normalized.phoneWorkers.filter((worker, index, all) => {
    const key = worker.pairingSlotId || (worker.id !== "android-worker" ? worker.id : "");
    if (!key) return true;
    const matches = all
      .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
      .filter(({ candidate }) =>
      (candidate.pairingSlotId || (candidate.id !== "android-worker" ? candidate.id : "")) === key
      );
    const preferred = matches.find(({ candidate }) => candidate.campaignContactId)
      || matches.find(({ candidate }) => candidate.physicalStateUnconfirmed)
      || matches.find(({ candidate }) => candidate.manualCommandId)
      || matches[0];
    if (preferred?.candidateIndex !== index) return false;
    for (const { candidate } of matches) {
      if (candidate === worker) continue;
      worker.campaignContactId ||= candidate.campaignContactId || null;
      worker.campaignCommandId ||= candidate.campaignCommandId || null;
      worker.manualCommandId ||= candidate.manualCommandId || null;
      worker.manualContactId ||= candidate.manualContactId || null;
      if (worker.manualCallPhase === "idle" && candidate.manualCallPhase !== "idle") {
        worker.manualCallPhase = candidate.manualCallPhase;
      }
      worker.hangupUnconfirmed ||= Boolean(candidate.hangupUnconfirmed);
      worker.manualHangupUnconfirmed ||= Boolean(candidate.manualHangupUnconfirmed);
      worker.physicalStateUnconfirmed ||= Boolean(candidate.physicalStateUnconfirmed);
      worker.quarantineKind ||= candidate.quarantineKind || "";
      worker.quarantineContactId ||= candidate.quarantineContactId || "";
      worker.quarantinePhoneNumber ||= candidate.quarantinePhoneNumber || "";
      worker.quarantineReason ||= candidate.quarantineReason || "";
    }
    if (worker.physicalStateUnconfirmed && worker.connected) worker.callState = "blocked";
    return true;
  });

  if (!normalized.phoneWorkers.length && normalized.phoneDevice) {
    normalized.phoneWorkers.push(createPhoneWorker({
      deviceId: normalized.phoneDevice.id,
      deviceName: normalized.phoneDevice.name,
      linkedAt: normalized.phoneDevice.linkedAt,
      connected: Boolean(normalized.phoneSocketId),
      socketId: normalized.phoneSocketId || null
    }));
  }

  normalizedSessions.add(normalized);
  return normalized;
}

function getConnectedPhoneWorkers(session) {
  return (session.phoneWorkers || []).filter((worker) => worker.connected && worker.socketId);
}

function getPhoneWorkerBySocketId(session, socketId) {
  return (session.phoneWorkers || []).find((worker) => worker.socketId === socketId) || null;
}

function getWorkerLabel(session, worker) {
  if (!worker) return "sin dispositivo";
  const slot = (session?.pairingSlots || []).find((item) => item.id === worker.pairingSlotId);
  const slotLabel = String(slot?.label || "").trim();
  const deviceName = String(worker.name || worker.id || "Android bridge").trim();
  return slotLabel ? `${slotLabel} (${deviceName})` : deviceName;
}

function campaignLog(code, event, details = {}) {
  const fields = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  console.log(`[CAMPAIGN][${new Date().toISOString()}][${code}][${event}]${fields ? ` ${fields}` : ""}`);
}

function workerTimerKey(code, workerId) {
  return `${code}:${workerId}`;
}

function clearWorkerDisconnectTimer(code, workerId) {
  const key = workerTimerKey(code, workerId);
  const timer = workerDisconnectTimers.get(key);
  if (timer) clearTimeout(timer);
  workerDisconnectTimers.delete(key);
}

function clearCampaignCommandTimer(code, workerId) {
  const key = workerTimerKey(code, workerId);
  const timer = campaignCommandTimers.get(key);
  if (timer) clearTimeout(timer);
  campaignCommandTimers.delete(key);
}

function clearCampaignHangupTimer(code, workerId, expectedCommandId = "") {
  const key = workerTimerKey(code, workerId);
  const entry = campaignHangupTimers.get(key);
  if (!entry || (expectedCommandId && entry.commandId !== expectedCommandId)) return null;
  clearTimeout(entry.timer);
  campaignHangupTimers.delete(key);
  return entry;
}

function markPhysicalStateUnconfirmed(worker, details = {}) {
  if (!worker) return;
  worker.physicalStateUnconfirmed = true;
  worker.quarantineKind = String(
    worker.quarantineKind || details.kind || (worker.campaignContactId ? "campaign" : "manual")
  );
  worker.quarantineContactId = String(
    details.contactId || worker.quarantineContactId || worker.campaignContactId || worker.manualContactId || ""
  );
  worker.quarantinePhoneNumber = String(
    details.phoneNumber || worker.quarantinePhoneNumber || worker.currentNumber || ""
  );
  worker.quarantineReason = String(
    details.reason || worker.quarantineReason || worker.lastError ||
    "No se pudo verificar si la llamada terminó físicamente"
  );
}

function clearPhysicalStateQuarantine(worker) {
  if (!worker) return;
  worker.physicalStateUnconfirmed = false;
  worker.quarantineKind = "";
  worker.quarantineContactId = "";
  worker.quarantinePhoneNumber = "";
  worker.quarantineReason = "";
}

function releaseCampaignWorker(worker, finalState = "idle") {
  if (!worker) return;
  if (["blocked", "unresponsive"].includes(finalState)) {
    markPhysicalStateUnconfirmed(worker, { kind: "campaign" });
  } else {
    clearPhysicalStateQuarantine(worker);
  }
  worker.callState = finalState;
  worker.currentNumber = "";
  worker.currentContactName = "";
  worker.currentCompanyName = "";
  worker.campaignContactId = null;
  worker.campaignCommandId = null;
  worker.campaignCallPhase = "idle";
  worker.campaignLastState = finalState;
  worker.hangupUnconfirmed = false;
}

function releaseManualWorker(worker, finalState = "idle") {
  if (!worker) return;
  if (["blocked", "unresponsive"].includes(finalState)) {
    markPhysicalStateUnconfirmed(worker, { kind: "manual" });
  } else {
    clearPhysicalStateQuarantine(worker);
  }
  worker.callState = finalState;
  worker.currentNumber = "";
  worker.currentContactName = "";
  worker.currentCompanyName = "";
  worker.manualCommandId = null;
  worker.manualContactId = null;
  worker.manualCallPhase = "idle";
  worker.manualLastState = finalState;
  worker.pendingManualHangupCommandId = null;
  worker.manualHangupUnconfirmed = false;
}

function failAssignedCampaignContact(code, worker, reason, eventName, workerFinalState = "") {
  const session = sessions.get(code);
  if (!session || !worker?.campaignContactId) return false;
  const contactId = worker.campaignContactId;
  const commandId = worker.campaignCommandId;
  const contact = ensureCampaign(session).contacts.find((item) => item.id === contactId);
  const contactWasActive = ["dialing", "ringing", "in_call"].includes(contact?.status);
  updateActiveCallState(session, "failed", worker);
  if (
    contact &&
    contactWasActive &&
    !contact.callbackReason
  ) contact.callbackReason = reason;
  campaignLog(code, eventName, {
    contacto: contact?.name,
    numero: contact?.phone || worker.currentNumber,
    dispositivo: getWorkerLabel(session, worker),
    contactoId: contactId,
    commandId,
    motivo: reason
  });
  clearCampaignCommandTimer(code, worker.id);
  worker.lastError = reason;
  const finalState = workerFinalState || (worker.connected ? "failed" : "offline");
  releaseCampaignWorker(worker, finalState);
  session.callState = ["blocked", "unresponsive"].includes(finalState) ? finalState : "failed";
  session.updatedAt = Date.now();
  saveSoon();
  emitState(code);
  emitCampaignState(code);
  if (ensureCampaign(session).status === "running") fillAvailableCampaignWorkers(code);
  return true;
}

function settleUnconfirmedCampaignHangup(
  code,
  worker,
  { contactId, dialCommandId, hangupCommandId, retryDeferred = false, reason, eventName }
) {
  const session = sessions.get(code);
  if (
    !session ||
    !worker ||
    worker.campaignContactId !== contactId ||
    worker.campaignCommandId !== dialCommandId
  ) return false;

  clearCampaignHangupTimer(code, worker.id, hangupCommandId);
  clearCampaignCommandTimer(code, worker.id);
  clearWorkerDisconnectTimer(code, worker.id);

  const campaign = ensureCampaign(session);
  const contact = campaign.contacts.find((item) => item.id === contactId);
  if (contact) {
    if (retryDeferred) {
      // A failed/unknown hangup must not immediately redial the same person
      // from another phone while the original physical call may still exist.
      contact.result = "reintentar";
      contact.status = "failed";
      contact.completedAt = new Date().toISOString();
    }
    if (retryDeferred || !["dialing", "ringing", "in_call"].includes(contact.status)) {
      contact.assignedWorkerId = null;
    }
    contact.lastCallState = "hangup_unconfirmed";
  }

  const remaining = getActiveContacts(session);
  campaign.activeContactId = remaining[0]?.id || null;
  campaign.activeWorkerId = remaining[0]?.assignedWorkerId || null;
  campaign.activeWorkerSocketId = null;
  campaign.updatedAt = Date.now();

  worker.lastError = reason;
  worker.callState = worker.connected ? "blocked" : "offline";
  worker.campaignLastState = worker.callState;
  worker.hangupUnconfirmed = true;
  markPhysicalStateUnconfirmed(worker, {
    kind: "campaign",
    contactId,
    phoneNumber: contact?.phone,
    reason
  });
  campaignLog(code, eventName, {
    contacto: contact?.name,
    numero: contact?.phone,
    dispositivo: getWorkerLabel(session, worker),
    contactoId: contactId,
    commandId: hangupCommandId,
    motivo: reason
  });

  session.updatedAt = Date.now();
  syncSessionPhoneState(session);
  if (!worker.connected) scheduleWorkerDisconnectGrace(code, worker);
  saveSoon();
  emitState(code);
  emitCampaignState(code);
  if (campaign.status === "running") fillAvailableCampaignWorkers(code);
  return true;
}

function requestCampaignHangup(code, worker, contactId, { retryDeferred = false, commandId = "" } = {}) {
  if (!worker?.id || !worker.campaignCommandId || !contactId) return null;

  const dialCommandId = worker.campaignCommandId;
  const hangupCommandId = commandId || nanoid();
  worker.hangupUnconfirmed = false;
  clearCampaignHangupTimer(code, worker.id);
  const delivered = emitToPhoneWorker(worker, "call:action", {
    action: "hangup",
    from: "dashboard",
    commandId: hangupCommandId,
    contactId
  });
  campaignLog(code, delivered ? "CORTE_ENVIADO" : "CORTE_NO_ENTREGADO", {
    dispositivo: worker.name || worker.id,
    contactoId: contactId,
    commandId: hangupCommandId
  });

  const context = {
    contactId,
    dialCommandId,
    hangupCommandId,
    retryDeferred
  };
  if (!delivered) {
    const dashboardSocketId = sessions.get(code)?.dashboardSocketId;
    if (dashboardSocketId) {
      emitCommandFailure(io.to(dashboardSocketId), {
        commandId: hangupCommandId,
        action: "hangup",
        message: "El socket del dispositivo no recibió la orden de corte"
      });
    }
    settleUnconfirmedCampaignHangup(code, worker, {
      ...context,
      reason: "El socket del dispositivo no recibió la orden de corte",
      eventName: "CORTE_NO_CONFIRMADO"
    });
    return { delivered: false, commandId: hangupCommandId };
  }

  const key = workerTimerKey(code, worker.id);
  const timer = setTimeout(() => {
    const entry = campaignHangupTimers.get(key);
    if (!entry || entry.commandId !== hangupCommandId) return;
    campaignHangupTimers.delete(key);
    const session = sessions.get(code);
    const current = session?.phoneWorkers?.find((item) => item.id === worker.id);
    settleUnconfirmedCampaignHangup(code, current, {
      ...context,
      reason: `La APK no confirmó el corte en ${Math.round(CAMPAIGN_HANGUP_TIMEOUT_MS / 1000)} segundos`,
      eventName: "CORTE_EXPIRADO"
    });
  }, CAMPAIGN_HANGUP_TIMEOUT_MS);
  timer.unref?.();
  campaignHangupTimers.set(key, {
    timer,
    commandId: hangupCommandId,
    contactId,
    dialCommandId,
    retryDeferred
  });
  return { delivered: true, commandId: hangupCommandId };
}

function settlePendingCampaignHangupOnDisconnect(code, worker) {
  if (!worker?.id) return false;
  const pending = clearCampaignHangupTimer(code, worker.id);
  if (!pending) return false;
  if (pending.manual && worker.manualCommandId === pending.dialCommandId) {
    const session = sessions.get(code);
    worker.callState = "offline";
    worker.manualLastState = "offline";
    worker.manualHangupUnconfirmed = true;
    worker.lastError = "El socket se desconectó antes de confirmar el corte manual";
    markPhysicalStateUnconfirmed(worker, {
      kind: "manual",
      reason: worker.lastError
    });
    if (session) {
      session.updatedAt = Date.now();
      saveSoon();
      emitState(code);
    }
    return true;
  }
  if (!pending.contactId) return false;
  return settleUnconfirmedCampaignHangup(code, worker, {
    contactId: pending.contactId,
    dialCommandId: pending.dialCommandId,
    hangupCommandId: pending.commandId,
    retryDeferred: pending.retryDeferred,
    reason: "El socket se desconectó antes de confirmar el corte",
    eventName: "CORTE_INTERRUMPIDO_POR_DESCONEXION"
  });
}

function scheduleManualHangupTimeout(code, worker, hangupCommandId) {
  if (!worker?.id || !worker.manualCommandId || !hangupCommandId) return;
  clearCampaignHangupTimer(code, worker.id);
  const key = workerTimerKey(code, worker.id);
  const expectedDialCommandId = worker.manualCommandId;
  const timer = setTimeout(() => {
    const entry = campaignHangupTimers.get(key);
    if (!entry || entry.commandId !== hangupCommandId) return;
    campaignHangupTimers.delete(key);
    const session = sessions.get(code);
    const current = session?.phoneWorkers?.find((item) => item.id === worker.id);
    if (
      !current ||
      current.manualCommandId !== expectedDialCommandId ||
      current.pendingManualHangupCommandId !== hangupCommandId
    ) return;
    current.callState = "blocked";
    current.lastError = `La APK no confirmó el corte en ${Math.round(CAMPAIGN_HANGUP_TIMEOUT_MS / 1000)} segundos`;
    current.manualLastState = "blocked";
    current.manualHangupUnconfirmed = true;
    markPhysicalStateUnconfirmed(current, {
      kind: "manual",
      reason: current.lastError
    });
    session.updatedAt = Date.now();
    saveSoon();
    emitState(code);
  }, CAMPAIGN_HANGUP_TIMEOUT_MS);
  timer.unref?.();
  campaignHangupTimers.set(key, {
    timer,
    commandId: hangupCommandId,
    dialCommandId: expectedDialCommandId,
    manual: true
  });
}

function scheduleCampaignCommandTimeout(code, worker, commandId) {
  if (!worker?.id || !commandId) return;
  clearCampaignCommandTimer(code, worker.id);
  const key = workerTimerKey(code, worker.id);
  const timer = setTimeout(() => {
    campaignCommandTimers.delete(key);
    const session = sessions.get(code);
    const current = session?.phoneWorkers?.find((item) => item.id === worker.id);
    if (
      !current ||
      current.campaignCommandId !== commandId ||
      current.campaignCallPhase !== "command_sent"
    ) return;
    failAssignedCampaignContact(
      code,
      current,
      "La APK no confirmó el inicio de la llamada dentro del tiempo límite",
      "ORDEN_EXPIRADA",
      "unresponsive"
    );
  }, CAMPAIGN_COMMAND_TIMEOUT_MS);
  timer.unref?.();
  campaignCommandTimers.set(key, timer);
}

function scheduleWorkerDisconnectGrace(code, worker, { allowConnected = false } = {}) {
  if (!worker?.id || !worker.campaignContactId) return;
  clearWorkerDisconnectTimer(code, worker.id);
  const key = workerTimerKey(code, worker.id);
  const expectedContactId = worker.campaignContactId;
  const timer = setTimeout(() => {
    workerDisconnectTimers.delete(key);
    const session = sessions.get(code);
    const current = session?.phoneWorkers?.find((item) => item.id === worker.id);
    if (
      !current ||
      (!allowConnected && current.connected) ||
      current.campaignContactId !== expectedContactId
    ) return;
    if (allowConnected && current.connected) {
      current.callState = "blocked";
      current.campaignLastState = "blocked";
      current.lastError = "El teléfono reconectó, pero no resincronizó la llamada física";
      markPhysicalStateUnconfirmed(current, {
        kind: "campaign",
        reason: current.lastError
      });
      campaignLog(code, "RESINCRONIZACION_EXPIRADA", {
        dispositivo: current.name || current.id,
        contactoId: current.campaignContactId,
        commandId: current.campaignCommandId
      });
      saveSoon();
      emitState(code);
      emitCampaignState(code);
      if (ensureCampaign(session).status === "running") fillAvailableCampaignWorkers(code);
      return;
    }
    if (current.hangupUnconfirmed) {
      current.callState = current.connected ? "blocked" : "offline";
      current.campaignLastState = current.callState;
      campaignLog(code, "CORTE_EN_CUARENTENA", {
        dispositivo: current.name || current.id,
        contactoId: current.campaignContactId,
        commandId: current.campaignCommandId,
        motivo: "Se conserva la correlación hasta que el teléfono confirme el estado físico"
      });
      saveSoon();
      emitState(code);
      emitCampaignState(code);
      if (ensureCampaign(session).status === "running") fillAvailableCampaignWorkers(code);
      return;
    }
    failAssignedCampaignContact(
      code,
      current,
      `El dispositivo no se reconectó en ${Math.round(CAMPAIGN_DISCONNECT_GRACE_MS / 1000)} segundos`,
      "DESCONEXION_CONFIRMADA",
      "unresponsive"
    );
  }, CAMPAIGN_DISCONNECT_GRACE_MS);
  timer.unref?.();
  workerDisconnectTimers.set(key, timer);
}

function emitToPhoneWorker(worker, eventName, payload) {
  if (!worker?.socketId) return false;
  const targetSocket = io.sockets.sockets.get(worker.socketId);
  if (!targetSocket || targetSocket.data.role !== "phone") return false;
  targetSocket.emit(eventName, payload);
  return true;
}

function emitCommandFailure(target, { commandId = "", action = "", message = "" } = {}) {
  target?.emit("phone:command_ack", {
    commandId,
    action,
    ok: false,
    message,
    at: new Date().toISOString()
  });
}

function remapCampaignWorkerId(session, oldId, newId, boundContactId = "") {
  if (!session?.campaign || !oldId || !newId || oldId === newId) return;
  const campaign = ensureCampaign(session);
  for (const contact of campaign.contacts) {
    if (
      (boundContactId && contact.id === boundContactId) ||
      (!boundContactId && contact.assignedWorkerId === oldId)
    ) contact.assignedWorkerId = newId;
  }
  if (
    campaign.activeWorkerId === oldId ||
    (boundContactId && campaign.activeContactId === boundContactId)
  ) campaign.activeWorkerId = newId;
}

function upsertPhoneWorker(session, { socketId, deviceId, deviceName, pairingSlotId = "" }) {
  const workers = session.phoneWorkers || (session.phoneWorkers = []);
  // A pairing slot represents one physical phone. Matching it also repairs
  // legacy entries whose persisted `id` was accidentally restored as
  // "android-worker".
  const matchingIndexes = workers
    .map((worker, index) => ({ worker, index }))
    .filter(({ worker }) =>
      (deviceId && worker.id === deviceId) ||
      (pairingSlotId && worker.pairingSlotId === pairingSlotId) ||
      (socketId && worker.socketId === socketId)
    );
  const preferred = matchingIndexes.find(({ worker }) => worker.campaignContactId)
    || matchingIndexes.find(({ worker }) => deviceId && worker.id === deviceId)
    || matchingIndexes[0];
  const existingIndex = preferred?.index ?? -1;
  
  if (existingIndex !== -1) {
    const existing = workers[existingIndex];
    const wasDisconnected = !existing.connected || !existing.socketId;
    const previousWorkerId = existing.id;
    existing.socketId = socketId;
    existing.id = deviceId || existing.id;
    remapCampaignWorkerId(session, previousWorkerId, existing.id, existing.campaignContactId || "");
    existing.name = deviceName || existing.name;
    existing.pairingSlotId = pairingSlotId || existing.pairingSlotId || "";
    existing.connected = Boolean(socketId);
    existing.linkedAt = existing.linkedAt || new Date().toISOString();
    existing.callState = existing.physicalStateUnconfirmed
      ? "blocked"
      : existing.campaignContactId
        ? (existing.campaignLastState && existing.campaignLastState !== "offline" ? existing.campaignLastState : "dialing")
        : existing.manualCommandId
          ? (existing.manualLastState && existing.manualLastState !== "offline" ? existing.manualLastState : "dialing")
          : (wasDisconnected ? "idle" : (existing.callState || "idle"));
    existing.disconnectedAt = null;

    // Merge and remove duplicate rows created by the old persistence bug.
    for (const { worker: duplicate, index } of [...matchingIndexes].sort((a, b) => b.index - a.index)) {
      if (index === existingIndex) continue;
      remapCampaignWorkerId(session, duplicate.id, existing.id, duplicate.campaignContactId || "");
      existing.campaignContactId ||= duplicate.campaignContactId || null;
      existing.campaignCommandId ||= duplicate.campaignCommandId || null;
      existing.manualCommandId ||= duplicate.manualCommandId || null;
      existing.manualContactId ||= duplicate.manualContactId || null;
      if (existing.manualCallPhase === "idle" && duplicate.manualCallPhase !== "idle") {
        existing.manualCallPhase = duplicate.manualCallPhase;
      }
      existing.hangupUnconfirmed ||= Boolean(duplicate.hangupUnconfirmed);
      existing.manualHangupUnconfirmed ||= Boolean(duplicate.manualHangupUnconfirmed);
      existing.physicalStateUnconfirmed ||= Boolean(duplicate.physicalStateUnconfirmed);
      existing.quarantineKind ||= duplicate.quarantineKind || "";
      existing.quarantineContactId ||= duplicate.quarantineContactId || "";
      existing.quarantinePhoneNumber ||= duplicate.quarantinePhoneNumber || "";
      existing.quarantineReason ||= duplicate.quarantineReason || "";
      if (existing.campaignCallPhase === "idle" && duplicate.campaignCallPhase !== "idle") {
        existing.campaignCallPhase = duplicate.campaignCallPhase;
      }
      workers.splice(index, 1);
    }
    if (existing.physicalStateUnconfirmed) existing.callState = "blocked";
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
  worker.campaignLastState = worker.callState || worker.campaignLastState || "idle";
  worker.manualLastState = worker.callState || worker.manualLastState || "idle";
  worker.socketId = null;
  worker.connected = false;
  worker.callState = "offline";
  worker.disconnectedAt = new Date().toISOString();
  return worker;
}

function isWorkerCallBusy(worker) {
  return Boolean(
    worker?.campaignContactId ||
    worker?.manualCommandId ||
    worker?.physicalStateUnconfirmed ||
    ["dialing", "ringing", "in_call", "blocked", "unresponsive"].includes(worker?.callState)
  );
}

function selectPhoneWorker(session, preferredSocketId = "") {
  const workers = getConnectedPhoneWorkers(session);
  if (!workers.length) return null;
  // Audio and dashboard controls currently represent one selected call. Keep
  // one physical call per session so frames/actions can never cross customers.
  if ((session.phoneWorkers || []).some(isWorkerCallBusy)) return null;
  const isAvailable = (worker) =>
    ["idle", "ended", "failed"].includes(worker.callState || "idle")
    && !worker.campaignContactId
    && !worker.manualCommandId
    && ["idle", "ended", "failed"].includes(worker.campaignCallPhase || "idle");

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
  return workers.find((worker) => worker.campaignContactId || worker.manualCommandId)
    || workers.find(isWorkerCallBusy)
    || workers.find((worker) => worker.socketId === session.activePhoneSocketId)
    || workers.find((worker) => worker.socketId === session.phoneSocketId)
    || workers[0]
    || null;
}

function getAuthoritativeCallOwner(session) {
  const workers = session.phoneWorkers || [];
  const activeWorkerId = session.campaign?.activeWorkerId || "";
  const activeContactId = session.campaign?.activeContactId || "";
  return workers.find((worker) =>
    (activeWorkerId && worker.id === activeWorkerId) ||
    (activeContactId && worker.campaignContactId === activeContactId)
  )
    || workers.find((worker) => worker.campaignContactId)
    || workers.find((worker) => worker.manualCommandId)
    || workers.find(isWorkerCallBusy)
    || getActivePhoneWorker(session);
}

function resolvePhoneWorkerForAction(session, contactId = "") {
  const connected = getConnectedPhoneWorkers(session);
  if (contactId) {
    const exact = (session.phoneWorkers || []).find((worker) =>
      worker.campaignContactId === contactId ||
      worker.manualContactId === contactId ||
      worker.quarantineContactId === contactId
    ) || null;
    return {
      worker: !exact?.physicalStateUnconfirmed && exact?.connected && exact.socketId ? exact : null,
      ambiguous: false,
      disconnected: Boolean(exact && (!exact.connected || !exact.socketId)),
      quarantined: Boolean(exact?.physicalStateUnconfirmed)
    };
  }
  const authoritative = getAuthoritativeCallOwner(session);
  if (authoritative && isWorkerCallBusy(authoritative)) {
    return {
      worker: !authoritative.physicalStateUnconfirmed && authoritative.connected && authoritative.socketId
        ? authoritative
        : null,
      ambiguous: false,
      disconnected: !authoritative.connected || !authoritative.socketId,
      quarantined: Boolean(authoritative.physicalStateUnconfirmed)
    };
  }
  const tracked = connected.filter((worker) => worker.campaignContactId || worker.manualCommandId);
  if (tracked.length > 1) {
    return { worker: null, ambiguous: true, disconnected: false, quarantined: false };
  }
  return {
    worker: tracked[0] || getActivePhoneWorker(session),
    ambiguous: false,
    disconnected: false,
    quarantined: false
  };
}

function syncSessionPhoneState(session) {
  const previousOwnerSocketId = session.activePhoneSocketId;
  const activeWorker = getAuthoritativeCallOwner(session);
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
  if (
    activeWorker?.socketId &&
    isWorkerCallBusy(activeWorker)
  ) {
    session.callState = activeWorker.callState || session.callState;
    if (activeWorker.socketId !== previousOwnerSocketId) {
      if (activeWorker.currentNumber) session.lastNumber = activeWorker.currentNumber;
      if (activeWorker.currentContactName) session.lastContactName = activeWorker.currentContactName;
      if (activeWorker.currentCompanyName) session.lastCompanyName = activeWorker.currentCompanyName;
    }
  }
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
    if (removed) settlePendingCampaignHangupOnDisconnect(previousCode, removed);
    if (previousSession.activePhoneSocketId === socket.id) {
      previousSession.activePhoneSocketId = null;
    }
    syncSessionPhoneState(previousSession);

    if (removed?.campaignContactId) {
      scheduleWorkerDisconnectGrace(previousCode, removed);
    }

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
    && !previousSession.dashboardData
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

  // Solo una llamada física por sesión: el audio y los controles del dashboard
  // pertenecen siempre a un único cliente, aunque haya teléfonos de respaldo.
  const worker = selectPhoneWorker(session);
  if (!worker) {
    const pending = campaign.contacts.filter((contact) => ["pending", "reintentar"].includes(contact.status)).length;
    if (pending) campaignLog(code, "ESPERA", {
      motivo: "sin dispositivo libre",
      pendientes: pending,
      conectados: getConnectedPhoneWorkers(session).length
    });
    emitCampaignState(code);
    return null;
  }
  const next = assignNextContact(session, worker || {});
  session.updatedAt = Date.now();
  saveSoon();

  if (!next) {
    if (campaign.status === "completed") campaignLog(code, "FINALIZADA", {
      total: campaign.contacts.length,
      completados: campaign.contacts.filter((contact) => contact.status === "completed").length,
      fallidos: campaign.contacts.filter((contact) => contact.status === "failed").length,
      callbacks: campaign.contacts.filter((contact) => contact.status === "awaiting_callback").length
    });
    emitCampaignState(code);
    return null;
  }

  session.callState = "dialing";
  session.lastNumber = next.phone;
  session.lastContactName = next.name;
  session.lastCompanyName = next.name;
  
  if (worker) {
    const commandId = nanoid();
    worker.callState = "dialing";
    worker.currentNumber = next.phone;
    worker.currentContactName = next.name || "";
    worker.currentCompanyName = next.name || "";
    worker.campaignContactId = next.id;
    worker.campaignCommandId = commandId;
    worker.campaignCallPhase = "command_sent";
    const workerLabel = getWorkerLabel(session, worker);
    campaignLog(code, "ASIGNADA", {
      contacto: next.name, numero: next.phone, dispositivo: workerLabel,
      intento: next.attempts, commandId
    });
    const delivered = emitToPhoneWorker(worker, "call:action", {
      action: "dial",
      phoneNumber: next.phone,
      contactId: next.id,
      companyName: next.name,
      contactName: next.name,
      commandId
    });
    campaignLog(code, delivered ? "ORDEN_ENVIADA" : "ORDEN_NO_ENTREGADA", {
      numero: next.phone, dispositivo: workerLabel, commandId
    });
    if (delivered) {
      scheduleCampaignCommandTimeout(code, worker, commandId);
    } else {
      worker.connected = false;
      worker.socketId = null;
      failAssignedCampaignContact(
        code,
        worker,
        "El socket del dispositivo no recibió la orden",
        "ENTREGA_FALLIDA"
      );
    }
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
  const session = sessions.get(code);
  if (!session || ensureCampaign(session).status !== "running") return [];

  const dispatched = [];
  const capacity = getConnectedPhoneWorkers(session).length ? 1 : 0;

  // Los demás dispositivos quedan listos como respaldo/failover.
  for (let index = 0; index < capacity; index += 1) {
    const next = dispatchNextCampaignCall(code);
    if (!next) break;
    dispatched.push(next);
  }

  return dispatched;
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
    pairingSlotId: worker.pairingSlotId || "",
    linkedAt: worker.linkedAt,
    connected: Boolean(worker.connected && worker.socketId),
    callState: worker.callState || "idle",
    currentNumber: worker.currentNumber || "",
    active: worker.socketId === session.activePhoneSocketId
  }));

  io.to(code).emit("state:changed", {
    connected: {
      dashboard: Boolean(session.dashboardSocketId),
      phone: phoneWorkers.some((worker) => worker.connected),
      phoneCount: phoneWorkers.filter((worker) => worker.connected).length,
      linking: Boolean(session.phoneDevice) && !phoneWorkers.some((worker) => worker.connected)
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


  socket.on("session:join", ({ code, role, token, deviceName, deviceId, protocolVersion }) => {
    if (!code || !role) return;

    if (role === "phone" && Number(protocolVersion || 0) < 2) {
      socket.emit("session:error", {
        message: "Esta APK es antigua. Instala la versión estable más reciente antes de vincularla."
      });
      return;
    }

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
        deviceId: deviceId || "android-phone",
        deviceName: deviceName || "Android bridge",
        pairingSlotId: pairingSlot?.id || ""
      });
      const resumedCampaignContactId = worker.campaignContactId;
      clearWorkerDisconnectTimer(normalizedCode, worker.id);
      if (resumedCampaignContactId) {
        scheduleWorkerDisconnectGrace(normalizedCode, worker, { allowConnected: true });
      }
      session.activePhoneSocketId ||= worker.socketId;
      syncSessionPhoneState(session);
      campaignLog(normalizedCode, "DISPOSITIVO_CONECTADO", {
        dispositivo: getWorkerLabel(session, worker), deviceId: worker.id,
        socketId: socket.id, conectados: getConnectedPhoneWorkers(session).length
      });
      if (resumedCampaignContactId) campaignLog(normalizedCode, "LLAMADA_RECUPERANDO", {
        dispositivo: getWorkerLabel(session, worker),
        contactoId: resumedCampaignContactId,
        commandId: worker.campaignCommandId
      });
      saveSoon();
    }

    session.updatedAt = Date.now();
    socket.emit("session:joined", { code: normalizedCode, role });
    emitState(normalizedCode);
    emitCampaignState(normalizedCode);

    // Un celular nuevo queda disponible como respaldo y toma la próxima llamada
    // solo cuando no existe otra llamada física en la sesión.
    if (role === "phone") {
      const campaign = ensureCampaign(session);
      if (campaign.status === "running") {
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
      const effectiveCommandId = commandId || nanoid();
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
        worker.currentContactName = contactName || "";
        worker.currentCompanyName = companyName || "";
        worker.manualCommandId = effectiveCommandId;
        worker.manualContactId = contactId || null;
        worker.manualCallPhase = "command_sent";
        worker.manualLastState = "dialing";
        worker.pendingManualHangupCommandId = null;
        worker.manualHangupUnconfirmed = false;
        console.log(`[MANUAL] Marcado directo a ${phoneNumber} vía worker ${worker.name}`);
        const delivered = emitToPhoneWorker(worker, "call:action", {
          action: "dial",
          phoneNumber: phoneNumber || "",
          companyName: companyName || "",
          contactName: contactName || "",
          imageUrl: imageUrl || "",
          contactId: contactId || "",
          commandId: effectiveCommandId
        });
        if (!delivered) {
          worker.connected = false;
          worker.socketId = null;
          releaseManualWorker(worker, "offline");
          session.callState = "failed";
          emitCommandFailure(socket, {
            commandId: effectiveCommandId,
            action: "dial",
            message: "El socket del dispositivo no recibió la orden de llamada"
          });
        }
        saveSoon();
        emitState(code);
      } else {
        console.log(`[MANUAL] Intento fallido para ${phoneNumber} (No hay worker activo)`);
        session.callState = "failed";
        emitCommandFailure(socket, {
          commandId: effectiveCommandId,
          action: "dial",
          message: "No hay un teléfono disponible para iniciar la llamada"
        });
        saveSoon();
        emitState(code);
      }
    }

    if (action === "hangup") {
      const { worker, ambiguous, disconnected, quarantined } = resolvePhoneWorkerForAction(session, contactId || "");
      if (!worker) {
        socket.emit("phone:command_ack", {
          commandId: commandId || "",
          action,
          ok: false,
          message: ambiguous
            ? "Hay varias llamadas activas; selecciona el contacto exacto"
            : quarantined
              ? "La llamada está en cuarentena; revisa el celular y usa la liberación de seguridad"
            : disconnected
              ? "El teléfono de esta llamada está desconectado; revisa el celular o usa la liberación de seguridad"
            : "No se encontró una llamada activa para cortar",
          at: new Date().toISOString()
        });
      }
      if (worker) {
        if (worker.campaignContactId && (!contactId || worker.campaignContactId === contactId)) {
          requestCampaignHangup(code, worker, worker.campaignContactId, { commandId });
        } else {
          const hangupCommandId = commandId || nanoid();
          worker.pendingManualHangupCommandId = hangupCommandId;
          const delivered = emitToPhoneWorker(worker, "call:action", {
            action: "hangup",
            from: "dashboard",
            commandId: hangupCommandId,
            contactId: contactId || worker.manualContactId || ""
          });
          if (delivered) scheduleManualHangupTimeout(code, worker, hangupCommandId);
          else {
            worker.callState = "blocked";
            worker.manualLastState = "blocked";
            worker.manualHangupUnconfirmed = true;
            worker.lastError = "El socket del dispositivo no recibió la orden de corte";
            markPhysicalStateUnconfirmed(worker, {
              kind: "manual",
              reason: worker.lastError
            });
            emitCommandFailure(socket, {
              commandId: hangupCommandId,
              action: "hangup",
              message: worker.lastError
            });
          }
        }
      }
      saveSoon();
    }

    if (action === "mute" || action === "unmute" || action === "speaker_on" || action === "speaker_off" || action === "answer") {
      const { worker, ambiguous, disconnected, quarantined } = resolvePhoneWorkerForAction(session, contactId || "");
      if (worker) {
        const delivered = emitToPhoneWorker(worker, "call:action", {
          action, 
          commandId,
          contactId 
        });
        if (!delivered) {
          emitCommandFailure(socket, {
            commandId: commandId || "",
            action,
            message: "El socket del teléfono no recibió la orden"
          });
        }
      } else {
        socket.emit("phone:command_ack", {
          commandId: commandId || "",
          action,
          ok: false,
          message: ambiguous
            ? "Hay varias llamadas activas; selecciona el contacto exacto"
            : quarantined
              ? "La llamada está en cuarentena; revisa el celular y usa la liberación de seguridad"
            : disconnected
              ? "El teléfono de esta llamada está desconectado; revisa el celular o usa la liberación de seguridad"
            : "No se encontró el teléfono de esta llamada",
          at: new Date().toISOString()
        });
      }
    }

    session.updatedAt = Date.now();
    emitState(code);
    emitCampaignState(code);
  });

  socket.on("phone:status", (payload = {}) => {
    const code = socket.data.code;
    const role = socket.data.role;
    if (!code || role !== "phone") return;

    const session = sessions.get(code);
    if (!session) return;

    const {
      callState,
      phoneNumber,
      contactName,
      companyName,
      micMuted,
      speakerOn,
      lineLabel,
      lastError,
      commandId,
      contactId,
      callDirection,
      source,
      physicalObserved,
      noLiveCalls
    } = payload;
    if (!isActiveCallState(callState) && !isTerminalCallState(callState)) return;

    const worker = getPhoneWorkerBySocketId(session, socket.id);
    if (!worker) return;

    const terminalState = isTerminalCallState(callState);
    const activeState = isActiveCallState(callState);
    const campaignPhaseBeforeStatus = worker?.campaignCallPhase || "idle";
    const previousCallState = worker?.callState || "idle";
    const campaignContactId = worker?.campaignContactId || "";
    const manualCommandId = worker?.manualCommandId || "";
    const manualContactId = worker?.manualContactId || "";
    const manualPhaseBeforeStatus = worker?.manualCallPhase || "idle";
    const campaignContact = campaignContactId
      ? ensureCampaign(session).contacts.find((contact) => contact.id === campaignContactId)
      : null;
    const exactOrphanedCampaignEvent = Boolean(
      campaignContactId &&
      !campaignContact &&
      commandId &&
      contactId &&
      commandId === worker.campaignCommandId &&
      contactId === campaignContactId &&
      String(callDirection || "").toLowerCase() !== "incoming"
    );
    const correlatedCampaignEvent = exactOrphanedCampaignEvent || isCampaignStatusCorrelated(worker, campaignContact, {
      commandId,
      contactId,
      phoneNumber,
      callDirection
    });
    const expectedManualNumber = normalizePhoneNumber(worker.currentNumber);
    const observedManualNumber = normalizePhoneNumber(phoneNumber);
    const hasReportedManualIds = Boolean(commandId || contactId);
    const manualIdsMatch = Boolean(
      commandId === manualCommandId &&
      (!manualContactId || contactId === manualContactId)
    );
    const legacyManualNumberMatch = Boolean(
      !hasReportedManualIds &&
      expectedManualNumber &&
      observedManualNumber &&
      expectedManualNumber === observedManualNumber
    );
    const correlatedManualEvent = Boolean(
      !campaignContactId &&
      manualCommandId &&
      String(callDirection || "").toLowerCase() !== "incoming" &&
      (manualIdsMatch || legacyManualNumberMatch) &&
      (!expectedManualNumber || !observedManualNumber || expectedManualNumber === observedManualNumber)
    );
    const reportedSource = String(source || "").trim();
    const confirmsPhysicalCall = physicalObserved === true ||
      !reportedSource ||
      ["telecom", "telephony_fallback", "user_action"].includes(reportedSource);
    const ignoredPrematureIdle = Boolean(
      callState === "idle" &&
      campaignPhaseBeforeStatus === "command_sent" &&
      correlatedCampaignEvent
    );
    const allowedCampaignTransition = Boolean(
      correlatedCampaignEvent &&
      campaignContact &&
      isAllowedCampaignTransition(campaignContact.status, callState) &&
      (!activeState || confirmsPhysicalCall || campaignPhaseBeforeStatus === "active")
    );
    const sameCampaignState = Boolean(campaignContact && campaignContact.status === callState);
    const confirmedCampaignActive = Boolean(
      activeState &&
      correlatedCampaignEvent &&
      campaignContact &&
      (allowedCampaignTransition || sameCampaignState) &&
      (confirmsPhysicalCall || campaignPhaseBeforeStatus === "active")
    );
    const confirmedCampaignEnd = Boolean(
      terminalState &&
      correlatedCampaignEvent &&
      !ignoredPrematureIdle &&
      (
        campaignPhaseBeforeStatus === "active" ||
        worker.hangupUnconfirmed ||
        ["ended", "failed"].includes(callState)
      )
    );
    const allowedManualTransition = Boolean(
      correlatedManualEvent &&
      isAllowedCampaignTransition(worker.manualLastState, callState) &&
      (!activeState || confirmsPhysicalCall)
    );
    const sameManualState = worker.manualLastState === callState;
    const confirmedManualActive = Boolean(
      activeState &&
      correlatedManualEvent &&
      (allowedManualTransition || sameManualState) &&
      confirmsPhysicalCall
    );
    const ignoredPrematureManualIdle = Boolean(
      callState === "idle" &&
      manualPhaseBeforeStatus === "command_sent" &&
      correlatedManualEvent &&
      noLiveCalls !== true
    );
    const confirmedManualEnd = Boolean(
      terminalState &&
      correlatedManualEvent &&
      !ignoredPrematureManualIdle &&
      (
        manualPhaseBeforeStatus === "active" ||
        worker.manualHangupUnconfirmed ||
        ["ringing", "in_call"].includes(worker.manualLastState) ||
        ["ended", "failed"].includes(callState) ||
        noLiveCalls === true
      )
    );
    const untrackedTerminalNeedsProof =
      !campaignContactId &&
      !manualCommandId &&
      terminalState;
    const trustedUntrackedTerminal =
      terminalState &&
      noLiveCalls === true;
    const shouldApplyWorkerStatus = campaignContactId
      ? (confirmedCampaignActive || confirmedCampaignEnd)
      : manualCommandId
        ? (confirmedManualActive || confirmedManualEnd)
        : (activeState ? confirmsPhysicalCall : trustedUntrackedTerminal);
    const trackedNumber = campaignContact?.phone || worker.currentNumber || phoneNumber || session.lastNumber || "";
    const statusSignature = buildStatusSignature(payload);
    const duplicateStatus = statusSignature === worker.lastStatusSignature;
    worker.lastStatusSignature = statusSignature;

    if (shouldApplyWorkerStatus) {
      worker.callState = callState || worker.callState || "idle";
      worker.currentNumber = ["idle", "ended", "failed"].includes(callState)
        ? ""
        : (phoneNumber || worker.currentNumber || "");
      if (typeof contactName === "string" && contactName.trim()) {
        worker.currentContactName = contactName.trim();
      }
      if (typeof companyName === "string" && companyName.trim()) {
        worker.currentCompanyName = companyName.trim();
      }
      if (manualCommandId) worker.manualLastState = callState || worker.manualLastState || "idle";
      if (untrackedTerminalNeedsProof && trustedUntrackedTerminal) {
        clearPhysicalStateQuarantine(worker);
      }
    }
    worker.connected = true;
    worker.disconnectedAt = null;
    if (lineLabel) worker.lineLabel = String(lineLabel).trim();
    if (shouldApplyWorkerStatus && lastError) worker.lastError = String(lastError).trim();
    const competingCallOwner = (session.phoneWorkers || [])
      .find((item) => item !== worker && isWorkerCallBusy(item));
    const shouldUpdateSessionState = !competingCallOwner;
    if (shouldUpdateSessionState) session.activePhoneSocketId = socket.id;
    if (confirmedCampaignActive) {
      worker.campaignCallPhase = "active";
      worker.campaignLastState = callState;
      clearCampaignCommandTimer(code, worker.id);
      clearWorkerDisconnectTimer(code, worker.id);
    }
    if (confirmedManualActive) worker.manualCallPhase = "active";

    // An unrelated incoming call may be shown by Android, but it must never
    // overwrite the number or state of an assigned campaign call.
    if (shouldApplyWorkerStatus && shouldUpdateSessionState) {
      session.callState = callState || session.callState;
    }
    if (shouldApplyWorkerStatus && shouldUpdateSessionState && typeof phoneNumber === "string" && phoneNumber.trim()) {
      session.lastNumber = phoneNumber.trim();
    }
    if (shouldApplyWorkerStatus && shouldUpdateSessionState && typeof contactName === "string" && contactName.trim()) {
      session.lastContactName = contactName.trim();
    }
    if (shouldApplyWorkerStatus && shouldUpdateSessionState && typeof companyName === "string" && companyName.trim()) {
      session.lastCompanyName = companyName.trim();
    }
    if (shouldUpdateSessionState && typeof micMuted === "boolean") session.micMuted = micMuted;
    if (shouldUpdateSessionState && typeof speakerOn === "boolean") session.isSpeakerOn = speakerOn;
    session.updatedAt = Date.now();

    const workerBecameAvailable =
      !campaignContactId &&
      !manualCommandId &&
      terminalState &&
      noLiveCalls === true &&
      !["idle", "ended", "failed"].includes(previousCallState);
    if (campaignContactId && !correlatedCampaignEvent && !duplicateStatus) {
      campaignLog(code, "ESTADO_NO_CORRELACIONADO", {
        numeroReportado: phoneNumber,
        numeroEsperado: campaignContact?.phone,
        dispositivo: getWorkerLabel(session, worker),
        estado: callState,
        direccion: callDirection || undefined,
        fuente: source || undefined,
        commandIdReportado: commandId || undefined,
        contactoIdReportado: contactId || undefined
      });
    } else if (
      correlatedCampaignEvent &&
      shouldApplyWorkerStatus &&
      !duplicateStatus &&
      callState !== previousCallState
    ) {
      campaignLog(code, "ESTADO", {
        numero: trackedNumber, dispositivo: getWorkerLabel(session, worker),
        anterior: previousCallState, actual: callState,
        contactoId: campaignContactId, commandId: worker.campaignCommandId,
        fuente: source || undefined, error: lastError || undefined
      });
    }
    if (ignoredPrematureIdle) campaignLog(code, "IDLE_IGNORADO", {
      numero: trackedNumber, dispositivo: getWorkerLabel(session, worker),
      motivo: "estado atrasado después de enviar dial"
    });

    if (!ignoredPrematureIdle && allowedCampaignTransition) {
      updateActiveCallState(session, callState, worker || {});
    }
    if (confirmedCampaignEnd && worker) {
      const finishedContact = campaignContact;
      if (finishedContact?.result === "reintentar") {
        finishedContact.status = "reintentar";
        finishedContact.completedAt = null;
        finishedContact.assignedWorkerId = null;
      }
      campaignLog(code, "LLAMADA_TERMINADA", {
        contacto: finishedContact?.name,
        numero: finishedContact?.phone || trackedNumber,
        dispositivo: getWorkerLabel(session, worker), estado: callState,
        resultado: finishedContact?.result || "sin_respuesta"
      });
      clearCampaignCommandTimer(code, worker.id);
      clearCampaignHangupTimer(code, worker.id);
      clearWorkerDisconnectTimer(code, worker.id);
      releaseCampaignWorker(
        worker,
        noLiveCalls === true ? (callState === "failed" ? "failed" : "idle") : "blocked"
      );
    }
    if (confirmedManualEnd && worker) {
      clearCampaignHangupTimer(code, worker.id);
      releaseManualWorker(
        worker,
        noLiveCalls === true ? (callState === "failed" ? "failed" : "idle") : "blocked"
      );
    }
    if (commandId) {
      const acknowledgedTerminal = terminalState && (
        campaignContactId
          ? confirmedCampaignEnd
          : manualCommandId
            ? confirmedManualEnd
            : trustedUntrackedTerminal
      );
      const acceptedStatus = campaignContactId
        ? (correlatedCampaignEvent && (!terminalState || confirmedCampaignEnd))
        : manualCommandId
          ? (correlatedManualEvent && (!terminalState || confirmedManualEnd))
          : (terminalState ? trustedUntrackedTerminal : confirmsPhysicalCall);
      socket.emit("phone:status_ack", {
        commandId,
        contactId,
        callState,
        accepted: acceptedStatus,
        terminal: acknowledgedTerminal
      });
    }
    syncSessionPhoneState(session);
    saveSoon();
    emitState(code);
    emitCampaignState(code);

    const campaign = ensureCampaign(session);
    if ((confirmedCampaignEnd || confirmedManualEnd || workerBecameAvailable) && campaign.status === "running") {
      fillAvailableCampaignWorkers(code);
    }
  });

  socket.on("phone:command_ack", ({ commandId, action, ok, message }) => {
    const code = socket.data.code;
    const role = socket.data.role;
    if (!code || role !== "phone") return;

    const session = sessions.get(code);
    if (!session) return;

    const worker = getPhoneWorkerBySocketId(session, socket.id);
    if (action === "dial") campaignLog(code, ok ? "ORDEN_ACEPTADA" : "ORDEN_RECHAZADA", {
      dispositivo: getWorkerLabel(session, worker), numero: worker?.currentNumber,
      commandId, mensaje: message || undefined
    });
    if (
      worker &&
      action === "dial" &&
      worker.campaignCommandId === commandId &&
      !ok
    ) {
      failAssignedCampaignContact(
        code,
        worker,
        message || "El teléfono rechazó la orden de llamada",
        "ORDEN_RECHAZADA_PROCESADA",
        "blocked"
      );
    } else if (
      worker &&
      action === "dial" &&
      worker.manualCommandId === commandId &&
      !ok
    ) {
      worker.lastError = message || "El teléfono rechazó la orden de llamada";
      releaseManualWorker(worker, "blocked");
      session.callState = "failed";
      session.updatedAt = Date.now();
      saveSoon();
      emitState(code);
    }

    if (worker && action === "hangup") {
      const key = workerTimerKey(code, worker.id);
      const pendingHangup = campaignHangupTimers.get(key);
      if (pendingHangup?.commandId === commandId && pendingHangup.contactId) {
        campaignLog(code, ok ? "CORTE_ACEPTADO" : "CORTE_RECHAZADO", {
          dispositivo: getWorkerLabel(session, worker),
          contactoId: pendingHangup.contactId,
          commandId,
          mensaje: message || undefined
        });
        if (!ok) {
          settleUnconfirmedCampaignHangup(code, worker, {
            contactId: pendingHangup.contactId,
            dialCommandId: pendingHangup.dialCommandId,
            hangupCommandId: commandId,
            retryDeferred: pendingHangup.retryDeferred,
            reason: message || "La APK rechazó la orden de corte",
            eventName: "CORTE_RECHAZADO_PROCESADO"
          });
        }
      } else if (worker.pendingManualHangupCommandId === commandId) {
        if (!ok) {
          clearCampaignHangupTimer(code, worker.id, commandId);
          worker.callState = "blocked";
          worker.manualLastState = "blocked";
          worker.manualHangupUnconfirmed = true;
          worker.lastError = message || "La APK rechazó la orden de corte";
          markPhysicalStateUnconfirmed(worker, {
            kind: "manual",
            reason: worker.lastError
          });
          session.updatedAt = Date.now();
          saveSoon();
          emitState(code);
        }
      }
    }

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
    // Never let a standby/incoming phone steal the media route while another
    // worker owns (or is quarantined with) the tracked call.
    const owner = getAuthoritativeCallOwner(session);
    if (!owner || owner.socketId !== socket.id) return;
    const peerId = getPeer(session, "phone");  // gets dashboardSocketId
    if (peerId) io.to(peerId).emit("audio:phone", data);
  });

  // Dashboard mic → phone speaker
  socket.on("audio:dashboard", (data) => {
    const { code, role } = socket.data;
    if (!code || role !== "dashboard") return;
    const session = sessions.get(code);
    if (!session) return;
    const owner = getAuthoritativeCallOwner(session);
    const peerId = owner?.connected ? owner.socketId : null;
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
      
      // Socket.IO reconnects transparently after short network cuts. Preserve
      // the assignment during a grace window instead of failing the contact
      // immediately.
      if (removed) {
        settlePendingCampaignHangupOnDisconnect(code, removed);
        campaignLog(code, "DISPOSITIVO_DESCONECTADO", {
          dispositivo: getWorkerLabel(session, removed), deviceId: removed.id,
          contactoId: removed.campaignContactId, socketId: socket.id,
          graciaMs: removed.campaignContactId ? CAMPAIGN_DISCONNECT_GRACE_MS : undefined
        });
        if (removed.campaignContactId) scheduleWorkerDisconnectGrace(code, removed);
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
      && !session.dashboardData
    ) {
      sessions.delete(code);
      saveSoon();
      return;
    }

    saveSoon();
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
    slots: session.pairingSlots.map((slot) => {
      const worker = (session.phoneWorkers || []).find((item) =>
        item.pairingSlotId === slot.id || (slot.deviceId && item.id === slot.deviceId)
      );
      return {
        id: slot.id,
        label: slot.label,
        deviceId: slot.deviceId,
        deviceName: slot.deviceName,
        linkedAt: slot.linkedAt,
        connected: Boolean(worker?.connected && worker?.socketId),
        callState: worker?.callState || "offline",
        link: getPairingLink(req, code, slot.token)
      };
    })
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

app.get("/api/session/:code/workspace", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  return res.json({ ok: true, code, workspace: session.dashboardData || null });
});

app.put("/api/session/:code/workspace", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  const input = req.body?.workspace;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return res.status(400).json({ ok: false, error: "workspace requerido" });
  }
  const contacts = Array.isArray(input.contacts) ? input.contacts.slice(0, 10000) : [];
  const lists = Array.isArray(input.lists)
    ? input.lists.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 200)
    : ["Principal"];
  if (!lists.includes("Principal")) lists.unshift("Principal");
  session.dashboardData = {
    contacts,
    lists,
    activeList: lists.includes(input.activeList) ? input.activeList : "Principal",
    calledCounts: input.calledCounts && typeof input.calledCounts === "object" ? input.calledCounts : {},
    contactRowStatus: input.contactRowStatus && typeof input.contactRowStatus === "object" ? input.contactRowStatus : {},
    callDurations: input.callDurations && typeof input.callDurations === "object" ? input.callDurations : {},
    dismissedReminderIds: input.dismissedReminderIds && typeof input.dismissedReminderIds === "object" ? input.dismissedReminderIds : {},
    callHistory: Array.isArray(input.callHistory) ? input.callHistory.slice(0, 100) : [],
    updatedAt: new Date().toISOString()
  };
  session.updatedAt = Date.now();
  await saveSoon();
  const persistenceStatus = await persistence.status();
  if (!persistenceStatus.connected) {
    return res.status(503).json({ ok: false, error: persistenceStatus.error || "Supabase no disponible" });
  }
  return res.json({ ok: true, code, updatedAt: session.dashboardData.updatedAt });
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
  const currentCampaign = ensureCampaign(session);
  const hasBoundCampaignWorker = (session.phoneWorkers || []).some((worker) =>
    worker.campaignContactId ||
    (worker.physicalStateUnconfirmed && worker.quarantineKind === "campaign")
  );
  if (
    ["running", "paused"].includes(currentCampaign.status) ||
    getActiveContact(session) ||
    hasBoundCampaignWorker
  ) {
    return res.status(409).json({
      ok: false,
      error: "Todavía hay una llamada física pendiente de cierre. No se puede reemplazar la campaña."
    });
  }

  const startedCampaign = startCampaign(session, contacts);
  if (!startedCampaign.contacts.length) {
    startedCampaign.status = "idle";
    return res.status(400).json({
      ok: false,
      error: "La lista no contiene celulares peruanos válidos."
    });
  }
  session.updatedAt = Date.now();
  saveSoon();
  emitCampaignState(code);
  const dispatched = fillAvailableCampaignWorkers(code);
  campaignLog(code, "INICIADA", {
    recibidos: contacts.length,
    validos: startedCampaign.contacts.length,
    descartados: contacts.length - startedCampaign.contacts.length,
    dispositivos: getConnectedPhoneWorkers(session).length,
    llamadasIniciales: dispatched.length
  });

  return res.json({
    ok: true,
    code,
    dispatched: dispatched.length,
    campaign: getCampaignSnapshot(session)
  });
});

app.post("/api/session/:code/campaign/pause", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  const activeCallContinues = Boolean(getActiveContact(session));
  pauseCampaign(session);
  saveSoon();
  emitCampaignState(code);
  return res.json({
    ok: true,
    code,
    activeCallContinues,
    campaign: getCampaignSnapshot(session)
  });
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

  const requestedContactId = String(req.body?.contactId || "").trim();
  const activeBeforeSkip = requestedContactId
    ? ensureCampaign(session).contacts.find((contact) => contact.id === requestedContactId)
    : getActiveContact(session);
  const skipWorker = (session.phoneWorkers || [])
    .find((worker) => worker.id === activeBeforeSkip?.assignedWorkerId);
  const workerSocketId = skipWorker?.connected ? skipWorker.socketId : null;
  const skipped = skipActiveContact(session, requestedContactId);
  if (!skipped) return res.status(409).json({ ok: false, error: "El contacto ya no tiene una llamada activa" });
  if (skipWorker) clearCampaignCommandTimer(code, skipWorker.id);
  if (skipWorker && !workerSocketId) {
    clearCampaignHangupTimer(code, skipWorker.id);
    settleUnconfirmedCampaignHangup(code, skipWorker, {
      contactId: skipped.id,
      dialCommandId: skipWorker.campaignCommandId,
      hangupCommandId: nanoid(),
      retryDeferred: true,
      reason: "El dispositivo estaba desconectado al solicitar el corte",
      eventName: "CORTE_DIFERIDO_SIN_CONEXION"
    });
  }
  if (workerSocketId && skipped) {
    requestCampaignHangup(code, skipWorker, skipped.id, { retryDeferred: true });
  }
  saveSoon();
  emitCampaignState(code);
  // Si había una llamada, esperamos su estado "ended/idle" antes de avanzar.
  if (!workerSocketId && ensureCampaign(session).status === "running") {
    fillAvailableCampaignWorkers(code);
  }
  return res.json({ ok: true, code, skipped, campaign: getCampaignSnapshot(session) });
});

app.post("/api/session/:code/campaign/force-release", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const contactId = String(req.body?.contactId || "").trim();
  const workerId = String(req.body?.workerId || "").trim();
  if (!code || (!contactId && !workerId) || req.body?.confirm !== true) {
    return res.status(400).json({
      ok: false,
      error: "workerId o contactId, además de confirm=true, son requeridos para forzar la liberación"
    });
  }
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  const worker = (session.phoneWorkers || []).find((item) =>
    (
      workerId
        ? item.id === workerId
        : [item.campaignContactId, item.manualContactId, item.quarantineContactId].includes(contactId)
    ) &&
    (item.campaignContactId || item.manualCommandId || item.physicalStateUnconfirmed) &&
    (
      item.hangupUnconfirmed ||
      item.manualHangupUnconfirmed ||
      ["blocked", "unresponsive", "offline"].includes(item.callState)
    )
  );
  const campaign = ensureCampaign(session);
  if (!worker) {
    return res.status(409).json({ ok: false, error: "No existe una llamada en cuarentena para liberar" });
  }
  const campaignContactId = worker.campaignContactId || "";
  const releaseKind = campaignContactId
    ? "campaign"
    : (worker.manualCommandId ? "manual" : (worker.quarantineKind || "manual"));
  const releasedContactId = campaignContactId || worker.manualContactId || worker.quarantineContactId || contactId || "";
  const contact = releaseKind === "campaign" && releasedContactId
    ? campaign.contacts.find((item) => item.id === releasedContactId) || null
    : null;

  const retryAfterRelease = req.body?.retry === true;
  const oldSocketId = worker.socketId;
  clearCampaignCommandTimer(code, worker.id);
  clearCampaignHangupTimer(code, worker.id);
  clearWorkerDisconnectTimer(code, worker.id);

  if (contact) {
    contact.assignedWorkerId = null;
    contact.lastCallState = "force_released";
    contact.completedAt = retryAfterRelease ? null : new Date().toISOString();
    if (retryAfterRelease) {
      contact.status = "reintentar";
      contact.result = "reintentar";
    } else {
      if (["dialing", "ringing", "in_call", "reintentar"].includes(contact.status)) {
        contact.status = "failed";
      }
      if (!contact.result || contact.result === "reintentar") contact.result = "sin_respuesta";
    }
  }

  const remaining = getActiveContacts(session);
  campaign.activeContactId = remaining[0]?.id || null;
  campaign.activeWorkerId = remaining[0]?.assignedWorkerId || null;
  campaign.activeWorkerSocketId = null;
  campaign.updatedAt = Date.now();

  if (campaignContactId) {
    releaseCampaignWorker(worker, "offline");
  } else if (worker.manualCommandId) {
    releaseManualWorker(worker, "offline");
  } else {
    clearPhysicalStateQuarantine(worker);
    worker.callState = "offline";
    worker.currentNumber = "";
    worker.currentContactName = "";
    worker.currentCompanyName = "";
  }
  worker.connected = false;
  worker.socketId = null;
  worker.lastError = "Liberado manualmente por el operador";
  session.callState = "failed";
  session.updatedAt = Date.now();
  syncSessionPhoneState(session);
  campaignLog(code, "LIBERACION_FORZADA", {
    dispositivo: getWorkerLabel(session, worker),
    tipo: releaseKind,
    contactoId: releasedContactId || undefined,
    reintentar: retryAfterRelease,
    advertencia: "No se pudo verificar el estado físico del teléfono"
  });

  saveSoon();
  emitState(code);
  emitCampaignState(code);
  if (campaign.status === "running") fillAvailableCampaignWorkers(code);
  if (oldSocketId) io.sockets.sockets.get(oldSocketId)?.disconnect(true);
  return res.json({ ok: true, code, contact, campaign: getCampaignSnapshot(session) });
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
  const targetCallStateBeforeUpdate = targetBeforeUpdate?.status || "";
  const resultWorker = (session.phoneWorkers || [])
    .find((worker) => worker.campaignContactId === contactId);
  const hangupWorkerSocketId = resultWorker?.connected ? resultWorker.socketId : null;
  const updated = markContactResult(session, contactId, result, {
    callbackReason: req.body?.callbackReason,
    assignedAdvisor: req.body?.assignedAdvisor,
    transcriptSummary: req.body?.transcriptSummary
  });
  if (!updated) return res.status(404).json({ ok: false, error: "Contacto no encontrado" });
  if (resultWorker && updated.result === "reintentar") {
    if (
      hangupWorkerSocketId &&
      !resultWorker.hangupUnconfirmed &&
      ["dialing", "ringing", "in_call"].includes(targetCallStateBeforeUpdate)
    ) {
      // Keep the contact out of the pending queue until Android confirms that
      // the original physical call ended; this prevents a duplicate redial.
      updated.status = targetCallStateBeforeUpdate;
      const campaign = ensureCampaign(session);
      campaign.activeContactId = contactId;
      campaign.activeWorkerId = resultWorker.id;
      campaign.activeWorkerSocketId = resultWorker.socketId;
    } else {
      updated.status = "failed";
      updated.completedAt ||= new Date().toISOString();
      updated.assignedWorkerId = null;
    }
  }
  if (resultWorker) clearCampaignCommandTimer(code, resultWorker.id);
  if (resultWorker && !hangupWorkerSocketId) {
    clearCampaignHangupTimer(code, resultWorker.id);
    settleUnconfirmedCampaignHangup(code, resultWorker, {
      contactId,
      dialCommandId: resultWorker.campaignCommandId,
      hangupCommandId: nanoid(),
      retryDeferred: updated.result === "reintentar",
      reason: "El dispositivo estaba desconectado al registrar el resultado",
      eventName: "RESULTADO_CON_DISPOSITIVO_DESCONECTADO"
    });
  }

  if (hangupWorkerSocketId) {
    requestCampaignHangup(code, resultWorker, contactId, {
      retryDeferred: updated.result === "reintentar"
    });
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

app.use((error, req, res, next) => {
  if (error?.type === "entity.too.large") {
    return res.status(413).json({
      ok: false,
      error: `La carga supera el límite permitido (${process.env.MAX_JSON_SIZE || "5mb"}).`
    });
  }
  return next(error);
});

app.use(express.static(path.join(__dirname, "../web")));
app.get("/health", async (_, res) => {
  const storage = await persistence.status();
  const ok = Boolean(storage.connected);
  return res.status(ok ? 200 : 503).json({
    ok,
    storage,
    sessionsInMemory: sessions.size
  });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SERVER] ${signal}: cerrando conexiones y persistiendo estado...`);
  for (const timer of workerDisconnectTimers.values()) clearTimeout(timer);
  for (const timer of campaignCommandTimers.values()) clearTimeout(timer);
  for (const entry of campaignHangupTimers.values()) clearTimeout(entry.timer);
  workerDisconnectTimers.clear();
  campaignCommandTimers.clear();
  campaignHangupTimers.clear();
  saveSoon();
  io.close();
  await Promise.race([
    new Promise((resolve) => server.close(resolve)),
    new Promise((resolve) => setTimeout(resolve, 8_000))
  ]);
  await persistence.close();
}

process.once("SIGTERM", () => {
  shutdown("SIGTERM").then(() => process.exit(0)).catch((error) => {
    console.error("[SERVER] Error durante cierre:", error);
    process.exit(1);
  });
});
process.once("SIGINT", () => {
  shutdown("SIGINT").then(() => process.exit(0)).catch((error) => {
    console.error("[SERVER] Error durante cierre:", error);
    process.exit(1);
  });
});

bootstrap().catch(err => {
  console.error("Fallo critico al iniciar el servidor:", err);
  process.exit(1);
});
