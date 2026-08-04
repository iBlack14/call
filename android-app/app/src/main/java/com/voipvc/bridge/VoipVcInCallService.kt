package com.voipvc.bridge

import android.content.Intent
import android.os.Build
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

        fun isTrackingCalls(): Boolean = liveCalls().isNotEmpty()

        fun hasLiveCall(phoneNumber: String): Boolean = findLiveCall(phoneNumber) != null

        fun isCallDefinitelyAbsent(phoneNumber: String): Boolean {
            if (activeService == null) return false
            val calls = liveCalls()
            if (calls.isEmpty()) return true
            val expected = normalizeNumber(phoneNumber)
            if (expected.isBlank()) return false
            if (calls.any {
                    normalizeNumber(it.details.handle?.schemeSpecificPart.orEmpty()) == expected
                }) return false
            // We can distinguish unrelated calls only when every live handle is
            // visible; a hidden/empty number remains ambiguous and must block.
            return calls.all {
                normalizeNumber(it.details.handle?.schemeSpecificPart.orEmpty()).isNotBlank()
            }
        }

        fun disconnectCall(phoneNumber: String): Boolean {
            val call = findLiveCall(phoneNumber) ?: return false
            return try {
                call.disconnect()
                true
            } catch (e: Exception) {
                Log.w(TAG, "Failed to disconnect call: ${e.message}")
                false
            }
        }

        private fun findLiveCall(phoneNumber: String): Call? {
            val liveCalls = liveCalls()
            val expected = normalizeNumber(phoneNumber)
            if (expected.isBlank()) return liveCalls.singleOrNull()
            return liveCalls.firstOrNull {
                normalizeNumber(it.details.handle?.schemeSpecificPart.orEmpty()) == expected
            }
        }

        private fun liveCalls(): List<Call> = activeService?.calls?.filter {
            it.state != Call.STATE_DISCONNECTED && it.state != Call.STATE_DISCONNECTING
        }.orEmpty()

        private fun normalizeNumber(value: String): String {
            var digits = value.filter(Char::isDigit)
            if (digits.length == 11 && digits.startsWith("51")) digits = digits.drop(2)
            return digits
        }
    }

    private val callbacks = mutableMapOf<Call, Call.Callback>()
    private val callDirections = mutableMapOf<Call, String>()
    private var lastBroadcastSignature = ""

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
                val mapped = mapCallState(state)
                // Do not let another ringing/active call hide the terminal
                // event of the campaign call that just disconnected.
                if (mapped == "ended") broadcastCallState(call, mapped)
                else broadcastAggregateState()
            }

            override fun onDetailsChanged(call: Call, details: Call.Details) {
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
        callDirections.remove(call)
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

        broadcastCallState(primaryCall, mapped)
    }

    private fun callDirection(call: Call?, mapped: String): String {
        if (call == null) return "unknown"
        val observed = when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> when (call.details.callDirection) {
                Call.Details.DIRECTION_INCOMING -> "incoming"
                Call.Details.DIRECTION_OUTGOING -> "outgoing"
                else -> "unknown"
            }
            mapped == "ringing" -> "incoming"
            else -> "unknown"
        }
        if (observed != "unknown") callDirections[call] = observed
        return callDirections[call] ?: observed
    }

    private fun broadcastCallState(primaryCall: Call?, mapped: String) {
        val number = primaryCall?.details?.handle?.schemeSpecificPart.orEmpty()
        val callerName = primaryCall?.details?.callerDisplayName?.toString()?.trim().orEmpty()
        val contactName = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            primaryCall?.details?.contactDisplayName?.toString()?.trim().orEmpty()
        } else ""
        val bestName = contactName.ifBlank { callerName }
        val direction = callDirection(primaryCall, mapped)
        val signature = listOf(mapped, number, bestName, direction).joinToString("|")
        if (signature == lastBroadcastSignature) return
        lastBroadcastSignature = signature

        sendBroadcast(
            Intent(BridgeService.ACTION_TELECOM_CALL_STATE)
                .setPackage(packageName)
                .putExtra(BridgeService.EXTRA_CALL_STATE, mapped)
                .putExtra(BridgeService.EXTRA_PHONE_NUMBER, number)
                .putExtra(BridgeService.EXTRA_CONTACT_NAME, bestName)
                .putExtra(BridgeService.EXTRA_CALL_DIRECTION, direction)
        )
    }
}
