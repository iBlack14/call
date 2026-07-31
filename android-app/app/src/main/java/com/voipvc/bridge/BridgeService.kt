@file:Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")

package com.voipvc.bridge

import android.Manifest
import android.app.*
import android.content.*
import android.content.pm.PackageManager
import android.media.*
import android.net.Uri
import android.os.*
import android.telecom.TelecomManager
import android.telephony.PhoneStateListener
import android.telephony.TelephonyManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.*

/**
 * Always-on foreground service.
 * • Connects to the VOIP VC server via Socket.IO
 * • Monitors call state with PhoneStateListener  (no root)
 * • Streams MIC audio to dashboard              (AudioRecord, no root)
 * • Plays dashboard audio during calls          (AudioTrack VOICE_COMMUNICATION, no root)
 * • Survives swipe-kill via AlarmManager restart
 * • Auto-starts on boot via BootReceiver
 */
class BridgeService : Service() {

    // ── CONSTANTS ─────────────────────────────────────────────────────────────
    companion object {
        private const val TAG = "BridgeService"

        const val CHANNEL_ID      = "phone_vc_channel"
        const val NOTIFICATION_ID = 9201

        // Sample rate accepted by both AudioRecord on Android and AudioContext on web
        const val SAMPLE_RATE  = 16000
        const val CHUNK_FRAMES = 1280  // 80 ms @ 16 kHz  → 2560 bytes

        // Intent actions
        const val ACTION_START  = "com.voipvc.bridge.START"
        const val ACTION_STOP   = "com.voipvc.bridge.STOP"
        const val ACTION_LOGOUT = "com.voipvc.bridge.LOGOUT"
        const val ACTION_UI_HANGUP = "com.voipvc.bridge.UI_HANGUP"
        const val ACTION_UI_ANSWER = "com.voipvc.bridge.UI_ANSWER"
        const val ACTION_UI_TOGGLE_MUTE = "com.voipvc.bridge.UI_TOGGLE_MUTE"
        const val ACTION_UI_TOGGLE_SPEAKER = "com.voipvc.bridge.UI_TOGGLE_SPEAKER"
        const val ACTION_UI_SYNC = "com.voipvc.bridge.UI_SYNC"

        // Extras
        const val EXTRA_SOCKET_URL  = "socket_url"
        const val EXTRA_CODE        = "code"
        const val EXTRA_TOKEN       = "token"
        const val EXTRA_DEVICE_ID   = "device_id"
        const val EXTRA_DEVICE_NAME = "device_name"
        const val EXTRA_PHONE_NUMBER = "phone_number"
        const val EXTRA_COMPANY_NAME = "company_name"
        const val EXTRA_CONTACT_NAME = "contact_name"
        const val EXTRA_IMAGE_URL = "image_url"

        // SharedPreferences
        const val PREFS_NAME       = "voip vc_prefs"
        const val PREF_SOCKET_URL  = "socket_url"
        const val PREF_CODE        = "code"
        const val PREF_TOKEN       = "token"
        const val PREF_DEVICE_ID   = "device_id"
        const val PREF_DEVICE_NAME = "device_name"

        // Status broadcast
        const val ACTION_STATUS        = "com.voipvc.bridge.STATUS"
        const val EXTRA_STATUS_MESSAGE = "status_msg"
        const val ACTION_CALL_UI_STATE = "com.voipvc.bridge.CALL_UI_STATE"
        const val ACTION_CLOSE_CALL_UI = "com.voipvc.bridge.CLOSE_CALL_UI"
        const val ACTION_TELECOM_CALL_STATE = "com.voipvc.bridge.TELECOM_CALL_STATE"
        const val EXTRA_CALL_STATE = "call_state"
        const val EXTRA_MIC_MUTED = "mic_muted"
        const val EXTRA_SPEAKER_ON = "speaker_on"
    }

    // ── STATE ─────────────────────────────────────────────────────────────────
    private var socket: Socket? = null

