const socket = io();

// ── DOM REFS ────────────────────────────────────────────────────────────
const statusDot = document.getElementById("statusDot");
const statusTextEl = document.getElementById("statusText");
const createBtn = document.getElementById("createSession");
const sessionCodeIn = document.getElementById("sessionCode");
const joinBtn = document.getElementById("joinSession");
const sessionBarEl = document.getElementById("sessionBar");
const apkBarEl = document.getElementById("apkBar");
const pairQrEl = document.getElementById("pairQr");
const qrHintEl = document.getElementById("qrHint");
const pairLinkEl = document.getElementById("pairLink");
const copyBtn = document.getElementById("copyPairLink");
const qrBlockEl = document.getElementById("qrBlock");
const linkedBanner = document.getElementById("linkedBanner");
const linkedDevice = document.getElementById("linkedDevice");
const cNameIn = document.getElementById("contactName");
const cPhoneIn = document.getElementById("contactPhone");
const cNoteIn = document.getElementById("contactNote");
const addContactBtn = document.getElementById("addContact");
const cBodyEl = document.getElementById("contactsBody");
const contactsSec = document.getElementById("contactsSection");
const contactsPaginationEl = document.getElementById("contactsPagination");
const prevPageBtn = document.getElementById("prevPageBtn");
const nextPageBtn = document.getElementById("nextPageBtn");
const pageInfoEl = document.getElementById("pageInfo");

const callModalEl = document.getElementById("callModal");
const callRingEl = document.getElementById("callRing");
const callKickerEl = document.getElementById("callKicker");
const callNameEl = document.getElementById("callName");
const callNumberEl = document.getElementById("callNumber");
const callNoteEl = document.getElementById("callNote");
const callBadgeEl = document.getElementById("callStateBadge");
const callDurEl = document.getElementById("callDuration");
const micBadgeEl = document.getElementById("micBadge");
const apkAckBadgeEl = document.getElementById("apkAckBadge");
const muteBtnEl = document.getElementById("modalMuteBtn");
const speakerBtnEl = document.getElementById("modalSpeakerBtn");
const hangupBtnEl = document.getElementById("modalHangupBtn");
const callHintEl = document.getElementById("callHint");

// APK
const apkNameEl = document.getElementById("apkName");
const apkMetaEl = document.getElementById("apkMeta");
const apkDlBtn = document.getElementById("apkDownloadBtn");
const apkVersionSelectEl = document.getElementById("apkVersionSelect");
const apkHelpBtn = document.getElementById("apkInstallHelp");
const installGuide = document.getElementById("installGuide");

// Import
const tabWord = document.getElementById("tabWord");
const tabUrl = document.getElementById("tabUrl");
const panelWord = document.getElementById("importPanelWord");
const panelUrl = document.getElementById("importPanelUrl");
const importFileEl = document.getElementById("importFile");
const importFileNameEl = document.getElementById("importFileName");
const importUrlEl = document.getElementById("importUrl");
const importUrlBtn = document.getElementById("importUrlBtn");
const importPreview = document.getElementById("importPreview");
const previewCountEl = document.getElementById("previewCount");
const previewBody = document.getElementById("previewBody");
const importConfirm = document.getElementById("importConfirmBtn");
const importCancel = document.getElementById("importCancelBtn");
const floatingAddContactBtn = document.getElementById("floatingAddContactBtn");
const addContactModalEl = document.getElementById("addContactModal");
const addCloseBtn = document.getElementById("addCloseBtn");
const addSaveBtn = document.getElementById("addSaveBtn");
const addNameInput = document.getElementById("addNameInput");
const addPhoneInput = document.getElementById("addPhoneInput");
const addNoteInput = document.getElementById("addNoteInput");
const editModalEl = document.getElementById("editContactModal");
const editCloseBtn = document.getElementById("editCloseBtn");
const editSaveBtn = document.getElementById("editSaveBtn");
const editNameInput = document.getElementById("editNameInput");
const editPhoneInput = document.getElementById("editPhoneInput");
const editNoteInput = document.getElementById("editNoteInput");

// ── STATE ──────────────────────────────────────────────────────────────
let sessionCode = "";
let pairLink = "";
let contacts = [];
let callCtx = null;
let callTimerId = null;
let callStartedAt = null;
let currentState = "idle";
let micStream = null;
let micEnabled = true;
let speakerEnabled = false;
let audioCtx = null;
let importPreviewData = [];
let currentPage = 1;
let editContactId = null;
let apkVersionsCache = [];
let currentCallingContactId = null;
const pendingCommandTimeouts = new Map();
const PAGE_SIZE = 20;
const CALLED_COUNTS_KEY = "kenia.calledCounts";
let calledCounts = {};

