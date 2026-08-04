package com.voipvc.bridge

import android.Manifest
import android.app.AlertDialog
import android.app.role.RoleManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.telecom.TelecomManager
import android.view.View
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.Locale
import androidx.lifecycle.lifecycleScope

class MainActivity : AppCompatActivity() {

    private enum class BridgeMode { ONBOARDING, CONNECTED }

    private val defaultBaseUrl = BuildConfig.DEFAULT_BASE_URL
    private val client = OkHttpClient()

    private lateinit var onboardingSection: View
    private lateinit var connectedSection: View
    private lateinit var settingsSection: View

    private lateinit var transientStatusText: TextView
    private lateinit var onboardingStatusText: TextView
    private lateinit var persistentStatusText: TextView
    private lateinit var connectionBadgeText: TextView
    private lateinit var deviceNameText: TextView
    private lateinit var sessionValueText: TextView
    private lateinit var serverValueText: TextView

    private lateinit var currentCallLabelText: TextView
    private lateinit var currentCallNameText: TextView
    private lateinit var currentCallNumberText: TextView
    private lateinit var callStateText: TextView
    private lateinit var callTimerText: TextView

    private lateinit var permMicChip: TextView
    private lateinit var permNotifChip: TextView
    private lateinit var permDialerChip: TextView

    private lateinit var baseUrlIn: TextInputEditText
    private lateinit var codeIn: TextInputEditText
    private lateinit var tokenIn: TextInputEditText
    private lateinit var settingsBaseUrlIn: TextInputEditText
    private lateinit var settingsCodeIn: TextInputEditText
    private lateinit var settingsTokenIn: TextInputEditText

    private lateinit var scanQrBtn: MaterialButton
    private lateinit var pairBtn: MaterialButton
    private lateinit var saveSettingsPairBtn: MaterialButton
    private lateinit var reconnectBtn: MaterialButton
    private lateinit var relinkBtn: MaterialButton
    private lateinit var toggleSettingsBtn: MaterialButton
    private lateinit var logoutBtn: MaterialButton
    private lateinit var answerBtn: MaterialButton
    private lateinit var hangupBtn: MaterialButton
    private lateinit var muteBtn: MaterialButton
    private lateinit var speakerBtn: MaterialButton

    private var bridgeMode = BridgeMode.ONBOARDING
    private var transientStatusMessage = "Escanea el QR del dashboard para vincular."
    private var currentPersistentStatus = "Bridge no vinculado."
    private var currentConnectionBadge = "Sin conexión"
    private var currentConnectionTone = Tone.WARNING

    private var lastCallState = "idle"
    private var currentPhoneNumber = ""
    private var currentContactName = ""
    private var currentCompanyName = ""
    private var isMicMuted = false
    private var isSpeakerOn = false
    private var callStartedAt: Long? = null
    private var autoReconnectAttempted = false
    private val timerHandler = Handler(Looper.getMainLooper())
    private val timerRunnable = object : Runnable {
        override fun run() {
            callTimerText.text = formatElapsed()
            if (callStartedAt != null) timerHandler.postDelayed(this, 1000L)
        }
    }

    private enum class Tone { SUCCESS, WARNING, ERROR, NEUTRAL }

    private val qrLauncher = registerForActivityResult(ScanContract()) { result ->
        val content = result.contents ?: return@registerForActivityResult
        applyQrContent(content)
    }

