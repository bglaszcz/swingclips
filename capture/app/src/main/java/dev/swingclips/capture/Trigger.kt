package dev.swingclips.capture

/**
 * The strike trigger's sensitivity scale, and what it heard lately for the server (capture app 0.12),
 * as plain Kotlin (no Android) so it's tested on the JVM. [ImpactListener] does the listening.
 */
object Trigger {
    /** 0-100 is the old scale (a window's energy over 150 down to over 10); 110 and 120 go below it,
     * for soft shots (40-yard wedges) the phones didn't hear at 100 (Oct 8). */
    const val MAX = 120
    const val DEFAULT = 100

    fun thresholdFor(sensitivity: Int): Float =
        if (sensitivity <= 100) 150f - sensitivity / 100f * 140f
        else 10f - (sensitivity - 100) * 0.4f

    fun clamp(sensitivity: Int) = sensitivity.coerceIn(0, MAX)

    // What came of a loud, sudden sound.
    const val STRIKE = "strike"            // it set the trigger off
    const val QUIET = "quiet"              // under the threshold: turn the sensitivity up to catch it
    const val NOT_SUDDEN = "notSudden"     // loud enough, but not 2.5x louder than just before it
    const val COOLDOWN = "cooldown"        // within 3 s of the last strike
    const val OWN_VOICE = "ownVoice"       // this phone was talking
    const val OTHER_TALKING = "otherTalking" // the other phone was talking

    /** A sound is worth logging from this loud (the meter's units) and this many times louder than just before. */
    const val LOG_MIN = 2f
    const val LOG_JUMP = 1.5f
}

/** A loud, sudden sound: when (System.nanoTime()), how loud, how many times louder than just before, what came of it. */
data class Sound(val at: Long, val level: Float, val jump: Float, val result: String)

/**
 * The trigger's recent hearing: the loud, sudden sounds (the loudest per [gapNs], a strike first),
 * and the room's level over the last few seconds. Written by the listener's thread, read by the link's.
 */
class StrikeLog(private val keep: Int = 40, private val gapNs: Long = 1_000_000_000L, windows: Int = 250) {
    private val sounds = ArrayDeque<Sound>()
    private val levels = FloatArray(windows)
    private var filled = 0
    private var next = 0

    /** Every window's level (about 47 a second), for [noise]. */
    @Synchronized fun level(v: Float) {
        levels[next] = v
        next = (next + 1) % levels.size
        if (filled < levels.size) filled++
    }

    @Synchronized fun add(s: Sound) {
        val last = sounds.lastOrNull()
        if (last != null && s.at - last.at < gapNs) {
            // One sound spread over a few windows: keep the strike, else the loudest.
            val better = if (last.result == Trigger.STRIKE) false
                else s.result == Trigger.STRIKE || s.level > last.level
            if (better) sounds[sounds.size - 1] = s
            return
        }
        sounds.addLast(s)
        while (sounds.size > keep) sounds.removeFirst()
    }

    /** The sounds since [sinceNs], oldest first. */
    @Synchronized fun since(sinceNs: Long): List<Sound> = sounds.filter { it.at >= sinceNs }

    /** The room's noise: the level 9 windows in 10 stay under, over the last ~5 s (0 before any). */
    @Synchronized fun noise(): Float {
        if (filled == 0) return 0f
        val sorted = levels.copyOf(filled).sorted()
        return sorted[((filled - 1) * 0.9).toInt()]
    }
}
