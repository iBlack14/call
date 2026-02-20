package com.kenia.bridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

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
