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
  const allowed = new Set(["agendado", "no_interesado", "requiere_asesor", "sin_respuesta", "reintentar"]);
  return allowed.has(value) ? value : "sin_respuesta";
}

function normalizeContact(input = {}) {
  let id = String(input.id || "").trim();
  let phone = String(input.phone || "").trim();
  
  // Keep leading + but strip all other non-digits
  const hasPlus = phone.startsWith("+");
  phone = phone.replace(/\D/g, "");
  if (hasPlus && !phone.startsWith("+")) phone = "+" + phone;
  
  if (!phone) return null;
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
    transcriptSummary: input.transcriptSummary || ""
  };
}

export function ensureCampaign(session) {
  if (!session.campaign || typeof session.campaign !== "object") {
    session.campaign = DEFAULT_CAMPAIGN();
  }

  const base = DEFAULT_CAMPAIGN();
  session.campaign = {
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

  return session.campaign;
}

export function syncCampaignContacts(session, contacts = []) {
  const campaign = ensureCampaign(session);
  campaign.contacts = contacts.map((contact) => normalizeContact(contact)).filter(Boolean);
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
  const active = getActiveContact(session);
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
    if (counts[contact.status] !== undefined) counts[contact.status] += 1;
  }

  return {
    status: campaign.status,
    activeContactId: active?.id || null,
    activeWorkerId: campaign.activeWorkerId,
    activeWorkerSocketId: campaign.activeWorkerSocketId,
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
  campaign.startedAt ||= nowIso();
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
    return getContactById(session, campaign.activeContactId);
  }
  // Fallback: look for ANY contact that is currently in a call state
  return campaign.contacts.find((c) => ["dialing", "ringing", "in_call"].includes(c.status)) || null;
}

export function getContactByWorker(session, workerId) {
  const campaign = ensureCampaign(session);
  return campaign.contacts.find((c) => c.assignedWorkerId === workerId && ["dialing", "ringing", "in_call"].includes(c.status)) || null;
}

export function pickNextContact(session) {
  const campaign = ensureCampaign(session);
  return campaign.contacts.find((contact) => contact.status === "pending" || contact.status === "reintentar") || null;
}

export function assignNextContact(session, worker = {}) {
  const campaign = ensureCampaign(session);
  const next = pickNextContact(session);
  if (!next) {
    campaign.status = campaign.status === "paused" ? "paused" : "completed";
    campaign.completedAt = nowIso();
    campaign.activeContactId = null;
    campaign.activeWorkerId = null;
    campaign.activeWorkerSocketId = null;
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
  // Try active ID first, then by worker ID
  let contact = getActiveContact(session);
  if (!contact && worker.id) {
    contact = getContactByWorker(session, worker.id);
  }

  if (!contact) return null;

  if (worker.id) contact.assignedWorkerId = worker.id;
  
  if (state === "dialing" || state === "ringing" || state === "in_call") {
    contact.status = state;
    campaign.activeContactId = contact.id; // Re-sync active ID if it was lost
    campaign.updatedAt = Date.now();
    return contact;
  }

  if ((state === "idle" || state === "ended") && ["dialing", "ringing", "in_call"].includes(contact.status)) {
    contact.status = "failed";
    if (!contact.result) contact.result = "sin_respuesta";
    contact.completedAt = nowIso();
    campaign.activeContactId = null;
    campaign.activeWorkerId = null;
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

  if (campaign.activeContactId === contactId) {
    campaign.activeContactId = null;
    campaign.activeWorkerId = null;
    campaign.activeWorkerSocketId = null;
  }

  campaign.updatedAt = Date.now();
  return contact;
}

export function skipActiveContact(session) {
  const campaign = ensureCampaign(session);
  const contact = getActiveContact(session);
  if (!contact) return null;

  contact.result = "reintentar";
  contact.status = "pending";
  contact.completedAt = null;
  campaign.activeContactId = null;
  campaign.activeWorkerId = null;
  campaign.activeWorkerSocketId = null;
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
