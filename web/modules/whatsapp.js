import { API_BASE } from './socket.js';
import { refs, setStatus } from './dom.js';

const WHATSAPP_API_BASE = API_BASE;
const WA_STATUS_PATHS = ["/api/whatsapp/status"];
const WA_QR_PATHS = ["/api/whatsapp/qr"];
const WA_LOGOUT_PATHS = ["/api/whatsapp/logout"];
const WA_SEND_PATHS = ["/api/whatsapp/send-message", "/api/whatsapp/send"];
const NGROK_SKIP_WARNING_HEADERS = { "ngrok-skip-browser-warning": "1" };
const WHATSAPP_PRESETS_KEY = "voip vc.whatsappPresetMessages";

const DEFAULT_WHATSAPP_PRESET_MESSAGES = [
  "Hola, te escribo de VCMAS. Quedo atento a tu respuesta.",
  "Buenas, te contacto para coordinar una llamada.",
  "Hola, te comparto seguimiento del tema pendiente."
];

export let whatsappPresetMessages = [...DEFAULT_WHATSAPP_PRESET_MESSAGES];
export let whatsappCurrentContact = null;
export let whatsappModalMode = "contact";
let whatsappQrPollTimer = null;

export function loadWhatsAppPresetMessages() {
  try {
    const raw = JSON.parse(localStorage.getItem(WHATSAPP_PRESETS_KEY) || "[]");
    if (Array.isArray(raw)) {
      whatsappPresetMessages = raw.map((msg) => String(msg || "").trim()).filter(Boolean);
    }
  } catch {
    whatsappPresetMessages = [];
  }
  if (!whatsappPresetMessages.length) {
    whatsappPresetMessages = [...DEFAULT_WHATSAPP_PRESET_MESSAGES];
    saveWhatsAppPresetMessages();
  }
}

export function saveWhatsAppPresetMessages() {
  localStorage.setItem(WHATSAPP_PRESETS_KEY, JSON.stringify(whatsappPresetMessages));
}

export function normalizePhoneForWa(phone) {
  let clean = String(phone || "").replace(/\D/g, "");
  if (!clean) return "";
  if (clean.startsWith("51") && clean.length >= 11) return "+" + clean;
  if (clean.length === 9 && clean.startsWith("9")) return "+51" + clean;
  return "+" + clean;
}

export async function fetchWhatsAppJson(paths, options) {
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
      try { return await res.json(); }
      catch {
        const text = await res.text();
        return { raw: text, qr: text };
      }
    } catch { }
  }
  return null;
}

export function isWaLinked(data) {
  if (!data || typeof data !== "object") return false;
  return Boolean(data.linked ?? data.connected ?? data.isConnected ?? data.ready ?? data.isReady ?? data.authenticated);
}

