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
const exportWordBtn = document.getElementById("exportWordBtn");
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
const whatsappModalEl = document.getElementById("whatsappModal");
const whatsappCloseBtn = document.getElementById("whatsappCloseBtn");
const whatsappTitleEl = document.getElementById("whatsappTitle");
const whatsappPhoneEl = document.getElementById("whatsappPhone");
const whatsappQrPanelEl = document.getElementById("whatsappQrPanel");
const whatsappQrLeadEl = document.getElementById("whatsappQrLead");
const whatsappConnectOkEl = document.getElementById("whatsappConnectOk");
const whatsappLinkedNumberEl = document.getElementById("whatsappLinkedNumber");
const whatsappQrImgEl = document.getElementById("whatsappQrImg");
const whatsappQrHintEl = document.getElementById("whatsappQrHint");
const whatsappLogoutBtn = document.getElementById("whatsappLogoutBtn");
const whatsappFormPanelEl = document.getElementById("whatsappFormPanel");
const whatsappMessageInput = document.getElementById("whatsappMessageInput");
const whatsappFileInput = document.getElementById("whatsappFileInput");
const whatsappSendBtn = document.getElementById("whatsappSendBtn");
const whatsappDropZone = document.getElementById("whatsappDropZone");
const whatsappFileNameEl = document.getElementById("whatsappFileName");
const whatsappTemplatesEl = document.getElementById("whatsappTemplates");
const whatsappTemplateInput = document.getElementById("whatsappTemplateInput");
const whatsappTemplateSaveBtn = document.getElementById("whatsappTemplateSaveBtn");
const connectWhatsAppBtn = document.getElementById("connectWhatsAppBtn");
const openQuotationBtn = document.getElementById("openQuotationBtn");
const quotationModalEl = document.getElementById("quotationModal");
const quotationCloseBtn = document.getElementById("quotationCloseBtn");
const quotationItemsBodyEl = document.getElementById("quotationItemsBody");
const quotationAddItemBtn = document.getElementById("quotationAddItemBtn");
const quotationApplyIgvEl = document.getElementById("quotationApplyIgv");
const quotationSubtotalEl = document.getElementById("quotationSubtotal");
const quotationIgvEl = document.getElementById("quotationIgv");
const quotationTotalEl = document.getElementById("quotationTotal");
const quotationPreviewBtn = document.getElementById("quotationPreviewBtn");
const quotationDownloadBtn = document.getElementById("quotationDownloadBtn");
const quotationPreviewModalEl = document.getElementById("quotationPreviewModal");
const quotationPreviewCloseBtn = document.getElementById("quotationPreviewCloseBtn");
const quotationPreviewDownloadBtn = document.getElementById("quotationPreviewDownloadBtn");
const quotationSendFeedbackEl = document.getElementById("quotationSendFeedback");
const quotationPreviewFrameEl = document.getElementById("quotationPreviewFrame");
const qDateEl = document.getElementById("qDate");
const qCompanyEl = document.getElementById("qCompany");
const qRucEl = document.getElementById("qRuc");
const qPhoneEl = document.getElementById("qPhone");
const qEmailEl = document.getElementById("qEmail");
const qAddressEl = document.getElementById("qAddress");
const quotationServicesDatalistEl = document.getElementById("quotationServicesDatalist");

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
let currentPhoneLinked = false;
let whatsappCurrentContact = null;
let whatsappModalMode = "contact";
let whatsappQrPollTimer = null;
const pendingCommandTimeouts = new Map();
const PAGE_SIZE = 20;
const CALLED_COUNTS_KEY = "kenia.calledCounts";
let calledCounts = {};
const WHATSAPP_API_BASE = window.location.origin;
const WA_STATUS_PATHS = ["/api/whatsapp/status"];
const WA_QR_PATHS = ["/api/whatsapp/qr"];
const WA_LOGOUT_PATHS = ["/api/whatsapp/logout"];
const WA_SEND_PATHS = ["/api/whatsapp/send-message", "/api/whatsapp/send"];
const NGROK_SKIP_WARNING_HEADERS = { "ngrok-skip-browser-warning": "1" };
const WHATSAPP_PRESETS_KEY = "kenia.whatsappPresetMessages";
const DEFAULT_WHATSAPP_PRESET_MESSAGES = [
  "Hola, te escribo de VCMAS. Quedo atento a tu respuesta.",
  "Buenas, te contacto para coordinar una llamada.",
  "Hola, te comparto seguimiento del tema pendiente."
];
let whatsappPresetMessages = [...DEFAULT_WHATSAPP_PRESET_MESSAGES];
let quotationItems = [];
let quotationMessageBridgeBound = false;
const QUOTATION_SERVICE_OPTIONS = [
  "WEB INFORMATIVA",
  "WEB E-COMMERCE",
  "WEB AULA VIRTUAL",
  "POSICIONAMIENTO SEO",
  "LICENCIA DE ANTIVIRUS",
  "PLUGIN YOAST SEO",
  "RESTRUCTURACION BASICA",
  "RESTRUCTURACION E-COMMERCE",
  "WEB FUSION E-COMMERCE",
  "WEB FUSION AULA VIRTUAL",
  "REDES SOCIALES"
];
const QUOTATION_IMAGE_OPTIONS = [
  "/quotation-images/web-informativa.png",
  "/quotation-images/E-COMERCE.png",
  "/quotation-images/aula-virtual.png",
  "/quotation-images/posicionamiento-seo.png",
  "/quotation-images/1764976277_ANTIVIRUS.png",
  "/quotation-images/yoast-seo.png",
  "/quotation-images/restructuracion.png",
  "/quotation-images/REDES.png"
];
const QUOTATION_SERVICE_IMAGE_MAP = {
  "WEB INFORMATIVA": ["/quotation-images/web-informativa.png"],
  "WEB E-COMMERCE": ["/quotation-images/E-COMERCE.png"],
  "WEB FUSION E-COMMERCE": ["/quotation-images/web-informativa.png", "/quotation-images/E-COMERCE.png"],
  "POSICIONAMIENTO SEO": ["/quotation-images/posicionamiento-seo.png"],
  "WEB AULA VIRTUAL": ["/quotation-images/aula-virtual.png"],
  "WEB FUSION AULA VIRTUAL": ["/quotation-images/web-informativa.png", "/quotation-images/aula-virtual.png"],
  "PLUGIN YOAST SEO": ["/quotation-images/yoast-seo.png"],
  "RESTRUCTURACION BASICA": ["/quotation-images/restructuracion.png"],
  "RESTRUCTURACION E-COMMERCE": ["/quotation-images/restructuracion.png"],
  "REDES SOCIALES": ["/quotation-images/REDES.png"]
};

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

