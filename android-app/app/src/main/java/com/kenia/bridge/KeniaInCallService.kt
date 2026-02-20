package com.kenia.bridge

import android.content.Intent
import android.telecom.Call
import android.telecom.InCallService

class KeniaInCallService : InCallService() {

    private val callbacks = mutableMapOf<Call, Call.Callback>()

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
        val mapped = when {
            calls.any { mapCallState(it.state) == "in_call" } -> "in_call"
            calls.any { mapCallState(it.state) == "ringing" } -> "ringing"
            calls.any { mapCallState(it.state) == "dialing" } -> "dialing"
            calls.any { mapCallState(it.state) == "ended" } -> "ended"
            else -> "idle"
        }
        sendBroadcast(
            Intent(BridgeService.ACTION_TELECOM_CALL_STATE)
                .setPackage(packageName)
                .putExtra(BridgeService.EXTRA_CALL_STATE, mapped)
        )
    }
}
