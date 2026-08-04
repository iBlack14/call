import { nanoid } from 'nanoid';

// A campaign must keep object identity for its whole in-memory lifetime.
// Several operations call helper functions recursively; rebuilding the object
// in ensureCampaign() made the caller continue mutating a stale object.
const normalizedCampaigns = new WeakSet();

const DEFAULT_CAMPAIGN = () => ({
  status: "idle",
  contacts: [],
  activeContactId: null,
  activeWorkerId: null,
  activeWorkerSocketId: null,
  callbacks: [],
  lastError: "",
  updatedAt: Date.now(),
  startedAt: null,
  pausedAt: null,
  completedAt: null
});

function nowIso() {
  return new Date().toISOString();
}

function normalizeResult(value) {
  const allowed = new Set(["agendado", "no_interesado", "requiere_asesor", "sin_respuesta", "reintentar", "contactado"]);
  return allowed.has(value) ? value : "sin_respuesta";
}

function normalizeContact(input = {}) {
  let id = String(input.id || "").trim();
  let phone = String(input.phone || "").trim();
  
  phone = phone.replace(/\D/g, "");

  // Las campañas solo admiten celulares peruanos. Esto también protege
  // listas antiguas que fueron importadas antes de aplicar el filtro web.
  let nationalDigits = phone.replace(/\D/g, "");
  if (nationalDigits.length === 11 && nationalDigits.startsWith("51")) {
    nationalDigits = nationalDigits.slice(2);
  }
  if (!/^9\d{8}$/.test(nationalDigits)) return null;
  phone = nationalDigits;

  if (!id) id = nanoid();

  return {
    id,
    name: String(input.name || "").trim() || "Contacto",
    phone,
    note: String(input.note || "").trim(),
    status: String(input.status || "pending").trim(),
    result: String(input.result || "").trim(),
    attempts: Number(input.attempts || 0),
    lastAttemptAt: input.lastAttemptAt || null,
    completedAt: input.completedAt || null,
    assignedWorkerId: input.assignedWorkerId || null,
    assignedAdvisor: input.assignedAdvisor || "",
    callbackReason: input.callbackReason || "",
    transcriptSummary: input.transcriptSummary || "",
    wasAnswered: Boolean(input.wasAnswered),
    connectedAt: input.connectedAt || null,
    lastCallState: String(input.lastCallState || "").trim()
  };
}

export function ensureCampaign(session) {
  if (!session.campaign || typeof session.campaign !== "object") {
    session.campaign = DEFAULT_CAMPAIGN();
  }

  if (normalizedCampaigns.has(session.campaign)) return session.campaign;

  const base = DEFAULT_CAMPAIGN();
  const normalized = {
    ...base,
    ...session.campaign,
    contacts: Array.isArray(session.campaign.contacts)
      ? session.campaign.contacts.map((contact) => normalizeContact(contact)).filter(Boolean)
      : [],
    callbacks: Array.isArray(session.campaign.callbacks)
      ? session.campaign.callbacks.map((item) => ({
          contactId: String(item.contactId || "").trim(),
          name: String(item.name || "").trim(),
          phone: String(item.phone || "").trim(),
          note: String(item.note || "").trim(),
          reason: String(item.reason || "").trim(),
          advisor: String(item.advisor || "").trim(),
          createdAt: item.createdAt || nowIso(),
          status: String(item.status || "pending").trim()
        }))
      : []
  };

  // Normalize in place so references held by callers remain authoritative.
  Object.assign(session.campaign, normalized);
  normalizedCampaigns.add(session.campaign);

  return session.campaign;
}

