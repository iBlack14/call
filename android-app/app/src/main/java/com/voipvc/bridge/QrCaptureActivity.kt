package com.voipvc.bridge

import android.os.Bundle
import android.os.SystemClock
import android.view.MotionEvent
import android.widget.TextView
import com.google.android.material.button.MaterialButton
import com.journeyapps.barcodescanner.CaptureManager
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.journeyapps.barcodescanner.Size
import com.journeyapps.barcodescanner.camera.CameraSettings

class QrCaptureActivity : androidx.activity.ComponentActivity() {
    private lateinit var barcodeScannerView: DecoratedBarcodeView
    private lateinit var captureManager: CaptureManager
    private lateinit var hintText: TextView
    private lateinit var focusButton: MaterialButton
    private lateinit var torchButton: MaterialButton
    private var torchEnabled = false
    private var lastFocusRequestAt = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_qr_capture)

        barcodeScannerView = findViewById(R.id.qrScannerView)
        hintText = findViewById(R.id.qrScannerHint)
        focusButton = findViewById(R.id.qrFocusBtn)
        torchButton = findViewById(R.id.qrTorchBtn)

        // SurfaceView looks sharper on many low/mid-range Android devices.
        barcodeScannerView.barcodeView.setUseTextureView(false)
        barcodeScannerView.barcodeView.setFramingRectSize(Size(720, 720))
        barcodeScannerView.barcodeView.setMarginFraction(0.12)
        applyCameraSettings()

        captureManager = CaptureManager(this, barcodeScannerView)
        captureManager.initializeFromIntent(intent, savedInstanceState)
        applyCameraSettings()

        focusButton.setOnClickListener { requestFreshFocus() }
        torchButton.setOnClickListener { toggleTorch() }
        barcodeScannerView.setOnTouchListener { _, event ->
            if (event.action == MotionEvent.ACTION_UP) requestFreshFocus()
            true
        }

        captureManager.decode()
    }

    private fun applyCameraSettings() {
        barcodeScannerView.cameraSettings = CameraSettings().apply {
            setRequestedCameraId(0)
            setAutoFocusEnabled(true)
            setContinuousFocusEnabled(true)
            setMeteringEnabled(true)
            setBarcodeSceneModeEnabled(true)
            setExposureEnabled(true)
        }
    }

    private fun requestFreshFocus() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastFocusRequestAt < 900L) return
        lastFocusRequestAt = now

        hintText.text = "Enfocando… mantén el QR dentro del recuadro."
        barcodeScannerView.pause()
        applyCameraSettings()
        barcodeScannerView.postDelayed({
            barcodeScannerView.resume()
            if (torchEnabled) barcodeScannerView.setTorchOn()
            hintText.text = "Listo. Acerca o aleja lentamente si aún se ve borroso."
        }, 180L)
    }

    private fun toggleTorch() {
        torchEnabled = !torchEnabled
        if (torchEnabled) {
            barcodeScannerView.setTorchOn()
            torchButton.text = "Apagar luz"
        } else {
            barcodeScannerView.setTorchOff()
            torchButton.text = "Linterna"
        }
    }

    override fun onResume() {
        super.onResume()
        captureManager.onResume()
    }

    override fun onPause() {
        if (torchEnabled) barcodeScannerView.setTorchOff()
        super.onPause()
        captureManager.onPause()
    }

    override fun onDestroy() {
        super.onDestroy()
        captureManager.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        captureManager.onSaveInstanceState(outState)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        captureManager.onRequestPermissionsResult(requestCode, permissions, grantResults)
    }
}
