import { socket, API_BASE } from './modules/socket.js?v=2';
import { refs, setStatus, setBadge, setAckBadge } from './modules/dom.js?v=2';
import * as Contacts from './modules/contacts.js?v=3';
import * as AudioBridge from './modules/audio-bridge.js?v=2';

// ── STATE ──────────────────────────────────────────────────────────────
let sessionCode = "";
let pairLink = "";
let callCtx = null;
let callTimerId = null;
let callStartedAt = null;
let lastCallDuration = 0;
let currentState = "idle";
let micEnabled = false;
let speakerEnabled = false;
let importPreviewData = [];
let currentPage = 1;
let currentCallingContactId = null;
let currentPhoneLinked = false;
let latestSessionState = {};
let campaignState = null;
let campaignStartPending = false;
let pairingConnectionSignature = "";
const pendingCommandTimeouts = new Map();
const PAGE_SIZE = 20;
const DASHBOARD_SESSION_KEY = "voip vc.dashboardSessionCode";
let restoreAttempted = false;
let workspaceSaveTimer = null;
let workspaceHydrating = false;

// ── INITIALIZATION ──────────────────────────────────────────────────
async function init() {
  console.log("Dashboard init starting...");
  Contacts.loadContacts();
  Contacts.loadCalledCounts();
  Contacts.loadContactRowStatus();
  Contacts.loadCallDurations();
  Contacts.loadDismissedReminders();
  Contacts.setPersistenceListener(scheduleWorkspaceSave);
  
  renderContacts();
  loadApkInfo().catch(e => console.error("Error loading APK info:", e));
  bindEvents();
  syncAudioButtons();
  renderCampaignPanel();
  renderCampaignPanel();
  restoreSavedSession();
  
  setStatus("Listo.");
  console.log("Dashboard init complete.");
}

// ── UI RENDERING ──────────────────────────────────────────────────────
function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function makeId() {
  return (typeof crypto.randomUUID === "function")
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function showCustomConfirm(title, message, okText = "Eliminar", isDanger = true) {
  window.showCustomConfirm = showCustomConfirm;
  return new Promise((resolve) => {
    const modal = document.getElementById("confirmModal");
    const titleEl = document.getElementById("confirmTitle");
    const msgEl = document.getElementById("confirmMessage");
    const okBtn = document.getElementById("confirmOkBtn");
    const cancelBtn = document.getElementById("confirmCancelBtn");
    
    if (!modal || !titleEl || !msgEl || !okBtn || !cancelBtn) {
      resolve(confirm(message));
      return;
    }
    
    titleEl.textContent = title;
    msgEl.textContent = message;
    okBtn.textContent = okText;
    
    if (isDanger) {
      okBtn.className = "danger-soft";
      okBtn.style.background = "rgba(220, 38, 38, 0.1)";
      okBtn.style.color = "#dc2626";
      okBtn.style.border = "1px solid rgba(220, 38, 38, 0.25)";
    } else {
      okBtn.className = "primary";
      okBtn.style.background = "var(--accent)";
      okBtn.style.color = "#fff";
      okBtn.style.border = "none";
    }
    
    modal.style.display = "flex";
    
    okBtn.onclick = () => {
      modal.style.display = "none";
      resolve(true);
    };
    
    cancelBtn.onclick = () => {
      modal.style.display = "none";
      resolve(false);
    };
    
    modal.onclick = (e) => {
      if (e.target === modal) {
        modal.style.display = "none";
        resolve(false);
      }
    };
  });
}

function normalizePhone(input) {
  return String(input || "").replace(/[^\d+]/g, "").trim();
}

function normalizeImportedPhone(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  return raw.startsWith("+") ? `+${digits}` : digits;
}

function normalizePeruvianMobilePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (/^9\d{8}$/.test(digits)) return digits;
  if (/^519\d{8}$/.test(digits)) return digits.slice(2);
  return "";
}

function importDetectionMessage({ accepted, rejected }, source = "archivo") {
  if (!accepted) {
    return rejected
      ? `No se importaron contactos: se descartaron ${rejected} números fijos o no móviles.`
      : `No se detectaron contactos en el ${source}.`;
  }
  const discarded = rejected
    ? ` Se descartaron ${rejected} números fijos o no móviles.`
    : "";
  return `Se detectaron ${accepted} celulares${source === "URL" ? " desde la URL" : ""}.${discarded}`;
}

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function mapRowByHeaders(row, headers) {
  const out = {};
  headers.forEach((header, index) => {
    out[header] = row[index];
  });
  return out;
}

function buildContactFromStructuredRow(row, fallbackIndex) {
  const entries = Object.entries(row || {});
  const normalized = Object.fromEntries(entries.map(([key, value]) => [normalizeHeader(key), String(value || "").trim()]));

  const rawName =
    normalized.name ||
    normalized.nombre ||
    normalized.company ||
    normalized.empresa ||
    normalized.businessname ||
    "";

  const rawPhone =
    normalized.mobilenumber ||
    normalized.mobile ||
    normalized.phone ||
    normalized.telefono ||
    normalized.telefono1 ||
    normalized.celular ||
    normalized.whatsapp ||
    normalized.tel ||
    "";

  const rawWebsite =
    normalized.website ||
    normalized.web ||
    normalized.url ||
    normalized.sitio ||
    "";

  const fallbackValues = entries.map(([, value]) => String(value || "").trim()).filter(Boolean);
  const detectedPhone = rawPhone || fallbackValues.find(v => /\+?\d[\d\s().-]{5,}/.test(v)) || "";
  if (!detectedPhone) return null;

  const detectedName =
    rawName ||
    fallbackValues.find(v => !/\+?\d[\d\s().-]{5,}/.test(v) && /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(v) && !/^https?:\/\//i.test(v) && !/^tel:/i.test(v)) ||
    `Contacto ${fallbackIndex + 1}`;

  const noteParts = [];
  if (rawWebsite) noteParts.push(rawWebsite);
  for (const value of fallbackValues) {
    if (value === detectedName || value === detectedPhone || value === rawWebsite) continue;
    if (!noteParts.includes(value)) noteParts.push(value);
  }

  return {
    id: makeId(),
    name: detectedName,
    phone: normalizeImportedPhone(detectedPhone),
    note: noteParts.join(" ").trim()
  };
}

function buildContactFromTableArrayRow(row, fallbackIndex) {
  const values = (row || []).map((value) => String(value || "").trim());
  if (!values.length) return null;

  const first = values[0] || "";
  const second = values[1] || "";
  const third = values[2] || "";
  const fourth = values[3] || "";

  const firstIsPhone = /\+?\d[\d\s().-]{5,}/.test(first);
  const secondIsPhone = /\+?\d[\d\s().-]{5,}/.test(second);

  const detectedName = !firstIsPhone && /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(first)
    ? first
    : (!secondIsPhone && /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(second) ? second : `Contacto ${fallbackIndex + 1}`);

  const detectedPhone = secondIsPhone
    ? second
    : (firstIsPhone ? first : "");

  if (!detectedPhone) return null;

  const noteParts = [third, fourth]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return {
    id: makeId(),
    name: detectedName,
    phone: normalizeImportedPhone(detectedPhone),
    note: noteParts.join(" ").trim()
  };
}

function extractContactsFromHtmlTable(doc) {
  const tables = [...doc.querySelectorAll("table")];
  for (const table of tables) {
    const rows = [...table.querySelectorAll("tr")];
    if (rows.length < 2) continue;

    const headerCells = [...rows[0].querySelectorAll("th,td")].map((cell) => normalizeHeader(cell.textContent || ""));
    const nameIdx = headerCells.findIndex((header) => ["name", "nombre", "company", "empresa", "businessname"].includes(header));
    const phoneIdx = headerCells.findIndex((header) => ["mobilenumber", "mobile", "phone", "telefono", "celular", "tel", "whatsapp"].includes(header));
    const websiteIdx = headerCells.findIndex((header) => ["website", "web", "url", "sitio"].includes(header));

    if (nameIdx === -1 && phoneIdx === -1) continue;

    const contacts = [];
    for (const row of rows.slice(1)) {
      const cols = [...row.querySelectorAll("th,td")].map((cell) => String(cell.textContent || "").trim());
      if (!cols.some(Boolean)) continue;

      const name = String(cols[nameIdx] || "").trim();
      const phone = normalizeImportedPhone(cols[phoneIdx] || "");
      const website = websiteIdx >= 0 ? String(cols[websiteIdx] || "").trim() : "";

      if (!phone) continue;
      contacts.push({
        id: makeId(),
        name: name || `Contacto ${contacts.length + 1}`,
        phone,
        note: website
      });
    }

    if (contacts.length) return contacts;
  }

  return [];
}

function extractContactsFromRows(rows) {
  const out = [];
  const list = rows || [];
  if (!list.length) return out;

  const firstRow = list[0];
  const headerCandidates = Array.isArray(firstRow) ? firstRow.map(normalizeHeader) : Object.keys(firstRow || {}).map(normalizeHeader);
  const hasStructuredHeaders = headerCandidates.some((header) =>
    ["name", "nombre", "mobilenumber", "mobile", "phone", "telefono", "celular", "website", "web", "url"].includes(header)
  );

  const structuredRows = hasStructuredHeaders
    ? list.slice(1).map((row) => Array.isArray(row) ? mapRowByHeaders(row, firstRow) : row)
    : list;

  for (const row of structuredRows) {
    if (Array.isArray(row)) {
      const tableContact = buildContactFromTableArrayRow(row, out.length);
      if (tableContact?.phone) {
        out.push(tableContact);
        continue;
      }
    }
    const contact = buildContactFromStructuredRow(row, out.length);
    if (!contact?.phone) continue;
    out.push(contact);
  }
  return out;
}

function parseDelimitedText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const rows = lines.map((line) => {
    if (line.includes("\t")) return line.split("\t");
    if (line.includes(";")) return line.split(";");
    return line.split(",");
  });
  return extractContactsFromRows(rows);
}