export function syncCampaignContacts(session, contacts = []) {
  const campaign = ensureCampaign(session);
  const seenPhones = new Set();
  const seenIds = new Set();
  campaign.contacts = contacts
    .map((contact) => normalizeContact(contact))
    .filter((contact) => {
      if (!contact) return false;
      const key = contact.phone.replace(/\D/g, "").replace(/^51(?=9\d{8}$)/, "");
      if (seenPhones.has(key)) return false;
      seenPhones.add(key);
      if (seenIds.has(contact.id)) contact.id = nanoid();
      seenIds.add(contact.id);
      contact.status = "pending";
      contact.result = "";
      contact.attempts = 0;
      contact.lastAttemptAt = null;
      contact.completedAt = null;
      contact.assignedWorkerId = null;
      contact.wasAnswered = false;
      contact.connectedAt = null;
      contact.lastCallState = "";
      return true;
    });
  campaign.activeContactId = null;
  campaign.activeWorkerId = null;
  campaign.activeWorkerSocketId = null;
  campaign.completedAt = null;
  campaign.lastError = "";
  campaign.updatedAt = Date.now();
  return campaign;
}

export function getCampaignSnapshot(session) {
  const campaign = ensureCampaign(session);
  const quarantinedCalls = (session.phoneWorkers || [])
    .filter((worker) =>
      worker.physicalStateUnconfirmed ||
      worker.hangupUnconfirmed ||
      worker.manualHangupUnconfirmed ||
      (
        (worker.campaignContactId || worker.manualCommandId) &&
        ["blocked", "unresponsive", "offline"].includes(worker.callState)
      )
    )
    .map((worker) => ({
      workerId: worker.id,
      kind: worker.campaignContactId ? "campaign" : (worker.quarantineKind || "manual"),
      contactId: worker.campaignContactId || worker.manualContactId || worker.quarantineContactId || "",
      phoneNumber: worker.currentNumber || worker.quarantinePhoneNumber || "",
      callState: worker.callState || "blocked",
      reason: worker.quarantineReason || worker.lastError || "No se pudo verificar el estado físico de la llamada"
    }));
  const quarantinedContactIds = quarantinedCalls
    .filter((item) => item.kind === "campaign" && item.contactId)
    .map((item) => item.contactId);
  const activeContacts = campaign.contacts.filter((contact) =>
    ["dialing", "ringing", "in_call"].includes(contact.status)
  );
  const active = activeContacts[0] || null;
  const counts = {
    pending: 0,
    dialing: 0,
    ringing: 0,
    in_call: 0,
    awaiting_callback: 0,
    completed: 0,
    failed: 0
  };

  for (const contact of campaign.contacts) {
    if (contact.status === "reintentar") counts.pending += 1;
    else if (counts[contact.status] !== undefined) counts[contact.status] += 1;
  }

  return {
    status: campaign.status,
    activeContactId: active?.id || null,
    activeContactIds: activeContacts.map((contact) => contact.id),
    activeContacts,
    activeWorkerId: campaign.activeWorkerId,
    activeWorkerSocketId: campaign.activeWorkerSocketId,
    quarantinedContactIds,
    quarantinedCalls,
    lastError: campaign.lastError,
    updatedAt: campaign.updatedAt,
    startedAt: campaign.startedAt,
    pausedAt: campaign.pausedAt,
    completedAt: campaign.completedAt,
    counts,
    contacts: campaign.contacts,
    callbacks: campaign.callbacks
  };
}

export function startCampaign(session, contacts = []) {
  const campaign = contacts.length ? syncCampaignContacts(session, contacts) : ensureCampaign(session);
  campaign.status = "running";
  campaign.startedAt = nowIso();
  campaign.pausedAt = null;
  campaign.completedAt = null;
  campaign.lastError = "";
  campaign.updatedAt = Date.now();
  return campaign;
}

export function pauseCampaign(session) {
  const campaign = ensureCampaign(session);
  campaign.status = "paused";
  campaign.pausedAt = nowIso();
  campaign.updatedAt = Date.now();
  return campaign;
}

export function resumeCampaign(session) {
  const campaign = ensureCampaign(session);
  campaign.status = "running";
  campaign.pausedAt = null;
  
  // Cleanup stuck active ID
  const active = getActiveContact(session);
  if (active) {
    campaign.activeContactId = active.id;
  } else {
    campaign.activeContactId = null;
  }

  campaign.updatedAt = Date.now();
  return campaign;
}

