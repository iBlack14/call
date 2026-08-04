package com.voipvc.bridge

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * Auto-starts BridgeService after device reboot.
 * Reads saved credentials from SharedPreferences — no user interaction needed.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != "android.intent.action.QUICKBOOT_POWERON") return

        val prefs   = context.getSharedPreferences(BridgeService.PREFS_NAME, Context.MODE_PRIVATE)
        val url     = prefs.getString(BridgeService.PREF_SOCKET_URL,   "") ?: ""
        val code    = prefs.getString(BridgeService.PREF_CODE,         "") ?: ""
        val token   = prefs.getString(BridgeService.PREF_TOKEN,        "") ?: ""
        val devId   = prefs.getString(BridgeService.PREF_DEVICE_ID,    "") ?: ""
        val devName = prefs.getString(BridgeService.PREF_DEVICE_NAME,  "") ?: ""

        if (url.isBlank() || code.isBlank() || token.isBlank()) return

        // Android 14+ forbids starting a microphone foreground service from
        // BOOT_COMPLETED. Ask for one explicit tap instead of entering a crash
        // loop that repeatedly disconnects/reconnects the bridge.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val manager = context.getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(
                NotificationChannel(
                    BridgeService.CHANNEL_ID,
                    "Phone-VC Bridge",
                    NotificationManager.IMPORTANCE_HIGH
                )
            )
            val openApp = PendingIntent.getActivity(
                context,
                4,
                Intent(context, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            manager?.notify(
                9203,
                NotificationCompat.Builder(context, BridgeService.CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.ic_menu_call)
                    .setContentTitle("Phone-VC listo para reconectar")
                    .setContentText("Toca para activar el bridge después del reinicio")
                    .setContentIntent(openApp)
                    .setAutoCancel(true)
                    .build()
            )
            return
        }

        val si = Intent(context, BridgeService::class.java).apply {
            this.action = BridgeService.ACTION_START
            putExtra(BridgeService.EXTRA_SOCKET_URL,  url)
            putExtra(BridgeService.EXTRA_CODE,        code)
            putExtra(BridgeService.EXTRA_TOKEN,       token)
            putExtra(BridgeService.EXTRA_DEVICE_ID,   devId)
            putExtra(BridgeService.EXTRA_DEVICE_NAME, devName)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            context.startForegroundService(si)
        else
            context.startService(si)
    }
}