function showImportPreview(items) {
  const normalizedItems = (items || []).map((item) => ({
    ...item,
    phone: normalizePeruvianMobilePhone(item.phone)
  }));
  const mobileItems = normalizedItems.filter((item) => Boolean(item.phone));
  const rejected = normalizedItems.length - mobileItems.length;
  importPreviewData = mobileItems.slice(0, 500);
  refs.previewBody.innerHTML = "";
  refs.previewCountEl.textContent = String(importPreviewData.length);

  const fragment = document.createDocumentFragment();
  for (const item of importPreviewData) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escHtml(item.name)}</td>
      <td style="font-family:monospace;">${escHtml(item.phone)}</td>
      <td>${escHtml(item.note || "—")}</td>
    `;
    fragment.appendChild(tr);
  }
  refs.previewBody.appendChild(fragment);

  refs.importPreview.style.display = importPreviewData.length ? "block" : "none";
  return { accepted: importPreviewData.length, rejected };
}

function resetImportPreview() {
  importPreviewData = [];
  refs.previewBody.innerHTML = "";
  refs.previewCountEl.textContent = "0";
  refs.importPreview.style.display = "none";
}

let currentImportFileName = ""; // Global variable to store the current import file name

function addImportedContacts() {
  if (!importPreviewData.length) return;
  
  const defaultTab = currentImportFileName ? currentImportFileName.split('.')[0] : "Lista Nueva";
  const listName = window.prompt("Nombre para esta lista (Tab):", defaultTab) || defaultTab;
  
  Contacts.addList(listName);
  Contacts.addContacts(importPreviewData, listName);
  
  setStatus(`Importados ${importPreviewData.length} contactos a la lista "${listName}".`, true);
  resetImportPreview();
  renderTabs();
  // Set active tab to the new one
  Contacts.setActiveList(listName);
  renderContacts();
}

async function handleImportFile(file) {
  if (!file) return;
  refs.importFileNameEl.textContent = file.name;
  currentImportFileName = file.name; // Store the file name

  const lowerName = file.name.toLowerCase();
  try {
    let contacts = [];

    if (lowerName.endsWith(".csv") || lowerName.endsWith(".txt")) {
      contacts = parseDelimitedText(await file.text());
    } else if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls")) {
      const data = await file.arrayBuffer();
      const wb = window.XLSX.read(data, { type: "array" });
      const firstSheet = wb.SheetNames[0];
      const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[firstSheet], { header: 1 });
      contacts = extractContactsFromRows(rows);
    } else if (lowerName.endsWith(".docx")) {
      const data = await file.arrayBuffer();
      const htmlResult = await window.mammoth.convertToHtml({ arrayBuffer: data });
      const doc = new DOMParser().parseFromString(htmlResult.value || "", "text/html");
      contacts = extractContactsFromHtmlTable(doc);
      if (!contacts.length) {
        const textResult = await window.mammoth.extractRawText({ arrayBuffer: data });
        contacts = parseDelimitedText(textResult.value);
      }
    } else {
      setStatus("Formato no soportado. Usa .docx, .xlsx, .xls, .csv o .txt", true);
      return;
    }

    const stats = showImportPreview(contacts);
    setStatus(importDetectionMessage(stats, "archivo"), true);
  } catch (error) {
    console.error("Import file error:", error);
    setStatus("No se pudo leer el archivo importado.", true);
  }
}

async function handleImportUrl() {
  const url = String(refs.importUrlEl.value || "").trim();
  if (!url) {
    setStatus("Pega una URL para importar.", true);
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/fetch-url?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!res.ok || !data.ok || !data.html) {
      setStatus(data.error || "No se pudo leer la URL.", true);
      return;
    }

    const doc = new DOMParser().parseFromString(data.html, "text/html");
    const directTableContacts = extractContactsFromHtmlTable(doc);
    if (directTableContacts.length) {
      const stats = showImportPreview(directTableContacts);
      setStatus(importDetectionMessage(stats, "URL"), true);
      return;
    }

    const rows = [];
    doc.querySelectorAll("table tr").forEach((tr) => {
      const cols = [...tr.querySelectorAll("th,td")].map((el) => el.textContent?.trim() || "");
      if (cols.some(Boolean)) rows.push(cols);
    });
    if (!rows.length) {
      doc.querySelectorAll("li, p").forEach((el) => {
        const text = el.textContent?.trim() || "";
        if (text) rows.push([text]);
      });
    }

    const contacts = extractContactsFromRows(rows);
    const stats = showImportPreview(contacts);
    setStatus(importDetectionMessage(stats, "URL"), true);
  } catch (error) {
    console.error("Import URL error:", error);
    setStatus("No se pudo importar desde la URL.", true);
  }
}

function addManualContact() {
  const name = String(refs.cNameIn?.value || "").trim();
  const phone = normalizeImportedPhone(refs.cPhoneIn?.value || "");
  const note = String(refs.cNoteIn?.value || "").trim();

  if (!name || !phone) {
    setStatus("Completa nombre y teléfono.", true);
    return;
  }

  Contacts.addContact({ id: makeId(), name, phone, note }, Contacts.activeList);
  refs.cNameIn.value = "";
  refs.cPhoneIn.value = "";
  refs.cNoteIn.value = "";
  renderContacts();
  setStatus("Contacto agregado.", true);
}

function renderContacts() {
  updateCalledContactsCounter();
  const cBodyEl = refs.cBodyEl;
  cBodyEl.innerHTML = "";
  
  // Filter by active list
  const allContacts = Contacts.contacts;
  const contacts = allContacts.filter(c => c.list === Contacts.activeList);
  
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

  const fragment = document.createDocumentFragment();
  for (const c of pageRows) {
    const tr = document.createElement("tr");
    const callCount = Number(Contacts.calledCounts[c.id] || 0);
    const rowStatus = String(Contacts.contactRowStatus[c.id] || "").toLowerCase();
    const duration = Number(Contacts.callDurations[c.id] || 0);
    const campaignContact = getCampaignContactMap().get(c.id);
    
    const isThisActiveCall = (currentState === "in_call" || currentState === "ringing" || currentState === "dialing") && normalizePhone(callCtx?.phone) === normalizePhone(c.phone);

    if (callCount > 0) tr.classList.add("contact-row-called");
    if (duration > 0) tr.classList.add("contact-row-answered");
    if (["r", "lc", "sc"].includes(rowStatus)) tr.classList.add(`contact-row-status-${rowStatus}`);
    
    if (campaignState?.activeContactId === c.id || isThisActiveCall) {
        tr.classList.add(currentState === "in_call" ? "contact-row-active-in-call" : "contact-row-active-call");
    }
    
    tr.innerHTML = `
      <td>${escHtml(c.name)}</td>
      <td style="font-family:monospace;font-size:13px;">${escHtml(c.phone)}</td>
      <td>
        ${escHtml(c.note || "—")}
        ${callCount > 0 ? `<span class="call-count-chip">📞 ${callCount}</span>` : ""}
        ${duration > 0 ? `<span class="duration-chip">⏱️ ${formatCallDuration(duration)}</span>` : ""}
        ${campaignContact?.status ? `<span class="campaign-status-chip state-${escHtml(campaignContact.status)}">${escHtml(campaignContact.status.replaceAll("_", " "))}</span>` : ""}
      </td>
      <td class="actions-cell">
        <button data-action="edit" data-id="${c.id}" class="secondary">✏️</button>
        <button data-action="delete" data-id="${c.id}" class="secondary">🗑️</button>
      </td>`;
    fragment.appendChild(tr);
  }
  cBodyEl.appendChild(fragment);

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
    if (!refs.reminderFloatContainer) return;
    refs.reminderFloatContainer.innerHTML = "";
    
    const now = Date.now();
    const reminders = Contacts.contacts.filter(c => {
        if (!c.note || Contacts.dismissedReminderIds[c.id]) return false;
        return c.note.toLowerCase().includes("llamar") || c.note.toLowerCase().includes("callback");
    });
    
    if (!reminders.length) return;
    
    reminders.slice(0, 3).forEach(c => {
        const div = document.createElement("div");
        div.className = "reminder-float-item";
        div.innerHTML = `
            <div class="reminder-content">
                <strong>Recordatorio: ${escHtml(c.name)}</strong>
                <p>${escHtml(c.note)}</p>
            </div>
            <div class="reminder-actions">
                <button onclick="dialManual('${escHtml(c.phone)}', '${escHtml(c.name)}')">📞</button>
                <button onclick="dismissReminder('${escHtml(c.id)}')">✕</button>
            </div>
        `;
        refs.reminderFloatContainer.appendChild(div);
    });
}

window.dismissReminder = (id) => {
    Contacts.dismissedReminderIds[id] = true;
    Contacts.saveDismissedReminders();
    renderReminderFloat();
};

function syncAudioButtons() {
  if (refs.muteBtnEl) {
    refs.muteBtnEl.textContent = micEnabled ? "🎙️ Micrófono" : "🔇 Micrófono";
    refs.muteBtnEl.classList.toggle("btn-audio-active", micEnabled);
  }
  if (refs.speakerBtnEl) {
    refs.speakerBtnEl.textContent = speakerEnabled ? "🔊 Altavoz activo" : "🔈 Altavoz";
    refs.speakerBtnEl.classList.toggle("btn-audio-active", speakerEnabled);
  }
  if (refs.micBadgeEl) {
    refs.micBadgeEl.textContent = micEnabled ? "🎙️ Mic activo" : "🔇 Mic apagado";
    refs.micBadgeEl.classList.toggle("is-active", micEnabled);
    refs.micBadgeEl.classList.toggle("muted", !micEnabled);
  }
}

function saveSessionCode(code) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return;
  localStorage.setItem(DASHBOARD_SESSION_KEY, normalized);
}

function getSavedSessionCode() {
  return String(localStorage.getItem(DASHBOARD_SESSION_KEY) || "").trim().toUpperCase();
}

function getCampaignContactMap() {
  return new Map((campaignState?.contacts || []).map((contact) => [contact.id, contact]));
}

function getActiveCampaignContact() {
  if (!campaignState?.activeContactId) return null;
  return getCampaignContactMap().get(campaignState.activeContactId) || null;
}

function getVisibleCallContactId() {
  const activeContacts = campaignState?.activeContacts || [];
  const visibleNumber = normalizePhone(callCtx?.phone || latestSessionState?.lastNumber || "");
  const byNumber = activeContacts.find((contact) =>
    visibleNumber && normalizePhone(contact.phone) === visibleNumber
  );
  if (byNumber) return byNumber.id;
  const byLocalId = activeContacts.find((contact) => contact.id === currentCallingContactId);
  if (byLocalId) return byLocalId.id;
  return activeContacts.length === 1 ? activeContacts[0].id : "";
}

function campaignCounter(label, value, tone = "") {
  return `<div class="campaign-counter ${tone}"><span>${escHtml(label)}</span><strong>${value}</strong></div>`;
}

function renderCampaignPanel() {
  const counts = campaignState?.counts || {};
  const active = getActiveCampaignContact();
  const callbacks = campaignState?.callbacks || [];
  const pendingCallbacks = callbacks.filter(c => c.status === "pending").length;

  if (refs.callbacksSummaryEl) {
    refs.callbacksSummaryEl.textContent = `${pendingCallbacks} pendientes`;
  }

  if (refs.campaignStatusLineEl) {
    const status = String(campaignState?.status || "idle");
    const labelMap = {
      idle: "Sin campaña activa.",
      running: "Campaña corriendo.",
      paused: active
        ? "Pausada: la llamada actual continúa. Al terminar no se llamará al siguiente."
        : "Campaña pausada. No se realizarán nuevas llamadas.",
      completed: "Campaña completada."
    };
    refs.campaignStatusLineEl.textContent = labelMap[status] || `Campaña ${status}`;
  }

  if (refs.campaignCountersEl) {
    refs.campaignCountersEl.innerHTML = [
      campaignCounter("Pendientes", counts.pending || 0),
      campaignCounter("Llamando", (counts.dialing || 0) + (counts.ringing || 0), "warn"),
      campaignCounter("En llamada", counts.in_call || 0, "ok"),
      campaignCounter("Completados", counts.completed || 0, "ok"),
      campaignCounter("Fallidos", counts.failed || 0, "danger")
    ].join("");
  }

  if (refs.campaignActiveCardEl) {
    refs.campaignActiveCardEl.innerHTML = active
      ? `
        <div class="campaign-active-card">
          <strong>${escHtml(active.name)}</strong>
          <span>${escHtml(active.phone)}</span>
          <small>${escHtml(active.note || "Sin nota")}</small>
          <small>Intentos: ${active.attempts || 0}${active.assignedWorkerId ? ` · Worker: ${escHtml(active.assignedWorkerId)}` : ""}</small>
        </div>
      `
      : `<div class="campaign-list-empty">Sin contacto activo.</div>`;
  }

  const disableResult = !active;
  if (refs.campaignResultAgendaBtn) refs.campaignResultAgendaBtn.disabled = disableResult;
  if (refs.campaignResultNoBtn) refs.campaignResultNoBtn.disabled = disableResult;
  if (refs.campaignResultAdvisorBtn) refs.campaignResultAdvisorBtn.disabled = disableResult;
  if (refs.campaignResultRetryBtn) refs.campaignResultRetryBtn.disabled = disableResult;
  if (refs.campaignPauseBtn) refs.campaignPauseBtn.disabled = campaignState?.status !== "running";
  if (refs.campaignResumeBtn) refs.campaignResumeBtn.disabled = !["paused", "idle"].includes(String(campaignState?.status || "idle"));
  if (refs.campaignSkipBtn) refs.campaignSkipBtn.disabled = disableResult;
  if (refs.campaignForceReleaseBtn) {
    const hasQuarantine = Boolean(
      campaignState?.quarantinedCalls?.length || campaignState?.quarantinedContactIds?.length
    );
    refs.campaignForceReleaseBtn.style.display = hasQuarantine ? "inline-flex" : "none";
    refs.campaignForceReleaseBtn.disabled = !hasQuarantine;
  }
  if (refs.campaignStartBtn) {
    const status = String(campaignState?.status || "idle");
    const campaignBusy = campaignStartPending || ["running", "paused"].includes(status);
    refs.campaignStartBtn.disabled = campaignBusy;
    refs.campaignStartBtn.textContent = campaignStartPending
      ? "⏳ Iniciando..."
      : campaignBusy
        ? "🔒 Llamada general activa"
        : "▶ Iniciar llamada general";
  }

  if (refs.callbacksListEl) {
    refs.callbacksListEl.innerHTML = callbacks.length
      ? callbacks.map((item) => `
          <div class="callback-item ${item.status === "completed" ? "is-completed" : ""}">
            <strong>${escHtml(item.name || "Contacto")}</strong>
            <span>${escHtml(item.phone || "-")}</span>
            <small>${escHtml(item.reason || "Sin motivo")}</small>
            <small>${escHtml(item.advisor ? `Asesor: ${item.advisor}` : "Asesor sin asignar")}</small>
          </div>
        `).join("")
      : `<div class="campaign-list-empty">Sin callbacks pendientes.</div>`;
  }
}

async function fetchCampaignState(code = sessionCode) {
  if (!code) return;
  try {
    const res = await fetch(`${API_BASE}/api/session/${encodeURIComponent(code)}/campaign`);
    const data = await res.json();
    if (!res.ok || !data.ok) return;
    campaignState = data.campaign || null;
    renderCampaignPanel();
  } catch (error) {
    console.error("Campaign state fetch error:", error);
  }
}

async function postCampaignAction(path, body = {}) {
  if (!sessionCode) {
    setStatus("Crea o restaura una sesión primero.", true);
    return null;
  }

  try {
    const res = await fetch(`${API_BASE}/api/session/${encodeURIComponent(sessionCode)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      setStatus(data.error || "No se pudo ejecutar la acción de campaña.", true);
      return null;
    }
    campaignState = data.campaign || campaignState;
    renderCampaignPanel();
    return data;
  } catch (error) {
    console.error("Campaign action error:", error);
    setStatus("No se pudo comunicar la acción de campaña.", true);
    return null;
  }
}

