package dev.swingclips.capture

import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.util.Log
import android.view.PixelCopy
import android.view.SurfaceView
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

/**
 * Camera setup, for a phone whose screen faces away from the golfer: while it isn't recording, a
 * still of the preview goes to the server about once a second (POST /api/setup/<angle>). The
 * server finds the golfer and says what to fix; this says it out loud when it changes (and repeats
 * a problem now and then), shows it via [onVerdict], and focuses the camera on the golfer.
 */
class CameraSetup(
    ctx: Context,
    private val preview: SurfaceView,
    private val serverUrl: () -> String,
    private val angle: () -> String,
    private val recorder: () -> ReplayRecorder?,
    /** Only while this is true (the phone is set up, not recording). */
    private val active: () -> Boolean,
    private val onVerdict: (ok: Boolean, text: String) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    private val thread = HandlerThread("setup").apply { start() }
    private val net = Handler(thread.looper)
    @Volatile private var running = false
    @Volatile private var speechReady = false
    private val tts = TextToSpeech(ctx) { status ->
        speechReady = status == TextToSpeech.SUCCESS
    }.also { it.language = Locale.US }

    private var heard: String? = null     // the latest verdict, and how many times in a row
    private var heardCount = 0
    private var said: String? = null
    private var saidAt = 0L
    private var focusCenter: Pair<Float, Float>? = null   // where the golfer was when last focused on
    private var seenCenter: Pair<Float, Float>? = null    // and in the still before this one

    fun start() {
        running = true
        main.postDelayed(tick, INTERVAL_MS)
    }

    fun stop() {
        running = false
        main.removeCallbacks(tick)
    }

    fun release() {
        stop()
        tts.shutdown()
        thread.quitSafely()
    }

    /** Whether the text-to-speech engine started (say() is silent until then). */
    val canSpeak get() = speechReady

    /** Say something outside the setup checks (e.g. what shutter the camera is really using). */
    fun say(text: String) {
        if (speechReady) tts.speak(text, TextToSpeech.QUEUE_ADD, null, "note")
    }

    /** Forget what was said and focused, e.g. after recording: the next setup starts fresh. */
    fun reset() {
        heard = null; heardCount = 0; said = null; focusCenter = null; seenCenter = null
    }

    private val tick: Runnable = Runnable { if (running) snap() }

    private fun next() {
        if (running) main.postDelayed(tick, INTERVAL_MS)
    }

    private fun snap() {
        val rec = recorder()
        val holder = preview.holder
        if (!active() || rec == null || !holder.surface.isValid || preview.width == 0) return next()
        // PixelCopy gives the picture as shown (upright, the preview's shape), so the server
        // needn't turn it; copying it into any other shape would stretch it.
        val scale = STILL_SIZE.toFloat() / maxOf(preview.width, preview.height)
        val bmp = Bitmap.createBitmap(maxOf(1, (preview.width * scale).toInt()), maxOf(1, (preview.height * scale).toInt()),
            Bitmap.Config.ARGB_8888)
        try {
            PixelCopy.request(preview, bmp, { result ->
                if (result == PixelCopy.SUCCESS) net.post { send(bmp, 0) } else { bmp.recycle(); next() }
            }, main)
        } catch (e: IllegalArgumentException) {
            bmp.recycle()
            next()
        }
    }

    private fun send(bmp: Bitmap, rotation: Int) {
        try {
            val jpeg = ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, 80, it) }.toByteArray()
            bmp.recycle()
            val conn = URL("${serverUrl().trimEnd('/')}/api/setup/${angle()}?rotation=$rotation").openConnection() as HttpURLConnection
            conn.connectTimeout = 3000
            conn.readTimeout = 5000
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "image/jpeg")
            conn.outputStream.use { it.write(jpeg) }
            if (conn.responseCode == 200) {
                val v = JSONObject(conn.inputStream.bufferedReader().readText())
                main.post { handle(v) }
            } else {
                Log.w(ReplayRecorder.TAG, "setup still: server said ${conn.responseCode}")
            }
            conn.disconnect()
        } catch (e: Exception) {
            Log.w(ReplayRecorder.TAG, "setup still failed: ${e.javaClass.simpleName}")
        } finally {
            next()
        }
    }

    private fun handle(v: JSONObject) {
        if (!active()) return
        val ok = v.optBoolean("ok")
        val say = v.optString("say")
        onVerdict(ok, v.optString("text"))
        // Speak a verdict once it's held for two stills in a row (not every flicker); repeat a
        // problem every so often while it lasts, so it's heard while adjusting the phone.
        heardCount = if (say == heard) heardCount + 1 else 1
        heard = say
        val now = System.currentTimeMillis()
        if (heardCount >= 2 && speechReady && (say != said || (!ok && now - saidAt > REPEAT_MS))) {
            tts.speak(say, TextToSpeech.QUEUE_FLUSH, null, "setup")
            said = say
            saidAt = now
        }
        v.optJSONObject("focus")?.let { f -> focus(f) }
    }

    /**
     * Focus on the golfer once they've stood still for two stills in a row (at address, not walking
     * into place: focusing on someone moving can lock out of focus), and again if they've since
     * moved (the phone was moved).
     */
    private fun focus(f: JSONObject) {
        val x = f.optDouble("x").toFloat(); val y = f.optDouble("y").toFloat()
        val w = f.optDouble("w").toFloat(); val h = f.optDouble("h").toFloat()
        val c = (x + w / 2) to (y + h / 2)
        fun near(a: Pair<Float, Float>?) = a != null && Math.hypot((c.first - a.first).toDouble(), (c.second - a.second).toDouble()) <= REFOCUS_MOVE
        val still = near(seenCenter)
        seenCenter = c
        if (!still || near(focusCenter)) return
        recorder()?.focusOn(x, y, w, h)
        focusCenter = c
    }

    companion object {
        private const val INTERVAL_MS = 1000L
        private const val STILL_SIZE = 960
        private const val REPEAT_MS = 12_000L
        // Refocus when the golfer's middle has moved this share of the picture (the phone moved).
        private const val REFOCUS_MOVE = 0.08
    }
}