// ── CONTACTS STORAGE ────────────────────────────────────────────────────
function loadContacts() {
  try { contacts = JSON.parse(localStorage.getItem("kenia.contacts") || "[]"); }
  catch { contacts = []; }
}

function saveContacts() {
  localStorage.setItem("kenia.contacts", JSON.stringify(contacts));
}

function loadCalledCounts() {
  try { calledCounts = JSON.parse(localStorage.getItem(CALLED_COUNTS_KEY) || "{}"); }
  catch { calledCounts = {}; }
}

function saveCalledCounts() {
  localStorage.setItem(CALLED_COUNTS_KEY, JSON.stringify(calledCounts));
}

function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function renderContacts() {
  cBodyEl.innerHTML = "";
  const totalPages = Math.max(1, Math.ceil(contacts.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  if (!contacts.length) {
    cBodyEl.innerHTML = `<tr><td colspan="4" class="muted" style="text-align:center;padding:18px;">Sin contactos. Agrega el primero.</td></tr>`;
    contactsPaginationEl.style.display = "none";
    return;
  }

  const startIndex = (currentPage - 1) * PAGE_SIZE;
  const pageRows = contacts.slice(startIndex, startIndex + PAGE_SIZE);

  for (const c of pageRows) {
    const tr = document.createElement("tr");
    const callCount = Number(calledCounts[c.id] || 0);
    if (callCount > 0) tr.classList.add("contact-row-called");
    tr.innerHTML = `
      <td>${escHtml(c.name)}</td>
      <td style="font-family:monospace;font-size:13px;">${escHtml(c.phone)}</td>
      <td>
        ${escHtml(c.note || "—")}
        ${callCount > 0 ? `<span class="call-count-chip">📞 ${callCount}</span>` : ""}
      </td>
      <td class="actions-cell">
        <button data-action="dial"   data-id="${c.id}">📞 Llamar</button>
        <button data-action="edit" data-id="${c.id}" class="secondary">✏️ Editar</button>
        <button data-action="delete" data-id="${c.id}" class="secondary">🗑️</button>
      </td>`;
    cBodyEl.appendChild(tr);
  }

  contactsPaginationEl.style.display = totalPages > 1 ? "flex" : "none";
  pageInfoEl.textContent = `Página ${currentPage} de ${totalPages}`;
  prevPageBtn.disabled = currentPage <= 1;
  nextPageBtn.disabled = currentPage >= totalPages;
}

// ── STATUS ─────────────────────────────────────────────────────────────
function setStatus(msg, isActive = false) {
  statusTextEl.textContent = msg;
  statusDot.classList.toggle("active", isActive);
}

// ── TIMER ──────────────────────────────────────────────────────────────
function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function startTimer() {
  if (callTimerId) return;
  callTimerId = setInterval(() => {
    callDurEl.textContent = callStartedAt ? fmt(Date.now() - callStartedAt) : "00:00";
  }, 1000);
}
function stopTimer() { clearInterval(callTimerId); callTimerId = null; }

// ── BADGE ──────────────────────────────────────────────────────────────
function setBadge(state) {
  callBadgeEl.className = `badge state-${state}`;
  const labels = {
    dialing: "LLAMANDO...",
    ringing: "SONANDO",
    in_call: "EN LLAMADA",
    ended: "FINALIZADA",
    idle: "ESPERA",
    failed: "ERROR"
  };
  callBadgeEl.textContent = labels[state] || state.replace("_", " ");
}

function setAckBadge(state, text) {
  apkAckBadgeEl.className = `badge ${state ? `ack-${state}` : ""}`.trim();
  apkAckBadgeEl.textContent = text || "APK · —";
}

function makeCommandId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `cmd_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

function emitCallActionWithAck(action, payload = {}) {
  const commandId = makeCommandId();
  socket.emit("call:action", { action, commandId, ...payload });
  setAckBadge("pending", `APK · enviando ${action}...`);

  const timerId = setTimeout(() => {
    pendingCommandTimeouts.delete(commandId);
    setAckBadge("fail", `APK · sin respuesta (${action})`);
  }, 3500);
  pendingCommandTimeouts.set(commandId, timerId);
  return commandId;
}

// ── CALL MODAL ─────────────────────────────────────────────────────────
function openCallWindow(phone, opts = {}) {
  const c = contacts.find(x => x.phone === phone);
  callCtx = {
    phone,
    name: opts.contactName || c?.name || "Número desconocido",
    companyName: opts.companyName || c?.name || "",
    note: opts.note || c?.note || "",
    imageUrl: opts.imageUrl || `${window.location.origin}/logotipo-VCMAS.ico`
  };
  callNameEl.textContent = callCtx.name;
  callNumberEl.textContent = phone || "—";
  callNoteEl.textContent = callCtx.note || "Sin nota";
  callHintEl.textContent = "";
  callDurEl.textContent = "00:00";
  callKickerEl.textContent = "Llamando...";
  micEnabled = true;
  speakerEnabled = false;
  muteBtnEl.textContent = "🎙️ Micrófono";
  muteBtnEl.style.background = "";
  speakerBtnEl.textContent = "🔈 Altavoz OFF";
  micBadgeEl.textContent = "⏺ REC —";
  micBadgeEl.className = "badge";
  setAckBadge("", "APK · —");
  setBadge("dialing");
  callModalEl.style.display = "grid";
}



// ── MIC CONTROLS ──────────────────────────────────────────────────────────

async function startMic() {
  if (micStream) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    micEnabled = true;
    micBadgeEl.textContent = "🎙️ Activo";
    micBadgeEl.className = "badge success";
    // If we are already in a call, start streaming immediately
    if (["in_call", "ringing"].includes(currentState)) {
      startWebMicStreaming();
    }
  } catch (e) {
    console.error("Mic denied", e);
    micBadgeEl.textContent = "⚠️ Mic denegado";
    micBadgeEl.className = "badge danger";
  }
}

function stopMic() {
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  micEnabled = false;
  micBadgeEl.textContent = "🚫 Inactivo";
  micBadgeEl.className = "badge muted";

  if (webMicProcessor) {
    webMicProcessor.disconnect();
    webMicSource.disconnect();
    webMicProcessor = null;
    webMicSource = null;
  }
}

function toggleMute() {
  if (micEnabled) {
    emitCallActionWithAck("mute");
    micEnabled = false;
    muteBtnEl.textContent = "🔇 Micrófono OFF";
    muteBtnEl.style.background = "#d63384";
    micBadgeEl.textContent = "⏺ REC OFF";
    micBadgeEl.className = "badge";
    callHintEl.textContent = "Micrófono silenciado";
  } else {
    emitCallActionWithAck("unmute");
    micEnabled = true;
    muteBtnEl.textContent = "🎙️ Micrófono";
    muteBtnEl.style.background = "";
    micBadgeEl.textContent = "⏺ REC";
    micBadgeEl.className = "badge";
    callHintEl.textContent = "Micrófono activado";
  }
}

function toggleSpeaker() {
  if (speakerEnabled) {
    emitCallActionWithAck("speaker_off");
    speakerEnabled = false;
    speakerBtnEl.textContent = "🔈 Altavoz OFF";
    callHintEl.textContent = "Altavoz desactivado";
  } else {
    emitCallActionWithAck("speaker_on");
    speakerEnabled = true;
    speakerBtnEl.textContent = "🔊 Altavoz ON";
    callHintEl.textContent = "Altavoz activado";
  }
}

function applyState(state, lastNum) {

  currentState = state;
  if (!callCtx && lastNum) openCallWindow(lastNum);
  if (!callCtx) return;
  if (lastNum && callCtx.phone !== lastNum) openCallWindow(lastNum);
  setBadge(state);
  if (state === "in_call") {
    callKickerEl.textContent = "Llamada activa";
    if (!callStartedAt) callStartedAt = Date.now();
    startTimer();
    callHintEl.textContent = "Llamada en curso";
    callRingEl.textContent = "🔊";
    micBadgeEl.textContent = "⏺ REC";
    micBadgeEl.className = "badge";
    // Start audio bridge
    phoneAudioEnabled = true;
    ensurePhoneAudioCtx();
    startWebMicStreaming();
    return;
  }
  if (state === "ringing") {
    callKickerEl.textContent = "Llamando...";
    callHintEl.textContent = "Conectando...";
    callRingEl.textContent = "📞";
    micBadgeEl.textContent = "⏺ REC —";
    micBadgeEl.className = "badge";
    // Pre-enable audio reception
    phoneAudioEnabled = true;
    ensurePhoneAudioCtx();
    return;
  }
  if (state === "dialing") {
    callKickerEl.textContent = "Llamando...";
    callHintEl.textContent = "Conectando...";
    callRingEl.textContent = "📞";
    micBadgeEl.textContent = "⏺ REC —";
    micBadgeEl.className = "badge";
    return;
  }
  if (state === "ended" || state === "idle") {
    currentCallingContactId = null;
    renderContacts();
    callKickerEl.textContent = "Llamada finalizada";
    callHintEl.textContent = "Llamada finalizada";
    callRingEl.textContent = "📵";
    micBadgeEl.textContent = "⏺ REC —";
    micBadgeEl.className = "badge";
    stopTimer(); callStartedAt = null;
    stopPhoneAudio();
    setTimeout(() => {
      if (currentState === "idle" || currentState === "ended") {
        callModalEl.style.display = "none";
        callCtx = null;
        stopMic();
      }
    }, 2200);
  }
}

function setLinkedUi(linked, devName) {
  if (linked) {
    qrBlockEl.style.display = "none";
    linkedBanner.style.display = "flex";
    contactsSec.style.display = "block";
    sessionBarEl.style.display = "none";
    apkBarEl.style.display = "none";
    floatingAddContactBtn.style.display = "grid";
    linkedDevice.textContent = devName || "Android conectado";
  } else {
    qrBlockEl.style.display = "grid";
    linkedBanner.style.display = "none";
    contactsSec.style.display = "none";
    sessionBarEl.style.display = "flex";
    apkBarEl.style.display = "flex";
    floatingAddContactBtn.style.display = "none";
  }
}

// ── PAIRING ────────────────────────────────────────────────────────────
async function loadPairingData(code) {
  try {
    const res = await fetch(`/api/pairing/${encodeURIComponent(code)}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    pairLink = data.link;
    pairLinkEl.value = pairLink;
    qrHintEl.textContent = "Cargando QR...";
    pairQrEl.style.display = "none";
    pairQrEl.src = `/api/pairing-qr/${encodeURIComponent(code)}.svg?ts=${Date.now()}`;
  } catch {
    qrHintEl.textContent = "No se pudo generar QR.";
  }
}