function loadWhatsAppPresetMessages() {
  try {
    const raw = JSON.parse(localStorage.getItem(WHATSAPP_PRESETS_KEY) || "[]");
    if (Array.isArray(raw)) {
      whatsappPresetMessages = raw
        .map((msg) => String(msg || "").trim())
        .filter(Boolean);
    }
  } catch {
    whatsappPresetMessages = [];
  }

  if (!whatsappPresetMessages.length) {
    whatsappPresetMessages = [...DEFAULT_WHATSAPP_PRESET_MESSAGES];
    saveWhatsAppPresetMessages();
  }
}

function saveWhatsAppPresetMessages() {
  localStorage.setItem(WHATSAPP_PRESETS_KEY, JSON.stringify(whatsappPresetMessages));
}

function exportContactsToWord() {
  const rows = contacts.map((c) => {
    const count = Number(calledCounts[c.id] || 0);
    const rowBg = count > 0 ? "#FEF3C7" : "#FFFFFF";
    return `
      <tr style="background:${rowBg};">
        <td style="border:1px solid #D1D5DB;padding:8px;">${escHtml(c.name || "—")}</td>
        <td style="border:1px solid #D1D5DB;padding:8px;">${escHtml(c.phone || "—")}</td>
        <td style="border:1px solid #D1D5DB;padding:8px;">${escHtml(c.note || "—")}</td>
        <td style="border:1px solid #D1D5DB;padding:8px;text-align:center;">${count}</td>
      </tr>`;
  }).join("");

  const now = new Date();
  const fileStamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}`;

  const html = `
    <html>
      <head>
        <meta charset="UTF-8" />
        <title>Contactos</title>
        <style>
          @page {
            size: A4 landscape;
            margin: 1.2cm;
            mso-page-orientation: landscape;
          }
          body { font-family: Calibri, Arial, sans-serif; }
          table { border-collapse: collapse; width: 100%; font-size: 12pt; }
        </style>
      </head>
      <body>
        <h2 style="margin-bottom:4px;">Reporte de Contactos</h2>
        <p style="margin-top:0;color:#6B7280;">Generado: ${now.toLocaleString("es")}</p>
        <table style="writing-mode:horizontal-tb;">
          <thead>
            <tr style="background:#F3F4F6;">
              <th style="border:1px solid #D1D5DB;padding:8px;">Nombre</th>
              <th style="border:1px solid #D1D5DB;padding:8px;">Teléfono</th>
              <th style="border:1px solid #D1D5DB;padding:8px;">Nota</th>
              <th style="border:1px solid #D1D5DB;padding:8px;">Llamadas</th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><td colspan="4" style="border:1px solid #D1D5DB;padding:8px;">Sin contactos</td></tr>`}
          </tbody>
        </table>
        <p style="margin-top:10px;font-size:11px;color:#6B7280;">Filas amarillas = contacto llamado al menos una vez.</p>
      </body>
    </html>`;

  const blob = new Blob(["\ufeff", html], { type: "application/msword" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `contactos_${fileStamp}.doc`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setStatus("Exportación Word completada.", true);
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
        <button data-action="edit" data-id="${c.id}" class="secondary">✏️ Editar</button>
        <button data-action="whatsapp" data-id="${c.id}" class="wa-action-btn" title="WhatsApp">🟢 WhatsApp</button>
        <button data-action="dial"   data-id="${c.id}">📞 Llamar</button>
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
  currentPhoneLinked = Boolean(linked);
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

function normalizePhoneForWa(phone) {
  let clean = String(phone || "").replace(/\D/g, "");
  if (!clean) return "";

  // Si ya empieza con 51 y tiene longitud de internacional (11 dígitos para Perú)
  if (clean.startsWith("51") && clean.length >= 11) {
    return "+" + clean;
  }

  // Si tiene 9 dígitos y empieza con 9, es un móvil de Perú
  if (clean.length === 9 && clean.startsWith("9")) {
    return "+51" + clean;
  }

  // Otros casos, solo asegurar el +
  return "+" + clean;
}

async function fetchWhatsAppJson(paths, options) {
  for (const p of paths) {
    try {
      const mergedOptions = {
        ...(options || {}),
        headers: {
          ...NGROK_SKIP_WARNING_HEADERS,
          ...(options?.headers || {})
        }
      };
      const res = await fetch(`${WHATSAPP_API_BASE}${p}`, mergedOptions);
      if (!res.ok) continue;
      try {
        const data = await res.json();
        return data;
      } catch {
        const text = await res.text();
        return { raw: text, qr: text };
      }
    } catch {
      // try next candidate path
    }
  }
  return null;
}

function isWaLinked(data) {
  if (!data || typeof data !== "object") return false;
  return Boolean(
    data.linked ??
    data.connected ??
    data.isConnected ??
    data.ready ??
    data.isReady ??
    data.authenticated
  );
}

function extractWaQr(data) {
  const raw = data?.qr || data?.qrCode || data?.qrcode || data?.dataUrl;
  if (!raw || typeof raw !== "string") return "";
  if (raw.startsWith("data:image")) return raw;
  if (raw.startsWith("<svg")) return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(raw)))}`;
  return `data:image/png;base64,${raw}`;
}

function showWaConnectionBadge({ connected, text }) {
  if (!whatsappConnectOkEl) return;
  whatsappConnectOkEl.style.display = "grid";
  whatsappConnectOkEl.classList.toggle("is-offline", !connected);
  const strong = whatsappConnectOkEl.querySelector("strong");
  if (strong) strong.textContent = connected ? "Cuenta conectada" : "Cuenta desconectada";
  if (whatsappLinkedNumberEl) whatsappLinkedNumberEl.textContent = text || (connected ? "Dispositivo vinculado" : "Sin vínculo activo");
}

async function refreshWhatsAppModal() {
  if (whatsappModalEl.style.display !== "grid") return;

  const statusData = await fetchWhatsAppJson(WA_STATUS_PATHS, { cache: "no-store" });
  const linked = isWaLinked(statusData);
  const linkedPhone = statusData?.phone ? String(statusData.phone).replace("@s.whatsapp.net", "") : "";

  if (linked) {
    whatsappQrImgEl.src = "";
    whatsappQrImgEl.style.display = "none";
    if (whatsappLogoutBtn) whatsappLogoutBtn.style.display = "inline-flex";
    if (whatsappQrLeadEl) whatsappQrLeadEl.style.display = "none";
    showWaConnectionBadge({ connected: true, text: linkedPhone || "Dispositivo vinculado" });

    if (whatsappModalMode === "connect") {
      whatsappFormPanelEl.style.display = "none";
      whatsappQrPanelEl.style.display = "grid";
      whatsappQrHintEl.textContent = "Listo. Puedes continuar.";
    } else {
      whatsappQrPanelEl.style.display = "none";
      whatsappFormPanelEl.style.display = "grid";
      if (!whatsappMessageInput.value) {
        whatsappMessageInput.focus();
      }
    }

    stopWhatsAppQrPolling();
    return;
  }

  whatsappFormPanelEl.style.display = "none";
  whatsappQrPanelEl.style.display = "grid";
  if (whatsappLogoutBtn) whatsappLogoutBtn.style.display = "none";
  showWaConnectionBadge({ connected: false, text: "Sin vínculo activo" });
  if (whatsappQrLeadEl) whatsappQrLeadEl.style.display = "block";
  whatsappQrHintEl.textContent = "Cuenta desconectada. Generando QR de WhatsApp...";

  const qrData = await fetchWhatsAppJson(WA_QR_PATHS, { cache: "no-store" });
  const qrSrc = extractWaQr(qrData);
  if (qrSrc) {
    whatsappQrImgEl.src = qrSrc;
    whatsappQrImgEl.style.display = "block";
    whatsappQrHintEl.textContent = "Escanea este QR en WhatsApp para vincular.";
  } else {
    whatsappQrImgEl.src = "";
    whatsappQrImgEl.style.display = "none";
    whatsappQrHintEl.textContent = "Esperando QR. Si tarda, verifica que el backend WhatsApp esté activo.";
  }

  startWhatsAppQrPolling();
}

function openWhatsAppModal(contact) {
  const phone = normalizePhoneForWa(contact?.phone || "");
  const waNumber = String(phone).replace(/\D/g, "");
  if (!waNumber) {
    alert("El contacto no tiene un número válido para WhatsApp.");
    return;
  }

  whatsappCurrentContact = { ...contact, phone };
  whatsappModalMode = "contact";
  whatsappTitleEl.textContent = `WhatsApp · ${contact?.name || "Contacto"}`;
  whatsappPhoneEl.textContent = phone;
  whatsappModalEl.style.display = "grid";
  whatsappFormPanelEl.style.display = "none";
  whatsappQrPanelEl.style.display = "grid";
  whatsappQrImgEl.style.display = "none";
  whatsappQrImgEl.src = "";
  if (whatsappConnectOkEl) whatsappConnectOkEl.style.display = "none";
  if (whatsappQrLeadEl) whatsappQrLeadEl.style.display = "block";
  whatsappMessageInput.value = "";
  whatsappFileInput.value = "";
  updateWhatsAppFileLabel();
  renderWhatsAppPresetMessages();
  whatsappQrHintEl.textContent = "Cargando estado de WhatsApp...";
  setStatus(`Verificando conexion de WhatsApp para ${phone}...`, true);
  refreshWhatsAppModal();
}

function openWhatsAppConnectModal() {
  whatsappModalMode = "connect";
  whatsappCurrentContact = null;
  whatsappTitleEl.textContent = "Conectar WhatsApp";
  whatsappPhoneEl.textContent = "Escanea el QR para vincular el dispositivo.";
  whatsappModalEl.style.display = "grid";
  whatsappFormPanelEl.style.display = "none";
  whatsappQrPanelEl.style.display = "grid";
  whatsappQrImgEl.style.display = "none";
  whatsappQrImgEl.src = "";
  if (whatsappConnectOkEl) whatsappConnectOkEl.style.display = "none";
  if (whatsappQrLeadEl) whatsappQrLeadEl.style.display = "block";
  whatsappQrHintEl.textContent = "Cargando estado de WhatsApp...";
  refreshWhatsAppModal();
}

function startWhatsAppQrPolling() {
  if (whatsappQrPollTimer) return;
  whatsappQrPollTimer = setInterval(() => {
    refreshWhatsAppModal().catch(() => {
      // El hint ya maneja errores visuales en la siguiente iteracion.
    });
  }, 3000);
}

function stopWhatsAppQrPolling() {
  if (!whatsappQrPollTimer) return;
  clearInterval(whatsappQrPollTimer);
  whatsappQrPollTimer = null;
}

function closeWhatsAppModal() {
  stopWhatsAppQrPolling();
  whatsappModalEl.style.display = "none";
  whatsappCurrentContact = null;
  whatsappModalMode = "contact";
  whatsappMessageInput.value = "";
  whatsappFileInput.value = "";
  whatsappQrImgEl.src = "";
  whatsappQrImgEl.style.display = "none";
  if (whatsappLogoutBtn) whatsappLogoutBtn.style.display = "none";
  if (whatsappConnectOkEl) whatsappConnectOkEl.style.display = "none";
  if (whatsappQrLeadEl) whatsappQrLeadEl.style.display = "block";
}

async function logoutWhatsAppAccount() {
  if (!confirm("Se cerrará la sesión de WhatsApp vinculada. ¿Continuar?")) return;
  try {
    if (whatsappLogoutBtn) {
      whatsappLogoutBtn.disabled = true;
      whatsappLogoutBtn.textContent = "Cerrando...";
    }
    let ok = false;
    let lastError = "No se pudo cerrar sesión.";
    for (const path of WA_LOGOUT_PATHS) {
      try {
        const res = await fetch(`${WHATSAPP_API_BASE}${path}`, {
          method: "POST",
          headers: {
            ...NGROK_SKIP_WARNING_HEADERS,
            "Content-Type": "application/json"
          },
          body: "{}"
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data?.ok) {
          ok = true;
          break;
        }
        lastError = data?.error || `HTTP ${res.status}`;
      } catch (err) {
        lastError = err?.message || "Error de red";
      }
    }

    // Fallback: si backend ya reporta desconectado, lo tomamos como cierre exitoso.
    if (!ok) {
      const statusData = await fetchWhatsAppJson(WA_STATUS_PATHS, { cache: "no-store" });
      if (!isWaLinked(statusData)) {
        ok = true;
      }
    }
    if (!ok) throw new Error(lastError);

    whatsappQrImgEl.src = "";
    whatsappQrImgEl.style.display = "none";
    showWaConnectionBadge({ connected: false, text: "Sin vínculo activo" });
    whatsappQrHintEl.textContent = "Cuenta desconectada. Generando nuevo QR...";
    setStatus("Sesión de WhatsApp cerrada.", true);
    await refreshWhatsAppModal();
  } catch (err) {
    alert(`No se pudo cerrar sesión: ${err.message}`);
    setStatus(`Error cerrando sesión de WhatsApp: ${err.message}`, true);
  } finally {
    if (whatsappLogoutBtn) {
      whatsappLogoutBtn.disabled = false;
      whatsappLogoutBtn.textContent = "Cerrar sesión";
    }
  }
}

async function sendWhatsAppMessage() {
  if (!whatsappCurrentContact) return;

  const phone = whatsappPhoneEl.textContent;
  const message = whatsappMessageInput.value.trim();
  const file = whatsappFileInput.files?.[0] || null;

  if (!phone || phone === "-") {
    alert("El contacto no tiene un número de teléfono válido.");
    return;
  }

  if (!message && !file) {
    alert("Por favor, escribe un mensaje o selecciona un archivo para enviar.");
    return;
  }

  whatsappSendBtn.disabled = true;
  whatsappSendBtn.textContent = "Enviando...";
  setStatus(`Enviando por Baileys a ${phone}...`, true);

  try {
    const statusData = await fetchWhatsAppJson(WA_STATUS_PATHS, { cache: "no-store" });
    if (!isWaLinked(statusData)) {
      throw new Error("WhatsApp no está conectado. Usa 'Conectar WhatsApp' primero.");
    }

    let sent = false;
    let lastError = "No se pudo enviar por WhatsApp.";
    for (const path of WA_SEND_PATHS) {
      const fd = new FormData();
      fd.append("to", phone);
      fd.append("message", message || "");
      if (file) fd.append("file", file, file.name || "archivo");

      try {
        const res = await fetch(`${WHATSAPP_API_BASE}${path}`, {
          method: "POST",
          body: fd,
          headers: NGROK_SKIP_WARNING_HEADERS
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data?.ok) {
          sent = true;
          break;
        }
        lastError = data?.error || `HTTP ${res.status}`;
      } catch (err) {
        lastError = err?.message || "Error de red";
      }
    }

    if (!sent) {
      throw new Error(lastError);
    }

    setStatus(`✅ Mensaje enviado a ${phone}`, true);
    setTimeout(() => setStatus("Listo.", true), 3000);
    closeWhatsAppModal();
  } catch (err) {
    console.error("WhatsApp Send Error:", err);
    alert(`No se pudo enviar: ${err.message}`);
    setStatus(`❌ Error: ${err.message}`, true);
  } finally {
    whatsappSendBtn.disabled = false;
    whatsappSendBtn.textContent = "Enviar por WhatsApp";
  }
}

// ── DRAG & DROP WHATSAPP ───────────────────────────────────────────
if (whatsappDropZone) {
  whatsappDropZone.addEventListener("click", () => whatsappFileInput.click());

  whatsappDropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    whatsappDropZone.classList.add("dragover");
  });

  ["dragleave", "dragend"].forEach(type => {
    whatsappDropZone.addEventListener(type, () => {
      whatsappDropZone.classList.remove("dragover");
    });
  });

  whatsappDropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    whatsappDropZone.classList.remove("dragover");
    if (e.dataTransfer.files?.length) {
      whatsappFileInput.files = e.dataTransfer.files;
      updateWhatsAppFileLabel();
    }
  });

  whatsappFileInput.addEventListener("change", updateWhatsAppFileLabel);
}

function updateWhatsAppFileLabel() {
  const file = whatsappFileInput.files?.[0];
  if (file) {
    let icon = "📄";
    const name = file.name.toLowerCase();
    if (name.endsWith(".pdf")) icon = "📕";
    else if (name.endsWith(".doc") || name.endsWith(".docx")) icon = "📘";
    else if (/\.(jpg|jpeg|png|gif|webp)$/.test(name)) icon = "🖼️";

    whatsappFileNameEl.textContent = `${icon} ${file.name} (${Math.round(file.size / 1024)} KB)`;
  } else {
    whatsappFileNameEl.textContent = "Arrastra un archivo aquí o haz clic";
  }
}

function renderWhatsAppPresetMessages() {
  if (!whatsappTemplatesEl) return;
  whatsappTemplatesEl.innerHTML = "";

  for (const msg of whatsappPresetMessages) {
    const row = document.createElement("div");
    row.className = "whatsapp-template-row";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "whatsapp-template-btn";
    btn.textContent = msg;
    btn.title = "Usar mensaje";
    btn.addEventListener("click", () => {
      whatsappMessageInput.value = msg;
      whatsappMessageInput.focus();
      whatsappMessageInput.setSelectionRange(whatsappMessageInput.value.length, whatsappMessageInput.value.length);
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "whatsapp-template-remove-btn";
    removeBtn.textContent = "✕";
    removeBtn.title = "Eliminar mensaje";
    removeBtn.addEventListener("click", () => {
      whatsappPresetMessages = whatsappPresetMessages.filter((x) => x !== msg);
      if (!whatsappPresetMessages.length) {
        whatsappPresetMessages = [...DEFAULT_WHATSAPP_PRESET_MESSAGES];
      }
      saveWhatsAppPresetMessages();
      renderWhatsAppPresetMessages();
      setStatus("Mensaje predeterminado eliminado.", true);
    });

    row.appendChild(btn);
    row.appendChild(removeBtn);
    whatsappTemplatesEl.appendChild(row);
  }
}

function saveNewWhatsAppPresetMessage() {
  const newMsg = (whatsappTemplateInput?.value || "").trim();
  if (!newMsg) {
    setStatus("Escribe un mensaje para guardarlo como predeterminado.", true);
    return;
  }

  const alreadyExists = whatsappPresetMessages.some((x) => x.toLowerCase() === newMsg.toLowerCase());
  if (alreadyExists) {
    setStatus("Ese mensaje ya existe en los predeterminados.", true);
    return;
  }

  whatsappPresetMessages.unshift(newMsg);
  saveWhatsAppPresetMessages();
  renderWhatsAppPresetMessages();
  whatsappTemplateInput.value = "";
  setStatus("Mensaje predeterminado guardado.", true);
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

exportWordBtn?.addEventListener("click", exportContactsToWord);

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
  if (action === "whatsapp") {
    openWhatsAppModal(c);
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
whatsappCloseBtn.addEventListener("click", closeWhatsAppModal);
whatsappSendBtn.addEventListener("click", sendWhatsAppMessage);
if (connectWhatsAppBtn) {
  connectWhatsAppBtn.addEventListener("click", openWhatsAppConnectModal);
}
if (whatsappLogoutBtn) {
  whatsappLogoutBtn.addEventListener("click", logoutWhatsAppAccount);
}
if (whatsappTemplateSaveBtn) {
  whatsappTemplateSaveBtn.addEventListener("click", saveNewWhatsAppPresetMessage);
}
if (whatsappTemplateInput) {
  whatsappTemplateInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveNewWhatsAppPresetMessage();
    }
  });
}
whatsappModalEl.addEventListener("click", (e) => {
  if (e.target === whatsappModalEl) closeWhatsAppModal();
});
whatsappQrImgEl.addEventListener("error", () => {
  if (!whatsappQrImgEl.src) return;
  whatsappQrImgEl.style.display = "none";
  whatsappQrHintEl.textContent = "No se pudo cargar el QR de WhatsApp.";
});

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

// ── QUOTATION (FRONTEND ONLY, NO PHP) ───────────────────────────────────
function qMoney(value) {
  return `S/ ${Number(value || 0).toFixed(2)}`;
}

function qToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function resetQuotationForm() {
  quotationItems = [{
    id: crypto.randomUUID(),
    service: "",
    customMode: false,
    quantity: 1,
    price: 0,
    image: ""
  }];
  if (qDateEl) qDateEl.value = qToday();
  if (qCompanyEl) qCompanyEl.value = "";
  if (qRucEl) qRucEl.value = "";
  if (qPhoneEl) qPhoneEl.value = "";
  if (qEmailEl) qEmailEl.value = "";
  if (qAddressEl) qAddressEl.value = "";
  if (quotationApplyIgvEl) quotationApplyIgvEl.checked = false;
  renderQuotationItems();
  recalcQuotationTotals();
}

function getQuotationTotals() {
  const subtotal = quotationItems.reduce((sum, item) => sum + (Number(item.quantity || 0) * Number(item.price || 0)), 0);
  const igv = quotationApplyIgvEl?.checked ? subtotal * 0.18 : 0;
  const total = subtotal + igv;
  return { subtotal, igv, total };
}

function recalcQuotationTotals() {
  const { subtotal, igv, total } = getQuotationTotals();
  if (quotationSubtotalEl) quotationSubtotalEl.textContent = qMoney(subtotal);
  if (quotationIgvEl) quotationIgvEl.textContent = qMoney(igv);
  if (quotationTotalEl) quotationTotalEl.textContent = qMoney(total);
}

function renderQuotationItems() {
  if (!quotationItemsBodyEl) return;
  quotationItemsBodyEl.innerHTML = "";

  quotationItems.forEach((item) => {
    const serviceKnown = QUOTATION_SERVICE_OPTIONS.includes(item.service);
    const isCustom = Boolean(item.customMode || (!serviceKnown && item.service));
    const serviceOptions = [`<option value="">Seleccione...</option>`]
      .concat(
        QUOTATION_SERVICE_OPTIONS.map((service) =>
          `<option value="${escHtml(service)}" ${item.service === service ? "selected" : ""}>${escHtml(service)}</option>`
        )
      )
      .concat([`<option value="__other__" ${isCustom ? "selected" : ""}>OTRO (escribir)</option>`])
      .join("");

    const imageOptions = [`<option value="">Sin imagen</option>`]
      .concat(QUOTATION_IMAGE_OPTIONS.map((img) => `<option value="${escHtml(img)}" ${item.image === img ? "selected" : ""}>${escHtml(img.split("/").pop())}</option>`))
      .join("");

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <select data-q-field="service_select" data-q-id="${item.id}" style="width:100%;">${serviceOptions}</select>
        ${isCustom ? `
          <input data-q-field="service_custom" data-q-id="${item.id}" type="text" value="${escHtml(item.service || "")}" placeholder="Escribe servicio personalizado" style="margin-top:6px;width:100%;" />
        ` : ""}
        ${(isCustom && String(item.service || "").trim().length > 0) ? `
          <div style="margin-top:6px;">
            <label class="muted" style="font-size:11px;">Imagen</label>
            <select data-q-field="image" data-q-id="${item.id}" style="width:100%;margin-top:4px;">${imageOptions}</select>
            ${item.image ? `<img src="${item.image}" alt="img" style="display:block;margin-top:6px;max-height:56px;border-radius:8px;border:1px solid rgba(255,255,255,.15);" />` : ""}
          </div>
        ` : ""}
      </td>
      <td><input data-q-field="quantity" data-q-id="${item.id}" type="number" min="1" value="${Number(item.quantity || 1)}" /></td>
      <td><input data-q-field="price" data-q-id="${item.id}" type="number" min="0" step="0.01" inputmode="decimal" value="${Number(item.price || 0)}" /></td>
      <td data-q-total="${item.id}" style="font-weight:700;">${qMoney(Number(item.quantity || 0) * Number(item.price || 0))}</td>
      <td>
        <div class="quote-item-actions">
          <button data-q-action="remove" data-q-id="${item.id}" type="button" class="secondary">🗑️ Quitar</button>
        </div>
      </td>
    `;
    quotationItemsBodyEl.appendChild(tr);
  });
}

