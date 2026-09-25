package dev.swingclips.capture

import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Practice mode's voice: while [enabled] (this phone's Practice voice setting), asks the server for
 * each swing's result (GET /api/practice/latest, held open by the server until there is one) and
 * says it with [say]. Keeps trying through Wi-Fi drops; [onStatus] says how it's going. Nothing
 * to do with recording: it only listens and speaks.
 */
class PracticeVoice(
    private val serverUrl: () -> String,
    private val angle: () -> String,
    private val enabled: () -> Boolean,
    private val say: (String) -> Unit,
    private val onStatus: (String) -> Unit,
) {
    // Bumped by each start and stop: a thread from an earlier start sees it and ends.
    @Volatile private var generation = 0
    @Volatile private var conn: HttpURLConnection? = null
    private var thread: Thread? = null
    private var lastStatus: String? = null

    fun start() {
        if (thread != null) return
        val g = ++generation
        lastStatus = null
        thread = Thread({ loop(g) }, "practice").apply { isDaemon = true; start() }
    }

    fun stop() {
        generation++
        thread?.interrupt()
        // Ends a request the server is holding open; off the main thread, which may not touch the network.
        conn?.let { c -> Thread { runCatching { c.disconnect() } }.start() }
        thread = null
    }

    /** The setting or the server changed: start over from the server's latest (no old results). */
    fun restart() {
        stop()
        start()
    }

    private fun loop(g: Int) {
        val feed = PracticeFeed()   // new each start: the first answer syncs, so nothing old is said
        val live = { g == generation }
        var failures = 0
        while (live()) {
            try {
                if (!enabled()) {
                    feed.reset()
                    status("Practice voice off on this phone")
                    Thread.sleep(1000)
                    continue
                }
                val c = URL(PracticeFeed.url(serverUrl(), feed.since, angle())).openConnection() as HttpURLConnection
                conn = c
                c.connectTimeout = 4000
                c.readTimeout = (PracticeFeed.WAIT_S + 10) * 1000
                val code = c.responseCode
                if (code == 404) {
                    status("Practice: the server needs updating")
                    c.disconnect()
                    Thread.sleep(10_000)
                    continue
                }
                if (code != 200) throw ServerError(code, "")
                val body = JSONObject(c.inputStream.bufferedReader().readText())
                c.disconnect()
                val list = body.optJSONArray("results")
                val results = (0 until (list?.length() ?: 0)).map { i ->
                    val r = list!!.getJSONObject(i)
                    PracticeResult(r.getLong("id"), r.optString("text"), r.optDouble("age", 0.0))
                }
                for (text in feed.take(body.getLong("last"), results)) {
                    if (!live()) return
                    Log.i(ReplayRecorder.TAG, "practice: $text")
                    say(text)
                }
                failures = 0
                if (live()) status(if (body.optBoolean("on")) "Practice on: speaking each swing"
                                   else "Practice is off (turn it on on the review page)")
            } catch (e: InterruptedException) {
                return
            } catch (e: Exception) {
                if (!live()) return
                failures++
                status("Practice: can't reach the server, retrying")
                Log.w(ReplayRecorder.TAG, "practice poll failed: ${e.javaClass.simpleName}")
                try { Thread.sleep(PracticeFeed.retryDelayMs(failures)) } catch (_: InterruptedException) { return }
            } finally {
                if (live()) conn = null
            }
        }
    }

    private fun status(text: String) {
        if (text == lastStatus) return
        lastStatus = text
        onStatus(text)
    }
}
