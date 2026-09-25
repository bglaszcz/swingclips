package dev.swingclips.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The practice feed's logic on the JVM: ./gradlew :app:testDebugUnitTest */
class PracticeFeedTest {
    private fun r(id: Long, text: String, age: Double = 1.0) = PracticeResult(id, text, age)

    @Test fun firstAnswerOnlySyncs() {
        val feed = PracticeFeed()
        assertNull(feed.since)
        // Even if results came back, the first answer never speaks: they're from before this phone listened.
        assertEquals(emptyList<String>(), feed.take(100, listOf(r(100, "Tempo 3, in range"))))
        assertEquals(100L, feed.since)
    }

    @Test fun eachResultOnceInOrder() {
        val feed = PracticeFeed()
        feed.take(100, emptyList())
        assertEquals(listOf("A", "B"), feed.take(102, listOf(r(102, "B"), r(101, "A"))))
        assertEquals(102L, feed.since)
        // The same results again (a retried request): nothing new to say.
        assertEquals(emptyList<String>(), feed.take(102, listOf(r(101, "A"), r(102, "B"))))
        assertEquals(listOf("C"), feed.take(103, listOf(r(103, "C"))))
    }

    @Test fun staleResultsAreSkippedButCounted() {
        val feed = PracticeFeed(maxAgeS = 45.0)
        feed.take(100, emptyList())
        assertEquals(listOf("fresh"), feed.take(102, listOf(r(101, "old", age = 80.0), r(102, "fresh", age = 3.0))))
        assertEquals(102L, feed.since)
    }

    @Test fun emptyAnswerKeepsPlace() {
        val feed = PracticeFeed()
        feed.take(100, emptyList())
        assertEquals(emptyList<String>(), feed.take(100, emptyList()))
        assertEquals(100L, feed.since)
    }

    @Test fun serverIdsGoingBackResyncs() {
        val feed = PracticeFeed()
        feed.take(5000, emptyList())
        feed.take(50, emptyList())       // the server's log was cleared
        assertEquals(50L, feed.since)
        assertEquals(listOf("next"), feed.take(51, listOf(r(51, "next"))))
    }

    @Test fun resetSyncsAgain() {
        val feed = PracticeFeed()
        feed.take(100, emptyList())
        feed.reset()
        assertEquals(emptyList<String>(), feed.take(200, listOf(r(200, "said while not listening"))))
        assertEquals(200L, feed.since)
    }

    @Test fun retryBacksOff() {
        assertEquals(listOf(0L, 1000L, 2000L, 4000L, 8000L, 10_000L, 10_000L),
            (0..6).map { PracticeFeed.retryDelayMs(it) })
    }

    @Test fun requestUrl() {
        assertEquals("http://h:8000/api/practice/latest?angle=face", PracticeFeed.url("http://h:8000/", null, "face"))
        assertEquals("http://h:8000/api/practice/latest?angle=dtl&since=42&wait=20", PracticeFeed.url("http://h:8000", 42, "dtl"))
    }

    @Test fun faceOnSpeaksByDefault() {
        assertEquals(true, PracticeFeed.speaksByDefault("face"))
        assertEquals(false, PracticeFeed.speaksByDefault("dtl"))
    }
}
