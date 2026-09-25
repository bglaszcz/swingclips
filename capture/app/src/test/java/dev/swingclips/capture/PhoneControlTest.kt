package dev.swingclips.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The review page's Start/Stop, auto-start and the setup voice on the JVM: ./gradlew :app:testDebugUnitTest */
class PhoneControlTest {
    private fun now(recording: Boolean = false, ready: Boolean = true, busy: String? = null, error: String? = null) =
        PhoneNow(recording, ready, busy, error)

    @Test fun startDoesWhatTheButtonDoes() {
        assertEquals(Decision(true, true, "Recording", null), PhoneControl.decide("start", now()))
        // Already recording: nothing changes, and it still says so.
        assertEquals(Decision(null, true, "Recording", null), PhoneControl.decide("start", now(recording = true)))
    }

    @Test fun startRefusedWhileASettingIsChangingOrTheCameraIsNotRunning() {
        val busy = PhoneControl.decide("start", now(busy = PhoneControl.BUSY_SETTING))
        assertEquals(null, busy.arm)
        assertFalse(busy.ok)
        assertEquals(PhoneControl.BUSY_SETTING, busy.error)
        assertEquals("camera busy (another app is using it)", PhoneControl.decide("start", now(error = "camera error 1 failed")).error)
        assertEquals("camera problem: encoder failed: boom", PhoneControl.decide("start", now(error = "encoder failed: boom")).error)
        assertEquals("the camera isn't running yet", PhoneControl.decide("start", now(ready = false)).error)
    }

    @Test fun stop() {
        assertEquals(Decision(false, true, "Stopped", null), PhoneControl.decide("stop", now(recording = true)))
        // Not recording (a dialog may be open): nothing to do, and that's fine.
        assertEquals(Decision(null, true, "Stopped", null), PhoneControl.decide("stop", now(busy = PhoneControl.BUSY_SETTING)))
    }

    @Test fun unknownCommand() {
        val d = PhoneControl.decide("dance", now())
        assertFalse(d.ok)
        assertEquals(null, d.arm)
    }

    @Test fun eachCommandOnceAndAcksUntilSent() {
        val inbox = CommandInbox(remember = 3)
        assertTrue(inbox.isNew(1))
        assertFalse(inbox.isNew(1))
        inbox.answer(CommandAck(1, true, null))
        val first = inbox.pending()
        assertEquals(listOf(CommandAck(1, true, null)), first)
        inbox.answer(CommandAck(2, false, "busy"))      // answered while the poll was out
        inbox.sent(first)
        assertEquals(listOf(CommandAck(2, false, "busy")), inbox.pending())
        // Only the last few ids are remembered.
        for (id in 2L..5L) inbox.isNew(id)
        assertTrue(inbox.isNew(1))
    }

    @Test fun autoStartOncePerOpening() {
        val a = AutoStart()
        assertFalse(a.shouldStart(enabled = false, checkGood = true, recording = false))
        assertFalse(a.shouldStart(enabled = true, checkGood = false, recording = false))
        assertTrue(a.shouldStart(enabled = true, checkGood = true, recording = false))
        // Stopped afterwards: it doesn't start again by itself.
        assertFalse(a.shouldStart(enabled = true, checkGood = true, recording = false))
        a.reset()
        assertTrue(a.shouldStart(enabled = true, checkGood = true, recording = false))
    }

    @Test fun autoStartNotAfterAManualStart() {
        val a = AutoStart()
        a.started()
        assertFalse(a.shouldStart(enabled = true, checkGood = true, recording = false))
        assertFalse(AutoStart().shouldStart(enabled = true, checkGood = true, recording = true))
    }

    @Test fun setupVoice() {
        assertEquals("combined", PhoneControl.setupVoice(null))
        assertEquals("combined", PhoneControl.setupVoice("junk"))
        assertEquals("own", PhoneControl.setupVoice("own"))
        assertFalse(PhoneControl.speaksOwnSetup("combined", serverCombines = true))
        // The server isn't answering (or is older): the phone speaks for itself, as before.
        assertTrue(PhoneControl.speaksOwnSetup("combined", serverCombines = false))
        assertTrue(PhoneControl.speaksOwnSetup("own", serverCombines = true))
    }

    @Test fun pollUrl() {
        assertEquals("http://h:8000/api/phones/dtl/poll?wait=10", PhoneControl.url("http://h:8000/", "dtl"))
        assertEquals("http://h:8000/api/phones/face/poll?wait=0", PhoneControl.url("http://h:8000", "face", 0))
    }
}