export function extractWaQr(data) {
  const raw = data?.qr || data?.qrCode || data?.qrcode || data?.dataUrl;
  if (!raw || typeof raw !== "string") return "";
  if (raw.startsWith("data:image")) return raw;
  if (raw.startsWith("<svg")) return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(raw)))}`;
  return `data:image/png;base64,${raw}`;
}

export function showWaConnectionBadge({ connected, text }) {
  if (!refs.whatsappConnectOkEl) return;
  refs.whatsappConnectOkEl.style.display = "grid";
  refs.whatsappConnectOkEl.classList.toggle("is-offline", !connected);
  const strong = refs.whatsappConnectOkEl.querySelector("strong");
  if (strong) strong.textContent = connected ? "Cuenta conectada" : "Cuenta desconectada";
  if (refs.whatsappLinkedNumberEl) refs.whatsappLinkedNumberEl.textContent = text || (connected ? "Dispositivo vinculado" : "Sin vínculo activo");
}

export async function refreshWhatsAppModal() {
  if (refs.whatsappModalEl.style.display !== "grid") return;

  const statusData = await fetchWhatsAppJson(WA_STATUS_PATHS, { cache: "no-store" });
  const linked = isWaLinked(statusData);
  const linkedPhone = statusData?.phone ? String(statusData.phone).replace("@s.whatsapp.net", "") : "";

  if (linked) {
    refs.whatsappQrImgEl.src = "";
    refs.whatsappQrImgEl.style.display = "none";
    if (refs.whatsappLogoutBtn) refs.whatsappLogoutBtn.style.display = "inline-flex";
    if (refs.whatsappQrLeadEl) refs.whatsappQrLeadEl.style.display = "none";
    showWaConnectionBadge({ connected: true, text: linkedPhone || "Dispositivo vinculado" });

    if (whatsappModalMode === "connect") {
      refs.whatsappFormPanelEl.style.display = "none";
      refs.whatsappQrPanelEl.style.display = "grid";
      refs.whatsappQrHintEl.textContent = "Listo. Puedes continuar.";
    } else {
      refs.whatsappQrPanelEl.style.display = "none";
      refs.whatsappFormPanelEl.style.display = "grid";
      if (!refs.whatsappMessageInput.value) refs.whatsappMessageInput.focus();
    }
    stopWhatsAppQrPolling();
    return;
  }

  refs.whatsappFormPanelEl.style.display = "none";
  refs.whatsappQrPanelEl.style.display = "grid";
  if (refs.whatsappLogoutBtn) refs.whatsappLogoutBtn.style.display = "none";
  showWaConnectionBadge({ connected: false, text: "Sin vínculo activo" });
  if (refs.whatsappQrLeadEl) refs.whatsappQrLeadEl.style.display = "block";
  refs.whatsappQrHintEl.textContent = "Cuenta desconectada. Generando QR de WhatsApp...";

  const qrData = await fetchWhatsAppJson(WA_QR_PATHS, { cache: "no-store" });
  const qrSrc = extractWaQr(qrData);
  if (qrSrc) {
    refs.whatsappQrImgEl.src = qrSrc;
    refs.whatsappQrImgEl.style.display = "block";
    refs.whatsappQrHintEl.textContent = "Escanea este QR en WhatsApp para vincular.";
  } else {
    refs.whatsappQrImgEl.src = "";
    refs.whatsappQrImgEl.style.display = "none";
    refs.whatsappQrHintEl.textContent = "Esperando QR. Si tarda, verifica que el backend WhatsApp esté activo.";
  }
  startWhatsAppQrPolling();
}

export function openWhatsAppModal(contact) {
  const phone = normalizePhoneForWa(contact?.phone || "");
  const waNumber = String(phone).replace(/\D/g, "");
  if (!waNumber) {
    alert("El contacto no tiene un número válido para WhatsApp.");
    return;
  }
  whatsappCurrentContact = { ...contact, phone };
  whatsappModalMode = "contact";
  refs.whatsappTitleEl.textContent = `WhatsApp · ${contact?.name || "Contacto"}`;
  refs.whatsappPhoneEl.textContent = phone;
  refs.whatsappModalEl.style.display = "grid";
  refs.whatsappFormPanelEl.style.display = "none";
  refs.whatsappQrPanelEl.style.display = "grid";
  refs.whatsappQrImgEl.style.display = "none";
  refs.whatsappQrImgEl.src = "";
  if (refs.whatsappConnectOkEl) refs.whatsappConnectOkEl.style.display = "none";
  if (refs.whatsappQrLeadEl) refs.whatsappQrLeadEl.style.display = "block";
  refs.whatsappMessageInput.value = "";
  refs.whatsappFileInput.value = "";
  updateWhatsAppFileLabel();
  renderWhatsAppPresetMessages();
  refs.whatsappQrHintEl.textContent = "Cargando estado de WhatsApp...";
  setStatus(`Verificando conexion de WhatsApp para ${phone}...`, true);
  refreshWhatsAppModal();
}

export function openWhatsAppConnectModal() {
  whatsappModalMode = "connect";
  whatsappCurrentContact = null;
  refs.whatsappTitleEl.textContent = "Conectar WhatsApp";
  refs.whatsappPhoneEl.textContent = "Escanea el QR para vincular el dispositivo.";
  refs.whatsappModalEl.style.display = "grid";
  refs.whatsappFormPanelEl.style.display = "none";
  refs.whatsappQrPanelEl.style.display = "grid";
  refs.whatsappQrImgEl.style.display = "none";
  refs.whatsappQrImgEl.src = "";
  if (refs.whatsappConnectOkEl) refs.whatsappConnectOkEl.style.display = "none";
  if (refs.whatsappQrLeadEl) refs.whatsappQrLeadEl.style.display = "block";
  refs.whatsappQrHintEl.textContent = "Cargando estado de WhatsApp...";
  refreshWhatsAppModal();
}

export function startWhatsAppQrPolling() {
  if (whatsappQrPollTimer) return;
  whatsappQrPollTimer = setInterval(() => {
    refreshWhatsAppModal().catch(() => {});
  }, 3000);
}

export function stopWhatsAppQrPolling() {
  if (!whatsappQrPollTimer) return;
  clearInterval(whatsappQrPollTimer);
  whatsappQrPollTimer = null;
}

export function closeWhatsAppModal() {
  stopWhatsAppQrPolling();
  refs.whatsappModalEl.style.display = "none";
  whatsappCurrentContact = null;
  whatsappModalMode = "contact";
  refs.whatsappMessageInput.value = "";
  refs.whatsappFileInput.value = "";
  refs.whatsappQrImgEl.src = "";
  refs.whatsappQrImgEl.style.display = "none";
  if (refs.whatsappLogoutBtn) refs.whatsappLogoutBtn.style.display = "none";
  if (refs.whatsappConnectOkEl) refs.whatsappConnectOkEl.style.display = "none";
  if (refs.whatsappQrLeadEl) refs.whatsappQrLeadEl.style.display = "block";
}

export async function logoutWhatsAppAccount() {
  if (!confirm("Se cerrará la sesión de WhatsApp vinculada. ¿Continuar?")) return;
  try {
    if (refs.whatsappLogoutBtn) {
      refs.whatsappLogoutBtn.disabled = true;
      refs.whatsappLogoutBtn.textContent = "Cerrando...";
    }
    let ok = false;
    for (const path of WA_LOGOUT_PATHS) {
      try {
        const res = await fetch(`${WHATSAPP_API_BASE}${path}`, {
          method: "POST",
          headers: { ...NGROK_SKIP_WARNING_HEADERS, "Content-Type": "application/json" },
          body: "{}"
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data?.ok) { ok = true; break; }
      } catch { }
    }
    if (!ok) {
      const statusData = await fetchWhatsAppJson(WA_STATUS_PATHS, { cache: "no-store" });
      if (!isWaLinked(statusData)) ok = true;
    }
    if (!ok) throw new Error("No se pudo cerrar sesión.");
    refs.whatsappQrImgEl.src = "";
    refs.whatsappQrImgEl.style.display = "none";
    showWaConnectionBadge({ connected: false, text: "Sin vínculo activo" });
    refs.whatsappQrHintEl.textContent = "Cuenta desconectada. Generando nuevo QR...";
    setStatus("Sesión de WhatsApp cerrada.", true);
    await refreshWhatsAppModal();
  } catch (err) {
    alert(`No se pudo cerrar sesión: ${err.message}`);
    setStatus(`Error cerrando sesión de WhatsApp: ${err.message}`, true);
  } finally {
    if (refs.whatsappLogoutBtn) {
      refs.whatsappLogoutBtn.disabled = false;
      refs.whatsappLogoutBtn.textContent = "Cerrar sesión";
    }
  }
}

export async function sendWhatsAppMessage() {
  if (!whatsappCurrentContact) return;
  const phone = refs.whatsappPhoneEl.textContent;
  const message = refs.whatsappMessageInput.value.trim();
  const file = refs.whatsappFileInput.files?.[0] || null;

  if (!phone || phone === "-") { alert("El contacto no tiene un número de teléfono válido."); return; }
  if (!message && !file) { alert("Por favor, escribe un mensaje o selecciona un archivo para enviar."); return; }

  refs.whatsappSendBtn.disabled = true;
  refs.whatsappSendBtn.textContent = "Enviando...";
  setStatus(`Enviando por Baileys a ${phone}...`, true);

  try {
    const statusData = await fetchWhatsAppJson(WA_STATUS_PATHS, { cache: "no-store" });
    if (!isWaLinked(statusData)) throw new Error("WhatsApp no está conectado. Usa 'Conectar WhatsApp' primero.");

    let sent = false;
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
        if (res.ok && data?.ok) { sent = true; break; }
      } catch { }
    }
    if (!sent) throw new Error("No se pudo enviar mensaje.");
    setStatus(`✅ Mensaje enviado a ${phone}`, true);
    setTimeout(() => setStatus("Listo.", true), 3000);
    closeWhatsAppModal();
  } catch (err) {
    alert(`No se pudo enviar: ${err.message}`);
    setStatus(`❌ Error: ${err.message}`, true);
  } finally {
    refs.whatsappSendBtn.disabled = false;
    refs.whatsappSendBtn.textContent = "Enviar por WhatsApp";
  }
}

export function updateWhatsAppFileLabel() {
  const file = refs.whatsappFileInput.files?.[0];
  if (file) {
    let icon = "📄";
    const name = file.name.toLowerCase();
    if (name.endsWith(".pdf")) icon = "📕";
    else if (name.endsWith(".doc") || name.endsWith(".docx")) icon = "📘";
    else if (/\.(jpg|jpeg|png|gif|webp)$/.test(name)) icon = "🖼️";
    refs.whatsappFileNameEl.textContent = `${icon} ${file.name} (${Math.round(file.size / 1024)} KB)`;
  } else {
    refs.whatsappFileNameEl.textContent = "Arrastra un archivo aquí o haz clic";
  }
}

export function renderWhatsAppPresetMessages() {
  if (!refs.whatsappTemplatesEl) return;
  refs.whatsappTemplatesEl.innerHTML = "";
  for (const msg of whatsappPresetMessages) {
    const row = document.createElement("div");
    row.className = "whatsapp-template-row";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "whatsapp-template-btn";
    btn.textContent = msg;
    btn.addEventListener("click", () => {
      refs.whatsappMessageInput.value = msg;
      refs.whatsappMessageInput.focus();
      refs.whatsappMessageInput.setSelectionRange(refs.whatsappMessageInput.value.length, refs.whatsappMessageInput.value.length);
    });
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "whatsapp-template-remove-btn";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => {
      whatsappPresetMessages = whatsappPresetMessages.filter((x) => x !== msg);
      if (!whatsappPresetMessages.length) whatsappPresetMessages = [...DEFAULT_WHATSAPP_PRESET_MESSAGES];
      saveWhatsAppPresetMessages();
      renderWhatsAppPresetMessages();
    });
    row.appendChild(btn);
    row.appendChild(removeBtn);
    refs.whatsappTemplatesEl.appendChild(row);
  }
}

export function saveNewWhatsAppPresetMessage() {
  const newMsg = (refs.whatsappTemplateInput?.value || "").trim();
  if (!newMsg) { setStatus("Escribe un mensaje para guardarlo.", true); return; }
  if (whatsappPresetMessages.some((x) => x.toLowerCase() === newMsg.toLowerCase())) {
    setStatus("Ese mensaje ya existe.", true); return;
  }
  whatsappPresetMessages.unshift(newMsg);
  saveWhatsAppPresetMessages();
  renderWhatsAppPresetMessages();
  refs.whatsappTemplateInput.value = "";
  setStatus("Mensaje guardado.", true);
}
