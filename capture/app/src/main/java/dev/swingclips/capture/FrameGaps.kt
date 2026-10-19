package dev.swingclips.capture

import kotlin.math.roundToLong

/**
 * Counts frames and the frames missing between them, from their timestamps: a frame that comes
 * two frame times after the last one means one was lost. [ReplayRecorder] keeps one for the
 * camera's own timestamps and one for the encoder's output, so a lost frame says where it went.
 */
class FrameGaps(private val frameUs: Double) {
    var frames = 0L
        private set
    var missing = 0L
        private set
    /** The biggest run of frames lost in a row. */
    var longest = 0L
        private set
    private var lastUs: Long? = null

    /** A frame at [tUs]: how many frames were lost just before it. */
    fun add(tUs: Long): Long {
        val gap = lastUs?.let { missingBetween(it, tUs, frameUs) } ?: 0L
        lastUs = tUs
        frames++
        missing += gap
        if (gap > longest) longest = gap
        return gap
    }

    /** Starts the counts again (the timestamps carry on). */
    fun clearCounts() {
        frames = 0; missing = 0; longest = 0
    }

    companion object {
        /** Frames lost between frames at [aUs] and [bUs] (a later frame half a frame early or late is fine). */
        fun missingBetween(aUs: Long, bUs: Long, frameUs: Double): Long =
            if (bUs <= aUs) 0L else maxOf(0L, ((bUs - aUs) / frameUs).roundToLong() - 1)

        /** Frames lost inside a run of timestamps (in order). */
        fun missingIn(ptsUs: List<Long>, frameUs: Double): Long =
            ptsUs.zipWithNext { a, b -> missingBetween(a, b, frameUs) }.sum()
    }
}
