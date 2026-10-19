package dev.swingclips.capture

import org.junit.Assert.assertEquals
import org.junit.Test

class FrameGapsTest {
    private val frameUs = 1e6 / 240   // 4166.7 us

    @Test
    fun countsFramesLostBetweenTimestamps() {
        val g = FrameGaps(frameUs)
        val t = listOf(0L, 4167L, 8333L, 12500L, 33333L, 37500L)   // 4 frames lost before 33333 (the S23's pattern)
        val lost = t.map(g::add)
        assertEquals(listOf(0L, 0L, 0L, 0L, 4L, 0L), lost)
        assertEquals(6L, g.frames)
        assertEquals(4L, g.missing)
        assertEquals(4L, g.longest)
    }

    @Test
    fun aFrameALittleEarlyOrLateIsNotALoss() {
        // Sensor timestamps wobble by a few microseconds; half a frame either way still counts as next.
        assertEquals(0L, FrameGaps.missingBetween(0, 5800, frameUs))
        assertEquals(1L, FrameGaps.missingBetween(0, 7000, frameUs))
        assertEquals(0L, FrameGaps.missingBetween(1000, 1000, frameUs))   // the same frame twice
        assertEquals(0L, FrameGaps.missingBetween(2000, 1000, frameUs))   // out of order
    }

    @Test
    fun clearCountsKeepsTheLastTimestamp() {
        val g = FrameGaps(frameUs)
        g.add(0); g.add(12500)   // 2 lost
        g.clearCounts()
        assertEquals(0L, g.missing)
        assertEquals(0L, g.add(16667))   // the next frame after 12500: nothing lost across the reset
        assertEquals(1L, g.frames)
    }

    @Test
    fun missingInAClip() {
        assertEquals(5L, FrameGaps.missingIn(listOf(0L, 4167L, 25000L, 29167L, 33333L, 37500L, 41667L, 45833L, 54167L), frameUs))
        assertEquals(0L, FrameGaps.missingIn(emptyList(), frameUs))
    }
}