function openQuotationModal(prefill = null) {
  if (!quotationModalEl) return;
  resetQuotationForm();
  if (prefill) {
    if (qCompanyEl) qCompanyEl.value = prefill.name || "";
    if (qPhoneEl) qPhoneEl.value = prefill.phone || "";
    if (qEmailEl) qEmailEl.value = prefill.email || "";
  }
  quotationModalEl.style.display = "grid";
}

function closeQuotationModal() {
  if (!quotationModalEl) return;
  quotationModalEl.style.display = "none";
}

function quotationToHtml() {
  const { subtotal, igv, total } = getQuotationTotals();
  const rows = quotationItems.map((item) => `
    <tr>
      <td style="border:1px solid #ddd;padding:8px;">
        <div>${escHtml(item.service || "—")}</div>
      </td>
      <td style="border:1px solid #ddd;padding:8px;text-align:right;">${Number(item.quantity || 0)}</td>
      <td style="border:1px solid #ddd;padding:8px;text-align:right;">${qMoney(item.price)}</td>
      <td style="border:1px solid #ddd;padding:8px;text-align:right;">${qMoney(Number(item.quantity || 0) * Number(item.price || 0))}</td>
    </tr>
  `).join("");

  const now = new Date().toLocaleString("es-PE");
  const date = qDateEl?.value || qToday();
  const company = escHtml(qCompanyEl?.value || "");
  const ruc = escHtml(qRucEl?.value || "");
  const phone = escHtml(qPhoneEl?.value || "");
  const email = escHtml(qEmailEl?.value || "");
  const address = escHtml(qAddressEl?.value || "");
  const datePretty = escHtml(date.split("-").reverse().join("/"));
  const extraPages = [];
  const seen = new Set();
  quotationItems.forEach((item) => {
    if (item.image) {
      if (!seen.has(item.image)) {
        seen.add(item.image);
        extraPages.push(item.image);
      }
      return;
    }
    const key = String(item.service || "").trim().toUpperCase();
    const mapped = QUOTATION_SERVICE_IMAGE_MAP[key] || (key.includes("REDES") ? ["/quotation-images/REDES.png"] : []);
    mapped.forEach((src) => {
      if (!seen.has(src)) {
        seen.add(src);
        extraPages.push(src);
      }
    });
  });

  const extraPagesHtml = extraPages.map((src) => `
    <div class="page page--extra">
      <img class="page--extra__image" src="${src}" alt="Detalle del servicio" />
      <div class="page--extra__date">${datePretty}</div>
    </div>
  `).join("");

  return `
    <html>
      <head>
        <meta charset="UTF-8" />
        <title>Cotizacion ${company || ""}</title>
        <style>
          * { margin:0; padding:0; box-sizing:border-box; }
          body {
            font-family: Arial, sans-serif;
            background:#f5f5f5;
            padding:20px;
            max-height:100vh;
            overflow-y:auto;
          }
          .preview-actions {
            position: sticky;
            top: 0;
            display: flex;
            justify-content: flex-start;
            margin: 0 auto 12px;
            max-width: 210mm;
            z-index: 5;
          }
          .preview-actions button {
            border: none;
            border-radius: 6px;
            padding: 8px 12px;
            font-size: 12px;
            color: #fff;
            margin-right: 8px;
            cursor: default;
            box-shadow: 0 6px 20px rgba(0,0,0,.15);
          }
          .btn-back { background: #666; }
          .btn-pdf { background: #4b1c91; }
          .btn-email { background: #28a745; }
          .btn-wa { background: #25D366; }
          .btn-email-wa { background: linear-gradient(135deg,#25D366 0%,#128C7E 100%); }
          .page {
            width:210mm;
            min-height:297mm;
            margin:0 auto;
            background:#fff;
            position:relative;
            overflow:hidden;
            box-shadow:0 0 20px rgba(0,0,0,.1);
          }
          .header-decoration {
            position:absolute;
            top:0; left:0; right:0;
            height:70mm;
            background:url('/quotation-assets/cabezera.png') no-repeat center top;
            background-size:100% auto;
            z-index:1;
          }
          .footer-decoration {
            position:absolute;
            bottom:0;
            left:0;
            right:0;
            height:86mm;
            overflow:hidden;
            z-index:1;
          }
          .footer-decoration img {
            position:absolute;
            bottom:0;
            left:0;
            width:100%;
            height:auto;
            display:block;
          }
          .content {
            position:relative;
            z-index:2;
            padding:70mm 20mm 90mm;
            min-height:297mm;
          }
          .client-section { margin-bottom:25px; }
          .section-title {
            font-size:12px; font-weight:bold; text-transform:uppercase;
            letter-spacing:2px; margin-bottom:10px; color:#333;
          }
          .client-data { font-size:13px; line-height:1.8; color:#333; }
          .client-row { margin-bottom:5px; }
          .client-label { display:inline-block; width:80px; }
          .fecha-row { margin-top:15px; font-size:13px; font-weight:bold; color:#333; }
          table { width:100%; border-collapse:collapse; margin:20px 0; font-size:13px; }
          thead { background:#333; color:#fff; }
          th { padding:10px; text-align:left; border:1px solid #333; }
          td { padding:10px; border:1px solid #ddd; }
          tbody tr { background:#f9f9f9; }
          .amount { text-align:right; }
          .total-section { text-align:right; margin:20px 0; font-size:14px; font-weight:bold; padding-right:10px; }
          .total-label { display:inline-block; margin-right:20px; }
          .total-value { display:inline-block; font-size:16px; color:#333; }
          .page--extra {
            margin:20px auto 0;
            width:210mm;
            min-height:297mm;
            position:relative;
            overflow:hidden;
            box-shadow:0 0 20px rgba(0,0,0,.1);
            background:#fff;
          }
          .page--extra__image {
            width:100%;
            height:100%;
            object-fit:contain;
            display:block;
          }
          .page--extra__date {
            position:absolute;
            top:58mm;
            right:80mm;
            background:rgba(255,255,255,.95);
            padding:8px 20px;
            border-radius:4px;
            font-weight:bold;
            color:#292927;
            font-size:14px;
            letter-spacing:1px;
          }
          @media print {
            body { background:#fff; padding:0; }
            .page, .page--extra { box-shadow:none; }
          }
        </style>
      </head>
      <body>
        <div class="preview-actions">
          <button class="btn-wa" type="button" onclick="window.parent.postMessage({ type: 'quotation-send-whatsapp' }, '*')">Enviar por WhatsApp</button>
        </div>
        <div class="page">
          <div class="header-decoration"></div>
          <div class="footer-decoration">
            <img src="/quotation-assets/footer2.png" alt="Footer" />
          </div>
          <div class="content">
            <div class="client-section">
              <div class="section-title">Datos del Cliente</div>
              <div class="client-data">
                <div class="client-row"><span class="client-label">Empresa :</span><span>${company || "—"}</span></div>
                <div class="client-row"><span class="client-label">RUC :</span><span>${ruc || "—"}</span></div>
                <div class="client-row"><span class="client-label">Teléfono :</span><span>${phone || "—"}</span></div>
                <div class="client-row"><span class="client-label">Correo :</span><span>${email || "—"}</span></div>
                <div class="client-row"><span class="client-label">Dirección :</span><span>${address || "—"}</span></div>
              </div>
            </div>

            <table>
              <thead>
                <tr>
                  <th>Concepto</th>
                  <th>Cantidad</th>
                  <th class="amount">Precio</th>
                  <th class="amount">Total</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>

            <div class="total-section">
              <div style="margin-bottom:5px;">
                <span class="total-label">Subtotal:</span>
                <span class="total-value">S/ ${Number(subtotal).toFixed(2)}</span>
              </div>
              <div style="margin-bottom:5px;">
                <span class="total-label">IGV (18%):</span>
                <span class="total-value">S/ ${Number(igv).toFixed(2)}</span>
              </div>
              <div>
                <span class="total-label" style="font-size:18px;">Total:</span>
                <span class="total-value" style="font-size:18px;color:#4b1c91;">S/ ${Number(total).toFixed(2)}</span>
              </div>
            </div>
          </div>
        </div>
        ${extraPagesHtml}
      </body>
    </html>
  `;
}

