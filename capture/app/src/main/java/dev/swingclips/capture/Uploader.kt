package dev.swingclips.capture

import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/** The server was reached but said no. */
class ServerError(val code: Int, body: String) : Exception("server said $code $body")

/**
 * Sends every clip in [outbox] to the home server, oldest first, and deletes each one once the
 * server has confirmed it. Keeps retrying while the server is unreachable.
 */
class Uploader(
    private val outbox: File,
    private val serverUrl: () -> String,
    private val onStatus: (pending: Int, message: String) -> Unit,
) {
    private val wake = Object()
    @Volatile private var running = false
    private var thread: Thread? = null

    fun start() {
        if (running) return
        running = true
        thread = Thread({ loop() }, "uploader").apply { isDaemon = true; start() }
    }

    fun stop() {
        running = false
        poke()
    }

    /** Check the outbox now (a new clip was saved, or the server address changed). */
    fun poke() = synchronized(wake) { wake.notifyAll() }

    private fun pending() = outbox.listFiles { f -> f.name.endsWith(".mp4") }.orEmpty().sortedBy { it.name }

    private fun loop() {
        while (running) {
            val files = pending()
            var waitMs = 60_000L
            if (files.isNotEmpty()) {
                val f = files.first()
                onStatus(files.size, "Uploading ${files.size} clip${if (files.size == 1) "" else "s"}…")
                try {
                    send(f)
                    f.delete()
                    val left = pending().size
                    onStatus(left, if (left == 0) "All clips on the server" else "Uploading $left…")
                    waitMs = 0
                } catch (e: ServerError) {
                    Log.w(ReplayRecorder.TAG, "upload refused", e)
                    val hint = if (e.code == 404) " — does the server need updating?" else ""
                    onStatus(files.size, "Server refused the upload (${e.code})$hint Will retry.")
                    waitMs = 60_000
                } catch (e: Exception) {
                    Log.w(ReplayRecorder.TAG, "upload failed", e)
                    onStatus(files.size, "Can't reach the server (${e.message ?: e.javaClass.simpleName}) — will retry")
                    waitMs = 15_000
                }
            }
            if (waitMs > 0) synchronized(wake) { if (running) wake.wait(waitMs) }
        }
    }

    private fun send(f: File) {
        val base = serverUrl().trimEnd('/')
        val url = URL("$base/api/upload?name=" + URLEncoder.encode(f.name, "UTF-8"))
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.connectTimeout = 5_000
            conn.readTimeout = 60_000
            conn.setFixedLengthStreamingMode(f.length())
            conn.setRequestProperty("Content-Type", "application/octet-stream")
            conn.setRequestProperty("X-Clip-Size", f.length().toString())
            conn.outputStream.use { out -> f.inputStream().use { it.copyTo(out, 256 * 1024) } }
            val code = conn.responseCode
            if (code != 200) {
                val body = runCatching { conn.errorStream?.bufferedReader()?.readText() }.getOrNull()
                throw ServerError(code, body.orEmpty().take(200))
            }
        } finally {
            conn.disconnect()
        }
    }
}