async function saveVoiceAgentConfig(enabled) {
  void enabled;
  setStatus("Agente de voz desactivado por ahora.");
  return null;
}

async function startCampaignRun() {
  if (
    campaignStartPending ||
    ["running", "paused"].includes(String(campaignState?.status || "idle"))
  ) {
    setStatus("La llamada general ya está activa.", true);
    return;
  }

  const queuedContacts = Contacts.contacts.filter(
    (contact) => contact.list === Contacts.activeList
  );
  if (!queuedContacts.length) {
    setStatus("Importa o agrega contactos antes de iniciar la campaña.", true);
    return;
  }
  campaignStartPending = true;
  renderCampaignPanel();
  try {
    const data = await postCampaignAction("/campaign/start", {
      contacts: queuedContacts.map((contact) => ({
        id: contact.id,
        name: contact.name,
        phone: contact.phone,
        note: contact.note || ""
      }))
    });
    if (data) {
      const accepted = data.campaign?.contacts?.length || 0;
      setStatus(`Llamada general iniciada: ${accepted} celulares válidos en cola.`, true);
    }
  } finally {
    campaignStartPending = false;
    renderCampaignPanel();
  }
}

function getWorkspaceSnapshot() {
  return { ...Contacts.getSnapshot(), callHistory };
}

