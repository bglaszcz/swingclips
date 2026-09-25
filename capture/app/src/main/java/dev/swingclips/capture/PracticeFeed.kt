package dev.swingclips.capture

/** One spoken result from the server (GET /api/practice/latest): its id, the sentence, and its age (s). */
data class PracticeResult(val id: Long, val text: String, val ageS: Double)

/**
 * What to say from each answer of the practice endpoint, each result once. Plain Kotlin (no Android)
 * so it can be tested on the JVM; [PracticeVoice] does the networking and speaking.
 *
 * The first answer only says where the server is ([since] is null until then), so a phone that
 * starts listening doesn't read out old swings. Ids are the server's milliseconds, so they keep
 * going up across server restarts.
 */
class PracticeFeed(private val maxAgeS: Double = MAX_AGE_S) {
    /** The newest id seen; asked for as ?since=. Null: not synced yet (ask without it). */
    var since: Long? = null
        private set
    private val said = ArrayDeque<Long>()

    /** Forget where things were (listening was turned off, or the server changed): sync again. */
    fun reset() {
        since = null
    }

    /**
     * One answer: the server's latest id and the results after [since]. Returns the sentences to
     * say, oldest first. Results too old to be useful (after a Wi-Fi drop: the golfer has hit
     * again by then) are skipped, and none is said twice.
     */
    fun take(last: Long, results: List<PracticeResult>): List<String> {
        val from = since
        if (from == null || (results.isEmpty() && last < from)) {
            // First contact, or the server's ids went back (its log was cleared): start from now.
            since = last
            return emptyList()
        }
        val out = mutableListOf<String>()
        for (r in results.sortedBy { it.id }) {
            if (r.id <= from || r.id in said) continue
            remember(r.id)
            if (r.ageS <= maxAgeS && r.text.isNotBlank()) out.add(r.text)
        }
        since = maxOf(from, results.maxOfOrNull { it.id } ?: from)
        return out
    }

    private fun remember(id: Long) {
        said.addLast(id)
        while (said.size > REMEMBER) said.removeFirst()
    }

    companion object {
        const val MAX_AGE_S = 45.0
        private const val REMEMBER = 200
        /** How long the server may hold a request open waiting for a result (its maximum is 25). */
        const val WAIT_S = 20
        /** Wait before trying again after a failed request: 1, 2, 4, 8 s, then 10 s. */
        fun retryDelayMs(failures: Int): Long =
            if (failures <= 0) 0L else minOf(10_000L, 1000L shl minOf(failures - 1, 4))

        /** The request for the next results. */
        fun url(server: String, since: Long?, angle: String, waitS: Int = WAIT_S): String =
            server.trimEnd('/') + "/api/practice/latest?angle=$angle" +
                (if (since != null) "&since=$since&wait=$waitS" else "")

        /** The setting's default: the face-on phone speaks, the down-the-line one doesn't. */
        fun speaksByDefault(angle: String) = angle == "face"
    }
}