    private val cameraLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) launchScanner()
        else showTransientStatus("Cámara denegada. Puedes vincular manualmente.", Tone.WARNING)
        refreshReadinessChips()
    }

    private val recordAudioLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        showTransientStatus(
            if (granted) "Micrófono concedido. Audio del bridge listo."
            else "Micrófono denegado. El audio puente no estará disponible.",
            if (granted) Tone.SUCCESS else Tone.WARNING
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !hasPermission(Manifest.permission.POST_NOTIFICATIONS)
        ) {
            notificationsLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            requestDialerRoleIfNeeded()
        }
        refreshReadinessChips()
    }

    private val notificationsLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        showTransientStatus(
            if (granted) "Notificaciones activas." else "Notificaciones denegadas.",
            if (granted) Tone.SUCCESS else Tone.WARNING
        )
        requestDialerRoleIfNeeded()
        refreshReadinessChips()
    }

    private val answerCallLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ ->
        if (!hasPermission(Manifest.permission.RECORD_AUDIO)) {
            recordAudioLauncher.launch(Manifest.permission.RECORD_AUDIO)
        } else {
            requestDialerRoleIfNeeded()
        }
        refreshReadinessChips()
    }

    private val callPhoneLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ ->
        if (!hasPermission(Manifest.permission.ANSWER_PHONE_CALLS)) {
            answerCallLauncher.launch(Manifest.permission.ANSWER_PHONE_CALLS)
        } else {
            recordAudioLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
        refreshReadinessChips()
    }

    private val readPhoneLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ ->
        if (!hasPermission(Manifest.permission.CALL_PHONE)) {
            callPhoneLauncher.launch(Manifest.permission.CALL_PHONE)
        } else {
            answerCallLauncher.launch(Manifest.permission.ANSWER_PHONE_CALLS)
        }
        refreshReadinessChips()
    }

    private val dialerRoleLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        showTransientStatus(
            if (isDefaultDialer()) "Phone-VC listo como marcador predeterminado."
            else "Aún no es marcador predeterminado. Colgar remoto puede fallar.",
            if (isDefaultDialer()) Tone.SUCCESS else Tone.WARNING
        )
        refreshReadinessChips()
        if (isDefaultDialer()) autoReconnectIfSaved()
    }

    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                BridgeService.ACTION_STATUS -> {
                    val msg = intent.getStringExtra(BridgeService.EXTRA_STATUS_MESSAGE) ?: return
                    consumeServiceStatusMessage(msg)
                }
                BridgeService.ACTION_CALL_UI_STATE -> renderCallState(intent)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        bindViews()
        bindActions()
        hydrateTechnicalInputs()
        refreshSavedSessionMode()
        refreshReadinessChips()
        renderPersistentStatus()
        renderTransientStatus()
        renderCallPresentation()
        requestAllPermissions()
    }

    override fun onStart() {
        super.onStart()
        val filter = IntentFilter().apply {
            addAction(BridgeService.ACTION_STATUS)
            addAction(BridgeService.ACTION_CALL_UI_STATE)
        }
        ContextCompat.registerReceiver(this, statusReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        if (bridgeMode == BridgeMode.CONNECTED) {
            sendServiceAction(BridgeService.ACTION_UI_SYNC)
        }
    }

    override fun onStop() {
        super.onStop()
        unregisterReceiver(statusReceiver)
        timerHandler.removeCallbacks(timerRunnable)
    }

    private fun bindViews() {
        onboardingSection = findViewById(R.id.onboardingSection)
        connectedSection = findViewById(R.id.connectedSection)
        settingsSection = findViewById(R.id.settingsSection)

        transientStatusText = findViewById(R.id.transientStatusText)
        onboardingStatusText = findViewById(R.id.onboardingStatusText)
        persistentStatusText = findViewById(R.id.persistentStatusText)
        connectionBadgeText = findViewById(R.id.connectionBadgeText)
        deviceNameText = findViewById(R.id.deviceNameText)
        sessionValueText = findViewById(R.id.sessionValueText)
        serverValueText = findViewById(R.id.serverValueText)

        currentCallLabelText = findViewById(R.id.currentCallLabelText)
        currentCallNameText = findViewById(R.id.currentCallNameText)
        currentCallNumberText = findViewById(R.id.currentCallNumberText)
        callStateText = findViewById(R.id.callStateText)
        callTimerText = findViewById(R.id.callTimerText)

        permMicChip = findViewById(R.id.permMicChip)
        permNotifChip = findViewById(R.id.permNotifChip)
        permDialerChip = findViewById(R.id.permDialerChip)

        baseUrlIn = findViewById(R.id.baseUrlInput)
        codeIn = findViewById(R.id.codeInput)
        tokenIn = findViewById(R.id.tokenInput)
        settingsBaseUrlIn = findViewById(R.id.settingsBaseUrlInput)
        settingsCodeIn = findViewById(R.id.settingsCodeInput)
        settingsTokenIn = findViewById(R.id.settingsTokenInput)

        scanQrBtn = findViewById(R.id.scanQrBtn)
        pairBtn = findViewById(R.id.pairBtn)
        saveSettingsPairBtn = findViewById(R.id.saveSettingsPairBtn)
        reconnectBtn = findViewById(R.id.reconnectBtn)
        relinkBtn = findViewById(R.id.relinkBtn)
        toggleSettingsBtn = findViewById(R.id.toggleSettingsBtn)
        logoutBtn = findViewById(R.id.logoutBtn)
        answerBtn = findViewById(R.id.answerBtn)
        hangupBtn = findViewById(R.id.hangupBtn)
        muteBtn = findViewById(R.id.muteBtn)
        speakerBtn = findViewById(R.id.speakerBtn)
    }

    private fun bindActions() {
        scanQrBtn.setOnClickListener { openQrScanner() }
        pairBtn.setOnClickListener {
            syncSettingsInputs(fromConnected = false)
            pairDevice(fromConnectedMode = false)
        }
        saveSettingsPairBtn.setOnClickListener {
            syncSettingsInputs(fromConnected = true)
            pairDevice(fromConnectedMode = true)
        }
        reconnectBtn.setOnClickListener { reconnectBridgeFromSavedSession() }
        relinkBtn.setOnClickListener {
            setBridgeMode(BridgeMode.ONBOARDING)
            settingsSection.visibility = View.GONE
            showTransientStatus("Escanea un nuevo QR o edita los ajustes manuales.", Tone.NEUTRAL)
        }
        toggleSettingsBtn.setOnClickListener {
            settingsSection.visibility = if (settingsSection.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        }
        logoutBtn.setOnClickListener { confirmLogoutAndStop() }
        answerBtn.setOnClickListener { sendServiceAction(BridgeService.ACTION_UI_ANSWER) }
        hangupBtn.setOnClickListener { sendServiceAction(BridgeService.ACTION_UI_HANGUP) }
        muteBtn.setOnClickListener { sendServiceAction(BridgeService.ACTION_UI_TOGGLE_MUTE) }
        speakerBtn.setOnClickListener { sendServiceAction(BridgeService.ACTION_UI_TOGGLE_SPEAKER) }
    }

    private fun hydrateTechnicalInputs() {
        baseUrlIn.setText(defaultBaseUrl)
        settingsBaseUrlIn.setText(defaultBaseUrl)
        deviceNameText.text = buildDeviceName()
        sessionValueText.text = "-"
        serverValueText.text = "Servidor -"
    }

    private fun requestAllPermissions() {
        when {
            !hasPermission(Manifest.permission.READ_PHONE_STATE) ->
                readPhoneLauncher.launch(Manifest.permission.READ_PHONE_STATE)
            !hasPermission(Manifest.permission.CALL_PHONE) ->
                callPhoneLauncher.launch(Manifest.permission.CALL_PHONE)
            !hasPermission(Manifest.permission.ANSWER_PHONE_CALLS) ->
                answerCallLauncher.launch(Manifest.permission.ANSWER_PHONE_CALLS)
            !hasPermission(Manifest.permission.RECORD_AUDIO) ->
                recordAudioLauncher.launch(Manifest.permission.RECORD_AUDIO)
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                !hasPermission(Manifest.permission.POST_NOTIFICATIONS) ->
                notificationsLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            else -> requestDialerRoleIfNeeded()
        }
    }

    private fun requestDialerRoleIfNeeded() {
        if (isDefaultDialer()) {
            refreshReadinessChips()
            autoReconnectIfSaved()
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val rm = getSystemService(RoleManager::class.java)
            if (rm?.isRoleAvailable(RoleManager.ROLE_DIALER) == true) {
                dialerRoleLauncher.launch(rm.createRequestRoleIntent(RoleManager.ROLE_DIALER))
                return
            }
        }
        dialerRoleLauncher.launch(
            Intent(TelecomManager.ACTION_CHANGE_DEFAULT_DIALER).apply {
                putExtra(TelecomManager.EXTRA_CHANGE_DEFAULT_DIALER_PACKAGE_NAME, packageName)
            }
        )
    }

    private fun openQrScanner() {
        if (!hasPermission(Manifest.permission.CAMERA)) {
            cameraLauncher.launch(Manifest.permission.CAMERA)
            return
        }
        launchScanner()
    }

    private fun launchScanner() {
        qrLauncher.launch(ScanOptions().apply {
            setPrompt("Apunta al QR del dashboard")
            setBeepEnabled(true)
            setOrientationLocked(true)
            setCameraId(0)
            setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            setTimeout(40000)
            setBarcodeImageEnabled(false)
        })
    }

    private fun applyQrContent(content: String) {
        try {
            val uri = Uri.parse(content)
            val origin = "${uri.scheme}://${uri.host}${if (uri.port != -1) ":${uri.port}" else ""}"
            val apiBase = uri.getQueryParameter("apiBase")?.trim()?.trimEnd('/') ?: ""
            val code = uri.getQueryParameter("code") ?: ""
            val token = uri.getQueryParameter("token") ?: ""
            val resolvedBase = when {
                apiBase.isNotBlank() -> apiBase
                uri.host.isNullOrBlank() -> ""
                else -> origin
            }
            if (code.isBlank() || token.isBlank() || resolvedBase.isBlank()) {
                showTransientStatus("QR inválido.", Tone.ERROR)
                return
            }
            baseUrlIn.setText(resolvedBase)
            codeIn.setText(code)
            tokenIn.setText(token)
            syncSettingsInputs(fromConnected = false)
            showTransientStatus("QR leído. Vinculando automáticamente…", Tone.SUCCESS)
            pairDevice(fromConnectedMode = false)
        } catch (_: Exception) {
            showTransientStatus("No se pudo leer el QR.", Tone.ERROR)
        }
    }

    private fun pairDevice(fromConnectedMode: Boolean) {
        val baseUrl = activeBaseUrlInput().text?.toString()?.trim()?.trimEnd('/') ?: ""
        val code = activeCodeInput().text?.toString()?.trim()?.uppercase(Locale.US) ?: ""
        val token = activeTokenInput().text?.toString()?.trim() ?: ""
        val deviceId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: "android"
        val deviceName = buildDeviceName()

        if (baseUrl.isBlank() || code.isBlank() || token.isBlank()) {
            showTransientStatus("Completa servidor, código y token.", Tone.WARNING)
            return
        }

        val body = JSONObject()
            .put("code", code)
            .put("token", token)
            .put("deviceId", deviceId)
            .put("deviceName", deviceName)
            .toString()
            .toRequestBody("application/json".toMediaType())

        showTransientStatus("Vinculando equipo…", Tone.NEUTRAL)
        updatePersistentStatus("Conectando al bridge…", "Conectando", Tone.WARNING)
        sessionValueText.text = code
        serverValueText.text = "Servidor ${sanitizeBaseForLabel(baseUrl)}"
        deviceNameText.text = deviceName

        lifecycleScope.launch(Dispatchers.IO) {
            val request = Request.Builder().url("$baseUrl/api/android/pair").post(body).build()
            try {
                val response = client.newCall(request).execute()
                val payload = response.body?.string().orEmpty()
                withContext(Dispatchers.Main) {
                    if (!response.isSuccessful) {
                        updatePersistentStatus("No se pudo vincular el equipo.", "Error", Tone.ERROR)
                        showTransientStatus("Error HTTP ${response.code}", Tone.ERROR)
                        return@withContext
                    }
                    try {
                        val json = JSONObject(payload)
                        if (!json.optBoolean("ok")) {
                            updatePersistentStatus("Respuesta inválida del servidor.", "Error", Tone.ERROR)
                            showTransientStatus("Pairing inválido.", Tone.ERROR)
                            return@withContext
                        }
                        val socketUrl = json.getJSONObject("socket").getString("url")
                        persistManualInputs(baseUrl, code, token)
                        setBridgeMode(BridgeMode.CONNECTED)
                        updatePersistentStatus("Bridge vinculado. Iniciando servicio…", "Activo", Tone.SUCCESS)
                        showTransientStatus("Vinculado correctamente.", Tone.SUCCESS)
                        startBridgeService(socketUrl, code, token, deviceId, deviceName)
                        if (fromConnectedMode) settingsSection.visibility = View.GONE
                    } catch (_: Exception) {
                        updatePersistentStatus("La respuesta del servidor no fue válida.", "Error", Tone.ERROR)
                        showTransientStatus("Respuesta de pairing inválida.", Tone.ERROR)
                    }
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    updatePersistentStatus("Error al conectar con el servidor.", "Error", Tone.ERROR)
                    showTransientStatus("Error de red: ${e.message}", Tone.ERROR)
                }
            }
        }
    }

    private fun startBridgeService(socketUrl: String, code: String, token: String, devId: String, devName: String) {
        val intent = Intent(this, BridgeService::class.java).apply {
            action = BridgeService.ACTION_START
            putExtra(BridgeService.EXTRA_SOCKET_URL, socketUrl)
            putExtra(BridgeService.EXTRA_CODE, code)
            putExtra(BridgeService.EXTRA_TOKEN, token)
            putExtra(BridgeService.EXTRA_DEVICE_ID, devId)
            putExtra(BridgeService.EXTRA_DEVICE_NAME, devName)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun reconnectBridgeFromSavedSession() {
        val prefs = getSharedPreferences(BridgeService.PREFS_NAME, Context.MODE_PRIVATE)
        val url = prefs.getString(BridgeService.PREF_SOCKET_URL, "") ?: ""
        val code = prefs.getString(BridgeService.PREF_CODE, "") ?: ""
        val token = prefs.getString(BridgeService.PREF_TOKEN, "") ?: ""
        val devId = prefs.getString(BridgeService.PREF_DEVICE_ID, "") ?: ""
        val devName = prefs.getString(BridgeService.PREF_DEVICE_NAME, buildDeviceName()) ?: buildDeviceName()
        if (url.isBlank() || code.isBlank() || token.isBlank()) {
            showTransientStatus("No hay una sesión guardada para reconectar.", Tone.WARNING)
            setBridgeMode(BridgeMode.ONBOARDING)
            return
        }
        updatePersistentStatus("Reconectando bridge…", "Conectando", Tone.WARNING)
        showTransientStatus("Restaurando sesión guardada…", Tone.NEUTRAL)
        baseUrlIn.setText(url.substringBefore("/socket"))
        codeIn.setText(code)
        tokenIn.setText(token)
        syncSettingsInputs(fromConnected = false)
        setBridgeMode(BridgeMode.CONNECTED)
        startBridgeService(url, code, token, devId, devName)
    }

    private fun autoReconnectIfSaved() {
        if (autoReconnectAttempted) return
        if (!hasPermission(Manifest.permission.READ_PHONE_STATE) ||
            !hasPermission(Manifest.permission.CALL_PHONE) ||
            !hasPermission(Manifest.permission.RECORD_AUDIO) ||
            !isDefaultDialer()
        ) return
        autoReconnectAttempted = true
        val prefs = getSharedPreferences(BridgeService.PREFS_NAME, Context.MODE_PRIVATE)
        val url = prefs.getString(BridgeService.PREF_SOCKET_URL, "") ?: ""
        val code = prefs.getString(BridgeService.PREF_CODE, "") ?: ""
        val token = prefs.getString(BridgeService.PREF_TOKEN, "") ?: ""
        val devId = prefs.getString(BridgeService.PREF_DEVICE_ID, "") ?: ""
        val devName = prefs.getString(BridgeService.PREF_DEVICE_NAME, buildDeviceName()) ?: buildDeviceName()

        if (url.isBlank() || code.isBlank() || token.isBlank()) {
            setBridgeMode(BridgeMode.ONBOARDING)
            updatePersistentStatus("Bridge no vinculado.", "Sin conexión", Tone.WARNING)
            showTransientStatus("Escanea el QR del dashboard para empezar.", Tone.NEUTRAL)
            return
        }

        baseUrlIn.setText(url.substringBefore("/socket"))
        codeIn.setText(code)
        tokenIn.setText(token)
        syncSettingsInputs(fromConnected = false)
        setBridgeMode(BridgeMode.CONNECTED)
        deviceNameText.text = devName
        sessionValueText.text = code
        serverValueText.text = "Servidor ${sanitizeBaseForLabel(url)}"
        updatePersistentStatus("Restaurando sesión guardada…", "Conectando", Tone.WARNING)
        showTransientStatus("Reconectando sesión guardada…", Tone.NEUTRAL)
        startBridgeService(url, code, token, devId, devName)
    }

    private fun persistManualInputs(baseUrl: String, code: String, token: String) {
        baseUrlIn.setText(baseUrl)
        codeIn.setText(code)
        tokenIn.setText(token)
        settingsBaseUrlIn.setText(baseUrl)
        settingsCodeIn.setText(code)
        settingsTokenIn.setText(token)
    }

    private fun refreshSavedSessionMode() {
        val prefs = getSharedPreferences(BridgeService.PREFS_NAME, Context.MODE_PRIVATE)
        val hasSavedSession = !(prefs.getString(BridgeService.PREF_SOCKET_URL, "") ?: "").isBlank() &&
            !(prefs.getString(BridgeService.PREF_CODE, "") ?: "").isBlank() &&
            !(prefs.getString(BridgeService.PREF_TOKEN, "") ?: "").isBlank()
        setBridgeMode(if (hasSavedSession) BridgeMode.CONNECTED else BridgeMode.ONBOARDING)
    }

    private fun setBridgeMode(mode: BridgeMode) {
        bridgeMode = mode
        onboardingSection.visibility = if (mode == BridgeMode.ONBOARDING) View.VISIBLE else View.GONE
        connectedSection.visibility = if (mode == BridgeMode.CONNECTED) View.VISIBLE else View.GONE
    }

    private fun activeBaseUrlInput(): TextInputEditText =
        if (bridgeMode == BridgeMode.CONNECTED) settingsBaseUrlIn else baseUrlIn

    private fun activeCodeInput(): TextInputEditText =
        if (bridgeMode == BridgeMode.CONNECTED) settingsCodeIn else codeIn

    private fun activeTokenInput(): TextInputEditText =
        if (bridgeMode == BridgeMode.CONNECTED) settingsTokenIn else tokenIn

    private fun syncSettingsInputs(fromConnected: Boolean) {
        if (fromConnected) {
            baseUrlIn.setText(settingsBaseUrlIn.text)
            codeIn.setText(settingsCodeIn.text)
            tokenIn.setText(settingsTokenIn.text)
        } else {
            settingsBaseUrlIn.setText(baseUrlIn.text)
            settingsCodeIn.setText(codeIn.text)
            settingsTokenIn.setText(tokenIn.text)
        }
    }

    private fun renderCallState(intent: Intent) {
        currentPhoneNumber = intent.getStringExtra(BridgeService.EXTRA_PHONE_NUMBER).orEmpty()
        currentContactName = intent.getStringExtra(BridgeService.EXTRA_CONTACT_NAME).orEmpty()
        currentCompanyName = intent.getStringExtra(BridgeService.EXTRA_COMPANY_NAME).orEmpty()
        lastCallState = intent.getStringExtra(BridgeService.EXTRA_CALL_STATE).orEmpty().ifBlank { "idle" }
        isMicMuted = intent.getBooleanExtra(BridgeService.EXTRA_MIC_MUTED, false)
        isSpeakerOn = intent.getBooleanExtra(BridgeService.EXTRA_SPEAKER_ON, false)

        if (lastCallState == "in_call") {
            if (callStartedAt == null) callStartedAt = System.currentTimeMillis()
            timerHandler.removeCallbacks(timerRunnable)
            timerHandler.post(timerRunnable)
        } else if (lastCallState == "idle" || lastCallState == "ended") {
            callStartedAt = null
            timerHandler.removeCallbacks(timerRunnable)
        }

        renderCallPresentation()
    }

    private fun renderCallPresentation() {
        val primaryName = when {
            currentContactName.isNotBlank() -> currentContactName
            currentCompanyName.isNotBlank() -> currentCompanyName
            currentPhoneNumber.isNotBlank() -> currentPhoneNumber
            else -> "Bridge listo"
        }

        currentCallNameText.text = primaryName
        currentCallNumberText.text = if (currentPhoneNumber.isBlank()) "-" else currentPhoneNumber
        currentCallLabelText.text = when (lastCallState) {
            "ringing" -> "Llamada entrante"
            "dialing" -> "Marcando desde el bridge"
            "in_call" -> "Llamada en curso"
            "ended" -> "Llamada finalizada"
            else -> "Sin llamada activa"
        }
        callStateText.text = when (lastCallState) {
            "ringing" -> "SONANDO"
            "dialing" -> "LLAMANDO"
            "in_call" -> "EN LLAMADA"
            "ended" -> "FINALIZADA"
            else -> "LISTO"
        }
        applyToneToChip(callStateText, when (lastCallState) {
            "in_call" -> Tone.SUCCESS
            "ringing", "dialing" -> Tone.WARNING
            "ended" -> Tone.ERROR
            else -> Tone.NEUTRAL
        })

        callTimerText.text = formatElapsed()
        answerBtn.visibility = if (lastCallState == "ringing") View.VISIBLE else View.GONE
        applyControlStyles()
    }

    private fun applyControlStyles() {
        muteBtn.text = if (isMicMuted) "Micrófono OFF" else "Micrófono ON"
        speakerBtn.text = if (isSpeakerOn) "Altavoz ON" else "Altavoz OFF"
        muteBtn.background = ContextCompat.getDrawable(
            this,
            if (isMicMuted) R.drawable.bg_danger_button else R.drawable.bg_secondary_button
        )
        muteBtn.setTextColor(
            ContextCompat.getColor(this, if (isMicMuted) R.color.vc_text_inverse else R.color.vc_text_primary)
        )
        speakerBtn.background = ContextCompat.getDrawable(
            this,
            if (isSpeakerOn) R.drawable.bg_success_button else R.drawable.bg_secondary_button
        )
        speakerBtn.setTextColor(
            ContextCompat.getColor(this, if (isSpeakerOn) R.color.vc_text_inverse else R.color.vc_text_primary)
        )
    }

    private fun consumeServiceStatusMessage(msg: String) {
        val normalized = msg.lowercase(Locale.US)
        transientStatusMessage = msg
        when {
            normalized.contains("activo") && normalized.contains("esperando") -> {
                updatePersistentStatus("Bridge conectado y esperando llamadas.", "Activo", Tone.SUCCESS)
            }
            normalized.contains("conectando") || normalized.contains("reconectando") -> {
                updatePersistentStatus("Bridge conectando con el servidor.", "Conectando", Tone.WARNING)
            }
            normalized.contains("error") || normalized.contains("inválid") || normalized.contains("invalido") -> {
                updatePersistentStatus("Hay un problema con la sesión o el servidor.", "Error", Tone.ERROR)
            }
            normalized.contains("marcador default") || normalized.contains("dialer") -> {
                updatePersistentStatus("Bridge conectado con limitaciones del marcador.", "Atención", Tone.WARNING)
            }
        }
        renderTransientStatus()
        refreshReadinessChips()
    }

    private fun updatePersistentStatus(message: String, badge: String, tone: Tone) {
        currentPersistentStatus = message
        currentConnectionBadge = badge
        currentConnectionTone = tone
        renderPersistentStatus()
    }

    private fun renderPersistentStatus() {
        persistentStatusText.text = currentPersistentStatus
        connectionBadgeText.text = currentConnectionBadge
        applyToneToChip(connectionBadgeText, currentConnectionTone)
    }

    private fun renderTransientStatus() {
        transientStatusText.text = transientStatusMessage
        onboardingStatusText.text = transientStatusMessage
    }

    private fun refreshReadinessChips() {
        updateReadinessChip(
            permMicChip,
            "Mic",
            hasPermission(Manifest.permission.RECORD_AUDIO),
            "Mic OK",
            "Sin mic"
        )
        val notificationsOk = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            hasPermission(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            true
        }
        updateReadinessChip(
            permNotifChip,
            "Notif",
            notificationsOk,
            "Notif OK",
            "Sin notif"
        )
        updateReadinessChip(
            permDialerChip,
            "Dialer",
            isDefaultDialer(),
            "Dialer OK",
            "Sin default"
        )
    }

    private fun updateReadinessChip(
        chip: TextView,
        fallbackLabel: String,
        isReady: Boolean,
        readyLabel: String,
        warningLabel: String
    ) {
        chip.text = if (isReady) readyLabel else warningLabel.ifBlank { fallbackLabel }
        applyToneToChip(chip, if (isReady) Tone.SUCCESS else Tone.WARNING)
    }

    private fun applyToneToChip(view: TextView, tone: Tone) {
        val bg = when (tone) {
            Tone.SUCCESS -> R.drawable.bg_status_success
            Tone.WARNING -> R.drawable.bg_status_warning
            Tone.ERROR -> R.drawable.bg_status_error
            Tone.NEUTRAL -> R.drawable.bg_state_chip
        }
        val color = when (tone) {
            Tone.SUCCESS -> R.color.vc_success
            Tone.WARNING -> R.color.vc_warning
            Tone.ERROR -> R.color.vc_error
            Tone.NEUTRAL -> R.color.vc_text_secondary
        }
        view.background = ContextCompat.getDrawable(this, bg)
        view.setTextColor(ContextCompat.getColor(this, color))
    }

    private fun formatElapsed(): String {
        val started = callStartedAt ?: return "00:00"
        val sec = ((System.currentTimeMillis() - started) / 1000L).toInt().coerceAtLeast(0)
        val mm = sec / 60
        val ss = sec % 60
        return String.format(Locale.US, "%02d:%02d", mm, ss)
    }

    private fun sanitizeBaseForLabel(value: String): String =
        value.removePrefix("https://").removePrefix("http://")

    private fun buildDeviceName(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()

    private fun sendServiceAction(action: String) {
        val intent = Intent(this, BridgeService::class.java).apply { this.action = action }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun isDefaultDialer(): Boolean =
        (getSystemService(TELECOM_SERVICE) as? TelecomManager)?.defaultDialerPackage == packageName

    private fun showTransientStatus(message: String, tone: Tone) {
        transientStatusMessage = message
        transientStatusText.text = message
        onboardingStatusText.text = message
        transientStatusText.background = ContextCompat.getDrawable(
            this,
            when (tone) {
                Tone.SUCCESS -> R.drawable.bg_status_success
                Tone.WARNING -> R.drawable.bg_status_warning
                Tone.ERROR -> R.drawable.bg_status_error
                Tone.NEUTRAL -> R.drawable.bg_secondary_card
            }
        )
        transientStatusText.setTextColor(
            ContextCompat.getColor(
                this,
                when (tone) {
                    Tone.SUCCESS -> R.color.vc_success
                    Tone.WARNING -> R.color.vc_warning
                    Tone.ERROR -> R.color.vc_error
                    Tone.NEUTRAL -> R.color.vc_text_secondary
                }
            )
        )
        onboardingStatusText.background = transientStatusText.background?.constantState?.newDrawable()?.mutate()
        onboardingStatusText.setTextColor(transientStatusText.currentTextColor)
    }

    private fun confirmLogoutAndStop() {
        AlertDialog.Builder(this)
            .setTitle("Cerrar sesión")
            .setMessage("Se detendrá el bridge y volverás al modo de vinculación.")
            .setNegativeButton("Cancelar", null)
            .setPositiveButton("Cerrar") { _, _ ->
                sendServiceAction(BridgeService.ACTION_LOGOUT)
                setBridgeMode(BridgeMode.ONBOARDING)
                settingsSection.visibility = View.GONE
                callStartedAt = null
                currentPhoneNumber = ""
                currentContactName = ""
                currentCompanyName = ""
                lastCallState = "idle"
                renderCallPresentation()
                updatePersistentStatus("Bridge no vinculado.", "Sin conexión", Tone.WARNING)
                showTransientStatus("Sesión cerrada. Escanea un QR para volver a conectar.", Tone.NEUTRAL)
            }
            .show()
    }
}
