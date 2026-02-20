package com.kenia.bridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.ColorStateList
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

class IncomingCallActivity : AppCompatActivity() {

    private lateinit var companyImage: ImageView
    private lateinit var companyName: TextView
    private lateinit var phoneNumber: TextView
    private lateinit var callState: TextView
    private lateinit var callTimer: TextView
    private lateinit var micBtn: MaterialButton
    private lateinit var speakerBtn: MaterialButton
    private lateinit var hangupBtn: MaterialButton

    private var imageUrl: String = ""
    private var callStartedAt: Long? = null
    private val timerHandler = Handler(Looper.getMainLooper())
    private val timerRunnable = object : Runnable {
        override fun run() {
            val started = callStartedAt ?: return
            val sec = ((System.currentTimeMillis() - started) / 1000L).toInt().coerceAtLeast(0)
            val mm = sec / 60
            val ss = sec % 60
            callTimer.text = String.format(Locale.US, "%02d:%02d", mm, ss)
            timerHandler.postDelayed(this, 1000L)
        }
    }

    private val uiReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == BridgeService.ACTION_CLOSE_CALL_UI) {
                finish()
                return
            }
            if (intent?.action != BridgeService.ACTION_CALL_UI_STATE) return
            renderFromIntent(intent)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_incoming_call)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }

        companyImage = findViewById(R.id.companyImage)
        companyName = findViewById(R.id.companyNameText)
        phoneNumber = findViewById(R.id.phoneNumberText)
        callState = findViewById(R.id.callStateText)
        callTimer = findViewById(R.id.callTimerText)
        micBtn = findViewById(R.id.micButton)
        speakerBtn = findViewById(R.id.speakerButton)
        hangupBtn = findViewById(R.id.hangupButton)

        micBtn.setOnClickListener { sendServiceAction(BridgeService.ACTION_UI_TOGGLE_MUTE) }
        speakerBtn.setOnClickListener { sendServiceAction(BridgeService.ACTION_UI_TOGGLE_SPEAKER) }
        hangupBtn.setOnClickListener { sendServiceAction(BridgeService.ACTION_UI_HANGUP) }

        renderFromIntent(intent)
        sendServiceAction(BridgeService.ACTION_UI_SYNC)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        renderFromIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        val filter = IntentFilter().apply {
            addAction(BridgeService.ACTION_CALL_UI_STATE)
            addAction(BridgeService.ACTION_CLOSE_CALL_UI)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(uiReceiver, filter, RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(uiReceiver, filter)
        }
    }

    override fun onStop() {
        super.onStop()
        unregisterReceiver(uiReceiver)
        timerHandler.removeCallbacks(timerRunnable)
    }

    private fun sendServiceAction(action: String) {
        val i = Intent(this, BridgeService::class.java).apply { this.action = action }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(i)
        } else {
            startService(i)
        }
    }

    private fun renderFromIntent(data: Intent) {
        val number = data.getStringExtra(BridgeService.EXTRA_PHONE_NUMBER).orEmpty()
        val company = data.getStringExtra(BridgeService.EXTRA_COMPANY_NAME).orEmpty()
        val contact = data.getStringExtra(BridgeService.EXTRA_CONTACT_NAME).orEmpty()
        val state = data.getStringExtra(BridgeService.EXTRA_CALL_STATE).orEmpty()
        val micMuted = data.getBooleanExtra(BridgeService.EXTRA_MIC_MUTED, false)
        val speakerOn = data.getBooleanExtra(BridgeService.EXTRA_SPEAKER_ON, false)
        val img = data.getStringExtra(BridgeService.EXTRA_IMAGE_URL).orEmpty()

        companyName.text = when {
            contact.isNotBlank() -> contact
            company.isNotBlank() -> company
            number.isNotBlank() -> number
            else -> "Contacto"
        }
        phoneNumber.text = if (number.isBlank()) "-" else number
        callState.text = when (state) {
            "dialing" -> "LLAMANDO..."
            "in_call" -> "EN LLAMADA"
            "ringing" -> "SONANDO"
            "ended" -> "FINALIZADA"
            "idle" -> "ESPERA"
            else -> "LLAMANDO..."
        }

        if (state == "in_call") {
            if (callStartedAt == null) callStartedAt = System.currentTimeMillis()
            timerHandler.removeCallbacks(timerRunnable)
            timerHandler.post(timerRunnable)
        } else {
            callStartedAt = null
            timerHandler.removeCallbacks(timerRunnable)
            callTimer.text = "00:00"
        }

        micBtn.text = if (micMuted) "🔇 Micrófono OFF" else "🎙️ Micrófono ON"
        speakerBtn.text = if (speakerOn) "🔊 Altavoz ON" else "🔈 Altavoz OFF"
        applyToggleStyles(micMuted, speakerOn)

        if (img.isNotBlank() && img != imageUrl) {
            imageUrl = img
            loadImage(img)
        }

        if (state == "idle" || state == "ended") finish()
    }

    private fun applyToggleStyles(micMuted: Boolean, speakerOn: Boolean) {
        // Mic: rojo cuando está muteado, verde cuando está activo.
        micBtn.backgroundTintList = ColorStateList.valueOf(
            if (micMuted) 0xFFBE123C.toInt() else 0xFF166534.toInt()
        )
        micBtn.setTextColor(0xFFFFFFFF.toInt())

        // Speaker: verde cuando ON, gris oscuro cuando OFF.
        speakerBtn.backgroundTintList = ColorStateList.valueOf(
            if (speakerOn) 0xFF15803D.toInt() else 0xFF1E293B.toInt()
        )
        speakerBtn.setTextColor(0xFFFFFFFF.toInt())
    }

    private fun loadImage(url: String) {
        Thread {
            try {
                val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 5000
                    readTimeout = 5000
                    doInput = true
                }
                conn.inputStream.use { stream ->
                    val bmp = BitmapFactory.decodeStream(stream)
                    if (bmp != null) runOnUiThread { companyImage.setImageBitmap(bmp) }
                }
                conn.disconnect()
            } catch (_: Exception) {
                // Keep default drawable when remote image is unavailable.
            }
        }.start()
    }
}
