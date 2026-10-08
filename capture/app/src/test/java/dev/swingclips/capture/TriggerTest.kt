package dev.swingclips.capture

import org.junit.Assert.assertEquals
import org.junit.Test

/** The trigger's scale and its log of sounds on the JVM: ./gradlew :app:testDebugUnitTest */
class TriggerTest {
    private val s = 1_000_000_000L

    @Test fun scaleKeepsTheOldRangeAndGoesBelowIt() {
        assertEquals(150f, Trigger.thresholdFor(0), 0.01f)
        assertEquals(80f, Trigger.thresholdFor(50), 0.01f)
        assertEquals(10f, Trigger.thresholdFor(100), 0.01f)
        assertEquals(6f, Trigger.thresholdFor(110), 0.01f)
        assertEquals(2f, Trigger.thresholdFor(120), 0.01f)
        assertEquals(120, Trigger.clamp(130))
        assertEquals(0, Trigger.clamp(-10))
    }

    @Test fun oneSoundOverAFewWindowsIsLoggedOnce() {
        val log = StrikeLog()
        log.add(Sound(0, 5f, 3f, Trigger.QUIET))
        log.add(Sound(s / 50, 8f, 2f, Trigger.QUIET))        // louder, same sound
        log.add(Sound(s / 25, 6f, 1.6f, Trigger.QUIET))
        log.add(Sound(2 * s, 40f, 9f, Trigger.STRIKE))
        log.add(Sound(2 * s + s / 50, 60f, 1.5f, Trigger.COOLDOWN))   // the strike stays
        assertEquals(listOf(8f to Trigger.QUIET, 40f to Trigger.STRIKE), log.since(0).map { it.level to it.result })
        assertEquals(1, log.since(s).size)
    }

    @Test fun keepsTheLatest() {
        val log = StrikeLog(keep = 3)
        for (i in 0 until 5) log.add(Sound(i * 2 * s, i.toFloat(), 2f, Trigger.QUIET))
        assertEquals(listOf(2f, 3f, 4f), log.since(0).map { it.level })
    }

    @Test fun noiseIsTheRoomsUsualLevel() {
        val log = StrikeLog(windows = 10)
        assertEquals(0f, log.noise(), 0f)
        for (v in listOf(1f, 1f, 2f, 1f, 1f, 2f, 1f, 1f, 3f, 90f)) log.level(v)
        assertEquals(3f, log.noise(), 0f)   // a strike in the last few seconds isn't the room
    }
}
