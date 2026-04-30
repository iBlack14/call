import { socket, API_BASE } from "./modules/socket.js";
import { refs, setStatus, setBadge, setAckBadge } from "./modules/dom.js";
import * as Contacts from "./modules/contacts.js";
import * as AudioBridge from "./modules/audio-bridge.js";
import * as Quotation from "./modules/quotation.js";

let sessionCode = "";
let currentState = "idle";
let micEnabled = true;
let speakerEnabled = false;
let currentPage = 1;
let currentCallingContactId = null;
let currentPhoneLinked = false;
let editingContactId = null;
let callCtx = null;

const pendingCommandTimeouts = new Map();
const PAGE_SIZE = 20;

function escHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function updateStatusFromConnectivity(message) {
  const connected = socket.connected && currentPhoneLinked;
  setStatus(message, connected);
}

function updateCalledContactsCounter() {
  if (!refs.calledContactsValueEl) return;
  const count = Contacts.contacts.reduce(
    (acc, contact) => acc + (Number(Contacts.calledCounts[contact.id] || 0) > 0 ? 1 : 0),
    0
  );
  refs.calledContactsValueEl.textContent = String(count);
}

function renderReminderFloat() {
  if (!refs.reminderFloatContainer) return;
  refs.reminderFloatContainer.style.display = "none";
  refs.reminderFloatContainer.innerHTML = "";
}

