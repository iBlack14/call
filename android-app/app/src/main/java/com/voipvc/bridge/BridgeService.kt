@file:Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")

package com.voipvc.bridge

import android.Manifest
import android.annotation.SuppressLint
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
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel

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

    private data class DialResult(val ok: Boolean, val message: String)

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
        const val PREF_ACTIVE_COMMAND_ID = "active_command_id"
        const val PREF_ACTIVE_CONTACT_ID = "active_contact_id"
        const val PREF_CAMPAIGN_PHONE = "campaign_phone"
        const val PREF_CAMPAIGN_CALL_STATE = "campaign_call_state"
        const val PREF_CAMPAIGN_STATE_OBSERVED = "campaign_state_observed"

        // Status broadcast
        const val ACTION_STATUS        = "com.voipvc.bridge.STATUS"
        const val EXTRA_STATUS_MESSAGE = "status_msg"
        const val ACTION_CALL_UI_STATE = "com.voipvc.bridge.CALL_UI_STATE"
        const val ACTION_CLOSE_CALL_UI = "com.voipvc.bridge.CLOSE_CALL_UI"
        const val ACTION_TELECOM_CALL_STATE = "com.voipvc.bridge.TELECOM_CALL_STATE"
        const val EXTRA_CALL_STATE = "call_state"
        const val EXTRA_CALL_DIRECTION = "call_direction"
        const val EXTRA_MIC_MUTED = "mic_muted"
        const val EXTRA_SPEAKER_ON = "speaker_on"
    }

    // ── STATE ─────────────────────────────────────────────────────────────────
    private var socket: Socket? = null
    private var connectionKey = ""

    // Audio
    private var audioRecord : AudioRecord? = null
    private var audioTrack  : AudioTrack?  = null
    private val isStreaming  = AtomicBoolean(false)
    private val isPlaying    = AtomicBoolean(false)
    private var captureJob: Job? = null
    private var playbackJob: Job? = null
    private val audioPlaybackQueue = Channel<ByteArray>(
        capacity = 4,
        onBufferOverflow = BufferOverflow.DROP_OLDEST
    )
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
    private var activeCommandId = ""
    private var activeContactId = ""
    private var campaignPhoneNumber = ""
    private var campaignStateObserved = false
    private var campaignTrackingRestored = false
    private var hangupVerificationToken = 0
    private var currentCallDirection = "unknown"
    private var lastTelecomEventAt = 0L
    private var statusSequence = 0L
    private val statusSessionId = UUID.randomUUID().toString()
    private var lastEmittedStatusSignature = ""
    private var lastDialCommandId = ""
    private var lastDialAck = DialResult(false, "")

    private val telecomStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != ACTION_TELECOM_CALL_STATE) return
            val st = intent.getStringExtra(EXTRA_CALL_STATE)?.trim().orEmpty()
            if (st.isBlank()) return
            val incomingNumber = intent.getStringExtra(EXTRA_PHONE_NUMBER).orEmpty().trim()
            val incomingName = intent.getStringExtra(EXTRA_CONTACT_NAME).orEmpty().trim()
            val direction = intent.getStringExtra(EXTRA_CALL_DIRECTION).orEmpty().ifBlank { "unknown" }
            lastTelecomEventAt = SystemClock.elapsedRealtime()
            handleObservedCallState(st, incomingNumber, incomingName, direction, "telecom")
        }
    }

    // ── LIFECYCLE ─────────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        restoreCampaignTracking()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification("Phone-VC iniciando…"))
        registerCallMonitor()
        val filter = IntentFilter(ACTION_TELECOM_CALL_STATE)
        ContextCompat.registerReceiver(
            this,
            telecomStateReceiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
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
            ACTION_UI_SYNC -> {
                emitCallUiState()
                emitPhoneStatus(lastCallState, "ui_sync", correlateCampaign = activeCommandId.isNotBlank())
            }
            null -> buildRestartIntentFromPrefs()?.let { restart ->
                tryConnect(
                    restart.getStringExtra(EXTRA_SOCKET_URL).orEmpty(),
                    restart.getStringExtra(EXTRA_CODE).orEmpty(),
                    restart.getStringExtra(EXTRA_TOKEN).orEmpty(),
                    restart.getStringExtra(EXTRA_DEVICE_ID).orEmpty(),
                    restart.getStringExtra(EXTRA_DEVICE_NAME).orEmpty()
                )
            }
        }
        return START_STICKY  // Android will restart this service if killed
    }

    /** The foreground service normally survives task removal; START_STICKY is
     * responsible for process recovery without creating a second socket. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
        stopAudio()
        unregisterCallMonitor()
        unregisterReceiver(telecomStateReceiver)
        socket?.disconnect()
        socket?.off()
        socket = null
        connectionKey = ""
        serviceScope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ── SOCKET CONNECTION ─────────────────────────────────────────────────────

    private fun tryConnect(url: String, code: String, token: String, devId: String, devName: String) {
        if (url.isBlank() || code.isBlank() || token.isBlank() || devId.isBlank()) {
            setStatus("⚠️ Datos incompletos")
            return
        }

        val requestedConnectionKey = listOf(url.trim(), code.trim(), token.trim(), devId.trim()).joinToString("|")
        if (requestedConnectionKey == connectionKey && socket != null) {
            if (socket?.connected() != true) socket?.connect()
            emitCallUiState()
            setStatus(if (socket?.connected() == true) "✅ Activo — esperando llamadas" else "🔄 Reconectando…")
            return
        }
        connectionKey = requestedConnectionKey

        socket?.disconnect()
        socket?.off()

        val client: Socket
        try {
            val options = IO.Options().apply {
                reconnection = true
                reconnectionAttempts = Int.MAX_VALUE
                reconnectionDelay = 1_000L
                reconnectionDelayMax = 10_000L
                timeout = 20_000L
                forceNew = true
            }
            client = IO.socket(url, options)
            socket = client
        } catch (e: Exception) {
            setStatus("URL inválida: ${e.message}")
            return
        }

        client.on(Socket.EVENT_CONNECT) {
            if (client !== socket) return@on
            val payload = JSONObject()
                .put("code", code).put("role", "phone")
                .put("protocolVersion", 2)
                .put("token", token)
                .put("deviceId", devId).put("deviceName", devName)
            client.emit("session:join", payload)
        }

        client.on("session:joined") {
            if (client !== socket) return@on
            mainHandler.post {
                if (client !== socket) return@post
                setStatus("✅ Activo — esperando llamadas")
                // Save credentials for reboot auto-start
                getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
                    .putString(PREF_SOCKET_URL, url) .putString(PREF_CODE, code)
                    .putString(PREF_TOKEN, token)    .putString(PREF_DEVICE_ID, devId)
                    .putString(PREF_DEVICE_NAME, devName).apply()
                // Re-announce the actual local call after a network micro-cut so
                // the server can resume the same command during its grace window.
                emitPhoneStatus(lastCallState, "reconnect", correlateCampaign = activeCommandId.isNotBlank())
                if (campaignTrackingRestored) {
                    campaignTrackingRestored = false
                    mainHandler.postDelayed({
                        if (
                            activeCommandId.isNotBlank() &&
                            lastCallState in setOf("dialing", "ringing", "in_call") &&
                            !isActuallyInCall()
                        ) {
                            handleObservedCallState(
                                "failed",
                                campaignPhoneNumber,
                                "",
                                "outgoing",
                                "process_recovery"
                            )
                        }
                    }, 3_000L)
                }
            }
        }

        client.on("session:error") { args ->
            if (client !== socket) return@on
            val msg = (args.firstOrNull() as? JSONObject)?.optString("message") ?: "Error de sesión"
            mainHandler.post { setStatus("❌ $msg") }
        }

        // Keep APK UI in sync with the authoritative session state from server.
        client.on("state:changed") { args ->
            if (client !== socket) return@on
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
            // Android/Telecom is authoritative for the physical call state.
            // Server echoes are useful only to restore missing display data;
            // feeding them back into lastCallState caused state oscillations.
            mainHandler.post {
                if (client !== socket) return@post
                if (currentPhoneNumber.isBlank() && !isActuallyInCall()) {
                    currentPhoneNumber = workerState.optString("currentNumber")
                }
            }
        }

        client.on("phone:status_ack") { args ->
            if (client !== socket) return@on
            val data = args.firstOrNull() as? JSONObject ?: return@on
            mainHandler.post {
                if (client !== socket) return@post
                val commandId = data.optString("commandId")
                val contactId = data.optString("contactId")
                if (
                    data.optBoolean("accepted") &&
                    data.optBoolean("terminal") &&
                    commandId == activeCommandId &&
                    contactId == activeContactId
                ) {
                    clearCampaignTracking()
                }
            }
        }

        client.on("call:action") { args ->
            if (client !== socket) return@on
            val data = args.firstOrNull() as? JSONObject ?: return@on
            mainHandler.post {
              if (client !== socket) return@post
              val commandId = data.optString("commandId")
              when (data.optString("action")) {
                "dial"   -> {
                    val phoneNumber = data.optString("phoneNumber")
                    val companyName = data.optString("companyName")
                    val contactName = data.optString("contactName")
                    val imageUrl = data.optString("imageUrl")
                    val contactId = data.optString("contactId")
                    val result = if (commandId.isNotBlank() && commandId == lastDialCommandId) {
                        lastDialAck
                    } else {
                        dialNumber(
                            phoneNumber,
                            companyName,
                            contactName,
                            imageUrl,
                            commandId,
                            contactId
                        ).also {
                            lastDialCommandId = commandId
                            lastDialAck = it
                        }
                    }
                    emitCommandAck(commandId, "dial", result.ok, result.message)
                }
                "hangup" -> {
                    val requestedContactId = data.optString("contactId")
                    val matchesActiveCall = requestedContactId.isBlank() ||
                        activeContactId.isBlank() ||
                        requestedContactId == activeContactId
                    val ok = matchesActiveCall && hangup()
                    emitCommandAck(
                        commandId,
                        "hangup",
                        ok,
                        when {
                            !matchesActiveCall -> "La orden pertenece a otra llamada"
                            ok -> "Corte solicitado; esperando confirmación física"
                            else -> "Android no pudo solicitar el corte"
                        }
                    )
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
        }

        // Receive web mic audio → play on phone speaker during call
        client.on("audio:dashboard") { args ->
            if (client !== socket) return@on
            val raw = args.firstOrNull()
            val bytes: ByteArray? = when (raw) {
                is ByteArray -> raw
                else -> null
            }
            bytes?.let { audioPlaybackQueue.trySend(it) }
        }

        client.on(Socket.EVENT_DISCONNECT) {
            if (client === socket) mainHandler.post { setStatus("🔄 Reconectando…") }
        }
        client.on(Socket.EVENT_CONNECT_ERROR) {
            if (client === socket) mainHandler.post { setStatus("🔄 Sin servidor — reintentando…") }
        }

        client.connect()
        setStatus("🔗 Conectando…")
    }

    // ── CALL ACTIONS ──────────────────────────────────────────────────────────

    @SuppressLint("MissingPermission")
    private fun dialNumber(
        number: String,
        companyName: String,
        contactName: String,
        imageUrl: String,
        commandId: String,
        contactId: String
    ): DialResult {
        if (number.isBlank() || commandId.isBlank()) {
            return DialResult(false, "Número o identificador de llamada inválido")
        }
        if (isActuallyInCall() || activeCommandId.isNotBlank()) {
            return DialResult(false, "El teléfono ya está atendiendo otra llamada")
        }
        dialAttemptToken += 1
        hangupVerificationToken += 1
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
        activeCommandId = commandId
        activeContactId = contactId
        campaignPhoneNumber = number
        campaignStateObserved = false
        campaignTrackingRestored = false
        currentCallDirection = "outgoing"
        lastCallState = "dialing"
        persistCampaignTracking()
        launchCallUi()
        emitCallUiState()

        if (!hasPermission(Manifest.permission.CALL_PHONE)) {
            return abortDial("Falta permiso CALL_PHONE")
        }
        if (!isDefaultDialer()) {
            return abortDial("Phone-VC no es el marcador predeterminado")
        }

        try {
            val tm = getSystemService(TELECOM_SERVICE) as? TelecomManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && tm != null) {
                tm.placeCall(Uri.parse("tel:$number"), Bundle())
                emitPhoneStatus("dialing", "command", correlateCampaign = true)
                setStatus("📞 Intentando llamada a $number")

                // Never place a second automatic call: on some phones the
                // original implementation could dial the contact twice while
                // Android was still reporting the first request.
                mainHandler.postDelayed({
                    if (thisAttempt != dialAttemptToken) return@postDelayed
                    if (!isActuallyInCall()) {
                        handleObservedCallState(
                            "failed",
                            number,
                            "",
                            "outgoing",
                            "dial_timeout"
                        )
                        setStatus("⚠️ Android no inició la llamada")
                    }
                }, 10_000)
                return DialResult(true, "Comando recibido e inicio de llamada solicitado")
            }
        } catch (e: Exception) {
            Log.w(TAG, "TelecomManager.placeCall failed: ${e.message}")
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return abortDial("Android bloqueó la marcación automática")
        }

        try {
            startActivity(Intent(Intent.ACTION_CALL, Uri.parse("tel:$number")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            emitPhoneStatus("dialing", "command", correlateCampaign = true)
            setStatus("📞 Llamando $number")
            return DialResult(true, "Comando recibido e inicio de llamada solicitado")
        } catch (e: Exception) {
            return abortDial("No se pudo iniciar la llamada: ${e.message}")
        }
    }

    private fun abortDial(reason: String): DialResult {
        dialAttemptToken += 1
        lastCallState = "idle"
        stopAudio()
        clearCampaignTracking()
        currentPhoneNumber = ""
        currentCompanyName = ""
        currentContactName = ""
        currentImageUrl = ""
        currentCallDirection = "unknown"
        emitCallUiState()
        closeCallUi()
        setStatus("⚠️ $reason")
        return DialResult(false, reason)
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
            emitPhoneStatus(lastCallState, "controls", correlateCampaign = activeCommandId.isNotBlank())
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
            emitPhoneStatus(lastCallState, "controls", correlateCampaign = activeCommandId.isNotBlank())
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
        emitPhoneStatus("in_call", "user_action", correlateCampaign = activeCommandId.isNotBlank())
        emitCallUiState()
        launchCallUi()
        setStatus("✅ Llamada contestada")
        return true
    }


    @SuppressLint("MissingPermission")
    private fun hangup(): Boolean {
        dialAttemptToken += 1 // cancel pending dial fallback callbacks
        val targetNumber = campaignPhoneNumber.ifBlank { currentPhoneNumber }
        if (!isDefaultDialer()) {
            setStatus("⚠️ Activa Phone-VC como marcador default")
            return false
        }
        try {
            if (!VoipVcInCallService.hasLiveCall(targetNumber)) {
                val targetAlreadyEnded = VoipVcInCallService.isCallDefinitelyAbsent(targetNumber) ||
                    (
                        !VoipVcInCallService.isTrackingCalls() &&
                            hasPermission(Manifest.permission.READ_PHONE_STATE) &&
                            !isActuallyInCall()
                    )
                if (targetAlreadyEnded && activeCommandId.isNotBlank()) {
                    handleObservedCallState(
                        "ended",
                        targetNumber,
                        "",
                        "outgoing",
                        "hangup_already_ended"
                    )
                    return true
                }
                setStatus("⚠️ No se pudo identificar la llamada que debe cortarse")
                return false
            }

            val requested = VoipVcInCallService.disconnectCall(targetNumber)
            scheduleHangupVerification(targetNumber)
            if (requested) {
                setStatus("📵 Corte solicitado; esperando confirmación…")
                return true
            }
            setStatus("⚠️ Android rechazó el corte; verificando nuevamente…")
            return false
        } catch (e: Exception) {
            setStatus("Error al colgar: ${e.message}")
            return false
        }
    }

    private fun scheduleHangupVerification(targetNumber: String) {
        hangupVerificationToken += 1
        val token = hangupVerificationToken
        mainHandler.postDelayed({
            if (token != hangupVerificationToken || activeCommandId.isBlank()) return@postDelayed
            if (VoipVcInCallService.hasLiveCall(targetNumber)) {
                VoipVcInCallService.disconnectCall(targetNumber)
            }
        }, 1_000L)
        mainHandler.postDelayed({
            if (token != hangupVerificationToken || activeCommandId.isBlank()) return@postDelayed
            val targetEnded = !VoipVcInCallService.hasLiveCall(targetNumber) &&
                (
                    VoipVcInCallService.isCallDefinitelyAbsent(targetNumber) ||
                        (
                            !VoipVcInCallService.isTrackingCalls() &&
                                hasPermission(Manifest.permission.READ_PHONE_STATE) &&
                                !isActuallyInCall()
                        )
                )
            if (targetEnded) {
                handleObservedCallState(
                    "ended",
                    targetNumber,
                    "",
                    "outgoing",
                    "hangup_verification"
                )
            } else {
                setStatus("⚠️ No se confirmó el corte; revisa el teléfono")
            }
        }, 3_500L)
    }

    private fun isDefaultDialer(): Boolean =
        (getSystemService(TELECOM_SERVICE) as? TelecomManager)?.defaultDialerPackage == packageName

    private fun isActuallyInCall(): Boolean {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
            return false
        }
        val tm = getSystemService(TELECOM_SERVICE) as? TelecomManager
        return tm?.isInCall == true
    }

    private fun normalizedNumber(value: String): String {
        var digits = value.filter(Char::isDigit)
        if (digits.length == 11 && digits.startsWith("51")) digits = digits.drop(2)
        return digits
    }

    private fun numbersMatch(first: String, second: String): Boolean {
        val a = normalizedNumber(first)
        val b = normalizedNumber(second)
        return a.isNotBlank() && b.isNotBlank() && a == b
    }

    private fun isRegressiveTransition(previous: String, next: String): Boolean =
        (previous == "in_call" && (next == "dialing" || next == "ringing")) ||
            (previous == "ringing" && next == "dialing")

    private fun handleObservedCallState(
        rawState: String,
        observedNumber: String,
        observedName: String,
        direction: String,
        source: String
    ) {
        if (rawState !in setOf("idle", "dialing", "ringing", "in_call", "ended", "failed")) return

        val hasCampaignCall = activeCommandId.isNotBlank()
        val normalizedDirection = direction.lowercase()
        val hasCampaignIdentity = if (observedNumber.isBlank()) {
            normalizedDirection == "outgoing"
        } else {
            numbersMatch(campaignPhoneNumber, observedNumber)
        }
        val belongsToCampaign = hasCampaignCall &&
            normalizedDirection != "incoming" &&
            hasCampaignIdentity

        if (hasCampaignCall && !belongsToCampaign) {
            // Report the observation for diagnostics, without campaign IDs.
            // The server will keep it isolated from the assigned outbound call.
            emitPhoneStatus(
                rawState,
                source,
                correlateCampaign = false,
                phoneNumberOverride = observedNumber,
                directionOverride = direction
            )
            Log.i(TAG, "Ignoring unrelated $direction call while campaign command is active")
            return
        }

        if (!hasCampaignCall && observedNumber.isNotBlank()) currentPhoneNumber = observedNumber
        if (!hasCampaignCall && observedName.isNotBlank()) {
            currentContactName = observedName
            if (currentCompanyName.isBlank()) currentCompanyName = observedName
        }
        if (hasCampaignCall) currentPhoneNumber = campaignPhoneNumber
        currentCallDirection = if (hasCampaignCall) "outgoing" else direction

        if (hasCampaignCall && rawState in setOf("dialing", "ringing", "in_call")) {
            campaignStateObserved = true
        }
        if (hasCampaignCall && rawState == "idle" && !campaignStateObserved) {
            Log.d(TAG, "Ignoring premature idle before campaign call activity")
            return
        }

        val state = if (hasCampaignCall && rawState == "idle") "ended" else rawState
        if (isRegressiveTransition(lastCallState, state)) {
            Log.d(TAG, "Ignoring regressive state $lastCallState -> $state from $source")
            return
        }

        lastCallState = state
        if (belongsToCampaign) persistCampaignTracking(state)
        emitPhoneStatus(state, source, correlateCampaign = belongsToCampaign)
        emitCallUiState()

        when (state) {
            "dialing" -> {
                launchCallUi()
                setStatus("📞 Llamando...")
            }
            "ringing" -> {
                launchCallUi()
                setStatus("📲 Llamada entrante")
            }
            "in_call" -> {
                startAudio()
                launchCallUi()
                setStatus("🔊 En llamada")
            }
            "ended", "failed", "idle" -> {
                dialAttemptToken += 1
                hangupVerificationToken += 1
                stopAudio()
                setStatus("✅ Activo — esperando llamadas")
                closeCallUi()
                if (!isActuallyInCall()) {
                    currentPhoneNumber = ""
                    currentCompanyName = ""
                    currentContactName = ""
                    currentImageUrl = ""
                }
            }
        }
    }

    private fun clearCampaignTracking() {
        activeCommandId = ""
        activeContactId = ""
        campaignPhoneNumber = ""
        campaignStateObserved = false
        campaignTrackingRestored = false
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
            .remove(PREF_ACTIVE_COMMAND_ID)
            .remove(PREF_ACTIVE_CONTACT_ID)
            .remove(PREF_CAMPAIGN_PHONE)
            .remove(PREF_CAMPAIGN_CALL_STATE)
            .remove(PREF_CAMPAIGN_STATE_OBSERVED)
            .apply()
    }

    private fun persistCampaignTracking(state: String = lastCallState) {
        if (activeCommandId.isBlank()) return
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
            .putString(PREF_ACTIVE_COMMAND_ID, activeCommandId)
            .putString(PREF_ACTIVE_CONTACT_ID, activeContactId)
            .putString(PREF_CAMPAIGN_PHONE, campaignPhoneNumber)
            .putString(PREF_CAMPAIGN_CALL_STATE, state)
            .putBoolean(PREF_CAMPAIGN_STATE_OBSERVED, campaignStateObserved)
            .apply()
    }

    private fun restoreCampaignTracking() {
        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        activeCommandId = prefs.getString(PREF_ACTIVE_COMMAND_ID, "").orEmpty()
        activeContactId = prefs.getString(PREF_ACTIVE_CONTACT_ID, "").orEmpty()
        campaignPhoneNumber = prefs.getString(PREF_CAMPAIGN_PHONE, "").orEmpty()
        if (activeCommandId.isBlank()) return
        lastCallState = prefs.getString(PREF_CAMPAIGN_CALL_STATE, "dialing").orEmpty().ifBlank { "dialing" }
        currentPhoneNumber = campaignPhoneNumber
        currentCallDirection = "outgoing"
        campaignStateObserved = prefs.getBoolean(
            PREF_CAMPAIGN_STATE_OBSERVED,
            lastCallState in setOf("ringing", "in_call", "ended", "failed")
        )
        campaignTrackingRestored = true
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
                val scheduledAt = SystemClock.elapsedRealtime()
                val number = phoneNumber.orEmpty()
                val direction = if (callState == "ringing") "incoming"
                    else if (activeCommandId.isNotBlank()) "outgoing" else "unknown"

                // InCallService has richer, authoritative states. Telephony is
                // retained only as a delayed fallback for vendor-specific ROMs.
                mainHandler.postDelayed({
                    if (lastTelecomEventAt >= scheduledAt || VoipVcInCallService.isTrackingCalls()) {
                        return@postDelayed
                    }
                    handleObservedCallState(callState, number, "", direction, "telephony_fallback")
                }, 750L)
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
    @SuppressLint("MissingPermission")
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
            playbackJob = serviceScope.launch(Dispatchers.IO) {
                for (bytes in audioPlaybackQueue) {
                    if (isPlaying.get()) playAudio(bytes)
                }
            }
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
            stopAudio()
            return
        }

        if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
            setStatus("⚠️ AudioRecord no disponible")
            stopAudio()
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
        playbackJob?.cancel()
        playbackJob = null
        while (audioPlaybackQueue.tryReceive().isSuccess) { /* discard stale audio */ }
        try { audioRecord?.stop(); audioRecord?.release() } catch (_: Exception) {}
        try { audioTrack?.stop(); audioTrack?.release()  } catch (_: Exception) {}
        audioRecord = null
        audioTrack  = null
        try {
            val audioManager = getSystemService(AUDIO_SERVICE) as? AudioManager
            @Suppress("DEPRECATION")
            audioManager?.isMicrophoneMute = false
            @Suppress("DEPRECATION")
            audioManager?.isSpeakerphoneOn = false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) audioManager?.clearCommunicationDevice()
            audioManager?.mode = AudioManager.MODE_NORMAL
        } catch (_: Exception) {}
        isMicMuted = false
        isSpeakerOn = false
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
        if (commandId.isBlank() || socket?.connected() != true) return
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
            connectionKey = ""
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().clear().apply()
            lastCallState = "idle"
            currentPhoneNumber = ""
            currentCompanyName = ""
            currentContactName = ""
            currentImageUrl = ""
            isMicMuted = false
            isSpeakerOn = false
            clearCampaignTracking()
            lastDialCommandId = ""
            lastDialAck = DialResult(false, "")
            setStatus("🔒 Sesión cerrada. APK detenida.")
        } catch (e: Exception) {
            setStatus("⚠️ Error al cerrar sesión: ${e.message}")
        } finally {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun emitPhoneStatus(
        state: String,
        source: String,
        correlateCampaign: Boolean,
        phoneNumberOverride: String? = null,
        directionOverride: String? = null
    ) {
        val reportedNumber = phoneNumberOverride ?: currentPhoneNumber
        val reportedDirection = directionOverride ?: currentCallDirection
        val commandId = if (correlateCampaign) activeCommandId else ""
        val contactId = if (correlateCampaign) activeContactId else ""
        val noLiveCalls = state in setOf("idle", "ended", "failed") &&
            hasPermission(Manifest.permission.READ_PHONE_STATE) &&
            !VoipVcInCallService.isTrackingCalls() &&
            !isActuallyInCall()
        val signature = listOf(
            state,
            normalizedNumber(reportedNumber),
            commandId,
            contactId,
            reportedDirection,
            source,
            campaignStateObserved.toString(),
            noLiveCalls.toString(),
            isMicMuted.toString(),
            isSpeakerOn.toString()
        ).joinToString("|")
        if (socket?.connected() != true) return
        if (signature == lastEmittedStatusSignature && source != "reconnect") return
        lastEmittedStatusSignature = signature
        statusSequence += 1

        socket?.emit(
            "phone:status",
            JSONObject()
                .put("callState", state)
                .put("phoneNumber", reportedNumber)
                .put("contactName", currentContactName)
                .put("companyName", currentCompanyName)
                .put("commandId", commandId)
                .put("contactId", contactId)
                .put("callDirection", reportedDirection)
                .put("source", source)
                .put("physicalObserved", campaignStateObserved)
                .put("noLiveCalls", noLiveCalls)
                .put("statusSessionId", statusSessionId)
                .put("statusSequence", statusSequence)
                .put("micMuted", isMicMuted)
                .put("speakerOn", isSpeakerOn)
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
        sendBroadcast(
            Intent(ACTION_STATUS)
                .setPackage(packageName)
                .putExtra(EXTRA_STATUS_MESSAGE, msg)
        )
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
