package dev.swingclips.capture

import android.annotation.SuppressLint
import android.content.Context
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraConstrainedHighSpeedCaptureSession
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import android.util.Range
import android.view.Surface
import java.io.File
import java.nio.ByteBuffer
import kotlin.math.abs

/**
 * Keeps the camera recording into memory all the time: camera -> hardware encoder -> the last
 * [keepSeconds] of encoded video. [save] cuts the window around a moment out of that buffer into
 * an MP4, so nothing is written between shots and there's no start-up delay when one happens.
 */
class ReplayRecorder(
    private val ctx: Context,
    private val cameraId: String,
    val mode: Mode,
    private val preview: Surface,
    private val keepSeconds: Double,
    private val onError: (String) -> Unit,
) {
    private class Packet(val data: ByteArray, val ptsUs: Long, val key: Boolean)

    private val thread = HandlerThread("replay").apply { start() }
    private val handler = Handler(thread.looper)
    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var encoder: MediaCodec? = null
    private var encoderSurface: Surface? = null
    private var outputFormat: MediaFormat? = null
    private var orientation = 90
    /** True when frame timestamps are on the elapsedRealtime clock rather than nanoTime. */
    private var realtimeClock = false

    private val lock = Object()
    private val packets = ArrayDeque<Packet>()
    @Volatile private var closed = false

    val codecName: String get() = if (mime == MediaFormat.MIMETYPE_VIDEO_HEVC) "HEVC" else "H.264"
    private var mime = MediaFormat.MIMETYPE_VIDEO_HEVC

    fun start() = handler.post {
        try { open() } catch (e: Exception) { fail("start", e) }
    }

    @SuppressLint("MissingPermission")
    private fun open() {
        val cm = ctx.getSystemService(CameraManager::class.java)
        val ch = cm.getCameraCharacteristics(cameraId)
        orientation = ch.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
        realtimeClock = ch.get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE) ==
            CameraMetadata.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME

        encoder = createEncoder()
        cm.openCamera(cameraId, object : CameraDevice.StateCallback() {
            override fun onOpened(d: CameraDevice) {
                device = d
                try { createSession(d) } catch (e: Exception) { fail("camera session", e) }
            }
            override fun onDisconnected(d: CameraDevice) = fail("camera disconnected", null)
            override fun onError(d: CameraDevice, error: Int) = fail("camera error $error", null)
        }, handler)
    }

    private fun createEncoder(): MediaCodec {
        // HEVC at half the bitrate MediaRecorder picks by default looked the same and is smaller.
        val bitrate = (mode.width.toLong() * mode.height * mode.fps / 20).coerceIn(4_000_000, 60_000_000).toInt()
        var lastError: Exception? = null
        // Older encoders (e.g. the Galaxy S8's) may refuse an operating rate they don't advertise;
        // they still keep up with the camera without being told it.
        val attempts = listOf(MediaFormat.MIMETYPE_VIDEO_HEVC, MediaFormat.MIMETYPE_VIDEO_AVC)
            .flatMap { listOf(it to true, it to false) }
        for ((m, withRate) in attempts) {
            val fmt = MediaFormat.createVideoFormat(m, mode.width, mode.height).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
                setInteger(MediaFormat.KEY_FRAME_RATE, mode.fps)
                if (withRate) {
                    setInteger(MediaFormat.KEY_OPERATING_RATE, mode.fps)
                    setInteger(MediaFormat.KEY_PRIORITY, 0) // realtime
                }
                // Short GOPs: a clip can only start on a keyframe, and the server splits pose
                // work at keyframes, so more of them means tighter clips and faster analysis.
                setFloat(MediaFormat.KEY_I_FRAME_INTERVAL, 0.25f)
            }
            var codec: MediaCodec? = null
            try {
                codec = MediaCodec.createEncoderByType(m)
                codec.setCallback(encoderCallback, handler)
                codec.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                encoderSurface = codec.createInputSurface()
                codec.start()
                mime = m
                return codec
            } catch (e: Exception) {
                lastError = e
                Log.w(TAG, "encoder $m${if (withRate) "" else " (no operating rate)"} unavailable", e)
                runCatching { encoderSurface?.release() }
                encoderSurface = null
                runCatching { codec?.release() }
            }
        }
        throw IllegalStateException("No encoder for ${mode.label}", lastError)
    }

    private val encoderCallback = object : MediaCodec.Callback() {
        override fun onInputBufferAvailable(codec: MediaCodec, index: Int) {}

        override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) {
            synchronized(lock) { outputFormat = format }
        }

        override fun onOutputBufferAvailable(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
            if (closed) return
            try {
                val config = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
                if (!config && info.size > 0) {
                    val buf = codec.getOutputBuffer(index)!!
                    val data = ByteArray(info.size)
                    buf.position(info.offset)
                    buf.get(data)
                    val key = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
                    synchronized(lock) {
                        packets.addLast(Packet(data, info.presentationTimeUs, key))
                        val oldest = info.presentationTimeUs - (keepSeconds * 1e6).toLong()
                        while (packets.size > 1 && packets.first().ptsUs < oldest) packets.removeFirst()
                    }
                }
                codec.releaseOutputBuffer(index, false)
            } catch (e: IllegalStateException) {
                // Codec stopped under us while closing.
            }
        }

        override fun onError(codec: MediaCodec, e: MediaCodec.CodecException) = fail("encoder", e)
    }

    @Suppress("DEPRECATION")
    private fun createSession(d: CameraDevice) {
        val targets = listOf(preview, encoderSurface!!)
        val cb = object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(s: CameraCaptureSession) {
                session = s
                try {
                    val b = d.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply {
                        targets.forEach(::addTarget)
                        set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, Range(mode.fps, mode.fps))
                    }
                    request = b
                    repeat(b)
                } catch (e: Exception) {
                    fail("start camera", e)
                }
            }
            override fun onConfigureFailed(s: CameraCaptureSession) = fail("camera rejected ${mode.label}", null)
        }
        if (mode.highSpeed) d.createConstrainedHighSpeedCaptureSession(targets, cb, handler)
        else d.createCaptureSession(targets, cb, handler)
    }

    /** The camera's standing request, for changing focus later. */
    private var request: CaptureRequest.Builder? = null

    private fun repeat(b: CaptureRequest.Builder) {
        val s = session ?: return
        if (mode.highSpeed) {
            val hs = s as CameraConstrainedHighSpeedCaptureSession
            s.setRepeatingBurst(hs.createHighSpeedRequestList(b.build()), afWatch, handler)
        } else {
            s.setRepeatingRequest(b.build(), afWatch, handler)
        }
    }

    /** Logs the autofocus state when it changes (e.g. to see focusOn lock onto the golfer). */
    private var afState: Int? = null
    private val afWatch = object : CameraCaptureSession.CaptureCallback() {
        override fun onCaptureCompleted(s: CameraCaptureSession, r: CaptureRequest, result: android.hardware.camera2.TotalCaptureResult) {
            val state = result.get(android.hardware.camera2.CaptureResult.CONTROL_AF_STATE) ?: return  // high-speed bursts report it on some frames only
            if (state != afState) {
                afState = state
                Log.i(TAG, "autofocus: ${AF_STATES.getOrElse(state) { "state $state" }}")
            }
        }
    }

    /** How far the preview/recording picture is turned to be upright (degrees clockwise). */
    val rotation: Int get() = orientation

    /**
     * Focuses (and meters exposure) on [box], a part of the upright picture in shares of its width
     * and height, then holds that focus: the continuous video autofocus otherwise drifts to the busy
     * wall behind a small golfer. Needs the camera to be running.
     */
    fun focusOn(x: Float, y: Float, w: Float, h: Float) = handler.post {
        try {
            val b = request ?: return@post
            val s = session ?: return@post
            val ch = ctx.getSystemService(CameraManager::class.java).getCameraCharacteristics(cameraId)
            if ((ch.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AF) ?: 0) < 1) return@post
            val active = ch.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE) ?: return@post
            // Upright picture -> the sensor's own (landscape) picture, for each corner of the box.
            fun toSensor(u: Float, v: Float): Pair<Float, Float> = when (orientation) {
                90 -> v to 1 - u
                180 -> 1 - u to 1 - v
                270 -> 1 - v to u
                else -> u to v
            }
            val (ax, ay) = toSensor(x, y)
            val (bx, by) = toSensor(x + w, y + h)
            // The recording is 16:9, a band across the middle of the (usually 4:3) sensor.
            val bandH = minOf(active.height().toFloat(), active.width() * mode.height.toFloat() / mode.width)
            val bandTop = active.top + (active.height() - bandH) / 2
            fun px(sx: Float) = (active.left + sx.coerceIn(0f, 1f) * active.width()).toInt()
            fun py(sy: Float) = (bandTop + sy.coerceIn(0f, 1f) * bandH).toInt()
            val rect = android.graphics.Rect(px(minOf(ax, bx)), py(minOf(ay, by)), px(maxOf(ax, bx)), py(maxOf(ay, by)))
            if (rect.width() < 8 || rect.height() < 8) return@post
            val regions = arrayOf(android.hardware.camera2.params.MeteringRectangle(rect, 1000))
            b.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_AUTO)
            b.set(CaptureRequest.CONTROL_AF_REGIONS, regions)
            if ((ch.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AE) ?: 0) > 0) b.set(CaptureRequest.CONTROL_AE_REGIONS, regions)
            // One request that starts the focus sweep, then the standing request holds the result.
            b.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_START)
            Log.i(TAG, "focus on $rect")
            if (mode.highSpeed) {
                s.captureBurst((s as CameraConstrainedHighSpeedCaptureSession).createHighSpeedRequestList(b.build()), null, handler)
            } else {
                s.capture(b.build(), null, handler)
            }
            b.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_IDLE)
            repeat(b)
        } catch (e: Exception) {
            Log.w(TAG, "focus failed", e)
        }
    }

    /**
     * Converts a System.nanoTime() moment to the clock the video frames are stamped with (us).
     * The camera says which clock it uses, but on the S23 Ultra it claims elapsedRealtime while the
     * encoder's frames are on nanoTime - so go by whichever clock the newest frame is close to.
     */
    fun toVideoUs(nanoTime: Long): Long {
        val realtimeOffset = SystemClock.elapsedRealtimeNanos() - System.nanoTime()
        val newest = newestUs()
        val useRealtime = if (newest == null) realtimeClock else {
            val nowMono = System.nanoTime() / 1000
            abs(newest - (nowMono + realtimeOffset / 1000)) < abs(newest - nowMono)
        }
        return (nanoTime + if (useRealtime) realtimeOffset else 0L) / 1000
    }

    /** Newest frame in the buffer, in video-clock microseconds (or null before the first one). */
    fun newestUs(): Long? = synchronized(lock) { packets.lastOrNull()?.ptsUs }

    /**
     * Writes [beforeUs] before to [afterUs] after [momentUs] (video clock) to [out]. The clip starts
     * on the last keyframe at or before the window, so it can run a fraction of a second longer.
     * Returns how far into the file [momentUs] falls, in seconds, or null if the buffer doesn't
     * reach back that far.
     */
    fun save(momentUs: Long, beforeUs: Long, afterUs: Long, out: File): Double? {
        val (format, clip) = synchronized(lock) {
            val fmt = outputFormat ?: return null
            val start = momentUs - beforeUs
            val end = momentUs + afterUs
            val firstKey = packets.indexOfLast { it.key && it.ptsUs <= start }
                .takeIf { it >= 0 } ?: packets.indexOfFirst { it.key }.takeIf { it >= 0 } ?: return null
            fmt to packets.drop(firstKey).filter { it.ptsUs <= end }
        }
        if (clip.isEmpty()) return null
        val muxer = MediaMuxer(out.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        try {
            muxer.setOrientationHint(orientation)
            val track = muxer.addTrack(format)
            muxer.start()
            val info = MediaCodec.BufferInfo()
            val base = clip.first().ptsUs
            for (p in clip) {
                info.set(0, p.data.size, p.ptsUs - base, if (p.key) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
                muxer.writeSampleData(track, ByteBuffer.wrap(p.data), info)
            }
            muxer.stop()
            return (momentUs - base) / 1e6
        } finally {
            muxer.release()
        }
    }

    fun close() {
        closed = true
        handler.post {
            runCatching { session?.close() }
            runCatching { device?.close() }
            runCatching { encoder?.stop() }
            runCatching { encoder?.release() }
            runCatching { encoderSurface?.release() }
            session = null; device = null; encoder = null; encoderSurface = null
            thread.quitSafely()
        }
        synchronized(lock) { packets.clear() }
    }

    private fun fail(stage: String, e: Exception?) {
        if (closed) return
        Log.e(TAG, "failed at $stage", e)
        onError("$stage failed${e?.message?.let { ": $it" } ?: ""}")
    }

    companion object {
        const val TAG = "SwingClips"
        private val AF_STATES = listOf("inactive", "scanning (continuous)", "focused (continuous)", "scanning", "focused and locked", "locked, not in focus")
    }
}
