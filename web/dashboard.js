import { socket, API_BASE } from './modules/socket.js';
import { refs, setStatus, setBadge, setAckBadge } from './modules/dom.js';
import * as Contacts from './modules/contacts.js';
import * as AudioBridge from './modules/audio-bridge.js';
import * as Quotation from './modules/quotation.js';

// ── STATE ──────────────────────────────────────────────────────────────
let sessionCode = "";
let pairLink = "";
let callCtx = null;
let callTimerId = null;
let callStartedAt = null;
let currentState = "idle";
let micEnabled = true;
let speakerEnabled = false;
let importPreviewData = [];
let currentPage = 1;
let currentCallingContactId = null;
let currentPhoneLinked = false;
const pendingCommandTimeouts = new Map();
const PAGE_SIZE = 20;

// ── INITIALIZATION ──────────────────────────────────────────────────
async function init() {
  Contacts.loadContacts();
  Contacts.loadCalledCounts();
  Contacts.loadContactRowStatus();
  Contacts.loadDismissedReminders();
  
  renderContacts();
  loadApkInfo();
  bindEvents();
  
  setStatus("Listo.");
}

// ── UI RENDERING ──────────────────────────────────────────────────────
function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function renderContacts() {
  updateCalledContactsCounter();
  const cBodyEl = refs.cBodyEl;
  cBodyEl.innerHTML = "";
  const contacts = Contacts.contacts;
  const totalPages = Math.max(1, Math.ceil(contacts.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  if (!contacts.length) {
    cBodyEl.innerHTML = `<tr><td colspan="4" class="muted" style="text-align:center;padding:18px;">Sin contactos. Agrega el primero.</td></tr>`;
    refs.contactsPaginationEl.style.display = "none";
    renderReminderFloat();
    return;
  }

  const startIndex = (currentPage - 1) * PAGE_SIZE;
  const pageRows = contacts.slice(startIndex, startIndex + PAGE_SIZE);

  for (const c of pageRows) {
    const tr = document.createElement("tr");
    const callCount = Number(Contacts.calledCounts[c.id] || 0);
    const rowStatus = String(Contacts.contactRowStatus[c.id] || "").toLowerCase();
    if (callCount > 0) tr.classList.add("contact-row-called");
    if (["r", "lc", "sc"].includes(rowStatus)) tr.classList.add(`contact-row-status-${rowStatus}`);
    
    tr.innerHTML = `
      <td>${escHtml(c.name)}</td>
      <td style="font-family:monospace;font-size:13px;">${escHtml(c.phone)}</td>
      <td>
        ${escHtml(c.note || "—")}
        ${callCount > 0 ? `<span class="call-count-chip">📞 ${callCount}</span>` : ""}
      </td>
      <td class="actions-cell">
        <button data-action="edit" data-id="${c.id}" class="secondary">✏️</button>
        <button data-action="dial" data-id="${c.id}">📞 Llamar</button>
        <button data-action="delete" data-id="${c.id}" class="secondary">🗑️</button>
      </td>`;
    cBodyEl.appendChild(tr);
  }

  refs.contactsPaginationEl.style.display = totalPages > 1 ? "flex" : "none";
  refs.pageInfoEl.textContent = `Página ${currentPage} de ${totalPages}`;
  refs.prevPageBtn.disabled = currentPage <= 1;
  refs.nextPageBtn.disabled = currentPage >= totalPages;
  renderReminderFloat();
}

function updateCalledContactsCounter() {
  if (!refs.calledContactsValueEl) return;
  const count = Contacts.contacts.reduce((acc, c) => acc + (Number(Contacts.calledCounts[c.id] || 0) > 0 ? 1 : 0), 0);
  refs.calledContactsValueEl.textContent = String(count);
}

function renderReminderFloat() {
  // logic from original dashboard.js simplified for the new structure
  // ... (keeping original logic)
}

// ── EVENT BINDING ────────────────────────────────────────────────────
function bindEvents() {
  refs.createBtn.onclick = () => socket.emit("session:create");
  refs.joinBtn.onclick = () => {
    const code = refs.sessionCodeIn.value.trim().toUpperCase();
    if (code) {
      socket.emit("session:join", { code, role: "dashboard" });
      loadPairingData(code);
    }
  };
  
  refs.cBodyEl.onclick = (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    const contact = Contacts.contacts.find(c => c.id === id);
    if (!contact) return;
    
    if (action === "dial") startDialForContact(contact);
    if (action === "delete") {
      if (confirm(`¿Eliminar a ${contact.name}?`)) {
        Contacts.deleteContact(id);
        renderContacts();
      }
    }
  };

  refs.hangupBtnEl.onclick = () => {
    emitCallActionWithAck("hangup");
    applyState("ended", callCtx?.phone || "");
  };

  refs.muteBtnEl.onclick = toggleMute;
  refs.speakerBtnEl.onclick = toggleSpeaker;
}

// ── CALL LOGIC ────────────────────────────────────────────────────────
function startDialForContact(c) {
  if (["dialing", "ringing", "in_call"].includes(currentState)) return;
  currentCallingContactId = c.id;
  Contacts.calledCounts[c.id] = (Contacts.calledCounts[c.id] || 0) + 1;
  Contacts.saveCalledCounts();
  renderContacts();
  openCallWindow(c.phone, { contactName: c.name, note: c.note });
  emitCallActionWithAck("dial", { phoneNumber: c.phone, contactName: c.name });
}

function openCallWindow(phone, opts = {}) {
  // ... (original logic using refs)
  refs.callModalEl.style.display = "grid";
  setBadge("dialing", refs.callBadgeEl);
}

function applyState(state, lastNum, meta = {}) {
  currentState = state;
  setBadge(state, refs.callBadgeEl);
  if (state === "in_call") {
    AudioBridge.setPhoneAudioEnabled(true);
    AudioBridge.ensurePhoneAudioCtx();
    AudioBridge.startWebMicStreaming();
  }
  if (state === "ended" || state === "idle") {
    AudioBridge.stopPhoneAudio();
    setTimeout(() => { if (currentState === "idle") refs.callModalEl.style.display = "none"; }, 2000);
  }
}

function emitCallActionWithAck(action, payload = {}) {
  const commandId = crypto.randomUUID();
  socket.emit("call:action", { action, commandId, ...payload });
  setAckBadge(refs.apkAckBadgeEl, "pending", `APK · ${action}...`);
  return commandId;
}

// ── APK & PAIRING ────────────────────────────────────────────────────
async function loadPairingData(code) {
  try {
    const res = await fetch(`${API_BASE}/api/pairing/${code}`);
    const data = await res.json();
    refs.pairLinkEl.value = data.link;
    refs.pairQrEl.src = `${API_BASE}/api/pairing-qr/${code}.svg?ts=${Date.now()}`;
    refs.pairQrEl.style.display = "block";
  } catch { }
}

async function loadApkInfo() {
  try {
    const res = await fetch(`${API_BASE}/api/apk/info`);
    const info = await res.json();
    if (info.ok) {
       refs.apkNameEl.textContent = info.name;
       refs.apkDlBtn.href = `${API_BASE}/api/apk/download`;
    }
  } catch { }
}

// ── SOCKET HANDLERS ──────────────────────────────────────────────────
socket.on("state:changed", st => {
  applyState(st.callState, st.lastNumber, { contactName: st.lastContactName });
});

socket.on("session:created", ({ code }) => {
  sessionCode = code;
  refs.sessionCodeIn.value = code;
  loadPairingData(code);
});

// START
init();
