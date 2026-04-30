package com.voipvc.bridge

import android.os.Bundle
import com.google.zxing.client.android.R as ZxingR
import com.journeyapps.barcodescanner.CaptureManager
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.journeyapps.barcodescanner.Size
import com.journeyapps.barcodescanner.camera.CameraSettings

class QrCaptureActivity : androidx.activity.ComponentActivity() {
    private lateinit var barcodeScannerView: DecoratedBarcodeView
    private lateinit var captureManager: CaptureManager

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(ZxingR.layout.zxing_capture)

        barcodeScannerView = findViewById(ZxingR.id.zxing_barcode_scanner)

        // SurfaceView usually looks sharper than TextureView on lower-end devices.
        barcodeScannerView.barcodeView.setUseTextureView(false)
        barcodeScannerView.barcodeView.setFramingRectSize(Size(900, 900))
        barcodeScannerView.barcodeView.setMarginFraction(0.08)
        barcodeScannerView.cameraSettings = CameraSettings().apply {
            setRequestedCameraId(0)
            setAutoFocusEnabled(true)
            setContinuousFocusEnabled(true)
            setMeteringEnabled(true)
            setBarcodeSceneModeEnabled(true)
        }

        captureManager = CaptureManager(this, barcodeScannerView)
        captureManager.initializeFromIntent(intent, savedInstanceState)

        // Re-apply after intent initialization so the library defaults don't override us.
        barcodeScannerView.cameraSettings = CameraSettings().apply {
            setRequestedCameraId(0)
            setAutoFocusEnabled(true)
            setContinuousFocusEnabled(true)
            setMeteringEnabled(true)
            setBarcodeSceneModeEnabled(true)
        }

        captureManager.decode()
    }

    override fun onResume() {
        super.onResume()
        captureManager.onResume()
    }

    override fun onPause() {
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
        captureManager.onRequestPermissionsResult(requestCode, permissions, grantResults)
    }
}
