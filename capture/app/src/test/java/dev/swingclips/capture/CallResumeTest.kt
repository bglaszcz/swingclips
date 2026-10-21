package dev.swingclips.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Recording a phone call cut off starts again when the call is over: ./gradlew :app:testDebugUnitTest */
class CallResumeTest {
    private val r = CallResume()

    @Test fun aCallWhileRecordingStartsItAgainOnceOver() {
        r.left(recording = true, inCall = true, nowMs = 0)
        assertEquals(CallResume.Action.WAIT, r.back(inCall = true, nowMs = 60_000))      // still on the call
        assertEquals(CallResume.Action.RESUME, r.back(inCall = false, nowMs = 90_000))
        // Until it has started (the camera may still be starting), it's still due.
        assertEquals(CallResume.Action.RESUME, r.back(inCall = false, nowMs = 91_000))
        r.done()
        assertEquals(CallResume.Action.NOTHING, r.back(inCall = false, nowMs = 92_000))
    }

    @Test fun theCallCanRingAMomentAfterTheAppLeft() {
        r.left(recording = true, inCall = false, nowMs = 0)
        assertTrue(r.watching(nowMs = 1_000))
        r.sawCall()
        assertFalse(r.watching(nowMs = 2_000))                                         // seen: no need to look
        assertEquals(CallResume.Action.RESUME, r.back(inCall = false, nowMs = 120_000))
    }

    @Test fun leavingAnyOtherWayStillEndsRecording() {
        r.left(recording = true, inCall = false, nowMs = 0)
        assertFalse(r.watching(nowMs = CallResume.WATCH_MS + 1))
        assertEquals(CallResume.Action.NOTHING, r.back(inCall = false, nowMs = 60_000))
        // Not recording when it left: nothing either, call or not.
        r.left(recording = false, inCall = true, nowMs = 0)
        assertEquals(CallResume.Action.NOTHING, r.back(inCall = false, nowMs = 60_000))
    }

    @Test fun notAfterALongCall() {
        r.left(recording = true, inCall = true, nowMs = 0)
        assertEquals(CallResume.Action.NOTHING, r.back(inCall = false, nowMs = CallResume.WITHIN_MS + 1))
    }

    @Test fun backToTheCallScreenWhileWaitingKeepsIt() {
        r.left(recording = true, inCall = true, nowMs = 0)
        assertEquals(CallResume.Action.WAIT, r.back(inCall = true, nowMs = 30_000))
        r.left(recording = false, inCall = true, nowMs = 40_000)                         // the call screen again
        assertEquals(CallResume.Action.RESUME, r.back(inCall = false, nowMs = 300_000))
    }

    @Test fun startedByHandMeanwhile() {
        r.left(recording = true, inCall = true, nowMs = 0)
        r.done()                                                                        // Start pressed
        assertEquals(CallResume.Action.NOTHING, r.back(inCall = false, nowMs = 60_000))
    }

    @Test fun callModes() {
        assertFalse(CallResume.isCall(0))                    // MODE_NORMAL
        for (mode in 1..6) assertTrue(CallResume.isCall(mode))  // ringing, in a call, internet call, screening, redirects
        assertFalse(CallResume.isCall(-1))                   // MODE_INVALID
    }
}