pairQrEl.addEventListener("load", () => { pairQrEl.style.display = "block"; qrHintEl.textContent = ""; });
pairQrEl.addEventListener("error", () => { pairQrEl.style.display = "none"; qrHintEl.textContent = "Error al cargar QR."; });


// ── APK INFO ───────────────────────────────────────────────────────────
function paintApkMeta(name, sizeKb, modified, downloadHref) {
  apkNameEl.textContent = name || "Phone-VC Android";
  const updatedAt = modified
    ? new Date(modified).toLocaleString("es", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    })
    : "fecha desconocida";
  apkMetaEl.textContent = `${sizeKb || 0} KB · ${updatedAt}`;
  apkDlBtn.href = downloadHref || "/api/apk/download";
  apkDlBtn.style.opacity = "1";
  apkDlBtn.style.pointerEvents = "auto";
}

async function loadApkInfo() {
  try {
    const res = await fetch("/api/apk/versions");
    if (!res.ok) throw new Error("versions endpoint unavailable");
    const data = await res.json();
    if (data.ok && data.versions?.length) {
      apkVersionsCache = data.versions;
      apkVersionSelectEl.style.display = "inline-block";
      apkVersionSelectEl.innerHTML = "";
      for (const v of data.versions) {
        const ts = new Date(v.modified).toLocaleString("es", {
          year: "2-digit",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit"
        });
        const option = document.createElement("option");
        option.value = v.id;
        option.textContent = `${v.version} · ${v.type} · ${v.sizeKb}KB · ${ts}`;
        apkVersionSelectEl.appendChild(option);
      }

      const selected = data.versions.find(v => v.id === data.latestId) || data.versions[0];
      apkVersionSelectEl.value = selected.id;
      paintApkMeta(selected.name, selected.sizeKb, selected.modified, `/api/apk/download/${encodeURIComponent(selected.id)}`);
      return;
    }
    throw new Error("no versions");
  } catch {
    try {
      const infoRes = await fetch("/api/apk/info");
      const info = await infoRes.json();
      if (info?.ok) {
        apkVersionsCache = [];
        apkVersionSelectEl.style.display = "none";
        apkVersionSelectEl.innerHTML = "";
        paintApkMeta(info.name || "Phone-VC Android", info.sizeKb, info.modified, "/api/apk/download");
        return;
      }
    } catch {
      // final fallback below
    }
    apkMetaEl.textContent = "APK no disponible — compila el proyecto";
    apkDlBtn.style.opacity = "0.4";
    apkDlBtn.style.pointerEvents = "none";
    apkVersionSelectEl.style.display = "none";
    apkVersionSelectEl.innerHTML = `<option value="">Sin versiones</option>`;
  }
}