    // Audio
    private var audioRecord : AudioRecord? = null
    private var audioTrack  : AudioTrack?  = null
    private val isStreaming  = AtomicBoolean(false)
    private val isPlaying    = AtomicBoolean(false)
    private var captureJob: Job? = null
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private val minBufIn  by lazy { AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,  AudioFormat.ENCODING_PCM_16BIT).coerceAtLeast(CHUNK_FRAMES * 2) }
    private val minBufOut by lazy { AudioTrack.getMinBufferSize(SAMPLE_RATE,  AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT).coerceAtLeast(CHUNK_FRAMES * 2) }

    // Call monitoring
    @Suppress("DEPRECATION")
    private var phoneStateListener: PhoneStateListener? = null
    private var lastCallState = "idle"
    private var currentPhoneNumber = ""
    private var currentCompanyName = ""
    private var currentContactName = ""
    private var currentImageUrl = ""
    private var isMicMuted = false
    private var isSpeakerOn = false
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var dialAttemptToken = 0

    private val telecomStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != ACTION_TELECOM_CALL_STATE) return
            val st = intent.getStringExtra(EXTRA_CALL_STATE)?.trim().orEmpty()
            if (st.isBlank()) return
            val incomingNumber = intent.getStringExtra(EXTRA_PHONE_NUMBER).orEmpty().trim()
            val incomingName = intent.getStringExtra(EXTRA_CONTACT_NAME).orEmpty().trim()

            if (incomingNumber.isNotBlank()) {
                currentPhoneNumber = incomingNumber
            }
            if (incomingName.isNotBlank()) {
                currentContactName = incomingName
                if (currentCompanyName.isBlank()) currentCompanyName = incomingName
            }
            lastCallState = st
            emitPhoneStatus(st)
            emitCallUiState()
            if (st == "in_call" || st == "dialing" || st == "ringing") {
                launchCallUi()
            }
            when (st) {
                "dialing" -> setStatus("📞 Llamando...")
                "ringing" -> setStatus("📲 Llamada entrante")
                "in_call" -> {
                    startAudio()
                    setStatus("🔊 En llamada")
                }
                "ended", "idle" -> {
                    stopAudio()
                    setStatus("✅ Activo — esperando llamadas")
                    closeCallUi()
                }
            }
        }
    }

    // ── LIFECYCLE ─────────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification("Phone-VC iniciando…"))
        registerCallMonitor()
        val filter = IntentFilter(ACTION_TELECOM_CALL_STATE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            registerReceiver(telecomStateReceiver, filter, RECEIVER_NOT_EXPORTED)
        else
            @Suppress("DEPRECATION") registerReceiver(telecomStateReceiver, filter)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val url     = intent.getStringExtra(EXTRA_SOCKET_URL)  ?: ""
                val code    = intent.getStringExtra(EXTRA_CODE)        ?: ""
                val token   = intent.getStringExtra(EXTRA_TOKEN)       ?: ""
                val devId   = intent.getStringExtra(EXTRA_DEVICE_ID)   ?: ""
                val devName = intent.getStringExtra(EXTRA_DEVICE_NAME) ?: ""
                tryConnect(url, code, token, devId, devName)
            }
            ACTION_STOP -> stopSelf()
            ACTION_LOGOUT -> logoutAndStop()
            ACTION_UI_HANGUP -> hangup()
            ACTION_UI_ANSWER -> answerIncomingCall()
            ACTION_UI_TOGGLE_MUTE -> setMicMute(!isMicMuted)
            ACTION_UI_TOGGLE_SPEAKER -> setSpeakerOn(!isSpeakerOn)
            ACTION_UI_SYNC -> emitCallUiState()
        }
        return START_STICKY  // Android will restart this service if killed
    }

    /** Schedules a self-restart 1.5s after the user swipes the app away */
    override fun onTaskRemoved(rootIntent: Intent?) {
        val restart = buildRestartIntentFromPrefs() ?: return
        val pi = PendingIntent.getService(
            this, 1, restart,
            PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE
        )
        (getSystemService(ALARM_SERVICE) as AlarmManager)
            .set(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + 1500L, pi)
    }

    override fun onDestroy() {
        stopAudio()
        unregisterCallMonitor()
        unregisterReceiver(telecomStateReceiver)
        socket?.disconnect()
        socket?.off()
        serviceScope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ── SOCKET CONNECTION ─────────────────────────────────────────────────────

    private fun tryConnect(url: String, code: String, token: String, devId: String, devName: String) {
        if (url.isBlank() || code.isBlank() || token.isBlank()) {
            setStatus("⚠️ Datos incompletos")
            return
        }

        socket?.disconnect()
        socket?.off()

        try { socket = IO.socket(url) } catch (e: Exception) {
            setStatus("URL inválida: ${e.message}")
            return
        }

        socket!!.on(Socket.EVENT_CONNECT) {
            val payload = JSONObject()
                .put("code", code).put("role", "phone")
                .put("token", token)
                .put("deviceId", devId).put("deviceName", devName)
            socket!!.emit("session:join", payload)
        }

        socket!!.on("session:joined") {
            setStatus("✅ Activo — esperando llamadas")
            // Save credentials for reboot auto-start
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
                .putString(PREF_SOCKET_URL, url) .putString(PREF_CODE, code)
                .putString(PREF_TOKEN, token)    .putString(PREF_DEVICE_ID, devId)
                .putString(PREF_DEVICE_NAME, devName).apply()
        }

        socket!!.on("session:error") { args ->
            val msg = (args.firstOrNull() as? JSONObject)?.optString("message") ?: "Error de sesión"
            setStatus("❌ $msg")
        }

        // Keep APK UI in sync with the authoritative session state from server.
        socket!!.on("state:changed") { args ->
            val data = args.firstOrNull() as? JSONObject ?: return@on
            val workers = data.optJSONArray("phoneWorkers") ?: return@on
            var ownWorker: JSONObject? = null
            for (index in 0 until workers.length()) {
                val candidate = workers.optJSONObject(index) ?: continue
                if (candidate.optString("id") == devId) {
                    ownWorker = candidate
                    break
                }
            }
            val workerState = ownWorker ?: return@on
            val st = workerState.optString("callState", "idle")
            if (st.isNotBlank()) {
                lastCallState = st
                if (currentPhoneNumber.isBlank()) {
                    currentPhoneNumber = workerState.optString("currentNumber")
                }
                emitCallUiState()
                if (st == "in_call" || st == "dialing" || st == "ringing") {
                    launchCallUi()
                }
                if (st == "in_call") startAudio()
                if (st == "idle" || st == "ended") {
                    stopAudio()
                    closeCallUi()
                }
            }
        }

        socket!!.on("call:action") { args ->
            val data = args.firstOrNull() as? JSONObject ?: return@on
            val commandId = data.optString("commandId")
            when (data.optString("action")) {
                "dial"   -> {
                    val phoneNumber = data.optString("phoneNumber")
                    val companyName = data.optString("companyName")
                    val contactName = data.optString("contactName")
                    val imageUrl = data.optString("imageUrl")
                    dialNumber(phoneNumber, companyName, contactName, imageUrl)
                    emitCommandAck(commandId, "dial", true, "Comando recibido en APK")
                }
                "hangup" -> {
                    // Close call UI immediately on remote hangup command.
                    lastCallState = "ended"
                    emitPhoneStatus("ended")
                    emitCallUiState()
                    closeCallUi()
                    emitCommandAck(commandId, "hangup", hangup(), "Corte procesado")
                }
                "answer" -> {
                    emitCommandAck(commandId, "answer", answerIncomingCall(), "Respuesta procesada")
                }
                "mute"   -> emitCommandAck(commandId, "mute", setMicMute(true), "Micrófono procesado")
                "unmute" -> emitCommandAck(commandId, "unmute", setMicMute(false), "Micrófono procesado")
                "speaker_on" -> emitCommandAck(commandId, "speaker_on", setSpeakerOn(true), "Altavoz procesado")
                "speaker_off" -> emitCommandAck(commandId, "speaker_off", setSpeakerOn(false), "Altavoz procesado")
                else -> emitCommandAck(commandId, data.optString("action"), false, "Acción no soportada")
            }
        }

        // Receive web mic audio → play on phone speaker during call
        socket!!.on("audio:dashboard") { args ->
            val raw = args.firstOrNull()
            val bytes: ByteArray? = when (raw) {
                is ByteArray -> raw
                else -> null
            }
            bytes?.let { playAudio(it) }
        }

        socket!!.on(Socket.EVENT_DISCONNECT) { setStatus("🔄 Reconectando…") }
        socket!!.on(Socket.EVENT_CONNECT_ERROR) { setStatus("🔄 Sin servidor — reintentando…") }

        socket!!.connect()
        setStatus("🔗 Conectando…")
    }

    // ── CALL ACTIONS ──────────────────────────────────────────────────────────

    private fun dialNumber(number: String, companyName: String, contactName: String, imageUrl: String) {
        if (number.isBlank()) return
        dialAttemptToken += 1
        val thisAttempt = dialAttemptToken
        // Every new call must start with speaker OFF by default.
        isSpeakerOn = false
        setSpeakerOn(false)
        currentPhoneNumber = number
        currentContactName = when {
            contactName.isNotBlank() -> contactName
            companyName.isNotBlank() -> companyName
            else -> number
        }
        currentCompanyName = when {
            companyName.isNotBlank() -> companyName
            currentContactName.isNotBlank() -> currentContactName
            else -> number
        }
        currentImageUrl = imageUrl
        lastCallState = "dialing"
        launchCallUi()
        emitCallUiState()

        if (!hasPermission(Manifest.permission.CALL_PHONE)) {
            setStatus("⚠️ Falta permiso CALL_PHONE"); return
        }
        if (!isDefaultDialer()) {
            setStatus("⚠️ Phone-VC no es marcador predeterminado. Toca la notificación para llamar.")
            showDialNotification(number)
            lastCallState = "idle"
            emitCallUiState()
            emitPhoneStatus("idle")
            return
        }

        try {
            val tm = getSystemService(TELECOM_SERVICE) as? TelecomManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && tm != null) {
                tm.placeCall(Uri.parse("tel:$number"), Bundle())
                emitPhoneStatus("dialing")
                setStatus("📞 Intentando llamada a $number")

                // Some devices silently block background dial attempts.
                mainHandler.postDelayed({
                    if (thisAttempt != dialAttemptToken) return@postDelayed
                    if (!isActuallyInCall()) {
                        val launched = launchSystemDialerCall(number)
                        if (launched) {
                            setStatus("📞 Reintentando vía marcador del sistema…")
                            mainHandler.postDelayed({
                                if (thisAttempt != dialAttemptToken) return@postDelayed
                                if (!isActuallyInCall()) {
                                    emitPhoneStatus("idle")
                                    setStatus("⚠️ Android exige confirmación. Mostrando llamada en pantalla.")
                                    showDialNotification(number, autoLaunch = true)
                                }
                            }, 1800)
                        } else {
                            emitPhoneStatus("idle")
                            setStatus("⚠️ Android bloqueó llamada automática. Mostrando fallback.")
                            showDialNotification(number, autoLaunch = true)
                        }
                    }
                }, 2200)
                return
            }
        } catch (e: Exception) {
            Log.w(TAG, "TelecomManager.placeCall failed: ${e.message}")
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            setStatus("⚠️ Android requiere confirmación manual. Toca la notificación.")
            showDialNotification(number, autoLaunch = true)
            return
        }

        try {
            startActivity(Intent(Intent.ACTION_CALL, Uri.parse("tel:$number")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            emitPhoneStatus("dialing")
            setStatus("📞 Llamando $number")
        } catch (e: Exception) {
            setStatus("❌ No se pudo llamar: ${e.message}")
        }
    }

    /** Shows a high-priority notification with a tap-to-call action (Android 10+ safe) */
    private fun showDialNotification(number: String, autoLaunch: Boolean = false) {
        val title = listOf(currentCompanyName, currentContactName).firstOrNull { it.isNotBlank() } ?: number
        val fullScreenIntent = PendingIntent.getActivity(
            this,
            3,
            callUiIntent(),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val callIntent = Intent(Intent.ACTION_CALL, Uri.parse("tel:$number"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pi = PendingIntent.getActivity(
            this, 2, callIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val n = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("📞 $title")
            .setContentText(number)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setFullScreenIntent(fullScreenIntent, true)
            .setContentIntent(fullScreenIntent)
            .setAutoCancel(true)
            .build()
        (getSystemService(NotificationManager::class.java))?.notify(9202, n)
        if (autoLaunch) {
            try {
                pi.send()
                setStatus("📱 Intentando abrir pantalla de llamada…")
            } catch (_: Exception) {
                setStatus("📱 Toca la notificación para llamar a $number")
            }
        } else {
            setStatus("📱 Toca la notificación para llamar a $number")
        }
    }

    private fun launchSystemDialerCall(number: String): Boolean {
        val candidates = listOf(
            "com.samsung.android.dialer",
            "com.google.android.dialer",
            "com.android.dialer"
        )
        val uri = Uri.parse("tel:$number")
        for (pkg in candidates) {
            try {
                val i = Intent(Intent.ACTION_CALL, uri)
                    .setPackage(pkg)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (i.resolveActivity(packageManager) != null) {
                    startActivity(i)
                    return true
                }
            } catch (_: Exception) {}
        }
        return false
    }

    private fun setMicMute(mute: Boolean): Boolean {
        try {
            val am = getSystemService(AUDIO_SERVICE) as? AudioManager
            if (am == null) {
                setStatus("⚠️ AudioManager no disponible")
                return false
            }
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            @Suppress("DEPRECATION")
            am.isMicrophoneMute = mute
            isMicMuted = mute
            emitCallUiState()
            launchCallUi()
            setStatus(if (mute) "🔇 Micrófono silenciado" else "🎙️ Micrófono activo")
            return true
        } catch (e: Exception) {
            setStatus("⚠️ No se pudo cambiar micro: ${e.message}")
            return false
        }
    }

    private fun setSpeakerOn(enabled: Boolean): Boolean {
        try {
            val am = getSystemService(AUDIO_SERVICE) as? AudioManager
            if (am == null) {
                setStatus("⚠️ AudioManager no disponible")
                return false
            }
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            var ok = true

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (enabled) {
                    val speaker = am.availableCommunicationDevices
                        .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                    ok = if (speaker != null) am.setCommunicationDevice(speaker) else false
                } else {
                    val earpiece = am.availableCommunicationDevices
                        .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
                    ok = if (earpiece != null) am.setCommunicationDevice(earpiece) else {
                        am.clearCommunicationDevice()
                        true
                    }
                }
            }

            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = enabled
            isSpeakerOn = enabled && ok
            emitCallUiState()
            launchCallUi()
            if (!ok) {
                setStatus("⚠️ No se pudo cambiar ruta de audio en este dispositivo")
                return false
            }
            setStatus(if (isSpeakerOn) "🔊 Altavoz activado" else "🔈 Altavoz desactivado")
            return isSpeakerOn == enabled
        } catch (e: Exception) {
            setStatus("⚠️ No se pudo cambiar altavoz: ${e.message}")
            return false
        }
    }

    private fun answerIncomingCall(): Boolean {
        if (!hasPermission(Manifest.permission.ANSWER_PHONE_CALLS)) {
            setStatus("⚠️ Falta permiso ANSWER_PHONE_CALLS")
            return false
        }
        val ok = VoipVcInCallService.answerRingingCall()
        if (!ok) {
            setStatus("⚠️ No hay llamada entrante para contestar")
            return false
        }
        lastCallState = "in_call"
        startAudio()
        emitPhoneStatus("in_call")
        emitCallUiState()
        launchCallUi()
        setStatus("✅ Llamada contestada")
        return true
    }


    private fun hangup(): Boolean {
        dialAttemptToken += 1 // cancel pending dial fallback callbacks
        if (!isDefaultDialer()) {
            setStatus("⚠️ Activa Phone-VC como marcador default")
            return false
        }
        try {
            val tm = getSystemService(TELECOM_SERVICE) as? TelecomManager
            if (tm?.endCall() == true) {
                emitPhoneStatus("ended")
                setStatus("📵 Llamada colgada")
                stopAudio()
                lastCallState = "ended"
                currentPhoneNumber = ""
                isSpeakerOn = false
                emitCallUiState()
                return true
            }
            return false
        } catch (e: Exception) {
            setStatus("Error al colgar: ${e.message}")
            return false
        }
    }

    private fun isDefaultDialer(): Boolean =
        (getSystemService(TELECOM_SERVICE) as? TelecomManager)?.defaultDialerPackage == packageName

    private fun isActuallyInCall(): Boolean {
        val tm = getSystemService(TELECOM_SERVICE) as? TelecomManager
        return tm?.isInCall == true
    }

    // ── CALL STATE MONITOR (no root, just READ_PHONE_STATE) ───────────────────

    @Suppress("DEPRECATION")
    private fun registerCallMonitor() {
        val tm = getSystemService(TELEPHONY_SERVICE) as? TelephonyManager ?: return
        if (!hasPermission(Manifest.permission.READ_PHONE_STATE)) return

        phoneStateListener = object : PhoneStateListener() {
            override fun onCallStateChanged(state: Int, phoneNumber: String?) {
                val callState = when (state) {
                    TelephonyManager.CALL_STATE_RINGING -> "ringing"
                    // OFFHOOK can happen before remote party answers (outgoing dialing).
                    // Real "in_call" is driven by Telecom ACTIVE state via VoipVcInCallService.
                    TelephonyManager.CALL_STATE_OFFHOOK -> "dialing"
                    else                                -> "idle"
                }
                if (callState == lastCallState) return
                lastCallState = callState

                if (!phoneNumber.isNullOrBlank()) currentPhoneNumber = phoneNumber
                emitPhoneStatus(callState)
                emitCallUiState()

                when (callState) {
                    "ringing" -> {
                        setStatus("📲 Llamada entrante: ${phoneNumber ?: "?"}")
                        launchCallUi()
                    }
                    "in_call" -> {
                        startAudio()
                        if (isActuallyInCall()) {
                            setStatus("🔊 En llamada")
                        } else {
                            emitPhoneStatus("idle")
                            setStatus("⚠️ Intento de llamada sin conexión real")
                        }
                    }
                    "idle" -> {
                        dialAttemptToken += 1
                        stopAudio()
                        currentPhoneNumber = ""
                        setStatus("✅ Activo — esperando llamadas")
                        closeCallUi()
                    }
                }
            }
        }

        @Suppress("DEPRECATION")
        tm.listen(phoneStateListener, PhoneStateListener.LISTEN_CALL_STATE)
    }

    @Suppress("DEPRECATION")
    private fun unregisterCallMonitor() {
        try {
            (getSystemService(TELEPHONY_SERVICE) as? TelephonyManager)
                ?.listen(phoneStateListener, PhoneStateListener.LISTEN_NONE)
        } catch (_: Exception) {}
        phoneStateListener = null
    }

    // ── AUDIO BRIDGE (no root required) ──────────────────────────────────────

    /**
     * Starts:
     * 1. AudioRecord — captures phone MIC → sends to web via socket "audio:phone"
     * 2. AudioTrack  — receives web MIC audio → plays on phone speaker
     */
    private fun startAudio() {
        if (isStreaming.getAndSet(true)) return

        if (!hasPermission(Manifest.permission.RECORD_AUDIO)) {
            setStatus("⚠️ Falta permiso RECORD_AUDIO")
            isStreaming.set(false)
            return
        }

        // ── AudioTrack (playback) ─────────────────────────────────────────────
        try {
            audioTrack = AudioTrack(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
                AudioFormat.Builder()
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .build(),
                minBufOut,
                AudioTrack.MODE_STREAM,
                AudioManager.AUDIO_SESSION_ID_GENERATE
            )
            audioTrack!!.play()
            isPlaying.set(true)
        } catch (e: Exception) {
            Log.e(TAG, "AudioTrack failed", e)
        }

        // ── AudioRecord (capture) ─────────────────────────────────────────────
        try {
            audioRecord = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBufIn
            )
        } catch (e: Exception) {
            Log.e(TAG, "AudioRecord failed", e)
            isStreaming.set(false)
            return
        }

        if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
            setStatus("⚠️ AudioRecord no disponible")
            isStreaming.set(false)
            return
        }

        audioRecord!!.startRecording()

        val chunkBytes = CHUNK_FRAMES * 2
        captureJob = serviceScope.launch(Dispatchers.IO) {
            val buf = ByteArray(chunkBytes)
            while (isActive && isStreaming.get()) {
                val read = audioRecord?.read(buf, 0, chunkBytes) ?: -1
                if (read > 0 && socket?.connected() == true) {
                    socket!!.emit("audio:phone", buf.copyOf(read))
                }
            }
        }

        Log.d(TAG, "Audio bridge started via Coroutines")
    }

    private fun stopAudio() {
        isStreaming.set(false)
        isPlaying.set(false)
        captureJob?.cancel()
        captureJob = null
        try { audioRecord?.stop(); audioRecord?.release() } catch (_: Exception) {}
        try { audioTrack?.stop(); audioTrack?.release()  } catch (_: Exception) {}
        audioRecord = null
        audioTrack  = null
    }

    private fun buildRestartIntentFromPrefs(): Intent? {
        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        val url = prefs.getString(PREF_SOCKET_URL, "") ?: ""
        val code = prefs.getString(PREF_CODE, "") ?: ""
        val token = prefs.getString(PREF_TOKEN, "") ?: ""
        val devId = prefs.getString(PREF_DEVICE_ID, "") ?: ""
        val devName = prefs.getString(PREF_DEVICE_NAME, "") ?: ""

        if (url.isBlank() || code.isBlank() || token.isBlank()) return null

        return Intent(this, BridgeService::class.java).apply {
            action = ACTION_START
            putExtra(EXTRA_SOCKET_URL, url)
            putExtra(EXTRA_CODE, code)
            putExtra(EXTRA_TOKEN, token)
            putExtra(EXTRA_DEVICE_ID, devId)
            putExtra(EXTRA_DEVICE_NAME, devName)
        }
    }

    private fun playAudio(bytes: ByteArray) {
        if (!isPlaying.get()) return
        try { audioTrack?.write(bytes, 0, bytes.size) } catch (_: Exception) {}
    }

    private fun callUiIntent(): Intent =
        Intent(this, IncomingCallActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra(EXTRA_PHONE_NUMBER, currentPhoneNumber)
            putExtra(EXTRA_COMPANY_NAME, currentCompanyName)
            putExtra(EXTRA_CONTACT_NAME, currentContactName)
            putExtra(EXTRA_IMAGE_URL, currentImageUrl)
            putExtra(EXTRA_CALL_STATE, lastCallState)
            putExtra(EXTRA_MIC_MUTED, isMicMuted)
            putExtra(EXTRA_SPEAKER_ON, isSpeakerOn)
        }

    private fun launchCallUi() {
        if (currentPhoneNumber.isBlank() && lastCallState == "idle") return
        try { startActivity(callUiIntent()) } catch (_: Exception) {}
    }

    private fun emitCallUiState() {
        sendBroadcast(
            Intent(ACTION_CALL_UI_STATE).apply {
                setPackage(packageName)
                putExtra(EXTRA_PHONE_NUMBER, currentPhoneNumber)
                putExtra(EXTRA_COMPANY_NAME, currentCompanyName)
                putExtra(EXTRA_CONTACT_NAME, currentContactName)
                putExtra(EXTRA_IMAGE_URL, currentImageUrl)
                putExtra(EXTRA_CALL_STATE, lastCallState)
                putExtra(EXTRA_MIC_MUTED, isMicMuted)
                putExtra(EXTRA_SPEAKER_ON, isSpeakerOn)
            }
        )
    }

    private fun closeCallUi() {
        sendBroadcast(Intent(ACTION_CLOSE_CALL_UI).setPackage(packageName))
    }

    private fun emitCommandAck(commandId: String, action: String, ok: Boolean, message: String) {
        if (commandId.isBlank()) return
        socket?.emit(
            "phone:command_ack",
            JSONObject()
                .put("commandId", commandId)
                .put("action", action)
                .put("ok", ok)
                .put("message", message)
        )
    }

    private fun logoutAndStop() {
        try {
            dialAttemptToken += 1
            stopAudio()
            closeCallUi()
            socket?.disconnect()
            socket?.off()
            socket = null
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().clear().apply()
            lastCallState = "idle"
            currentPhoneNumber = ""
            currentCompanyName = ""
            currentContactName = ""
            currentImageUrl = ""
            isMicMuted = false
            isSpeakerOn = false
            setStatus("🔒 Sesión cerrada. APK detenida.")
        } catch (e: Exception) {
            setStatus("⚠️ Error al cerrar sesión: ${e.message}")
        } finally {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun emitPhoneStatus(state: String) {
        socket?.emit(
            "phone:status",
            JSONObject()
                .put("callState", state)
                .put("phoneNumber", currentPhoneNumber)
                .put("contactName", currentContactName)
                .put("companyName", currentCompanyName)
        )
    }

    // ── HELPERS ───────────────────────────────────────────────────────────────

    private fun hasPermission(perm: String) =
        ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED

    private fun setStatus(msg: String) {
        Log.d(TAG, msg)
        // Update notification
        (getSystemService(NotificationManager::class.java))
            ?.notify(NOTIFICATION_ID, buildNotification(msg))
        // Broadcast to MainActivity
        sendBroadcast(Intent(ACTION_STATUS).putExtra(EXTRA_STATUS_MESSAGE, msg))
    }

    // ── NOTIFICATION ──────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val ch = NotificationChannel(
            CHANNEL_ID, "Phone-VC Bridge", NotificationManager.IMPORTANCE_HIGH
        ).apply { setShowBadge(false) }
        (getSystemService(NotificationManager::class.java))?.createNotificationChannel(ch)
    }

    private fun buildNotification(text: String): Notification {
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Phone-VC")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setContentIntent(pi)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }
}
