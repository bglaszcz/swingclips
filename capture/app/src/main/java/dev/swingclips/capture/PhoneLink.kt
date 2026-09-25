package dev.swingclips.capture

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * This phone's line to the server (capture app 0.6): while the app is open it reports what it's
 * doing (POST /api/phones/<angle>/poll, about every 10 s: [state]) and the server holds the request
 * until it has a command from the review page or something for this phone to say (a long poll).
 * Commands go to [onCommand] (which starts or stops recording as the phone's own button does) and
 * the answer goes back with the next poll. Nothing to do with recording itself.
 */
class PhoneLink(
    private val serverUrl: () -> String,
    private val angle: () -> String,
    /** What the phone is doing, as JSON fields (called on this thread; MainActivity makes it safe). */
    private val state: () -> Map<String, Any?>,
    /** Do a command and return what happened (called on this thread; MainActivity runs it on the main one). */
    private val onCommand: (PhoneCommand) -> CommandAck,
    private val say: (PhoneSay) -> Unit,
) {
    private val inbox = CommandInbox()
    @Volatile private var generation = 0
    @Volatile private var conn: HttpURLConnection? = null
    @Volatile private var poked = false
    @Volatile private var answeredAt = 0L
    private var thread: Thread? = null

    /** The server answered a poll lately, so it's doing the combined setup voice. */
    val linked get() = System.currentTimeMillis() - answeredAt < PhoneControl.LINKED_FOR_MS

    fun start() {
        if (thread != null) return
        val g = ++generation
        thread = Thread({ loop(g) }, "phonelink").apply { isDaemon = true; start() }
    }

    fun stop() {
        generation++
        thread?.interrupt()
        hangUp()
        thread = null
    }

    /** Something changed (Start pressed, a setting): report it now rather than at the next poll. */
    fun poke() {
        poked = true
        hangUp()
    }

    /** The app is closing: one last report, so the review page shows it closed at once. */
    fun closing(finalState: Map<String, Any?>) {
        val body = JSONObject(finalState + ("closing" to true)).toString()
        val url = PhoneControl.url(serverUrl(), angle(), 0)
        Thread {
            runCatching { post(url, body, 3000).disconnect() }
        }.start()
    }

    private fun hangUp() {
        // Ends a request the server is holding open; off the main thread, which may not touch the network.
        conn?.let { c -> Thread { runCatching { c.disconnect() } }.start() }
    }

    private fun post(url: String, body: String, readTimeoutMs: Int): HttpURLConnection {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 4000
        c.readTimeout = readTimeoutMs
        c.requestMethod = "POST"
        c.doOutput = true
        c.setRequestProperty("Content-Type", "application/json")
        c.outputStream.use { it.write(body.toByteArray()) }
        return c
    }

    private fun loop(g: Int) {
        val live = { g == generation }
        var failures = 0
        // The first poll is answered at once (not held): until an answer, this phone says its own setup verdicts.
        var first = true
        while (live()) {
            try {
                poked = false
                val acks = inbox.pending()
                val body = JSONObject(state()).apply {
                    put("acks", JSONArray(acks.map { a -> JSONObject().put("id", a.id).put("ok", a.ok).put("error", a.error ?: JSONObject.NULL) }))
                }.toString()
                val c = post(PhoneControl.url(serverUrl(), angle(), if (first) 0 else PhoneControl.WAIT_S), body,
                    (PhoneControl.WAIT_S + 10) * 1000)
                conn = c
                val code = c.responseCode
                if (code == 204) {           // the server saw this phone hang up (a poke): ask again
                    c.disconnect()
                    continue
                }
                if (code == 404) {
                    c.disconnect()
                    Log.i(ReplayRecorder.TAG, "link: the server has no /api/phones (older server)")
                    Thread.sleep(30_000)
                    continue
                }
                if (code != 200) throw ServerError(code, "")
                val reply = JSONObject(c.inputStream.bufferedReader().readText())
                c.disconnect()
                inbox.sent(acks)
                answeredAt = System.currentTimeMillis()
                first = false
                failures = 0
                val says = reply.optJSONArray("say")
                for (i in 0 until (says?.length() ?: 0)) {
                    val s = says!!.getJSONObject(i)
                    if (live()) say(PhoneSay(s.getLong("id"), s.optString("text"), s.optBoolean("flush")))
                }
                val cmds = reply.optJSONArray("commands")
                for (i in 0 until (cmds?.length() ?: 0)) {
                    val o = cmds!!.getJSONObject(i)
                    val cmd = PhoneCommand(o.getLong("id"), o.optString("action"))
                    if (!live() || !inbox.isNew(cmd.id)) continue
                    Log.i(ReplayRecorder.TAG, "link: command ${cmd.action}")
                    inbox.answer(onCommand(cmd))
                }
            } catch (e: InterruptedException) {
                return
            } catch (e: Exception) {
                if (!live()) return
                if (poked) continue          // hung up on purpose, to report a change
                failures++
                Log.w(ReplayRecorder.TAG, "link poll failed: ${e.javaClass.simpleName}")
                try { Thread.sleep(PracticeFeed.retryDelayMs(failures)) } catch (_: InterruptedException) { return }
            } finally {
                if (live()) conn = null
            }
        }
    }
}
