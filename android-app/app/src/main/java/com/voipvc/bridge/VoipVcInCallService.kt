package com.voipvc.bridge

import android.content.Intent
import android.telecom.Call
import android.telecom.InCallService
import android.telecom.VideoProfile
import android.util.Log

class VoipVcInCallService : InCallService() {
    companion object {
        private const val TAG = "VoipVcInCallService"

        @Volatile
        private var activeService: VoipVcInCallService? = null

        fun answerRingingCall(): Boolean {
            val service = activeService ?: return false
            val ringingCall = service.calls.firstOrNull { it.state == Call.STATE_RINGING } ?: return false
            return try {
                ringingCall.answer(VideoProfile.STATE_AUDIO_ONLY)
                true
            } catch (e: Exception) {
                Log.w(TAG, "Failed to answer incoming call: ${e.message}")
                false
            }
        }
    }

    private val callbacks = mutableMapOf<Call, Call.Callback>()

    override fun onCreate() {
        super.onCreate()
        activeService = this
    }

    override fun onDestroy() {
        if (activeService === this) activeService = null
        super.onDestroy()
    }

    override fun onCallAdded(call: Call) {
        super.onCallAdded(call)
        val cb = object : Call.Callback() {
            override fun onStateChanged(call: Call, state: Int) {
                broadcastAggregateState()
            }
        }
        callbacks[call] = cb
        call.registerCallback(cb)
        broadcastAggregateState()
    }

    override fun onCallRemoved(call: Call) {
        callbacks.remove(call)?.let { call.unregisterCallback(it) }
        broadcastAggregateState()
        super.onCallRemoved(call)
    }

    private fun mapCallState(state: Int): String = when (state) {
        Call.STATE_ACTIVE, Call.STATE_HOLDING -> "in_call"
        Call.STATE_RINGING -> "ringing"
        Call.STATE_DIALING, Call.STATE_CONNECTING, Call.STATE_SELECT_PHONE_ACCOUNT, Call.STATE_NEW -> "dialing"
        Call.STATE_DISCONNECTED, Call.STATE_DISCONNECTING -> "ended"
        else -> "idle"
    }

    private fun broadcastAggregateState() {
        val activeCall = calls.firstOrNull { mapCallState(it.state) == "in_call" }
        val ringingCall = calls.firstOrNull { mapCallState(it.state) == "ringing" }
        val dialingCall = calls.firstOrNull { mapCallState(it.state) == "dialing" }
        val endedCall = calls.firstOrNull { mapCallState(it.state) == "ended" }

        val primaryCall = activeCall ?: ringingCall ?: dialingCall ?: endedCall
        val mapped = when {
            activeCall != null -> "in_call"
            ringingCall != null -> "ringing"
            dialingCall != null -> "dialing"
            endedCall != null -> "ended"
            else -> "idle"
        }

        val number = primaryCall?.details?.handle?.schemeSpecificPart.orEmpty()
        val callerName = primaryCall?.details?.callerDisplayName?.toString()?.trim().orEmpty()
        val contactName = primaryCall?.details?.contactDisplayName?.toString()?.trim().orEmpty()
        val bestName = contactName.ifBlank { callerName }

        sendBroadcast(
            Intent(BridgeService.ACTION_TELECOM_CALL_STATE)
                .setPackage(packageName)
                .putExtra(BridgeService.EXTRA_CALL_STATE, mapped)
                .putExtra(BridgeService.EXTRA_PHONE_NUMBER, number)
                .putExtra(BridgeService.EXTRA_CONTACT_NAME, bestName)
        )
    }
}