function scheduleWorkspaceSave() {
  if (!sessionCode || workspaceHydrating) return;
  clearTimeout(workspaceSaveTimer);
  workspaceSaveTimer = setTimeout(() => saveWorkspaceToSupabase(), 500);
}

async function saveWorkspaceToSupabase() {
  if (!sessionCode || workspaceHydrating) return;
  const code = sessionCode;
  try {
    const response = await fetch(`${API_BASE}/api/session/${encodeURIComponent(code)}/workspace`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: getWorkspaceSnapshot() })
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
  } catch (error) {
    console.error("No se pudo guardar la sesión en Supabase:", error);
  }
}

async function loadWorkspaceFromSupabase(code) {
  try {
    const response = await fetch(`${API_BASE}/api/session/${encodeURIComponent(code)}/workspace`);
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
    const data = await response.json();
    if (!data.workspace) {
      scheduleWorkspaceSave(); // migración única de los datos locales existentes
      return;
    }
    workspaceHydrating = true;
    Contacts.applySnapshot(data.workspace);
    callHistory = Array.isArray(data.workspace.callHistory) ? data.workspace.callHistory : [];
    workspaceHydrating = false;
    renderTabs();
    renderContacts();
    renderReminderFloat();
    setStatus("Sesión recuperada desde Supabase.", true);
  } catch (error) {
    workspaceHydrating = false;
    console.error("No se pudo recuperar la sesión desde Supabase:", error);
  }
}

async function pauseCampaignRun() {
  const data = await postCampaignAction("/campaign/pause");
  if (data) {
    const activeContinues = Boolean(data.activeCallContinues);
    setStatus(
      activeContinues
        ? "Cola pausada. La llamada actual continúa y al terminar no avanzará."
        : "Cola pausada. No se realizarán nuevas llamadas.",
      true
    );
  }
}

async function resumeCampaignRun() {
  const data = await postCampaignAction("/campaign/resume");
  if (data) setStatus("Campaña reanudada.", true);
}

async function skipCampaignContact() {
  const active = getActiveCampaignContact();
  if (!active) {
    setStatus("No hay contacto activo en campaña.", true);
    return;
  }
  const data = await postCampaignAction("/campaign/skip", { contactId: active.id });
  if (data) setStatus("Contacto saltado y marcado para reintento.", true);
}

async function forceReleaseCampaignPhone() {
  const quarantined = campaignState?.quarantinedCalls?.[0] || null;
  const contactId = quarantined?.contactId || campaignState?.quarantinedContactIds?.[0] || "";
  const workerId = quarantined?.workerId || "";
  if (!contactId && !workerId) return;
  const accepted = await showCustomConfirm(
    "Forzar liberación",
    "No se pudo comprobar si la llamada terminó físicamente. Forzar la liberación desconectará ese teléfono y, si pertenece a la campaña, marcará el contacto como fallido. Úsalo solo después de revisar el celular."
  );
  if (!accepted) return;
  const data = await postCampaignAction("/campaign/force-release", {
    contactId,
    workerId,
    confirm: true,
    retry: false
  });
  if (data) setStatus("Teléfono liberado manualmente y desconectado por seguridad.", true);
}

async function markCampaignResult(result) {
  const active = getActiveCampaignContact();
  if (!active) {
    setStatus("No hay contacto activo en campaña.", true);
    return;
  }

  const payload = { contactId: active.id, result };
  if (result === "requiere_asesor") {
    payload.callbackReason = window.prompt("Motivo de derivación:", active.callbackReason || "Solicitó asesor") || "Solicitó asesor";
    payload.assignedAdvisor = window.prompt("Asesor asignado:", active.assignedAdvisor || "") || "";
  }

  const data = await postCampaignAction("/campaign/result", payload);
  if (!data) return;

  const labels = {
    agendado: "Contacto marcado como agendado.",
    no_interesado: "Contacto marcado como no interesado.",
    requiere_asesor: "Contacto derivado a callback.",
    reintentar: "Contacto marcado para reintento."
  };
  setStatus(labels[result] || "Resultado de campaña actualizado.", true);
}

