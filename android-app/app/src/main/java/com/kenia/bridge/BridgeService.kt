@file:Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")

package com.kenia.bridge

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

/**
 * Always-on foreground service.
 * • Connects to the KENIA server via Socket.IO
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
        const val ACTION_START  = "com.kenia.bridge.START"
        const val ACTION_STOP   = "com.kenia.bridge.STOP"

        // Extras
        const val EXTRA_SOCKET_URL  = "socket_url"
        const val EXTRA_CODE        = "code"
        const val EXTRA_TOKEN       = "token"
        const val EXTRA_DEVICE_ID   = "device_id"
        const val EXTRA_DEVICE_NAME = "device_name"

        // SharedPreferences
        const val PREFS_NAME       = "kenia_prefs"
        const val PREF_SOCKET_URL  = "socket_url"
        const val PREF_CODE        = "code"
        const val PREF_TOKEN       = "token"
        const val PREF_DEVICE_ID   = "device_id"
        const val PREF_DEVICE_NAME = "device_name"

        // Status broadcast
        const val ACTION_STATUS        = "com.kenia.bridge.STATUS"
        const val EXTRA_STATUS_MESSAGE = "status_msg"
    }

    // ── STATE ─────────────────────────────────────────────────────────────────
    private var socket: Socket? = null

    // Audio
    private var audioRecord : AudioRecord? = null
    private var audioTrack  : AudioTrack?  = null
    private val isStreaming  = AtomicBoolean(false)
    private val isPlaying    = AtomicBoolean(false)
    private var captureThread: Thread? = null

    private val minBufIn  by lazy { AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,  AudioFormat.ENCODING_PCM_16BIT).coerceAtLeast(CHUNK_FRAMES * 2) }
    private val minBufOut by lazy { AudioTrack.getMinBufferSize(SAMPLE_RATE,  AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT).coerceAtLeast(CHUNK_FRAMES * 2) }

    // Call monitoring
    @Suppress("DEPRECATION")
    private var phoneStateListener: PhoneStateListener? = null
    private var lastCallState = "idle"

    // ── LIFECYCLE ─────────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification("Phone-VC iniciando…"))
        registerCallMonitor()
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
        }
        return START_STICKY  // Android will restart this service if killed
    }

    /** Schedules a self-restart 1.5s after the user swipes the app away */
    override fun onTaskRemoved(rootIntent: Intent?) {
        val restart = Intent(this, BridgeService::class.java).apply { action = ACTION_START }
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
        socket?.disconnect()
        socket?.off()
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

        socket!!.on("call:action") { args ->
            val data = args.firstOrNull() as? JSONObject ?: return@on
            when (data.optString("action")) {
                "dial"   -> dialNumber(data.optString("phoneNumber"))
                "hangup" -> hangup()
                "mute"   -> setMicMute(true)
                "unmute" -> setMicMute(false)
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

    private fun dialNumber(number: String) {
        if (number.isBlank()) return
        if (!hasPermission(Manifest.permission.CALL_PHONE)) {
            setStatus("⚠️ Falta permiso CALL_PHONE"); return
        }
        if (!isDefaultDialer()) {
            setStatus("⚠️ Phone-VC no es marcador predeterminado. Toca la notificación para llamar.")
            showDialNotification(number)
            socket?.emit("phone:status", JSONObject().put("callState", "idle"))
            return
        }

        try {
            val tm = getSystemService(TELECOM_SERVICE) as? TelecomManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && tm != null) {
                tm.placeCall(Uri.parse("tel:$number"), Bundle())
                socket?.emit("phone:status", JSONObject().put("callState", "dialing"))
                setStatus("📞 Intentando llamada a $number")

                // Some devices silently block background dial attempts.
                Handler(Looper.getMainLooper()).postDelayed({
                    if (!isActuallyInCall()) {
                        val launched = launchSystemDialerCall(number)
                        if (launched) {
                            setStatus("📞 Reintentando vía marcador del sistema…")
                            Handler(Looper.getMainLooper()).postDelayed({
                                if (!isActuallyInCall()) {
                                    socket?.emit("phone:status", JSONObject().put("callState", "idle"))
                                    setStatus("⚠️ Android exige confirmación. Mostrando llamada en pantalla.")
                                    showDialNotification(number, autoLaunch = true)
                                }
                            }, 1800)
                        } else {
                            socket?.emit("phone:status", JSONObject().put("callState", "idle"))
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
            socket?.emit("phone:status", JSONObject().put("callState", "dialing"))
            setStatus("📞 Llamando $number")
        } catch (e: Exception) {
            setStatus("❌ No se pudo llamar: ${e.message}")
        }
    }

    /** Shows a high-priority notification with a tap-to-call action (Android 10+ safe) */
    private fun showDialNotification(number: String, autoLaunch: Boolean = false) {
        val callIntent = Intent(Intent.ACTION_CALL, Uri.parse("tel:$number"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pi = PendingIntent.getActivity(
            this, 2, callIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val n = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("📞 Llamar: $number")
            .setContentText("Toca para iniciar la llamada")
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setFullScreenIntent(pi, true)
            .setContentIntent(pi)
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

    private fun setMicMute(mute: Boolean) {
        try {
            val am = getSystemService(AUDIO_SERVICE) as? AudioManager
            if (am == null) {
                setStatus("⚠️ AudioManager no disponible")
                return
            }
            @Suppress("DEPRECATION")
            am.isMicrophoneMute = mute
            setStatus(if (mute) "🔇 Micrófono silenciado" else "🎙️ Micrófono activo")
        } catch (e: Exception) {
            setStatus("⚠️ No se pudo cambiar micro: ${e.message}")
        }
    }


    private fun hangup() {
        if (!isDefaultDialer()) {
            setStatus("⚠️ Activa Phone-VC como marcador default")
            return
        }
        try {
            val tm = getSystemService(TELECOM_SERVICE) as? TelecomManager
            if (tm?.endCall() == true) {
                socket?.emit("phone:status", JSONObject().put("callState", "ended"))
                setStatus("📵 Llamada colgada")
                stopAudio()
            }
        } catch (e: Exception) {
            setStatus("Error al colgar: ${e.message}")
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
                    TelephonyManager.CALL_STATE_OFFHOOK -> "in_call"
                    else                                -> "idle"
                }
                if (callState == lastCallState) return
                lastCallState = callState

                socket?.emit("phone:status", JSONObject().put("callState", callState))

                when (callState) {
                    "ringing" -> {
                        setStatus("📲 Llamada entrante: ${phoneNumber ?: "?"}")
                    }
                    "in_call" -> {
                        if (isActuallyInCall()) {
                            setStatus("🔊 En llamada")
                        } else {
                            socket?.emit("phone:status", JSONObject().put("callState", "idle"))
                            setStatus("⚠️ Intento de llamada sin conexión real")
                        }
                    }
                    "idle" -> {
                        setStatus("✅ Activo — esperando llamadas")
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

        val chunkBytes = CHUNK_FRAMES * 2  // 16-bit = 2 bytes per frame
        captureThread = Thread({
            val buf = ByteArray(chunkBytes)
            while (isStreaming.get()) {
                val read = audioRecord?.read(buf, 0, chunkBytes) ?: -1
                if (read > 0 && socket?.connected() == true) {
                    socket!!.emit("audio:phone", buf.copyOf(read))
                }
            }
        }, "AudioCaptureThread").also { it.start() }

        Log.d(TAG, "Audio bridge started")
    }

    private fun stopAudio() {
        isStreaming.set(false)
        isPlaying.set(false)
        captureThread?.interrupt()
        captureThread = null
        try { audioRecord?.stop(); audioRecord?.release() } catch (_: Exception) {}
        try { audioTrack?.stop(); audioTrack?.release()  } catch (_: Exception) {}
        audioRecord = null
        audioTrack  = null
    }

    private fun playAudio(bytes: ByteArray) {
        if (!isPlaying.get()) return
        try { audioTrack?.write(bytes, 0, bytes.size) } catch (_: Exception) {}
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
