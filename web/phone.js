const socket = io();

// ── DOM ─────────────────────────────────────────────────────────────────
const statusEl = document.getElementById("status");
const sessionCodeIn = document.getElementById("sessionCode");
const joinBtn = document.getElementById("joinSession");
const grantMicBtn = document.getElementById("grantMicBtn");
const grantNotifBtn = document.getElementById("grantNotifBtn");
const acceptBtn = document.getElementById("acceptBtn");
const idleBtn = document.getElementById("idleBtn");
const ringtoneBtn = document.getElementById("ringtoneBtn");
const stopBtn = document.getElementById("stopBtn");
const permMic = document.getElementById("permMic");
const permNotif = document.getElementById("permNotif");
const permWake = document.getElementById("permWake");
const permSocket = document.getElementById("permSocket");
const incomingBanner = document.getElementById("incomingBanner");
const incomingNumEl = document.getElementById("incomingNumber");
const acceptCallBtn = document.getElementById("acceptCallBtn");
const rejectCallBtn = document.getElementById("rejectCallBtn");

// ── URL PARAMS ──────────────────────────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const urlCode = params.get("code");
const urlToken = params.get("token");
let sessionToken = urlToken ? urlToken.trim() : "";

if (urlCode) sessionCodeIn.value = String(urlCode).toUpperCase().trim();

// ── STATE ───────────────────────────────────────────────────────────────
let micStream = null;
let wakeLock = null;
let connected = false;
let notifGranted = false;

// ── STATUS ──────────────────────────────────────────────────────────────
function setStatus(msg) { statusEl.textContent = msg; }

function setPermItem(el, status) {
  el.className = `perm-val ${status}`;
  const labels = { granted: "✅ Concedido", denied: "❌ Denegado", pending: "⏳ Verificando…", active: "✅ Activo", inactive: "— No activo" };
  el.textContent = labels[status] || status;
}

// ── MICROPHONE ──────────────────────────────────────────────────────────
async function requestMic() {
  setStatus("Solicitando acceso al micrófono...");
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    setPermItem(permMic, "granted");
    setStatus("✅ Micrófono activo. Este dispositivo está listo.");
    grantMicBtn.textContent = "🎙️ Micrófono activo";
    grantMicBtn.disabled = true;
  } catch (e) {
    setPermItem(permMic, "denied");
    setStatus("⚠️ Micrófono denegado: " + e.message);
  }
}

async function checkMicPermission() {
  if (!navigator.permissions) return;
  try {
    const perm = await navigator.permissions.query({ name: "microphone" });
    if (perm.state === "granted") {
      setPermItem(permMic, "granted");
    } else if (perm.state === "denied") {
      setPermItem(permMic, "denied");
    } else {
      setPermItem(permMic, "pending");
    }
    perm.addEventListener("change", () => checkMicPermission());
  } catch { /* ignore */ }
}

// ── NOTIFICATIONS ───────────────────────────────────────────────────────
async function requestNotifications() {
  if (!("Notification" in window)) {
    setPermItem(permNotif, "denied");
    return;
  }
  const result = await Notification.requestPermission();
  if (result === "granted") {
    notifGranted = true;
    setPermItem(permNotif, "granted");
    setStatus("🔔 Notificaciones activadas.");
  } else {
    setPermItem(permNotif, "denied");
    setStatus("Notificaciones denegadas.");
  }
}

function sendNotification(title, body) {
  if (!notifGranted || Notification.permission !== "granted") return;
  new Notification(title, { body, icon: "/favicon.ico" });
}

// ── WAKE LOCK ───────────────────────────────────────────────────────────
async function requestWakeLock() {
  if (!("wakeLock" in navigator)) {
    setPermItem(permWake, "inactive");
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    setPermItem(permWake, "active");
    wakeLock.addEventListener("release", () => setPermItem(permWake, "inactive"));
  } catch (e) {
    setPermItem(permWake, "inactive");
  }
}