function restoreSavedSession() {
  if (restoreAttempted) return;
  
  let savedCode = getSavedSessionCode();
  
  if (!savedCode) {
    restoreAttempted = true;
    console.log("No saved session code found. Automatically creating a new one...");
    socket.emit("session:create");
    return;
  }

  restoreAttempted = true;
  sessionCode = savedCode;
  if (refs.sessionCodeIn) refs.sessionCodeIn.value = savedCode;
  setStatus(`Restaurando sesión ${savedCode}...`);
  socket.emit("session:join", { code: savedCode, role: "dashboard" });
  loadPairingData(savedCode);
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
  if (refs.addPairingSlotBtn) refs.addPairingSlotBtn.onclick = createPairingSlot;
  if (refs.pairingSlotsEl) {
    refs.pairingSlotsEl.onclick = async (event) => {
      const copyBtn = event.target.closest(".copy-slot-link");
      if (copyBtn) {
        await navigator.clipboard.writeText(copyBtn.dataset.link || "");
        setStatus("Link de este dispositivo copiado.", true);
        return;
      }
      
      const deleteBtn = event.target.closest(".delete-slot-btn");
      if (deleteBtn) {
        const slotId = deleteBtn.dataset.id;
        if (await showCustomConfirm("Eliminar dispositivo QR", "¿Estás seguro de que deseas eliminar este dispositivo QR? Si el celular está conectado se desconectará.")) {
          try {
            const res = await fetch(`${API_BASE}/api/session/${encodeURIComponent(sessionCode)}/pairing-slots/${encodeURIComponent(slotId)}`, {
              method: "DELETE"
            });
            const data = await res.json();
            if (data.ok) {
              setStatus("Dispositivo QR eliminado.", true);
              await loadPairingData(sessionCode);
            } else {
              alert(data.error || "No se pudo eliminar el dispositivo QR");
            }
          } catch (e) {
            console.error(e);
            alert("Error al intentar eliminar el dispositivo QR");
          }
        }
      }
    };
  }
  
  refs.cBodyEl.onclick = async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    const contact = Contacts.contacts.find(c => c.id === id);
    if (!contact) return;
    
    if (action === "edit") {
       openEditModal(contact);
    }
    if (action === "delete") {
      if (await showCustomConfirm("Eliminar contacto", `¿Eliminar a ${contact.name}?`)) {
        Contacts.deleteContact(id);
        renderContacts();
      }
    }
  };

  refs.hangupBtnEl.onclick = () => {
    const contactId = getVisibleCallContactId();
    emitCallActionWithAck("hangup", contactId ? { contactId } : {});
    if (refs.callHintEl) refs.callHintEl.textContent = "Solicitando corte al teléfono; esperando confirmación física…";
  };

  refs.muteBtnEl.onclick = toggleMute;
  refs.speakerBtnEl.onclick = toggleSpeaker;
  if (refs.addContactBtn) refs.addContactBtn.onclick = addManualContact;
  if (refs.importFileEl) refs.importFileEl.onchange = (e) => handleImportFile(e.target.files?.[0] || null);
  if (refs.importUrlBtn) refs.importUrlBtn.onclick = handleImportUrl;
  if (refs.importConfirm) refs.importConfirm.onclick = addImportedContacts;
  if (refs.importCancel) refs.importCancel.onclick = resetImportPreview;
  if (refs.tabWord) refs.tabWord.onclick = () => {
    refs.tabWord.classList.add("active");
    refs.tabUrl.classList.remove("active");
    refs.panelWord.style.display = "block";
    refs.panelUrl.style.display = "none";
  };
  if (refs.tabUrl) refs.tabUrl.onclick = () => {
    refs.tabUrl.classList.add("active");
    refs.tabWord.classList.remove("active");
    refs.panelUrl.style.display = "block";
    refs.panelWord.style.display = "none";
  };
  if (refs.prevPageBtn) refs.prevPageBtn.onclick = () => {
    currentPage = Math.max(1, currentPage - 1);
    renderContacts();
  };
  if (refs.nextPageBtn) refs.nextPageBtn.onclick = () => {
    currentPage += 1;
    renderContacts();
  };
  if (refs.campaignStartBtn) refs.campaignStartBtn.onclick = startCampaignRun;
  if (refs.campaignPauseBtn) refs.campaignPauseBtn.onclick = pauseCampaignRun;
  if (refs.campaignResumeBtn) refs.campaignResumeBtn.onclick = resumeCampaignRun;
  if (refs.campaignSkipBtn) refs.campaignSkipBtn.onclick = skipCampaignContact;
  if (refs.campaignForceReleaseBtn) refs.campaignForceReleaseBtn.onclick = forceReleaseCampaignPhone;
  if (refs.campaignResultAgendaBtn) refs.campaignResultAgendaBtn.onclick = () => markCampaignResult("agendado");
  if (refs.campaignResultNoBtn) refs.campaignResultNoBtn.onclick = () => markCampaignResult("no_interesado");
  if (refs.campaignResultAdvisorBtn) refs.campaignResultAdvisorBtn.onclick = () => markCampaignResult("requiere_asesor");
  if (refs.campaignResultRetryBtn) refs.campaignResultRetryBtn.onclick = () => markCampaignResult("reintentar");
  if (refs.agentDisableBtn) {
    refs.agentDisableBtn.onclick = () => saveVoiceAgentConfig(false);
    refs.agentDisableBtn.disabled = true;
    refs.agentDisableBtn.title = "Agente de voz desactivado temporalmente";
  }
  
  if (refs.testBotAudioBtn) refs.testBotAudioBtn.onclick = () => socket.emit("test:bot_audio");



  // History
  if (refs.openHistoryBtn) refs.openHistoryBtn.onclick = openHistory;
  if (refs.historyCloseBtn) refs.historyCloseBtn.onclick = () => { refs.historyModalEl.style.display = "none"; };
  if (refs.clearHistoryBtn) refs.clearHistoryBtn.onclick = clearHistory;

  // Report
  if (refs.openReportBtn) refs.openReportBtn.onclick = openReportModal;
  if (refs.reportCloseBtn) refs.reportCloseBtn.onclick = () => { refs.reportModalEl.style.display = "none"; };
  if (refs.repDate) refs.repDate.onchange = updateReportPreview;
  if (refs.repStartHour) refs.repStartHour.onchange = updateReportPreview;
  if (refs.repEndHour) refs.repEndHour.onchange = updateReportPreview;
  if (refs.repDownloadBtn) refs.repDownloadBtn.onclick = downloadReportExcel;

  // Tabs
  renderTabs();

  loadHistory();
  
  // Visual feedback for bot audio activity
  AudioBridge.setOnAudioActivity((active) => {
    if (refs.testBotAudioBtn) {
      refs.testBotAudioBtn.style.boxShadow = active ? "0 0 15px var(--accent)" : "none";
      refs.testBotAudioBtn.style.transform = active ? "scale(1.05)" : "scale(1)";
    }
  });
  
  
  // Missing button handlers
  if (refs.exportWordBtn) refs.exportWordBtn.onclick = exportContactsToWord;
  if (refs.deleteAllContactsBtn) {
    refs.deleteAllContactsBtn.onclick = async () => {
      if (!await showCustomConfirm("Eliminar todos los contactos", "¿Estás seguro de que deseas ELIMINAR TODOS los contactos y todas las listas? Esta acción no se puede deshacer.")) return;
      Contacts.contacts.length = 0;
      Contacts.lists.length = 0;
      Contacts.lists.push("Principal");
      Contacts.setActiveList("Principal");
      Contacts.saveContacts();
      Contacts.saveLists();
      renderTabs();
      renderContacts();
      setStatus("Todos los contactos y listas han sido eliminados.");
    };
  }
  
}

