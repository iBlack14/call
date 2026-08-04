const ACTIVE_STATES = new Set(["dialing", "ringing", "in_call"]);
const TERMINAL_STATES = new Set(["idle", "ended", "failed"]);

export function normalizePhoneNumber(value = "") {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("51")) digits = digits.slice(2);
  return digits;
}

export function createPhoneWorker(input = {}) {
  const id = String(input.deviceId || input.id || "").trim() || "android-worker";
  const name = String(input.deviceName || input.name || "").trim() || "Android bridge";

  return {
    socketId: input.socketId || null,
    id,
    name,
    pairingSlotId: String(input.pairingSlotId || "").trim(),
    linkedAt: input.linkedAt || new Date().toISOString(),
    connected: Boolean(input.connected),
    callState: input.callState || "idle",
    currentNumber: String(input.currentNumber || ""),
    currentContactName: String(input.currentContactName || ""),
    currentCompanyName: String(input.currentCompanyName || ""),
    campaignContactId: input.campaignContactId || null,
    campaignCommandId: input.campaignCommandId || null,
    campaignCallPhase: input.campaignCallPhase || "idle",
    campaignLastState: input.campaignLastState || "idle",
    hangupUnconfirmed: Boolean(input.hangupUnconfirmed),
    manualCommandId: input.manualCommandId || null,
    manualContactId: input.manualContactId || null,
    manualCallPhase: input.manualCallPhase || "idle",
    manualLastState: input.manualLastState || "idle",
    pendingManualHangupCommandId: input.pendingManualHangupCommandId || null,
    manualHangupUnconfirmed: Boolean(input.manualHangupUnconfirmed),
    physicalStateUnconfirmed: Boolean(input.physicalStateUnconfirmed),
    quarantineKind: String(input.quarantineKind || ""),
    quarantineContactId: String(input.quarantineContactId || ""),
    quarantinePhoneNumber: String(input.quarantinePhoneNumber || ""),
    quarantineReason: String(input.quarantineReason || ""),
    lastStatusSignature: input.lastStatusSignature || "",
    lineLabel: input.lineLabel || "",
    lastError: input.lastError || "",
    disconnectedAt: input.disconnectedAt || null
  };
}

/**
 * New APK versions correlate every state with both IDs. A number-based fallback
 * keeps a rolling deployment compatible with older APKs without ever accepting
 * a known incoming call as part of a campaign.
 */
export function isCampaignStatusCorrelated(worker, contact, payload = {}) {
  if (!worker?.campaignContactId || !worker?.campaignCommandId || !contact) return false;

  const commandId = String(payload.commandId || "").trim();
  const contactId = String(payload.contactId || "").trim();
  if (String(payload.callDirection || "").toLowerCase() === "incoming") return false;
  if (commandId || contactId) {
    return Boolean(
      commandId &&
      contactId &&
      commandId === worker.campaignCommandId &&
      contactId === worker.campaignContactId
    );
  }

  const expected = normalizePhoneNumber(contact.phone || worker.currentNumber);
  const observed = normalizePhoneNumber(payload.phoneNumber);
  return Boolean(expected && observed && expected === observed);
}

export function isAllowedCampaignTransition(previousState, nextState) {
  const previous = String(previousState || "idle");
  const next = String(nextState || "");
  if (!ACTIVE_STATES.has(next) && !TERMINAL_STATES.has(next)) return false;
  if (previous === next) return false;

  // Once Android confirms a connected call, a late OFFHOOK/dialing event must
  // never move the campaign backwards. The same applies to ringing -> dialing.
  if (previous === "in_call" && (next === "dialing" || next === "ringing")) return false;
  if (previous === "ringing" && next === "dialing") return false;
  return true;
}

export function buildStatusSignature(payload = {}) {
  return [
    String(payload.callState || ""),
    normalizePhoneNumber(payload.phoneNumber),
    String(payload.commandId || ""),
    String(payload.contactId || ""),
    String(payload.callDirection || ""),
    String(payload.source || ""),
    String(payload.physicalObserved === true),
    String(payload.noLiveCalls === true)
  ].join("|");
}

export function isActiveCallState(state) {
  return ACTIVE_STATES.has(String(state || ""));
}

export function isTerminalCallState(state) {
  return TERMINAL_STATES.has(String(state || ""));
}