export function stopCampaign(session) {
  const campaign = ensureCampaign(session);
  campaign.status = "idle";
  campaign.activeContactId = null;
  campaign.activeWorkerId = null;
  campaign.activeWorkerSocketId = null;
  campaign.completedAt = nowIso();
  campaign.updatedAt = Date.now();
  return campaign;
}

export function getContactById(session, contactId) {
  const campaign = ensureCampaign(session);
  return campaign.contacts.find((contact) => contact.id === contactId) || null;
}

export function getActiveContact(session) {
  const campaign = ensureCampaign(session);
  if (campaign.activeContactId) {
    const active = getContactById(session, campaign.activeContactId);
    if (active && ["dialing", "ringing", "in_call"].includes(active.status)) return active;
  }
  // Fallback: look for ANY contact that is currently in a call state
  return campaign.contacts.find((c) => ["dialing", "ringing", "in_call"].includes(c.status)) || null;
}

export function getActiveContacts(session) {
  const campaign = ensureCampaign(session);
  return campaign.contacts.filter((contact) =>
    ["dialing", "ringing", "in_call"].includes(contact.status)
  );
}

export function getContactByWorker(session, workerId) {
  const campaign = ensureCampaign(session);
  return campaign.contacts.find((c) => c.assignedWorkerId === workerId && ["dialing", "ringing", "in_call"].includes(c.status)) || null;
}

export function pickNextContact(session) {
  const campaign = ensureCampaign(session);
  // Complete the untouched queue before cycling back to explicitly skipped
  // contacts; otherwise "Saltar" could immediately call the same number again.
  return campaign.contacts.find((contact) => contact.status === "pending")
    || campaign.contacts.find((contact) => contact.status === "reintentar")
    || null;
}

export function assignNextContact(session, worker = {}) {
  const campaign = ensureCampaign(session);
  const next = pickNextContact(session);
  if (!next) {
    const hasBoundWorker = (session.phoneWorkers || []).some((worker) => worker.campaignContactId);
    if (!getActiveContacts(session).length && !hasBoundWorker) {
      campaign.status = campaign.status === "paused" ? "paused" : "completed";
      campaign.completedAt = nowIso();
      campaign.activeContactId = null;
      campaign.activeWorkerId = null;
      campaign.activeWorkerSocketId = null;
    }
    campaign.updatedAt = Date.now();
    return null;
  }

  next.status = "dialing";
  next.result = "";
  next.attempts += 1;
  next.lastAttemptAt = nowIso();
  next.assignedWorkerId = worker.id || null;
  campaign.activeContactId = next.id;
  campaign.activeWorkerId = worker.id || null;
  campaign.activeWorkerSocketId = worker.socketId || null;
  campaign.lastError = "";
  campaign.updatedAt = Date.now();
  return next;
}

export function updateActiveCallState(session, state, worker = {}) {
  const campaign = ensureCampaign(session);
  // La asignación del dispositivo es autoritativa. Un evento tardío de otro
  // celular nunca debe cerrar o modificar la llamada que acaba de comenzar.
  const contact = worker.id
    ? getContactByWorker(session, worker.id)
    : getActiveContact(session);

  if (!contact) return null;

  if (worker.id) contact.assignedWorkerId = worker.id;
  contact.lastCallState = state;
  
  if (state === "dialing" || state === "ringing" || state === "in_call") {
    if (contact.status === "in_call" && (state === "dialing" || state === "ringing")) return contact;
    if (contact.status === "ringing" && state === "dialing") return contact;
    contact.status = state;
    if (state === "in_call") {
      contact.wasAnswered = true;
      contact.connectedAt ||= nowIso();
    }
    campaign.activeContactId = contact.id; // Re-sync active ID if it was lost
    campaign.updatedAt = Date.now();
    return contact;
  }

  if (["idle", "ended", "failed"].includes(state) && ["dialing", "ringing", "in_call"].includes(contact.status)) {
    if (!contact.result && contact.wasAnswered) {
      contact.status = "completed";
      contact.result = "contactado";
    } else {
      contact.status = "failed";
      if (!contact.result) contact.result = "sin_respuesta";
    }
    contact.completedAt = nowIso();
    const remaining = getActiveContacts(session).filter((item) => item.id !== contact.id);
    campaign.activeContactId = remaining[0]?.id || null;
    campaign.activeWorkerId = remaining[0]?.assignedWorkerId || null;
    campaign.activeWorkerSocketId = null;
    campaign.updatedAt = Date.now();
    return contact;
  }

  return contact;
}

