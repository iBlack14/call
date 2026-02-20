package com.kenia.bridge

import android.Manifest
import android.app.role.RoleManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.telecom.TelecomManager
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException

/**
 * Simple single-screen activity.
 * On open:  auto-requests all permissions in sequence.
 * On pair:  scans QR or accepts manual input → starts BridgeService.
 * After pair: the service runs forever in background; this screen just shows status.
 */
class MainActivity : AppCompatActivity() {

    private val defaultBaseUrl = "https://crooked-fanny-principally.ngrok-free.dev"

    private lateinit var statusText : TextView
    private lateinit var baseUrlIn  : TextInputEditText
    private lateinit var codeIn     : TextInputEditText
    private lateinit var tokenIn    : TextInputEditText

    private val client = OkHttpClient()

    // ── Permission launchers (chain: camera → call → answer → record → dialer) ──

    private val recordAudioLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        setStatus(if (granted) "✅ Micrófono concedido — listo para llamadas de audio" else "⚠️ Micrófono denegado (audio puente no disponible)")
        // Next step: notifications permission (Android 13+), then dialer role
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !hasPermission(Manifest.permission.POST_NOTIFICATIONS)) {
            notificationsLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            requestDialerRoleIfNeeded()
        }
    }

    private val notificationsLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        setStatus(if (granted) "✅ Notificaciones activas" else "⚠️ Notificaciones denegadas (fallback de llamada puede no mostrarse)")
        requestDialerRoleIfNeeded()
    }

    private val answerCallLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ ->
        // Continue chain → RECORD_AUDIO
        if (!hasPermission(Manifest.permission.RECORD_AUDIO))
            recordAudioLauncher.launch(Manifest.permission.RECORD_AUDIO)
        else requestDialerRoleIfNeeded()
    }

    private val callPhoneLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ ->
        // Continue chain → ANSWER_PHONE_CALLS
        if (!hasPermission(Manifest.permission.ANSWER_PHONE_CALLS))
            answerCallLauncher.launch(Manifest.permission.ANSWER_PHONE_CALLS)
        else recordAudioLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }

    private val readPhoneLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ ->
        // Continue chain → CALL_PHONE
        if (!hasPermission(Manifest.permission.CALL_PHONE))
            callPhoneLauncher.launch(Manifest.permission.CALL_PHONE)
        else answerCallLauncher.launch(Manifest.permission.ANSWER_PHONE_CALLS)
    }

    private val cameraLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) launchScanner()
        else setStatus("⚠️ Cámara denegada — ingresa el código manualmente")
    }

    private val dialerRoleLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        setStatus(if (isDefaultDialer()) "✅ Todo listo — puedes escanear el QR o ingresar código" else "⚠️ No es dialer default — colgar remoto limitado")
    }

    private val qrLauncher = registerForActivityResult(ScanContract()) { result ->
        val content = result.contents ?: return@registerForActivityResult
        applyQrContent(content)
    }

    // ── Status broadcast from BridgeService ───────────────────────────────────

    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val msg = intent?.getStringExtra(BridgeService.EXTRA_STATUS_MESSAGE) ?: return
            setStatus(msg)
        }
    }

    // ── LIFECYCLE ─────────────────────────────────────────────────────────────

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusText = findViewById(R.id.statusText)
        baseUrlIn  = findViewById(R.id.baseUrlInput)
        codeIn     = findViewById(R.id.codeInput)
        tokenIn    = findViewById(R.id.tokenInput)

        baseUrlIn.setText(defaultBaseUrl)

        // Buttons
        findViewById<MaterialButton>(R.id.scanQrBtn)?.setOnClickListener { openQrScanner() }
        findViewById<MaterialButton>(R.id.pairBtn)?.setOnClickListener   { pairDevice() }

        // Hide buttons that no longer exist in the simple layout (graceful no-op)
        tryHide(R.id.enableHangupBtn)
        tryHide(R.id.sendIdleBtn)

        // Auto-reconnect if we already have saved credentials
        autoReconnectIfSaved()

        // Start permissions chain on first launch
        requestAllPermissions()
    }

    override fun onStart() {
        super.onStart()
        val filter = IntentFilter(BridgeService.ACTION_STATUS)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            registerReceiver(statusReceiver, filter, RECEIVER_NOT_EXPORTED)
        else
            @Suppress("DEPRECATION") registerReceiver(statusReceiver, filter)
    }

    override fun onStop() {
        super.onStop()
        unregisterReceiver(statusReceiver)
    }

    // ── PERMISSIONS (auto-chain, no manual buttons needed) ───────────────────

    private fun requestAllPermissions() {
        when {
            !hasPermission(Manifest.permission.READ_PHONE_STATE)  ->
                readPhoneLauncher.launch(Manifest.permission.READ_PHONE_STATE)
            !hasPermission(Manifest.permission.CALL_PHONE)        ->
                callPhoneLauncher.launch(Manifest.permission.CALL_PHONE)
            !hasPermission(Manifest.permission.ANSWER_PHONE_CALLS)->
                answerCallLauncher.launch(Manifest.permission.ANSWER_PHONE_CALLS)
            !hasPermission(Manifest.permission.RECORD_AUDIO)      ->
                recordAudioLauncher.launch(Manifest.permission.RECORD_AUDIO)
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !hasPermission(Manifest.permission.POST_NOTIFICATIONS) ->
                notificationsLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            else -> requestDialerRoleIfNeeded()
        }
    }

    private fun requestDialerRoleIfNeeded() {
        if (isDefaultDialer()) {
            setStatus("✅ Todo listo — escanea el QR del dashboard")
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

    // ── QR SCANNER ────────────────────────────────────────────────────────────

    private fun openQrScanner() {
        if (!hasPermission(Manifest.permission.CAMERA)) {
            cameraLauncher.launch(Manifest.permission.CAMERA); return
        }
        launchScanner()
    }

    private fun launchScanner() {
        qrLauncher.launch(ScanOptions().apply {
            setPrompt("📷 Apunta al QR del dashboard\n(mantén a 15–25 cm de distancia)")
            setBeepEnabled(true)             // beep cuando lo lea
            setOrientationLocked(true)       // vertical / portrait
            setCameraId(0)                   // cámara trasera
            setDesiredBarcodeFormats(ScanOptions.QR_CODE)  // solo QR → enfoca más rápido
            setTimeout(40000)                // 40 segundos de tiempo máximo
            setBarcodeImageEnabled(false)
        })
    }


    private fun applyQrContent(content: String) {
        try {
            val uri    = Uri.parse(content)
            val origin = "${uri.scheme}://${uri.host}${if (uri.port != -1) ":${uri.port}" else ""}"
            val code   = uri.getQueryParameter("code")  ?: ""
            val token  = uri.getQueryParameter("token") ?: ""
            if (code.isBlank() || token.isBlank() || uri.host.isNullOrBlank()) {
                setStatus("QR inválido"); return
            }
            baseUrlIn.setText(origin)
            codeIn.setText(code)
            tokenIn.setText(token)
            setStatus("QR cargado — vinculando automáticamente…")
            pairDevice() // auto-pair immediately after scan
        } catch (_: Exception) { setStatus("No se pudo leer el QR") }
    }

    // ── PAIRING ───────────────────────────────────────────────────────────────

    private fun pairDevice() {
        val baseUrl    = baseUrlIn.text?.toString()?.trim()?.trimEnd('/') ?: ""
        val code       = codeIn.text?.toString()?.trim()?.uppercase() ?: ""
        val token      = tokenIn.text?.toString()?.trim() ?: ""
        val deviceId   = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: "android"
        val deviceName = "${Build.MANUFACTURER} ${Build.MODEL}".trim()

        if (baseUrl.isBlank() || code.isBlank() || token.isBlank()) {
            setStatus("Completa URL, código y token"); return
        }

        val body = JSONObject()
            .put("code", code).put("token", token)
            .put("deviceId", deviceId).put("deviceName", deviceName)
            .toString().toRequestBody("application/json".toMediaType())

        setStatus("Vinculando…")
        client.newCall(Request.Builder().url("$baseUrl/api/android/pair").post(body).build())
            .enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) =
                    runOnUiThread { setStatus("Error de red: ${e.message}") }

                override fun onResponse(call: Call, response: Response) {
                    val payload = response.body?.string().orEmpty()
                    runOnUiThread {
                        if (!response.isSuccessful) { setStatus("Error HTTP ${response.code}"); return@runOnUiThread }
                        try {
                            val json = JSONObject(payload)
                            if (!json.optBoolean("ok")) { setStatus("Pairing inválido"); return@runOnUiThread }
                            val socketUrl = json.getJSONObject("socket").getString("url")
                            setStatus("✅ Vinculado — servicio iniciando en segundo plano")
                            startBridgeService(socketUrl, code, token, deviceId, deviceName)
                        } catch (_: Exception) { setStatus("Respuesta de pairing inválida") }
                    }
                }
            })
    }

    private fun startBridgeService(socketUrl: String, code: String, token: String, devId: String, devName: String) {
        val si = Intent(this, BridgeService::class.java).apply {
            action = BridgeService.ACTION_START
            putExtra(BridgeService.EXTRA_SOCKET_URL,  socketUrl)
            putExtra(BridgeService.EXTRA_CODE,        code)
            putExtra(BridgeService.EXTRA_TOKEN,       token)
            putExtra(BridgeService.EXTRA_DEVICE_ID,   devId)
            putExtra(BridgeService.EXTRA_DEVICE_NAME, devName)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            startForegroundService(si)
        else
            startService(si)
    }

    // ── AUTO-RECONNECT ────────────────────────────────────────────────────────

    private fun autoReconnectIfSaved() {
        val prefs   = getSharedPreferences(BridgeService.PREFS_NAME, Context.MODE_PRIVATE)
        val url     = prefs.getString(BridgeService.PREF_SOCKET_URL,  "") ?: ""
        val code    = prefs.getString(BridgeService.PREF_CODE,        "") ?: ""
        val token   = prefs.getString(BridgeService.PREF_TOKEN,       "") ?: ""
        val devId   = prefs.getString(BridgeService.PREF_DEVICE_ID,   "") ?: ""
        val devName = prefs.getString(BridgeService.PREF_DEVICE_NAME, "") ?: ""

        if (url.isBlank() || code.isBlank() || token.isBlank()) {
            setStatus("Escanea el QR del dashboard para vincular")
            return
        }

        // Restore inputs so user can see the saved session
        baseUrlIn.setText(url.substringBefore("/socket"))
        codeIn.setText(code)
        tokenIn.setText(token)

        setStatus("Reconectando sesión guardada…")
        startBridgeService(url, code, token, devId, devName)
    }

    // ── HELPERS ───────────────────────────────────────────────────────────────

    private fun hasPermission(p: String) =
        ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun isDefaultDialer() =
        (getSystemService(TELECOM_SERVICE) as? TelecomManager)?.defaultDialerPackage == packageName

    private fun setStatus(msg: String) { statusText.text = msg }

    private fun tryHide(id: Int) {
        try { findViewById<android.view.View>(id)?.visibility = android.view.View.GONE } catch (_: Exception) {}
    }
}
