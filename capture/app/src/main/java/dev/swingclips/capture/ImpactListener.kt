package dev.swingclips.capture

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTimestamp
import android.media.MediaRecorder
import kotlin.math.PI
import kotlin.math.abs

/**
 * Listens for ball strikes, with the same detector as the SwingClips web app: high-pass at 1 kHz
 * (club-on-ball is sharp; voices and fans aren't), sum |signal| over 1024-sample windows, and
 * trigger when a window is over the threshold AND 2.5x louder than the two before it, at most
 * once every 3 seconds.
 *
 * [onLevel] gets each window's energy (0-150 is the meter's range); [onImpact] gets the moment of
 * the loudest sample in the triggering window, on the System.nanoTime() clock.
 */
class ImpactListener(
    private val ctx: Context,
    private val onLevel: (Float) -> Unit,
    private val onImpact: (Long) -> Unit,
) {
    /** 0-100; higher = triggers on quieter sounds. */
    @Volatile var sensitivity = 100

    @Volatile private var running = false
    @Volatile private var lastTrigger = 0L

    /** Start the cooldown now, e.g. for a manual save (its beep would otherwise trigger one). */
    fun holdOff() { lastTrigger = System.nanoTime() }
    private var thread: Thread? = null

    @SuppressLint("MissingPermission")
    fun start() {
        if (running) return
        running = true
        thread = Thread({ loop() }, "impact-listener").apply { start() }
    }

    fun stop() {
        running = false
        thread?.join(500)
        thread = null
    }

    @SuppressLint("MissingPermission")
    private fun loop() {
        val rate = 48_000
        val format = AudioFormat.ENCODING_PCM_FLOAT
        val minBuf = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, format)
        // UNPROCESSED skips automatic gain and noise suppression, which squash exactly the kind of
        // sudden loud click we're after. Not every phone has it.
        val am = ctx.getSystemService(AudioManager::class.java)
        val unprocessed = am.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED) == "true"
        val source = if (unprocessed) MediaRecorder.AudioSource.UNPROCESSED else MediaRecorder.AudioSource.VOICE_RECOGNITION
        val rec = AudioRecord(source, rate, AudioFormat.CHANNEL_IN_MONO, format, maxOf(minBuf, WINDOW * 4 * 8))
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            running = false
            return
        }

        val buf = FloatArray(WINDOW)
        val rc = 1.0 / (2 * PI * 1000) // 1 kHz high-pass
        val alpha = (rc / (rc + 1.0 / rate)).toFloat()
        var prevRaw = 0f
        var prevFiltered = 0f
        val history = floatArrayOf(0f, 0f)
        var framesRead = 0L
        val ts = AudioTimestamp()

        rec.startRecording()
        try {
            while (running) {
                val n = rec.read(buf, 0, WINDOW, AudioRecord.READ_BLOCKING)
                if (n <= 0) continue
                val windowStart = framesRead
                framesRead += n

                var sum = 0f
                var peak = 0f
                var peakAt = 0
                for (i in 0 until n) {
                    val raw = buf[i]
                    val filtered = alpha * (prevFiltered + raw - prevRaw)
                    prevRaw = raw
                    prevFiltered = filtered
                    val a = abs(filtered)
                    sum += a
                    if (a > peak) { peak = a; peakAt = i }
                }
                onLevel(sum)

                val threshold = 150f - sensitivity / 100f * 140f
                val background = (history[0] + history[1]) / 2
                val spike = background == 0f || sum > background * 2.5f
                val now = System.nanoTime()
                if (sum > threshold && spike && now - lastTrigger > COOLDOWN_NS) {
                    lastTrigger = now
                    // When the loudest sample was captured, from the recorder's own timestamp if
                    // it has one, else estimated from when the read returned.
                    val frame = windowStart + peakAt
                    val at = if (rec.getTimestamp(ts, AudioTimestamp.TIMEBASE_MONOTONIC) == AudioRecord.SUCCESS) {
                        ts.nanoTime + (frame - ts.framePosition) * 1_000_000_000L / rate
                    } else {
                        now - (framesRead - frame) * 1_000_000_000L / rate
                    }
                    onImpact(at)
                }
                history[0] = history[1]
                history[1] = sum
            }
        } finally {
            rec.stop()
            rec.release()
        }
    }

    companion object {
        const val WINDOW = 1024
        const val METER_MAX = 150f
        private const val COOLDOWN_NS = 3_000_000_000L

        fun thresholdFor(sensitivity: Int) = 150f - sensitivity / 100f * 140f
    }
}