export function markContactResult(session, contactId, result, extras = {}) {
  const campaign = ensureCampaign(session);
  const contact = getContactById(session, contactId);
  if (!contact) return null;

  const normalizedResult = normalizeResult(result);
  contact.result = normalizedResult;
  contact.assignedAdvisor = String(extras.assignedAdvisor || contact.assignedAdvisor || "").trim();
  contact.callbackReason = String(extras.callbackReason || contact.callbackReason || "").trim();
  contact.transcriptSummary = String(extras.transcriptSummary || contact.transcriptSummary || "").trim();

  if (normalizedResult === "reintentar") {
    contact.status = "pending";
    contact.completedAt = null;
  } else if (normalizedResult === "requiere_asesor") {
    contact.status = "awaiting_callback";
    contact.completedAt = nowIso();
    registerCallback(session, {
      contactId: contact.id,
      name: contact.name,
      phone: contact.phone,
      note: contact.note,
      reason: contact.callbackReason || "Solicitó asesor",
      advisor: contact.assignedAdvisor || ""
    });
  } else if (normalizedResult === "sin_respuesta") {
    contact.status = "failed";
    contact.completedAt = nowIso();
  } else {
    contact.status = "completed";
    contact.completedAt = nowIso();
  }

  const remaining = getActiveContacts(session).filter((item) => item.id !== contactId);
  campaign.activeContactId = remaining[0]?.id || null;
  campaign.activeWorkerId = remaining[0]?.assignedWorkerId || null;
  campaign.activeWorkerSocketId = null;

  campaign.updatedAt = Date.now();
  return contact;
}

export function skipActiveContact(session, contactId = "") {
  const campaign = ensureCampaign(session);
  const contact = contactId ? getContactById(session, contactId) : getActiveContact(session);
  if (contact && !["dialing", "ringing", "in_call"].includes(contact.status)) return null;
  if (!contact) return null;

  contact.result = "reintentar";
  contact.completedAt = null;
  campaign.updatedAt = Date.now();
  return contact;
}

export function registerCallback(session, callback) {
  const campaign = ensureCampaign(session);
  const contactId = String(callback.contactId || "").trim();
  if (!contactId) return null;

  const existing = campaign.callbacks.find((item) => item.contactId === contactId);
  if (existing) {
    existing.reason = String(callback.reason || existing.reason || "").trim();
    existing.advisor = String(callback.advisor || existing.advisor || "").trim();
    existing.note = String(callback.note || existing.note || "").trim();
    existing.status = String(callback.status || existing.status || "pending").trim();
    existing.createdAt ||= nowIso();
    campaign.updatedAt = Date.now();
    return existing;
  }

  const entry = {
    contactId,
    name: String(callback.name || "").trim(),
    phone: String(callback.phone || "").trim(),
    note: String(callback.note || "").trim(),
    reason: String(callback.reason || "").trim(),
    advisor: String(callback.advisor || "").trim(),
    createdAt: callback.createdAt || nowIso(),
    status: String(callback.status || "pending").trim()
  };
  campaign.callbacks.unshift(entry);
  campaign.updatedAt = Date.now();
  return entry;
}

export function completeCallback(session, contactId) {
  const campaign = ensureCampaign(session);
  const callback = campaign.callbacks.find((item) => item.contactId === contactId);
  if (!callback) return null;
  callback.status = "completed";
  campaign.updatedAt = Date.now();
  return callback;
}
