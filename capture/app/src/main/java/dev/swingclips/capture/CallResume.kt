package dev.swingclips.capture

/**
 * Recording that a phone call cut off starts again by itself once the call is over (the owner, Oct 21
 * 2026: a call on the down-the-line phone stopped it mid-session, and it stayed off). Answering a call
 * puts the call screen over the app, which ends recording as leaving the app does
 * ([MainActivity].onPause). When the app is back on screen and the call has ended, recording starts
 * again and the phone says so. Only after a call (Android's audio mode said one was ringing or on
 * while the app was away), and only within [WITHIN_MS] of it: leaving the app any other way still
 * ends recording, as before.
 *
 * Plain Kotlin, so it's tested on the JVM; [MainActivity] reads the audio mode and starts recording.
 */
class CallResume {
    /** When (elapsed ms) the app left while recording, or null. */
    private var leftAt: Long? = null
    private var call = false

    enum class Action { NOTHING, WAIT, RESUME }

    /**
     * The app left the screen: [recording] whether it was, [inCall] whether a call was ringing or on. Left
     * again while it was waiting for a call to end (back to the call screen): still waiting.
     */
    fun left(recording: Boolean, inCall: Boolean, nowMs: Long) {
        if (!recording && leftAt != null && call) return
        leftAt = if (recording) nowMs else null
        call = recording && inCall
    }

    /** A call seen while away (the audio mode can change a moment after the app left). */
    fun sawCall() {
        if (leftAt != null) call = true
    }

    /** Whether a call might still turn up: the app left while recording, and none seen yet. */
    fun watching(nowMs: Long): Boolean = leftAt.let { it != null && !call && nowMs - it <= WATCH_MS }

    /**
     * The app is on screen again: [Action.RESUME] start recording now (then [done]), [Action.WAIT] the
     * call isn't over yet (ask again), or [Action.NOTHING].
     */
    fun back(inCall: Boolean, nowMs: Long): Action {
        val at = leftAt ?: return Action.NOTHING
        if (!call || nowMs - at > WITHIN_MS) {
            done()
            return Action.NOTHING
        }
        return if (inCall) Action.WAIT else Action.RESUME
    }

    /** Recording started again, or was started or stopped by hand: nothing left to do. */
    fun done() {
        leftAt = null
        call = false
    }

    companion object {
        /** A call that kept the app away longer than this doesn't start recording again. */
        const val WITHIN_MS = 30 * 60 * 1000L
        /** How long after the app left a call can still show up as its reason. */
        const val WATCH_MS = 10_000L

        /**
         * Android's audio modes for a call ringing or on: AudioManager MODE_RINGTONE (1), MODE_IN_CALL (2),
         * MODE_IN_COMMUNICATION (3, a video or internet call), MODE_CALL_SCREENING (4), MODE_CALL_REDIRECT (5),
         * MODE_COMMUNICATION_REDIRECT (6). MODE_NORMAL is 0.
         */
        fun isCall(audioMode: Int): Boolean = audioMode in 1..6
    }
}