apkVersionSelectEl.addEventListener("change", async () => {
  const selectedId = apkVersionSelectEl.value;
  if (!selectedId) return;
  const v = apkVersionsCache.find(x => x.id === selectedId);
  if (!v) return;
  paintApkMeta(v.name, v.sizeKb, v.modified, `/api/apk/download/${encodeURIComponent(v.id)}`);
});

apkHelpBtn.addEventListener("click", () => {
  installGuide.style.display = installGuide.style.display === "none" ? "block" : "none";
});

// ─────────────────────────────────────────────────────────────────────
// ── CONTACT IMPORT ────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────

/**
 * Maps a column header string to a canonical field name.
 * Returns 'name'|'phone'|'note'|null
 */
function detectField(header) {
  const h = String(header).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  if (/^(nombre|name|nom|contact|contacto|cliente|empresa|razon_?social|company)/.test(h)) return "name";
  if (/^(tele?fono|phone|tel|cel(ular)?|movil|mobile|numero|number|num|whatsapp|wa)/.test(h)) return "phone";
  if (/^(nota?|note?|comment|comentario|obs|direccion|address|cargo|ref|description)/.test(h)) return "note";
  return null;
}

/**
 * Given an array of {name, phone, note?} rows, show preview table.
 */
function showPreview(rows) {
  importPreviewData = rows.filter(r => r.phone);
  previewCountEl.textContent = importPreviewData.length;
  previewBody.innerHTML = importPreviewData.slice(0, 50).map(r =>
    `<tr><td>${escHtml(r.name || "—")}</td><td style="font-family:monospace;font-size:12px;">${escHtml(r.phone)}</td><td>${escHtml(r.note || "")}</td></tr>`
  ).join("");
  if (importPreviewData.length > 50) {
    previewBody.innerHTML += `<tr><td colspan="3" class="muted" style="text-align:center;">… y ${importPreviewData.length - 50} más</td></tr>`;
  }
  importPreview.style.display = importPreviewData.length ? "block" : "none";
  if (!importPreviewData.length) setStatus("No se detectaron contactos con teléfono válido.");
}