// ── JOIN AS PHONE ───────────────────────────────────────────────────────
function joinAsPhone() {
  const code = sessionCodeIn.value.trim().toUpperCase();
  if (!code) return;
  socket.emit("session:join", {
    code,
    role: "phone",
    token: sessionToken,
    deviceId: "web-phone-" + (navigator.userAgent.slice(0, 20).replace(/\s/g, "")),
    deviceName: "Web Phone (" + (navigator.platform || "Web") + ")"
  });
}

// ── INCOMING CALL ───────────────────────────────────────────────────────
function showIncoming(phoneNumber) {
  incomingBanner.style.display = "block";
  incomingNumEl.textContent = phoneNumber || "—";
  sendNotification("📞 Llamada entrante", `Número: ${phoneNumber}`);
  // Vibrate if supported
  if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]);
}

function hideIncoming() {
  incomingBanner.style.display = "none";
  incomingNumEl.textContent = "—";
}

// ── EVENTS ──────────────────────────────────────────────────────────────
joinBtn.addEventListener("click", joinAsPhone);

grantMicBtn.addEventListener("click", requestMic);
grantNotifBtn.addEventListener("click", requestNotifications);

acceptBtn.addEventListener("click", () => {
  socket.emit("phone:status", { callState: "in_call" });
  hideIncoming();
  setStatus("✅ Reportado: llamada en curso.");
});

idleBtn.addEventListener("click", () => {
  socket.emit("phone:status", { callState: "idle" });
  hideIncoming();
  setStatus("Reportado: libre.");
});

ringtoneBtn.addEventListener("click", () => {
  socket.emit("phone:status", { callState: "ringing" });
  setStatus("🔔 Simulando llamada entrante...");
  showIncoming("+51 000 000 000 (simulado)");
});

stopBtn.addEventListener("click", () => {
  socket.disconnect();
  setStatus("Desconectado.");
  setPermItem(permSocket, "inactive");
  connected = false;
  hideIncoming();
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (wakeLock) { wakeLock.release(); wakeLock = null; }
});

acceptCallBtn.addEventListener("click", () => {
  socket.emit("phone:status", { callState: "in_call" });
  hideIncoming();
  setStatus("✅ Llamada contestada (reportado).");
});

rejectCallBtn.addEventListener("click", () => {
  socket.emit("phone:status", { callState: "idle" });
  hideIncoming();
  setStatus("📵 Llamada rechazada.");
});

// ── SOCKET HANDLERS ──────────────────────────────────────────────────────
socket.on("connect", () => {
  connected = true;
  setPermItem(permSocket, "active");
  setStatus("🔗 Conectado al servidor. Vincula tu sesión.");
  requestWakeLock();
  if (urlCode && sessionToken) joinAsPhone();
});

socket.on("disconnect", () => {
  connected = false;
  setPermItem(permSocket, "denied");
  setStatus("❌ Desconectado del servidor.");
});

socket.on("connect_error", () => {
  setPermItem(permSocket, "denied");
  setStatus("No se pudo conectar al servidor.");
});

socket.on("session:joined", ({ code, role }) => {
  setStatus(`✅ Vinculado como "${role}" en sesión ${code}. Esperando órdenes...`);
});

socket.on("session:error", ({ message }) => {
  setStatus("⚠️ Error: " + (message || "Token inválido."));
});

socket.on("call:action", ({ action, phoneNumber }) => {
  if (action === "dial") {
    setStatus(`📞 Orden recibida: llamar a ${phoneNumber}`);
    showIncoming(phoneNumber);
    // Auto-report dialing
    socket.emit("phone:status", { callState: "dialing" });
  }
  if (action === "hangup") {
    setStatus("📵 Orden recibida: colgar.");
    hideIncoming();
    socket.emit("phone:status", { callState: "idle" });
  }
});

socket.on("state:changed", st => {
  const c = st.connected;
  if (connected) {
    setStatus(`Sesión ${st.code || "—"} | Dashboard: ${c.dashboard ? "✅" : "❌"} | Estado: ${st.callState}`);
  }
});

// ── INIT ─────────────────────────────────────────────────────────────────
checkMicPermission();

if (Notification.permission === "granted") {
  notifGranted = true;
  setPermItem(permNotif, "granted");
} else if (Notification.permission === "denied") {
  setPermItem(permNotif, "denied");
}