// ── MISSING BUTTON FUNCTIONS ─────────────────────────────────────────────
async function exportContactsToWord() {
  if (!Contacts.contacts.length) {
    setStatus("No hay contactos para exportar.", true);
    return;
  }

  try {
    setStatus("Generando documento Word...", true);
    
    // Create HTML content that can be converted to Word
    let htmlContent = `
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Lista de Contactos</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          h1 { color: #333; }
          table { border-collapse: collapse; width: 100%; margin-top: 20px; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #f2f2f2; font-weight: bold; }
          .call-count { background-color: #e8f5e8; padding: 2px 6px; border-radius: 3px; font-size: 11px; }
        </style>
      </head>
      <body>
        <h1>Lista de Contactos - ${new Date().toLocaleDateString()}</h1>
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Teléfono</th>
              <th>Nota</th>
              <th>Llamadas</th>
            </tr>
          </thead>
          <tbody>
    `;

    Contacts.contacts.forEach(contact => {
      const callCount = Number(Contacts.calledCounts[contact.id] || 0);
      htmlContent += `
        <tr>
          <td>${escHtml(contact.name)}</td>
          <td>${escHtml(contact.phone)}</td>
          <td>${escHtml(contact.note || "")}</td>
          <td>${callCount > 0 ? `<span class="call-count">${callCount}</span>` : "0"}</td>
        </tr>
      `;
    });

    htmlContent += `
          </tbody>
        </table>
        <p style="margin-top: 20px; font-size: 12px; color: #666;">
          Total de contactos: ${Contacts.contacts.length} | 
          Contactos llamados: ${Contacts.contacts.reduce((acc, c) => acc + (Number(Contacts.calledCounts[c.id] || 0) > 0 ? 1 : 0), 0)}
        </p>
      </body>
      </html>
    `;

    // Create a Blob with the HTML content
    const blob = new Blob([htmlContent], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    
    // Create download link
    const a = document.createElement('a');
    a.href = url;
    a.download = `contactos_${new Date().toISOString().split('T')[0]}.doc`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setStatus("Documento Word descargado.", true);
  } catch (error) {
    console.error("Error exporting to Word:", error);
    setStatus("Error al exportar a Word.", true);
  }
}



// ── CALL LOGIC ────────────────────────────────────────────────────────
function startDialForContact(c) {
  if (["dialing", "ringing", "in_call"].includes(currentState)) return;
  currentCallingContactId = c.id;
  Contacts.calledCounts[c.id] = (Contacts.calledCounts[c.id] || 0) + 1;
  Contacts.saveCalledCounts();
  renderContacts();
  openCallWindow(c.phone, { contactName: c.name, note: c.note });
  emitCallActionWithAck("dial", { phoneNumber: c.phone, contactName: c.name, contactId: c.id });
}

function openCallWindow(phone, opts = {}) {
  callCtx = {
    phone: phone || "",
    contactName: opts.contactName || "Sin contacto",
    note: opts.note || "",
    answered: false
  };
  if (callTimerId) {
    clearInterval(callTimerId);
    callTimerId = null;
  }
  callStartedAt = null;
  if (refs.callKickerEl) refs.callKickerEl.textContent = "Enviando orden...";
  if (refs.callNameEl) refs.callNameEl.textContent = callCtx.contactName || "Sin contacto";
  if (refs.callNumberEl) refs.callNumberEl.textContent = callCtx.phone || "-";
  if (refs.callNoteEl) refs.callNoteEl.textContent = callCtx.note || "-";
  if (refs.callDurEl) refs.callDurEl.textContent = "00:00";
  refs.callModalEl.style.display = "grid";
  setBadge("idle", refs.callBadgeEl);
  if (refs.callHintEl) {
    refs.callHintEl.textContent = "Enviando orden al celular...";
  }
}

function formatCallDuration(totalSeconds) {
  const safeSeconds = Math.max(0, Number(totalSeconds || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    const remMinutes = minutes % 60;
    return [hours, remMinutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
  }
  return [minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function stopCallTimer(clearStart = true) {
  if (callTimerId) {
    clearInterval(callTimerId);
    callTimerId = null;
  }
  if (clearStart) callStartedAt = null;
}

function startCallTimer() {
  stopCallTimer();
  if (!callStartedAt) callStartedAt = Date.now();
  if (refs.callDurEl) {
    refs.callDurEl.textContent = formatCallDuration(Math.floor((Date.now() - callStartedAt) / 1000));
  }
    callTimerId = setInterval(() => {
        if (!callStartedAt || !refs.callDurEl) return;
        const dur = Math.floor((Date.now() - callStartedAt) / 1000);
        refs.callDurEl.textContent = formatCallDuration(dur);
        lastCallDuration = dur; // Store the last duration
    }, 1000);
}

async function toggleMute() {
  micEnabled = !micEnabled;

  if (micEnabled) {
    await AudioBridge.startMic();
    if (currentState === "in_call") {
      await AudioBridge.startWebMicStreaming();
    }
    const contactId = getVisibleCallContactId();
    emitCallActionWithAck("unmute", contactId ? { contactId } : {});
  } else {
    AudioBridge.stopMic();
    const contactId = getVisibleCallContactId();
    emitCallActionWithAck("mute", contactId ? { contactId } : {});
  }

  syncAudioButtons();
}

function toggleSpeaker() {
  speakerEnabled = !speakerEnabled;
  AudioBridge.setPhoneAudioEnabled(speakerEnabled && currentState === "in_call");
  
  // Enviar comando al APK para el altavoz físico
  const contactId = getVisibleCallContactId();
  emitCallActionWithAck(
    speakerEnabled ? "speaker_on" : "speaker_off",
    contactId ? { contactId } : {}
  );
  
  syncAudioButtons();
}

function applyState(state, lastNum, opts = {}) {
  const previousState = currentState;
  currentState = state;
  
  if (opts.micMuted !== undefined) {
    const newMicEnabled = !opts.micMuted;
    if (newMicEnabled !== micEnabled) {
      micEnabled = newMicEnabled;
      if (!micEnabled) {
        AudioBridge.stopMic();
      }
    }
  }
  if (opts.isSpeakerOn !== undefined) {
    const newSpeakerEnabled = opts.isSpeakerOn;
    if (newSpeakerEnabled !== speakerEnabled) {
      speakerEnabled = newSpeakerEnabled;
      AudioBridge.setPhoneAudioEnabled(speakerEnabled && state === "in_call");
    }
  }
  
  syncAudioButtons();

  setBadge(state, refs.callBadgeEl);
  if (refs.callNumberEl && lastNum) refs.callNumberEl.textContent = lastNum;
  if (refs.callNameEl && opts.contactName) refs.callNameEl.textContent = opts.contactName;
  if (refs.callKickerEl) {
    refs.callKickerEl.className = `call-kicker state-${state}`;
    const kickerMap = {
      idle: "Listo",
      dialing: "Llamando...",
      ringing: "Sonando...",
      in_call: "Contestada",
      ended: callStartedAt ? "Llamada finalizada" : "No contestó",
      failed: "No se pudo llamar"
    };
    refs.callKickerEl.textContent = kickerMap[state] || "Estado";
  }
  if (refs.callHintEl) {
    const hints = {
      idle: "Esperando acción del celular.",
      dialing: "El celular inició el marcado.",
      ringing: "La llamada está sonando.",
      in_call: "Llamada contestada y en curso.",
      ended: callStartedAt ? `Duración: ${refs.callDurEl?.textContent || "00:00"}` : "La llamada no fue contestada.",
      failed: "No se pudo iniciar la llamada."
    };
    refs.callHintEl.textContent = hints[state] || "";
  }

  // New state handling logic
    if (state === "in_call") {
        if (!callStartedAt) { 
            callStartedAt = Date.now();
            startCallTimer();
        }
        refs.callModalEl.classList.add("is-active-call");
        refs.callModalEl.classList.remove("is-ringing");
        refs.callRingEl.classList.add("is-in-call");
    } else if (state === "idle" || state === "ended" || state === "failed") {
        stopCallTimer(false); // Stop but don't clear Last Duration yet
        refs.callModalEl.classList.remove("is-active-call");
        refs.callModalEl.classList.remove("is-ringing");
        refs.callRingEl.classList.remove("is-in-call");
        
        if (state === "ended" && lastCallDuration > 0) {
            if (currentCallingContactId) {
                Contacts.callDurations[currentCallingContactId] = (Contacts.callDurations[currentCallingContactId] || 0) + lastCallDuration;
                Contacts.saveCallDurations();
            }
            
            // Add to history
            addHistoryEntry(lastNum || callCtx?.phone, lastCallDuration);

            refs.callHintEl.textContent = `Llamada finalizada. Duración: ${formatCallDuration(lastCallDuration)}`;
            // Keep duration visible in the badge for a moment
            if (refs.callDurEl) refs.callDurEl.textContent = formatCallDuration(lastCallDuration);
            lastCallDuration = 0;
            renderContacts();
        }

        if (state === "idle" || state === "ended" || state === "failed") {
            if (state === "idle") {
              callStartedAt = null;
              if (refs.callDurEl) refs.callDurEl.textContent = "00:00";
            }
            AudioBridge.stopPhoneAudio();
            AudioBridge.stopMic();
            micEnabled = false;
            syncAudioButtons();
            
            // Close modal faster (2s instead of 4s) to keep campaign moving
            setTimeout(() => { 
                if (currentState === "idle" || currentState === "ended" || currentState === "failed") {
                    refs.callModalEl.style.display = "none"; 
                }
            }, 2000);
        }
    } else {
        refs.callModalEl.classList.remove("is-active-call");
        if (state === "ringing" || state === "dialing") {
          refs.callModalEl.classList.add("is-ringing");
        } else {
          refs.callModalEl.classList.remove("is-ringing");
        }
        refs.callRingEl.classList.remove("is-in-call");
    }

    if (state === "ringing" || state === "dialing") {
        refs.callRingEl.classList.add("is-calling");
    } else {
        refs.callRingEl.classList.remove("is-calling");
    }
    syncAudioButtons();
}

function emitCallActionWithAck(action, payload = {}) {
  const commandId = (typeof crypto.randomUUID === 'function') 
    ? crypto.randomUUID() 
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  const existing = pendingCommandTimeouts.get(commandId);
  if (existing) clearTimeout(existing);
  socket.emit("call:action", { action, commandId, ...payload });
  setAckBadge(refs.apkAckBadgeEl, "pending", `APK · ${action}...`);
  const timeoutId = setTimeout(() => {
    pendingCommandTimeouts.delete(commandId);
    setAckBadge(refs.apkAckBadgeEl, "warn", `APK · sin respuesta`);
    if (refs.callHintEl && action === "dial" && ["idle", "failed", "ended"].includes(currentState)) {
      refs.callHintEl.textContent = "El celular no confirmó la orden. Revisa permisos, marcador predeterminado o conexión del APK.";
    }
  }, 8000);
  pendingCommandTimeouts.set(commandId, timeoutId);
  return commandId;
}

function updatePairingHint(link) {
  if (!refs.qrHintEl) return;
  if (currentPhoneLinked) return;

  try {
    const parsed = new URL(link);
    const apiBase = String(parsed.searchParams.get("apiBase") || "").trim();
    if (!apiBase) {
      refs.qrHintEl.textContent = "QR generado, pero no incluye apiBase.";
      return;
    }

    const apiUrl = new URL(apiBase);
    const host = apiUrl.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      refs.qrHintEl.textContent = `Advertencia: el QR apunta a ${apiBase}. Ese host no sirve para el celular; usa IP LAN o dominio público.`;
      return;
    }

    refs.qrHintEl.textContent = `QR listo. La APK se conectará a ${apiBase}`;
  } catch {
    refs.qrHintEl.textContent = "QR listo. Verifica que la URL del servidor sea accesible desde el celular.";
  }
}

function updateSessionUi(st = {}) {
  latestSessionState = st || {};
  const dashboardConnected = Boolean(st?.connected?.dashboard ?? sessionCode);

  const phoneConnected = Boolean(st?.connected?.phone);
  const phoneLinking   = Boolean(st?.connected?.linking);
  const phoneCount = Number(st?.connected?.phoneCount || 0);
  const phoneDeviceName = String(st?.phoneDevice?.name || "").trim();
  currentPhoneLinked = phoneConnected;

  const workers = Array.isArray(st?.phoneWorkers) ? st.phoneWorkers : [];
  const nextPairingSignature = workers
    .map((worker) => `${worker.id || ""}:${worker.connected ? "1" : "0"}`)
    .sort()
    .join("|");
  if (nextPairingSignature !== pairingConnectionSignature) {
    pairingConnectionSignature = nextPairingSignature;
    if (sessionCode) void loadPairingData(sessionCode);
  }

  if (refs.qrHintEl && phoneLinking) {
    refs.qrHintEl.innerHTML = `<strong>¡Celular detectado!</strong> Sincronizando datos...`;
    refs.qrHintEl.style.color = "var(--success)";
  }

  if (refs.qrBlockEl) {
    refs.qrBlockEl.classList.toggle("is-linked", phoneConnected);
  }

  if (refs.linkedBanner) {
    refs.linkedBanner.style.display = phoneConnected ? "flex" : "none";
  }
  if (refs.linkedDevice) {
    if (phoneConnected) {
      const deviceLabel = phoneCount > 1
        ? `${phoneCount} dispositivos conectados`
        : (phoneDeviceName || "1 dispositivo conectado");
      refs.linkedDevice.textContent = `${deviceLabel} · Sesión ${sessionCode || "activa"}`;
    } else {
      refs.linkedDevice.textContent = "Dispositivo conectado";
    }
  }
  if (refs.contactsSec) {
    refs.contactsSec.style.display = dashboardConnected ? "block" : "none";
  }
  if (refs.campaignSectionEl) {
    refs.campaignSectionEl.style.display = dashboardConnected ? "block" : "none";
  }
  if (refs.qrBlockEl) {
    refs.qrBlockEl.style.display = dashboardConnected ? "flex" : "none";
  }

  if (dashboardConnected) {
    const connectedStatus = phoneCount > 1
      ? `${phoneCount} marcadores vinculados y listos para llamar`
      : "Marcador vinculado y listo para llamar";
    setStatus(
      phoneConnected
        ? connectedStatus
        : "Sesión creada. Escanea el QR para conectar el teléfono",
      true
    );
    renderCampaignPanel();
  } else {
    setStatus("Sin vincular. Crea o une a una sesión.");
  }
}

// ── APK & PAIRING ────────────────────────────────────────────────────
async function loadPairingData(code) {
  try {
    const res = await fetch(`${API_BASE}/api/session/${encodeURIComponent(code)}/pairing-slots`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "No se pudieron cargar los QR");
    const slots = Array.isArray(data.slots) ? data.slots : [];
    const first = slots[0];
    pairLink = first?.link || "";
    refs.pairLinkEl.value = pairLink;
    refs.pairQrEl.style.display = "none";
    renderPairingSlots(slots);
    updatePairingHint(first?.link || "");
  } catch { }
}

function renderPairingSlots(slots) {
  if (!refs.pairingSlotsEl) return;
  refs.pairingSlotsEl.innerHTML = slots.map((slot) => {
    return `
      <article class="pairing-slot-card ${slot.connected ? "is-connected" : (slot.deviceId ? "is-disconnected" : "")}">
        <img src="${API_BASE}/api/pairing-qr/${encodeURIComponent(sessionCode)}.svg?slotId=${encodeURIComponent(slot.id)}&ts=${Date.now()}" alt="QR ${escHtml(slot.label)}" />
        <div>
          <strong>${escHtml(slot.label)}</strong>
          <small class="pairing-live-state">
            ${slot.connected
              ? `● Conectado · ${escHtml(slot.deviceName || slot.deviceId || "Celular")}`
              : slot.deviceId
                ? `○ Desconectado · QR activo para reconectar`
                : "Disponible para vincular"}
          </small>
          <div style="display: flex; gap: 8px; width: 100%; margin-top: 4px;">
            <button class="secondary copy-slot-link" data-link="${escHtml(slot.link)}" style="flex: 1; padding: 0 8px; min-height: 32px; font-size: 11px;">📋 Copiar</button>
            <button class="danger-soft delete-slot-btn" data-id="${slot.id}" style="flex: 1; padding: 0 8px; min-height: 32px; font-size: 11px; border: 1px solid rgba(239, 68, 68, 0.25);">🗑️ Eliminar</button>
          </div>
        </div>
      </article>
    `;
  }).join("");
  
  const qrBlock = document.getElementById("qrBlock");
  if (qrBlock) qrBlock.classList.toggle("has-many-slots", slots.length >= 3);
}

async function createPairingSlot() {
  if (!sessionCode) return setStatus("Primero crea o vincula una sesión.");
  try {
    const currentSlots = refs.pairingSlotsEl?.children.length || 0;
    const res = await fetch(`${API_BASE}/api/session/${encodeURIComponent(sessionCode)}/pairing-slots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: `Dispositivo ${currentSlots + 1}` })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "No se pudo crear el QR");
    await loadPairingData(sessionCode);
    setStatus("QR independiente creado. Escanéalo con el nuevo celular.", true);
  } catch (error) {
    setStatus(error.message || "No se pudo crear el QR.");
  }
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
  updateSessionUi(st);
  applyState(st.callState, st.lastNumber, st);
  renderContacts();
});

socket.on("campaign:state", st => {
  campaignState = st;
  renderCampaignPanel();
  renderContacts();
});

socket.on("session:created", ({ code }) => {
  sessionCode = code;
  refs.sessionCodeIn.value = code;
  saveSessionCode(code);
  updateSessionUi({ connected: { dashboard: true, phone: false } });
  loadPairingData(code);
  fetchCampaignState(code);
  loadWorkspaceFromSupabase(code);
});

socket.on("session:joined", ({ code, role }) => {
  if (role === "dashboard") {
    sessionCode = code;
    refs.sessionCodeIn.value = code;
    saveSessionCode(code);
    updateSessionUi({ connected: { dashboard: true, phone: currentPhoneLinked } });
    loadPairingData(code);
    fetchCampaignState(code);
    loadWorkspaceFromSupabase(code);
  }
});

socket.on("connect", () => {
  restoreSavedSession();
  if (sessionCode) {
    fetchCampaignState(sessionCode);
  }
});

socket.on("phone:command_ack", ({ commandId, action, ok, message }) => {
  const timeoutId = pendingCommandTimeouts.get(commandId);
  if (timeoutId) {
    clearTimeout(timeoutId);
    pendingCommandTimeouts.delete(commandId);
  }
  setAckBadge(
    refs.apkAckBadgeEl,
    ok ? "ok" : "error",
    ok ? `APK · ${action} ok` : `APK · ${action} error`
  );
  if (refs.callHintEl) {
    refs.callHintEl.textContent = message || (ok ? "Orden recibida por el celular." : "El celular rechazó la orden.");
  }
  if (!ok && action === "dial") {
    applyState("failed", callCtx?.phone || "");
  }
});

// START

/* ── HISTORY LOGIC ────────────────────────────────────── */
let callHistory = [];
function loadHistory() {
  try { callHistory = JSON.parse(localStorage.getItem("voip.callHistory") || "[]"); }
  catch { callHistory = []; }
}

function saveHistory() {
  localStorage.setItem("voip.callHistory", JSON.stringify(callHistory));
  scheduleWorkspaceSave();
}

function addHistoryEntry(phone, duration) {
  if (!phone) return;
  callHistory.unshift({
    phone,
    duration,
    timestamp: Date.now()
  });
  if (callHistory.length > 1000) callHistory.pop();
  saveHistory();
}

function openHistory() {
  renderHistory();
  refs.historyModalEl.style.display = "flex";
}

async function clearHistory() {
  if (!await showCustomConfirm("Limpiar historial", "¿Estás seguro de que deseas limpiar todo el historial de llamadas recientes?")) return;
  callHistory = [];
  saveHistory();
  renderHistory();
}

function renderHistory() {
  const list = refs.historyListEl;
  if (!list) return;
  if (callHistory.length === 0) {
    list.innerHTML = `<div class="muted" style="text-align:center;padding:40px;">Sin llamadas recientes.</div>`;
    return;
  }
  list.innerHTML = callHistory.map(h => `
    <div class="history-item">
      <div class="history-info">
        <div class="history-phone">${escHtml(h.phone)}</div>
        <div class="history-meta">
          <span>📅 ${new Date(h.timestamp).toLocaleString()}</span>
          <span>⏱️ ${formatCallDuration(h.duration)}</span>
        </div>
      </div>
      <div class="history-actions">
        <button class="history-call-btn" onclick="dialFromHistory('${escHtml(h.phone)}')">📞 Llamar</button>
      </div>
    </div>
  `).join("");
}

window.dialFromHistory = (phone) => {
  refs.historyModalEl.style.display = "none";
  dialManual(phone, "Historial");
};

/* ── REPORT LOGIC ─────────────────────────────────────── */
function openReportModal() {
  if (refs.repDate) {
    const today = new Date().toISOString().split("T")[0];
    refs.repDate.value = today;
  }
  updateReportPreview();
  if (refs.reportModalEl) refs.reportModalEl.style.display = "flex";
}

function getFilteredHistory() {
  const selectedDate = refs.repDate?.value || "";
  const startHourStr = refs.repStartHour?.value || "07:00";
  const endHourStr = refs.repEndHour?.value || "20:00";
  
  if (!selectedDate) return [];
  
  const [startH, startM] = startHourStr.split(":").map(Number);
  const [endH, endM] = endHourStr.split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  
  return callHistory.filter(h => {
    const callDate = new Date(h.timestamp);
    const callDateStr = callDate.toISOString().split("T")[0];
    
    if (callDateStr !== selectedDate) return false;
    
    const callMinutes = callDate.getHours() * 60 + callDate.getMinutes();
    return callMinutes >= startMinutes && callMinutes <= endMinutes;
  });
}

function updateReportPreview() {
  const matches = getFilteredHistory();
  if (refs.repMatchCount) refs.repMatchCount.textContent = String(matches.length);
}

function downloadReportExcel() {
  const matches = getFilteredHistory();
  if (!matches.length) {
    alert("No hay llamadas registradas en el rango de fecha y hora seleccionado.");
    return;
  }
  
  try {
    if (typeof XLSX === "undefined") {
      alert("La librería de Excel no está disponible. Por favor, recarga la página.");
      return;
    }
    
    const rows = matches.map(h => {
      const date = new Date(h.timestamp);
      return {
        "Teléfono": h.phone,
        "Duración (segundos)": h.duration,
        "Duración Formateada": formatCallDuration(h.duration),
        "Fecha y Hora": date.toLocaleString("es-PE"),
        "Día": date.toLocaleDateString("es-PE"),
        "Hora": date.toLocaleTimeString("es-PE", { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      };
    });
    
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Reporte");
    
    const max_len = rows.reduce((w, r) => Math.max(w, String(r["Fecha y Hora"]).length), 15);
    worksheet["!cols"] = [
      { wch: 15 },
      { wch: 20 },
      { wch: 20 },
      { wch: max_len },
      { wch: 15 },
      { wch: 15 }
    ];
    
    const filename = `Reporte_Llamadas_${refs.repDate.value}_${refs.repStartHour.value.replace(':', '')}-${refs.repEndHour.value.replace(':', '')}.xlsx`;
    XLSX.writeFile(workbook, filename);
    setStatus(`Reporte de Excel descargado con éxito: ${filename}`, true);
  } catch (error) {
    console.error("Error al exportar Excel:", error);
    alert("Ocurrió un error al generar el reporte de Excel.");
  }
}

/* ── TABS LOGIC ────────────────────────────────────────── */
function renderTabs() {
  const container = refs.contactsTabsEl;
  if (!container) return;
  
  const lists = Contacts.lists || ["Principal"];
  container.innerHTML = lists.map(list => `
    <div class="tab-item ${Contacts.activeList === list ? "active" : ""}" data-name="${escHtml(list)}">
      <span>${escHtml(list)}</span>
      ${list !== "Principal" ? `<button class="delete-tab-btn" data-list="${escHtml(list)}">×</button>` : ""}
    </div>
  `).join("") + `
    <button class="add-tab-btn" id="addNewTabBtn">＋ Nueva Lista</button>
  `;
  
  container.onclick = async (e) => {
    const tab = e.target.closest(".tab-item");
    const del = e.target.closest(".delete-tab-btn");
    const add = e.target.closest("#addNewTabBtn");
    
    if (del) {
      e.stopPropagation();
      const name = del.dataset.list;
      if (await showCustomConfirm("Eliminar lista", `¿Eliminar la lista "${name}" y todos sus contactos?`)) {
        Contacts.deleteList(name);
        renderTabs();
        renderContacts();
      }
      return;
    }
    
    if (add) {
      const name = window.prompt("Nombre de la nueva lista:");
      if (name && name.trim()) {
        Contacts.addList(name.trim());
        renderTabs();
      }
      return;
    }
    
    if (tab) {
      const name = tab.dataset.name;
      Contacts.setActiveList(name);
      renderTabs();
      renderContacts();
    }
  };
}

function dialManual(phone, name) {
  if (["dialing", "ringing", "in_call"].includes(currentState)) return;
  currentCallingContactId = null; 
  openCallWindow(phone, { contactName: name });
  emitCallActionWithAck("dial", { phoneNumber: phone, contactName: name });
}

function openEditModal(contact) {
    if (!refs.editModalEl) return;
    refs.editNameInput.value = contact.name || "";
    refs.editPhoneInput.value = contact.phone || "";
    refs.editNoteInput.value = contact.note || "";
    
    refs.editSaveBtn.onclick = () => {
        const newData = {
            name: refs.editNameInput.value.trim(),
            phone: refs.editPhoneInput.value.trim(),
            note: refs.editNoteInput.value.trim()
        };
        if (Contacts.updateContact(contact.id, newData)) {
            refs.editModalEl.style.display = "none";
            renderContacts();
            setStatus("Contacto actualizado.", true);
        }
    };
    
    refs.editCloseBtn.onclick = () => {
        refs.editModalEl.style.display = "none";
    };
    
    refs.editModalEl.style.display = "grid";
}

init();

/* ═══════════════════════════════════════════════════════
   SHIFT MANAGEMENT (Gestión de Turnos)
   Turno mañana : 07:00 – 14:00
   Turno tarde  : 14:00 – 20:00
   ═══════════════════════════════════════════════════════ */
(function shiftManager() {
  const SHIFTS = [
    { id: "morning",   name: "Turno Mañana",   start: 7,  end: 14 },
    { id: "afternoon", name: "Turno Tarde",     start: 14, end: 20 }
  ];
  const LS_KEY = "vc_shift_start";

  const elBar      = document.getElementById("shiftBar");
  const elDot      = document.getElementById("shiftDot");
  const elName     = document.getElementById("shiftName");
  const elRange    = document.getElementById("shiftRange");
  const elElapsed  = document.getElementById("shiftElapsed");
  const elProgress = document.getElementById("shiftProgressBar");
  const elEndBtn   = document.getElementById("shiftEndBtn");

  if (!elBar) return;

  function getActiveShift(now) {
    const h = now.getHours() + now.getMinutes() / 60;
    return SHIFTS.find(s => h >= s.start && h < s.end) || null;
  }

  function fmt2(n) { return String(n).padStart(2, "0"); }

  function fmtDuration(ms) {
    const s = Math.floor(ms / 1000);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return `${fmt2(hh)}:${fmt2(mm)}:${fmt2(ss)}`;
  }

  function fmtTime(h) {
    const suffix = h < 12 ? "AM" : "PM";
    const display = h % 12 === 0 ? 12 : h % 12;
    return `${display}:00 ${suffix}`;
  }

  function getShiftStart(shift, now) {
    // Saved session start from localStorage (operator may have started mid-shift)
    const saved = localStorage.getItem(LS_KEY);
    if (saved) {
      const d = new Date(saved);
      // Only use saved if it's from the same shift window
      const savedH = d.getHours() + d.getMinutes() / 60;
      if (savedH >= shift.start && savedH < shift.end && d.toDateString() === now.toDateString()) {
        return d;
      }
    }
    // Default: start of the shift
    const d = new Date(now);
    d.setHours(shift.start, 0, 0, 0);
    return d;
  }

  function saveShiftStart(date) {
    localStorage.setItem(LS_KEY, date.toISOString());
  }

  function clearShiftStart() {
    localStorage.removeItem(LS_KEY);
  }

  function showEndSummary(shift, startTime, endTime) {
    const dur = fmtDuration(endTime - startTime);
    const startStr = startTime.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
    const endStr   = endTime.toLocaleTimeString("es-PE",   { hour: "2-digit", minute: "2-digit" });
    const msg =
      `✅ ${shift.name} finalizado\n\n` +
      `Inicio:   ${startStr}\n` +
      `Fin:      ${endStr}\n` +
      `Duración: ${dur}\n\n` +
      `El turno ha sido registrado.`;
    alert(msg);
  }

  let currentShiftId = null;
  let shiftStartTime = null;
  let tickTimer = null;

  function tick() {
    const now = new Date();
    const shift = getActiveShift(now);

    // Shift changed or started
    if (shift?.id !== currentShiftId) {
      currentShiftId = shift ? shift.id : null;
      if (shift) {
        shiftStartTime = getShiftStart(shift, now);
        saveShiftStart(shiftStartTime);
      } else {
        shiftStartTime = null;
      }
    }

    // Update bar class
    elBar.className = "shift-bar " + (shift ? shift.id : "off");
    elDot.className = "shift-dot "  + (shift ? shift.id : "off");

    if (shift) {
      elName.textContent    = shift.name;
      elRange.textContent   = `${fmtTime(shift.start)} – ${fmtTime(shift.end)}`;
      const elapsed         = now - shiftStartTime;
      elElapsed.textContent = fmtDuration(elapsed);
      const totalMs         = (shift.end - shift.start) * 3600 * 1000;
      const pct             = Math.min(100, (elapsed / totalMs) * 100);
      elProgress.style.width = pct.toFixed(1) + "%";
    } else {
      elName.textContent     = "Fuera de turno";
      elRange.textContent    = "Próximo: 7:00 AM";
      elElapsed.textContent  = "—";
      elProgress.style.width = "0%";
    }
  }

  elEndBtn.addEventListener("click", () => {
    const now = new Date();
    const shift = getActiveShift(now);
    if (!shift || !shiftStartTime) return;
    showEndSummary(shift, shiftStartTime, now);
    clearShiftStart();
    // Reset: next tick will recalculate from shift start
    shiftStartTime = new Date();
    shiftStartTime.setHours(shift.start, 0, 0, 0);
    saveShiftStart(shiftStartTime);
  });

  // Init immediately then every second
  tick();
  tickTimer = setInterval(tick, 1000);
})();