/**
 * Parse a 2D array (rows×cols) of strings using header detection.
 */
function parseTable(rows) {
  if (rows.length < 2) return [];
  const headers = rows[0].map(detectField);
  const nameIdx = headers.indexOf("name");
  const phoneIdx = headers.indexOf("phone");
  const noteIdx = headers.indexOf("note");
  if (phoneIdx === -1) return [];

  return rows.slice(1).map(row => ({
    name: nameIdx >= 0 ? (row[nameIdx] || "").trim() : "",
    phone: phoneIdx >= 0 ? cleanPhone(row[phoneIdx] || "") : "",
    note: noteIdx >= 0 ? (row[noteIdx] || "").trim() : ""
  }));
}

function cleanPhone(raw) {
  // keep only digits, +, spaces; strip invisible chars
  return raw.replace(/[^\d+\s\-().]/g, "").trim();
}

// ── PARSE CSV ──────────────────────────────────────────────────────────
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  // Auto-detect delimiter: comma, semicolon, tab, pipe
  const delim = [",", ";", "\t", "|"].reduce((best, d) =>
    (lines[0].split(d).length > lines[0].split(best).length ? d : best), ",");

  return lines.map(line => {
    const cells = [];
    let cur = "", inQ = false;
    for (const ch of line) {
      if (ch === '"' && !inQ) { inQ = true; continue; }
      if (ch === '"' && inQ) { inQ = false; continue; }
      if (ch === delim && !inQ) { cells.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  });
}

// ── PARSE HTML TABLE ───────────────────────────────────────────────────
function parseHtmlTable(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const tables = [...doc.querySelectorAll("table")];
  if (!tables.length) return extractFlatList(doc);

  // Pick the table with the most rows
  const tbl = tables.reduce((a, b) => b.rows.length > a.rows.length ? b : a);
  const rows = [...tbl.rows].map(r => [...r.cells].map(c => c.textContent.trim()));
  return parseTable(rows);
}

/**
 * Fallback: scan page for patterns like "Nombre: ... Teléfono: ..."
 */
function extractFlatList(doc) {
  const text = doc.body?.innerText || "";
  const result = [];
  const phoneRe = /(\+?[\d][\d\s\-().]{6,17})/g;
  // Try to find lines that have a phone number
  const lines = text.split(/\n/).filter(l => l.trim());
  for (const line of lines) {
    const m = line.match(phoneRe);
    if (!m) continue;
    const phone = cleanPhone(m[0]);
    const name = line.replace(m[0], "").replace(/[:;,|]+/g, " ").replace(/\s{2,}/g, " ").trim();
    result.push({ name: name || "—", phone, note: "" });
  }
  return result;
}

// ── WORD (.docx) handler ───────────────────────────────────────────────
async function importFromDocx(file) {
  setStatus("Leyendo archivo Word...");
  try {
    const arrayBuffer = await file.arrayBuffer();
    // mammoth.js converts docx → HTML
    const result = await mammoth.convertToHtml({ arrayBuffer });
    const rows = parseHtmlTable(result.value);
    if (rows.length) { showPreview(rows); return; }
    // Fallback: extract raw text and try CSV-like parsing
    const text = await mammoth.extractRawText({ arrayBuffer });
    const csvRows = parseCsv(text.value);
    showPreview(parseTable(csvRows));
  } catch (e) {
    setStatus("Error al leer .docx: " + e.message);
  }
}

// ── CSV / TXT handler ──────────────────────────────────────────────────
async function importFromCsv(file) {
  setStatus("Leyendo archivo CSV...");
  try {
    const text = await file.text();
    const rows = parseCsv(text);
    showPreview(parseTable(rows));
  } catch (e) {
    setStatus("Error al leer CSV: " + e.message);
  }
}

// ── URL IMPORT ─────────────────────────────────────────────────────────
async function importFromUrl() {
  const url = importUrlEl.value.trim();
  if (!url) return;
  importUrlBtn.disabled = true;
  importUrlBtn.textContent = "⏳ Cargando...";
  setStatus("Obteniendo página...");
  try {
    const res = await fetch(`/api/fetch-url?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Error al obtener URL");
    const rows = parseHtmlTable(data.html);
    showPreview(rows);
  } catch (e) {
    setStatus("Error: " + e.message);
  } finally {
    importUrlBtn.disabled = false;
    importUrlBtn.textContent = "🔍 Importar";
  }
}

// ── FILE INPUT ─────────────────────────────────────────────────────────
importFileEl.addEventListener("change", async () => {
  const file = importFileEl.files[0];
  if (!file) return;
  importFileNameEl.textContent = file.name;
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "docx") { await importFromDocx(file); }
  else { await importFromCsv(file); }  // csv, txt, xlsx (as csv export)
});

importUrlBtn.addEventListener("click", importFromUrl);

importConfirm.addEventListener("click", () => {
  let added = 0;
  for (const r of importPreviewData) {
    if (!r.phone) continue;
    contacts.unshift({ id: crypto.randomUUID(), name: r.name || "—", phone: r.phone, note: r.note || "" });
    added++;
  }
  currentPage = 1;
  saveContacts(); renderContacts();
  importPreview.style.display = "none";
  importPreviewData = [];
  setStatus(`✅ ${added} contactos importados.`, true);
});

importCancel.addEventListener("click", () => {
  importPreview.style.display = "none";
  importPreviewData = [];
  importFileEl.value = "";
  importFileNameEl.textContent = "Ninguno seleccionado";
});

// ── IMPORT TABS ────────────────────────────────────────────────────────
tabWord.addEventListener("click", () => {
  tabWord.classList.add("active"); tabUrl.classList.remove("active");
  panelWord.style.display = "block"; panelUrl.style.display = "none";
});
tabUrl.addEventListener("click", () => {
  tabUrl.classList.add("active"); tabWord.classList.remove("active");
  panelUrl.style.display = "block"; panelWord.style.display = "none";
});

// ── CONTACT TABLE ACTIONS ──────────────────────────────────────────────
function closeAddModal() {
  addContactModalEl.style.display = "none";
  addNameInput.value = "";
  addPhoneInput.value = "";
  addNoteInput.value = "";
}

floatingAddContactBtn.addEventListener("click", () => {
  addContactModalEl.style.display = "grid";
  addNameInput.focus();
});

addCloseBtn.addEventListener("click", closeAddModal);

addSaveBtn.addEventListener("click", () => {
  const name = addNameInput.value.trim();
  const phone = addPhoneInput.value.trim();
  const note = addNoteInput.value.trim();
  if (!name || !phone) {
    setStatus("Nombre y teléfono son obligatorios.", true);
    return;
  }
  contacts.unshift({ id: crypto.randomUUID(), name, phone, note });
  currentPage = 1;
  saveContacts();
  renderContacts();
  setStatus("Contacto agregado.", true);
  closeAddModal();
});

cBodyEl.addEventListener("click", e => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;
  if (!action || !id) return;
  if (action === "delete") {
    if (id === currentCallingContactId) currentCallingContactId = null;
    delete calledCounts[id];
    saveCalledCounts();
    contacts = contacts.filter(c => c.id !== id);
    saveContacts(); renderContacts(); return;
  }
  const c = contacts.find(x => x.id === id);
  if (!c) return;
  if (action === "edit") {
    editContactId = c.id;
    editNameInput.value = c.name || "";
    editPhoneInput.value = c.phone || "";
    editNoteInput.value = c.note || "";
    editModalEl.style.display = "grid";
    editNameInput.focus();
    setStatus("Editando contacto en popup.", true);
    return;
  }
  if (action === "dial") {
    if (["dialing", "ringing", "in_call"].includes(currentState)) {
      setStatus("Ya hay una llamada en curso.", true); return;
    }
    currentCallingContactId = c.id;
    calledCounts[c.id] = Number(calledCounts[c.id] || 0) + 1;
    saveCalledCounts();
    renderContacts();
    openCallWindow(c.phone, {
      contactName: c.name,
      companyName: c.name,
      note: c.note,
      imageUrl: `${window.location.origin}/logotipo-VCMAS.ico`
    });
    emitCallActionWithAck("dial", {
      phoneNumber: c.phone,
      contactName: c.name,
      companyName: c.name,
      imageUrl: `${window.location.origin}/logotipo-VCMAS.ico`
    });
    return;
  }
});

function closeEditModal() {
  editModalEl.style.display = "none";
  editContactId = null;
  editNameInput.value = "";
  editPhoneInput.value = "";
  editNoteInput.value = "";
}

editCloseBtn.addEventListener("click", closeEditModal);

editSaveBtn.addEventListener("click", () => {
  if (!editContactId) return;
  const contact = contacts.find(x => x.id === editContactId);
  if (!contact) return;

  const name = editNameInput.value.trim();
  const phone = editPhoneInput.value.trim();
  const note = editNoteInput.value.trim();
  if (!name || !phone) {
    setStatus("Nombre y teléfono son obligatorios.", true);
    return;
  }

  contact.name = name;
  contact.phone = phone;
  contact.note = note;
  saveContacts();
  renderContacts();
  setStatus("Contacto editado.", true);
  closeEditModal();
});

prevPageBtn.addEventListener("click", () => {
  if (currentPage <= 1) return;
  currentPage--;
  renderContacts();
});

nextPageBtn.addEventListener("click", () => {
  const totalPages = Math.max(1, Math.ceil(contacts.length / PAGE_SIZE));
  if (currentPage >= totalPages) return;
  currentPage++;
  renderContacts();
});

// ── CALL MODAL EVENTS ──────────────────────────────────────────────────
muteBtnEl.addEventListener("click", toggleMute);
speakerBtnEl.addEventListener("click", toggleSpeaker);

hangupBtnEl.addEventListener("click", () => {
  emitCallActionWithAck("hangup");
  callHintEl.textContent = "Enviando orden de corte...";
  applyState("ended", callCtx?.phone || "");
});

copyBtn.addEventListener("click", async () => {
  if (!pairLink) return;
  try { await navigator.clipboard.writeText(pairLink); setStatus("Link copiado al portapapeles.", true); }
  catch { setStatus("No se pudo copiar el link."); }
});

// ── SESSION EVENTS ─────────────────────────────────────────────────────
createBtn.addEventListener("click", () => { socket.emit("session:create"); });

joinBtn.addEventListener("click", () => {
  const code = sessionCodeIn.value.trim().toUpperCase();
  if (!code) return;
  socket.emit("session:join", { code, role: "dashboard" });
  loadPairingData(code);
});

// ── SOCKET EVENTS ──────────────────────────────────────────────────────
socket.on("session:created", ({ code }) => {
  sessionCode = code;
  sessionCodeIn.value = code;
  setStatus(`Sesión ${code} creada. Vincula el dashboard y el celular.`, true);
  setLinkedUi(false);
  loadPairingData(code);
});

socket.on("session:joined", ({ code, role }) => {
  sessionCode = code;
  setStatus(`${role} vinculado en sesión ${code}.`, true);
  setLinkedUi(false);
  loadPairingData(code);
});

socket.on("state:changed", st => {
  const c = st.connected;
  setStatus(
    `Dashboard: ${c.dashboard ? "✅" : "❌"} | Celular: ${c.phone ? "✅" : "❌"} | Estado: ${st.callState} | Nro: ${st.lastNumber || "—"}`,
    c.dashboard && c.phone
  );
  setLinkedUi(Boolean(c.phone), st.phoneDevice?.name);
  applyState(st.callState, st.lastNumber);
});

socket.on("connect", () => setStatus("Conectado al servidor. Crea una sesión."));
socket.on("disconnect", () => { setStatus("Socket desconectado."); stopPhoneAudio(); });
socket.on("connect_error", () => setStatus("No se pudo conectar al servidor."));

socket.on("phone:command_ack", ({ commandId, action, ok, message }) => {
  if (commandId && pendingCommandTimeouts.has(commandId)) {
    clearTimeout(pendingCommandTimeouts.get(commandId));
    pendingCommandTimeouts.delete(commandId);
  }
  if (ok) {
    setAckBadge("ok", `APK · ${action} aplicado`);
  } else {
    setAckBadge("fail", `APK · error ${action}`);
  }
  if (message) callHintEl.textContent = message;
});

// ── AUDIO BRIDGE ──────────────────────────────────────────────────────────
// Bidirectional audio: Android phone MIC ↔ Web browser MIC
// No root required. Works entirely with standard Web APIs + Socket.IO binary.
// -  phone MIC  → socket "audio:phone"    → AudioContext.play() in browser
// -  web  MIC  → socket "audio:dashboard" → AudioTrack on Android phone

const AUDIO_SAMPLE_RATE = 16000;  // must match BridgeService.SAMPLE_RATE

let phoneAudioCtx = null;
let webMicSource = null;
let webMicProcessor = null;
let phoneAudioEnabled = false;
let phoneNextPlayTime = 0;

/** Receive binary PCM16 from Android → play via AudioContext */
socket.on("audio:phone", (data) => {
  if (!phoneAudioEnabled) return;
  ensurePhoneAudioCtx();

  // Decode ArrayBuffer → Int16 → Float32
  const ab = data instanceof ArrayBuffer ? data : data.buffer || data;
  const i16 = new Int16Array(ab);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;

  // Create AudioBuffer and schedule playback  (gap-free streaming)
  const buf = phoneAudioCtx.createBuffer(1, f32.length, AUDIO_SAMPLE_RATE);
  buf.copyToChannel(f32, 0);

  const srcNode = phoneAudioCtx.createBufferSource();
  srcNode.buffer = buf;
  srcNode.connect(phoneAudioCtx.destination);

  const now = phoneAudioCtx.currentTime;
  // Maintain a ~150ms buffer ahead to avoid gaps
  if (phoneNextPlayTime < now + 0.02) phoneNextPlayTime = now + 0.02;
  srcNode.start(phoneNextPlayTime);
  phoneNextPlayTime += buf.duration;
});

function ensurePhoneAudioCtx() {
  if (phoneAudioCtx && phoneAudioCtx.state !== "closed") return;
  phoneAudioCtx = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
  phoneNextPlayTime = 0;
}

/** Capture web MIC → send PCM16 to Android via socket */
async function startWebMicStreaming() {
  if (webMicProcessor) return;  // already running

  if (!micStream) await startMic();  // reuse existing mic stream
  if (!micStream) return;

  // Create an AudioContext at 16kHz (Chrome/Edge support arbitrary rates)
  let streamCtx;
  try {
    streamCtx = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
  } catch {
    streamCtx = new AudioContext();  // fallback to default, resampling happens below
  }

  webMicSource = streamCtx.createMediaStreamSource(micStream);
  webMicProcessor = streamCtx.createScriptProcessor(1280, 1, 1);

  const targetRate = AUDIO_SAMPLE_RATE;
  const srcRate = streamCtx.sampleRate;

  webMicProcessor.onaudioprocess = (e) => {
    let f32 = e.inputBuffer.getChannelData(0);

    // Resample if AudioContext rate ≠ 16kHz
    if (srcRate !== targetRate) {
      f32 = downsample(f32, srcRate, targetRate);
    }

    const i16 = float32ToInt16(f32);
    if (socket.connected()) {
      socket.emit("audio:dashboard", i16.buffer);
    }
  };

  webMicSource.connect(webMicProcessor);
  webMicProcessor.connect(streamCtx.destination);
}

function stopPhoneAudio() {
  phoneAudioEnabled = false;
  try { phoneAudioCtx?.close(); } catch { }
  phoneAudioCtx = null;
  phoneNextPlayTime = 0;

  webMicProcessor?.disconnect();
  webMicSource?.disconnect();
  webMicProcessor = null;
  webMicSource = null;
}

/** Linear downsample Float32Array from srcRate to dstRate */
function downsample(buf, srcRate, dstRate) {
  if (srcRate === dstRate) return buf;
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(buf.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = Math.min(Math.floor(i * ratio), buf.length - 1);
    out[i] = buf[idx];
  }
  return out;
}

/** Convert Float32 [-1,1] → Int16 PCM */
function float32ToInt16(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return i16;
}


// ── INIT ──────────────────────────────────────────────────────────────────
loadContacts();
loadCalledCounts();
renderContacts();
loadApkInfo();