function previewQuotationHtml() {
  const html = quotationToHtml();
  if (!quotationPreviewModalEl || !quotationPreviewFrameEl) return;
  quotationPreviewFrameEl.srcdoc = html;
  quotationPreviewModalEl.style.display = "grid";
  setQuotationSendFeedback("");
}

function closeQuotationPreview() {
  if (!quotationPreviewModalEl || !quotationPreviewFrameEl) return;
  quotationPreviewModalEl.style.display = "none";
  quotationPreviewFrameEl.srcdoc = "";
  setQuotationSendFeedback("");
}

function setQuotationSendFeedback(message, tone = "") {
  if (!quotationSendFeedbackEl) return;
  quotationSendFeedbackEl.textContent = message || "";
  quotationSendFeedbackEl.classList.remove("is-sending", "is-ok", "is-error");
  if (tone === "sending") quotationSendFeedbackEl.classList.add("is-sending");
  if (tone === "ok") quotationSendFeedbackEl.classList.add("is-ok");
  if (tone === "error") quotationSendFeedbackEl.classList.add("is-error");
}

async function downloadQuotationPdf() {
  const payload = await buildQuotationPdfPayload();
  if (!payload) return;
  const { blob, filename } = payload;
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus("PDF descargado.", true);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

async function buildQuotationPdfPayload() {
  const jsPdfNamespace = window.jspdf || window.jsPDF;
  const html2canvasFn = window.html2canvas;
  if (!jsPdfNamespace?.jsPDF || typeof html2canvasFn !== "function") {
    setStatus("No se pudo cargar el generador PDF.", true);
    return null;
  }

  const wasOpen = quotationPreviewModalEl?.style.display === "grid";
  if (!wasOpen) {
    previewQuotationHtml();
    await new Promise((resolve) => setTimeout(resolve, 260));
  }

  const frameDoc = quotationPreviewFrameEl?.contentDocument;
  if (!frameDoc) {
    setStatus("No se pudo abrir la vista previa.", true);
    return null;
  }

  const pages = Array.from(frameDoc.querySelectorAll(".page, .page--extra"));
  if (!pages.length) {
    setStatus("No hay páginas para exportar.", true);
    return null;
  }

  try {
    const pdf = new jsPdfNamespace.jsPDF("p", "mm", "a4");
    for (let i = 0; i < pages.length; i++) {
      const canvas = await html2canvasFn(pages[i], {
        scale: 2,
        useCORS: true,
        backgroundColor: "#ffffff",
        logging: false
      });
      const imgData = canvas.toDataURL("image/jpeg", 0.92);
      const pageWidth = 210;
      const pageHeight = (canvas.height * pageWidth) / canvas.width;
      pdf.addImage(imgData, "JPEG", 0, 0, pageWidth, pageHeight, undefined, "FAST");
      if (i < pages.length - 1) pdf.addPage("a4", "portrait");
    }

    const stamp = (qDateEl?.value || qToday()).replaceAll("-", "");
    const companyRaw = (qCompanyEl?.value || "cliente").trim().toLowerCase().replace(/\s+/g, "-");
    const filename = `cotizacion-${companyRaw || "cliente"}-${stamp}.pdf`;
    const blob = pdf.output("blob");
    return { blob, filename };
  } catch (error) {
    console.error(error);
    setStatus("Error al generar PDF.", true);
    return null;
  }
}

async function sendQuotationPdfViaWhatsApp() {
  const rawPhone = (qPhoneEl?.value || "").trim();
  const to = normalizePhoneForWa(rawPhone);
  if (!to) {
    alert("Ingresa un teléfono válido en la cotización para enviar por WhatsApp.");
    setQuotationSendFeedback("Falta teléfono válido", "error");
    return;
  }

  const statusData = await fetchWhatsAppJson(WA_STATUS_PATHS, { cache: "no-store" });
  if (!isWaLinked(statusData)) {
    alert("WhatsApp no está conectado. Usa el botón Conectar WhatsApp.");
    setQuotationSendFeedback("WhatsApp no conectado", "error");
    return;
  }

  setQuotationSendFeedback("Enviando PDF por WhatsApp...", "sending");
  setStatus(`Generando PDF para enviar a ${to}...`, true);
  const payload = await buildQuotationPdfPayload();
  if (!payload) return;

  const { blob, filename } = payload;
  let sent = false;
  let lastError = "No se pudo enviar la cotización.";

  for (const path of WA_SEND_PATHS) {
    const fd = new FormData();
    fd.append("to", to);
    fd.append("message", `Hola, te comparto tu cotización en PDF.${qCompanyEl?.value ? `\nEmpresa: ${qCompanyEl.value.trim()}` : ""}`);
    fd.append("file", blob, filename);

    try {
      const res = await fetch(`${WHATSAPP_API_BASE}${path}`, {
        method: "POST",
        body: fd,
        headers: NGROK_SKIP_WARNING_HEADERS
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) {
        sent = true;
        break;
      }
      lastError = data?.error || `HTTP ${res.status}`;
    } catch (err) {
      lastError = err?.message || "Error de red";
    }
  }

  if (!sent) {
    setStatus(`❌ Error enviando cotización: ${lastError}`, true);
    setQuotationSendFeedback(`Error: ${lastError}`, "error");
    alert(`No se pudo enviar la cotización: ${lastError}`);
    return;
  }

  setStatus(`✅ Cotización enviada por WhatsApp a ${to}`, true);
  setQuotationSendFeedback("Enviado correctamente", "ok");
  alert(`✅ Cotización enviada a ${to}`);
}

function bindQuotationEvents() {
  if (quotationServicesDatalistEl) {
    quotationServicesDatalistEl.innerHTML = QUOTATION_SERVICE_OPTIONS
      .map((service) => `<option value="${escHtml(service)}"></option>`)
      .join("");
  }
  if (openQuotationBtn) openQuotationBtn.addEventListener("click", () => openQuotationModal());
  if (quotationCloseBtn) quotationCloseBtn.addEventListener("click", closeQuotationModal);
  // Cotizador: solo se cierra con Esc o botón X.
  if (quotationAddItemBtn) {
    quotationAddItemBtn.addEventListener("click", () => {
      quotationItems.push({ id: crypto.randomUUID(), service: "", customMode: false, quantity: 1, price: 0, image: "" });
      renderQuotationItems();
      recalcQuotationTotals();
    });
  }
  if (quotationApplyIgvEl) {
    quotationApplyIgvEl.addEventListener("change", recalcQuotationTotals);
  }
  if (quotationPreviewBtn) quotationPreviewBtn.addEventListener("click", previewQuotationHtml);
  if (quotationDownloadBtn) quotationDownloadBtn.addEventListener("click", downloadQuotationPdf);
  if (quotationPreviewDownloadBtn) quotationPreviewDownloadBtn.addEventListener("click", downloadQuotationPdf);
  if (quotationPreviewCloseBtn) quotationPreviewCloseBtn.addEventListener("click", closeQuotationPreview);
  if (!quotationMessageBridgeBound) {
    window.addEventListener("message", (event) => {
      if (event?.data?.type === "quotation-send-whatsapp") {
        sendQuotationPdfViaWhatsApp().catch((err) => {
          setStatus(`❌ Error enviando cotización: ${err.message}`, true);
        });
      }
    });
    quotationMessageBridgeBound = true;
  }

  if (quotationItemsBodyEl) {
    quotationItemsBodyEl.addEventListener("input", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const id = target.getAttribute("data-q-id");
      const field = target.getAttribute("data-q-field");
      if (!id || !field) return;
      const item = quotationItems.find((x) => x.id === id);
      if (!item) return;
      const value = target.value;
      if (field === "quantity" || field === "price") {
        item[field] = value === "" ? 0 : Number(value);
      } else if (field === "service_custom") {
        const cursorPos = typeof target.selectionStart === "number" ? target.selectionStart : null;
        item.service = value;
        renderQuotationItems();
        const refocused = quotationItemsBodyEl.querySelector(`input[data-q-field="service_custom"][data-q-id="${id}"]`);
        if (refocused) {
          refocused.focus();
          if (cursorPos !== null && typeof refocused.setSelectionRange === "function") {
            refocused.setSelectionRange(cursorPos, cursorPos);
          }
        }
        recalcQuotationTotals();
        return;
      } else {
        item[field] = value;
      }
      const totalEl = quotationItemsBodyEl.querySelector(`[data-q-total="${id}"]`);
      if (totalEl) {
        totalEl.textContent = qMoney(Number(item.quantity || 0) * Number(item.price || 0));
      }
      recalcQuotationTotals();
    });

    quotationItemsBodyEl.addEventListener("change", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const id = target.getAttribute("data-q-id");
      const field = target.getAttribute("data-q-field");
      if (!id || !field) return;
      if (field !== "service_select" && field !== "image") return;
      const item = quotationItems.find((x) => x.id === id);
      if (!item) return;
      if (field === "service_select") {
        if (target.value === "__other__") {
          item.customMode = true;
          item.service = "";
          item.image = "";
        } else {
          item.customMode = false;
          item.service = target.value;
        }
      } else {
        item.image = target.value;
      }
      renderQuotationItems();
      recalcQuotationTotals();
    });

    quotationItemsBodyEl.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-q-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-q-action");
      const id = btn.getAttribute("data-q-id");
      if (action === "remove" && id) {
        quotationItems = quotationItems.filter((x) => x.id !== id);
        if (!quotationItems.length) {
          quotationItems.push({ id: crypto.randomUUID(), service: "", customMode: false, quantity: 1, price: 0, image: "" });
        }
        renderQuotationItems();
        recalcQuotationTotals();
      }
    });
  }
}


// ── INIT ──────────────────────────────────────────────────────────────────
loadContacts();
loadCalledCounts();
loadWhatsAppPresetMessages();
renderContacts();
loadApkInfo();
bindQuotationEvents();
resetQuotationForm();