function renderContacts() {
  updateCalledContactsCounter();
  refs.cBodyEl.innerHTML = "";

  const totalPages = Math.max(1, Math.ceil(Contacts.contacts.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  if (!Contacts.contacts.length) {
    refs.cBodyEl.innerHTML =
      '<tr><td colspan="4" class="muted" style="text-align:center;padding:18px;">Sin contactos. Agrega el primero.</td></tr>';
    refs.contactsPaginationEl.style.display = "none";
    renderReminderFloat();
    return;
  }

  const startIndex = (currentPage - 1) * PAGE_SIZE;
  const pageRows = Contacts.contacts.slice(startIndex, startIndex + PAGE_SIZE);

  for (const contact of pageRows) {
    const tr = document.createElement("tr");
    const callCount = Number(Contacts.calledCounts[contact.id] || 0);
    const rowStatus = String(Contacts.contactRowStatus[contact.id] || "").toLowerCase();

    if (callCount > 0) tr.classList.add("contact-row-called");
    if (["r", "lc", "sc"].includes(rowStatus)) tr.classList.add(`contact-row-status-${rowStatus}`);

    tr.innerHTML = `
      <td>${escHtml(contact.name)}</td>
      <td style="font-family:monospace;font-size:13px;">${escHtml(contact.phone)}</td>
      <td>
        ${escHtml(contact.note || "—")}
        ${callCount > 0 ? `<span class="call-count-chip">📞 ${callCount}</span>` : ""}
      </td>
      <td class="actions-cell">
        <button data-action="edit" data-id="${contact.id}" class="secondary">✏️</button>
        <button data-action="dial" data-id="${contact.id}">📞 Llamar</button>
        <button data-action="delete" data-id="${contact.id}" class="secondary">🗑️</button>
      </td>
    `;
    refs.cBodyEl.appendChild(tr);
  }

  refs.contactsPaginationEl.style.display = totalPages > 1 ? "flex" : "none";
  refs.pageInfoEl.textContent = `Página ${currentPage} de ${totalPages}`;
  refs.prevPageBtn.disabled = currentPage <= 1;
  refs.nextPageBtn.disabled = currentPage >= totalPages;
  renderReminderFloat();
}

function normalizePhone(phone) {
  return String(phone || "").trim();
}

function createContactPayload(name, phone, note) {
  return {
    id: crypto.randomUUID(),
    name: String(name || "").trim(),
    phone: normalizePhone(phone),
    note: String(note || "").trim()
  };
}

function resetAddModal() {
  refs.addNameInput.value = "";
  refs.addPhoneInput.value = "";
  refs.addNoteInput.value = "";
}

function openAddModal() {
  resetAddModal();
  refs.addContactModalEl.style.display = "grid";
  refs.addNameInput.focus();
}

function closeAddModal() {
  refs.addContactModalEl.style.display = "none";
}

function openEditModal(contact) {
  editingContactId = contact.id;
  refs.editNameInput.value = contact.name;
  refs.editPhoneInput.value = contact.phone;
  refs.editNoteInput.value = contact.note || "";
  refs.editModalEl.style.display = "grid";
  refs.editNameInput.focus();
}

function closeEditModal() {
  editingContactId = null;
  refs.editModalEl.style.display = "none";
}

function saveNewContact() {
  const contact = createContactPayload(refs.addNameInput.value, refs.addPhoneInput.value, refs.addNoteInput.value);
  if (!contact.name || !contact.phone) {
    updateStatusFromConnectivity("Completa nombre y teléfono.");
    return;
  }
  Contacts.addContact(contact);
  closeAddModal();
  renderContacts();
  updateStatusFromConnectivity(`Contacto agregado: ${contact.name}`);
}

function saveInlineContact() {
  const contact = createContactPayload(refs.cNameIn.value, refs.cPhoneIn.value, refs.cNoteIn.value);
  if (!contact.name || !contact.phone) {
    updateStatusFromConnectivity("Completa nombre y teléfono.");
    return;
  }
  Contacts.addContact(contact);
  refs.cNameIn.value = "";
  refs.cPhoneIn.value = "";
  refs.cNoteIn.value = "";
  renderContacts();
  updateStatusFromConnectivity(`Contacto agregado: ${contact.name}`);
}

function saveEditedContact() {
  if (!editingContactId) return;
  const updated = {
    name: String(refs.editNameInput.value || "").trim(),
    phone: normalizePhone(refs.editPhoneInput.value),
    note: String(refs.editNoteInput.value || "").trim()
  };
  if (!updated.name || !updated.phone) {
    updateStatusFromConnectivity("Completa nombre y teléfono.");
    return;
  }
  Contacts.updateContact(editingContactId, updated);
  closeEditModal();
  renderContacts();
  updateStatusFromConnectivity(`Contacto actualizado: ${updated.name}`);
}

function updateLinkedUi(state) {
  currentPhoneLinked = Boolean(state?.connected?.phone);
  refs.linkedBanner.style.display = currentPhoneLinked ? "flex" : "none";

  if (currentPhoneLinked && state.phoneDevice) {
    const deviceName = state.phoneDevice.name || "Android bridge";
    const deviceId = state.phoneDevice.id ? ` · ${state.phoneDevice.id}` : "";
    refs.linkedDevice.textContent = `${deviceName}${deviceId}`;
  } else {
    refs.linkedDevice.textContent = "Dispositivo conectado";
  }
}

function openCallWindow(phone, opts = {}) {
  callCtx = { phone, ...opts };
  refs.callModalEl.style.display = "grid";
  refs.callNameEl.textContent = opts.contactName || opts.companyName || "Sin contacto";
  refs.callNumberEl.textContent = phone || "-";
  refs.callNoteEl.textContent = opts.note || "—";
  refs.callKickerEl.textContent = "Llamando...";
  refs.callHintEl.textContent = currentPhoneLinked
    ? "La orden se está enviando a la APK vinculada."
    : "No hay APK vinculada. La orden puede quedar pendiente.";
  setBadge("dialing", refs.callBadgeEl);
}

function closeCallWindowSoon() {
  window.setTimeout(() => {
    if (currentState === "idle") refs.callModalEl.style.display = "none";
  }, 2000);
}

function applyState(state, lastNum, meta = {}) {
  currentState = state || "idle";
  setBadge(currentState, refs.callBadgeEl);

  if (meta.contactName) refs.callNameEl.textContent = meta.contactName;
  if (lastNum) refs.callNumberEl.textContent = lastNum;

  if (currentState === "dialing") refs.callKickerEl.textContent = "Llamando...";
  if (currentState === "ringing") refs.callKickerEl.textContent = "Sonando...";
  if (currentState === "in_call") refs.callKickerEl.textContent = "En llamada";
  if (currentState === "ended") refs.callKickerEl.textContent = "Finalizada";
  if (currentState === "idle") refs.callKickerEl.textContent = "En espera";

  if (currentState === "in_call") {
    AudioBridge.setPhoneAudioEnabled(true);
    AudioBridge.ensurePhoneAudioCtx();
    AudioBridge.startWebMicStreaming();
  }

  if (currentState === "ended" || currentState === "idle") {
    AudioBridge.stopPhoneAudio();
    if (currentState === "idle") closeCallWindowSoon();
  }
}

function clearCommandTimeout(commandId) {
  const timeoutId = pendingCommandTimeouts.get(commandId);
  if (timeoutId) {
    clearTimeout(timeoutId);
    pendingCommandTimeouts.delete(commandId);
  }
}

function emitCallActionWithAck(action, payload = {}) {
  const commandId = crypto.randomUUID();
  socket.emit("call:action", { action, commandId, ...payload });
  setAckBadge(refs.apkAckBadgeEl, "pending", `APK · ${action}...`);

  const timeoutId = window.setTimeout(() => {
    pendingCommandTimeouts.delete(commandId);
    setAckBadge(refs.apkAckBadgeEl, "timeout", `APK · ${action} sin respuesta`);
  }, 8000);

  pendingCommandTimeouts.set(commandId, timeoutId);
  return commandId;
}

function startDialForContact(contact) {
  if (["dialing", "ringing", "in_call"].includes(currentState)) return;

  currentCallingContactId = contact.id;
  Contacts.calledCounts[contact.id] = Number(Contacts.calledCounts[contact.id] || 0) + 1;
  Contacts.saveCalledCounts();
  renderContacts();

  openCallWindow(contact.phone, { contactName: contact.name, note: contact.note });
  applyState("dialing", contact.phone, { contactName: contact.name });
  emitCallActionWithAck("dial", {
    phoneNumber: contact.phone,
    contactName: contact.name,
    companyName: contact.name
  });
}

function toggleMute() {
  micEnabled = !micEnabled;
  refs.micBadgeEl.textContent = micEnabled ? "🎙️ mic activo" : "🔇 mic silenciado";
  refs.muteBtnEl.textContent = micEnabled ? "🎙️ Micrófono" : "🔇 Activar mic";
  emitCallActionWithAck(micEnabled ? "unmute" : "mute");
}

function toggleSpeaker() {
  speakerEnabled = !speakerEnabled;
  refs.speakerBtnEl.textContent = speakerEnabled ? "🔈 Auricular" : "🔊 Altavoz";
  emitCallActionWithAck(speakerEnabled ? "speaker_on" : "speaker_off");
}

async function copyPairLink() {
  const value = refs.pairLinkEl.value.trim();
  if (!value) return;

  try {
    await navigator.clipboard.writeText(value);
    updateStatusFromConnectivity("Link de vinculación copiado.");
  } catch {
    refs.pairLinkEl.select();
    document.execCommand("copy");
    updateStatusFromConnectivity("Link de vinculación copiado.");
  }
}

async function loadPairingData(code) {
  try {
    const res = await fetch(`${API_BASE}/api/pairing/${code}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "No se pudo obtener el pairing");

    refs.pairLinkEl.value = data.link;
    refs.pairQrEl.src = `${API_BASE}/api/pairing-qr/${code}.svg?ts=${Date.now()}`;
    refs.pairQrEl.style.display = "block";
    refs.qrHintEl.textContent = "Escanea este QR con la APK.";
  } catch (error) {
    updateStatusFromConnectivity(error.message || "No se pudo cargar el pairing.");
  }
}

function updateApkDownloadLink(id = "") {
  refs.apkDlBtn.href = id ? `${API_BASE}/api/apk/download/${encodeURIComponent(id)}` : `${API_BASE}/api/apk/download`;
}

async function loadApkInfo() {
  try {
    const [infoRes, versionsRes] = await Promise.all([
      fetch(`${API_BASE}/api/apk/info`),
      fetch(`${API_BASE}/api/apk/versions`)
    ]);
    const info = await infoRes.json();
    const versions = await versionsRes.json();

    if (info.ok) {
      refs.apkNameEl.textContent = info.name;
      refs.apkMetaEl.textContent = `${info.version} · ${info.type} · ${info.sizeKb} KB`;
    }

    refs.apkVersionSelectEl.innerHTML = '<option value="">Versiones...</option>';
    if (versions.ok) {
      for (const version of versions.versions) {
        const option = document.createElement("option");
        option.value = version.id;
        option.textContent = `${version.version} · ${version.type} · ${version.sizeKb} KB`;
        refs.apkVersionSelectEl.appendChild(option);
      }
      if (versions.latestId) {
        refs.apkVersionSelectEl.value = versions.latestId;
        updateApkDownloadLink(versions.latestId);
      }
    } else {
      updateApkDownloadLink("");
    }
  } catch {
    refs.apkMetaEl.textContent = "No se pudo cargar la información del APK.";
  }
}

function bindEvents() {
  refs.createBtn.onclick = () => socket.emit("session:create");
  refs.joinBtn.onclick = () => {
    const code = refs.sessionCodeIn.value.trim().toUpperCase();
    if (!code) return;
    sessionCode = code;
    socket.emit("session:join", { code, role: "dashboard" });
    loadPairingData(code);
  };

  refs.sessionCodeIn.addEventListener("keydown", (event) => {
    if (event.key === "Enter") refs.joinBtn.click();
  });

  refs.addContactBtn.onclick = saveInlineContact;
  refs.floatingAddContactBtn.onclick = openAddModal;
  refs.addCloseBtn.onclick = closeAddModal;
  refs.addSaveBtn.onclick = saveNewContact;
  refs.editCloseBtn.onclick = closeEditModal;
  refs.editSaveBtn.onclick = saveEditedContact;
  refs.copyBtn.onclick = copyPairLink;

  refs.prevPageBtn.onclick = () => {
    if (currentPage <= 1) return;
    currentPage -= 1;
    renderContacts();
  };
  refs.nextPageBtn.onclick = () => {
    const totalPages = Math.max(1, Math.ceil(Contacts.contacts.length / PAGE_SIZE));
    if (currentPage >= totalPages) return;
    currentPage += 1;
    renderContacts();
  };

  refs.apkHelpBtn.onclick = () => {
    refs.installGuide.style.display = refs.installGuide.style.display === "none" ? "block" : "none";
  };
  refs.apkVersionSelectEl.onchange = () => updateApkDownloadLink(refs.apkVersionSelectEl.value);

  refs.cBodyEl.onclick = (event) => {
    const btn = event.target.closest("button[data-action]");
    if (!btn) return;

    const contact = Contacts.contacts.find((item) => item.id === btn.dataset.id);
    if (!contact) return;

    if (btn.dataset.action === "edit") openEditModal(contact);
    if (btn.dataset.action === "dial") startDialForContact(contact);
    if (btn.dataset.action === "delete") {
      if (!confirm(`¿Eliminar a ${contact.name}?`)) return;
      Contacts.deleteContact(contact.id);
      renderContacts();
      updateStatusFromConnectivity(`Contacto eliminado: ${contact.name}`);
    }
  };

  refs.hangupBtnEl.onclick = () => {
    emitCallActionWithAck("hangup");
    applyState("ended", callCtx?.phone || "");
  };
  refs.muteBtnEl.onclick = toggleMute;
  refs.speakerBtnEl.onclick = toggleSpeaker;

  refs.openQuotationBtn.onclick = () => {
    Quotation.resetQuotationForm();
    refs.quotationModalEl.style.display = "grid";
  };
  refs.quotationCloseBtn.onclick = () => {
    refs.quotationModalEl.style.display = "none";
  };
  refs.quotationPreviewCloseBtn.onclick = () => {
    refs.quotationPreviewModalEl.style.display = "none";
  };
  refs.quotationPreviewBtn.onclick = () => Quotation.previewQuotationHtml();
  refs.quotationDownloadBtn.onclick = () => Quotation.downloadQuotationPdf();
  refs.quotationPreviewDownloadBtn.onclick = () => Quotation.downloadQuotationPdf();
}

function bindSocketEvents() {
  socket.on("connect", () => updateStatusFromConnectivity("Dashboard conectado."));
  socket.on("disconnect", () => setStatus("Sin conexión con el server.", false));

  socket.on("state:changed", (state) => {
    updateLinkedUi(state);
    applyState(state.callState, state.lastNumber, { contactName: state.lastContactName });

    const statusMessage = currentPhoneLinked
      ? `Sesión ${sessionCode || refs.sessionCodeIn.value || "activa"} · APK vinculada`
      : "Sesión activa, esperando APK.";
    updateStatusFromConnectivity(statusMessage);
  });

  socket.on("phone:command_ack", ({ commandId, ok, message, action }) => {
    clearCommandTimeout(commandId);
    setAckBadge(
      refs.apkAckBadgeEl,
      ok ? "ok" : "error",
      ok ? `APK · ${action} OK` : `APK · ${message || "error"}`
    );
  });

  socket.on("session:created", ({ code }) => {
    sessionCode = code;
    refs.sessionCodeIn.value = code;
    loadPairingData(code);
    updateStatusFromConnectivity(`Sesión creada: ${code}`);
  });

  socket.on("session:joined", ({ code }) => {
    sessionCode = code;
    refs.sessionCodeIn.value = code;
    updateStatusFromConnectivity(`Sesión vinculada: ${code}`);
  });

  socket.on("session:error", ({ message }) => {
    updateStatusFromConnectivity(message || "Error de sesión.");
  });
}

function init() {
  Contacts.loadContacts();
  Contacts.loadCalledCounts();
  Contacts.loadContactRowStatus();
  Contacts.loadDismissedReminders();

  renderContacts();
  bindEvents();
  bindSocketEvents();
  Quotation.bindQuotationEvents();
  Quotation.resetQuotationForm();
  loadApkInfo();

  refs.floatingAddContactBtn.style.display = "inline-flex";
  setAckBadge(refs.apkAckBadgeEl, "", "APK · —");
  refs.micBadgeEl.textContent = "🎙️ mic activo";
  updateStatusFromConnectivity("Listo.");
}

init();
