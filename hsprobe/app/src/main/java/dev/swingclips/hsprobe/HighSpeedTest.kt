package dev.swingclips.hsprobe

import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Context
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraConstrainedHighSpeedCaptureSession
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.media.MediaCodecList
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaRecorder
import android.os.Environment
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Log
import android.util.Range
import android.view.Surface
import java.io.File
import kotlin.math.roundToInt

/**
 * Records [recordMs] of video with one [TestConfig] and reports what really happened:
 * frames the sensor delivered, frames that landed in the file, and exposure/ISO
 * (exposure is what decides motion blur on the club).
 */
class HighSpeedTest(
    private val ctx: Context,
    private val cfg: TestConfig,
    private val preview: Surface?,
    private val recordMs: Long,
    private val onRecording: () -> Unit,
    private val progress: (String) -> Unit,
    /** Full summary, and the share of frames missing from the file (null if the test failed). */
    private val done: (String, Double?) -> Unit,
) {
    private val thread = HandlerThread("hstest").apply { start() }
    private val handler = Handler(thread.looper)
    private lateinit var chars: CameraCharacteristics
    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var recorder: MediaRecorder? = null
    private lateinit var file: File
    private var codecName = ""
    private var exposureNote = ""

    private var recording = false
    private var finished = false
    private var dropPct: Double? = null
    private var startNs = 0L

    // Latest auto-exposure values before recording, used to pick the manual ISO.
    private var meterExposure = 0L
    private var meterIso = 0

    // Measured during recording. Samsung reports some frames twice, so count unique timestamps.
    private val timestamps = HashSet<Long>()
    private var callbacks = 0
    private var minExposure = Long.MAX_VALUE
    private var maxExposure = 0L
    private var minIso = Int.MAX_VALUE
    private var maxIso = 0

    fun start() = handler.post {
        try { open() } catch (e: Exception) { fail("setup", e) }
    }

    @SuppressLint("MissingPermission")
    private fun open() {
        val cm = ctx.getSystemService(CameraManager::class.java)
        chars = cm.getCameraCharacteristics(cfg.cameraId)
        val orientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
        val dir = ctx.getExternalFilesDir(Environment.DIRECTORY_MOVIES)
        val suffix = when {
            cfg.exposureNs > 0 -> "_shutter${cfg.exposureNs / 1000}us"
            cfg.evMin -> "_evmin"
            else -> ""
        } + (cfg.codec?.let { "_$it" } ?: "") +
            (if (cfg.bitrateScale != 1.0) "_br${(cfg.bitrateScale * 100).toInt()}" else "") +
            (if (cfg.noPreview) "_nopreview" else "") +
            if (cfg.noResults) "_noresults" else ""
        file = File(dir, "cam${cfg.cameraId}_${cfg.width}x${cfg.height}_${cfg.fps}fps" +
            "${if (cfg.highSpeed) "_hs" else ""}${suffix}_${System.currentTimeMillis() / 1000}.mp4")

        val (encoder, name) = pickEncoder()
        codecName = name
        val bitrate = (cfg.width.toLong() * cfg.height * cfg.fps / 10 * cfg.bitrateScale).toLong()
            .coerceIn(4_000_000, 120_000_000).toInt()
        codecName += ", %.0f Mbps".format(bitrate / 1e6)
        recorder = MediaRecorder(ctx).apply {
            setVideoSource(MediaRecorder.VideoSource.SURFACE)
            setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            setOutputFile(file.absolutePath)
            setVideoEncoder(encoder)
            setVideoSize(cfg.width, cfg.height)
            setVideoFrameRate(cfg.fps)
            setVideoEncodingBitRate(bitrate)
            setOrientationHint(orientation)
            prepare()
        }

        progress("Opening camera ${cfg.cameraId}…")
        cm.openCamera(cfg.cameraId, object : CameraDevice.StateCallback() {
            override fun onOpened(d: CameraDevice) {
                device = d
                try { createSession(d) } catch (e: Exception) { fail("create session", e) }
            }
            override fun onDisconnected(d: CameraDevice) = fail("camera disconnected", null)
            override fun onError(d: CameraDevice, error: Int) = fail("camera error $error", null)
        }, handler)
    }

    @Suppress("DEPRECATION")
    private fun createSession(d: CameraDevice) {
        val targets = listOfNotNull(preview, recorder!!.surface)
        val cb = object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(s: CameraCaptureSession) {
                session = s
                try { startStreaming(d, s, targets) } catch (e: Exception) { fail("start streaming", e) }
            }
            override fun onConfigureFailed(s: CameraCaptureSession) =
                fail("camera rejected the session configuration", null)
        }
        if (cfg.highSpeed) d.createConstrainedHighSpeedCaptureSession(targets, cb, handler)
        else d.createCaptureSession(targets, cb, handler)
    }

    private fun baseRequest(d: CameraDevice, targets: List<Surface>): CaptureRequest.Builder =
        d.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply {
            targets.forEach(::addTarget)
            set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, Range(cfg.fpsMin, cfg.fps))
        }

    private fun repeat(s: CameraCaptureSession, b: CaptureRequest.Builder, metering: Boolean = false) {
        // Metering needs results even in no-results mode; recording then drops the callback.
        val cb = if (cfg.noResults && !metering) null else captureCb
        if (cfg.highSpeed) {
            val hs = s as CameraConstrainedHighSpeedCaptureSession
            s.setRepeatingBurst(hs.createHighSpeedRequestList(b.build()), cb, handler)
        } else {
            s.setRepeatingRequest(b.build(), cb, handler)
        }
    }

    private fun startStreaming(d: CameraDevice, s: CameraCaptureSession, targets: List<Surface>) {
        val b = baseRequest(d, targets)
        if (cfg.evMin) {
            val ev = chars.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE)?.lower ?: 0
            b.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, ev)
            exposureNote = "EV comp $ev requested"
        }
        repeat(s, b, metering = cfg.exposureNs > 0)
        if (cfg.exposureNs == 0L) {
            beginRecording()
            return
        }
        // Let auto exposure settle, then switch to the manual shutter with ISO scaled to match.
        progress("Metering…")
        handler.postDelayed({
            try {
                goManual(d, s, targets)
                beginRecording()
            } catch (e: Exception) {
                fail("manual exposure", e)
            }
        }, 800)
    }

    private fun goManual(d: CameraDevice, s: CameraCaptureSession, targets: List<Surface>) {
        val autoExp = meterExposure.takeIf { it > 0 } ?: (1e9 / cfg.fps).toLong()
        val autoIso = meterIso.takeIf { it > 0 } ?: 400
        val isoRange = chars.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE) ?: Range(50, 3200)
        val wantIso = (autoIso * autoExp.toDouble() / cfg.exposureNs).roundToInt()
        val iso = wantIso.coerceIn(isoRange.lower, isoRange.upper)
        exposureNote = "auto metered %.2f ms ISO %d → requested %.2f ms ISO %d".format(
            autoExp / 1e6, autoIso, cfg.exposureNs / 1e6, iso) +
            if (iso < wantIso) " (ISO capped; ~%.1f× darker)".format(wantIso.toDouble() / iso) else ""

        val b = baseRequest(d, targets)
        b.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_OFF)
        b.set(CaptureRequest.SENSOR_EXPOSURE_TIME, cfg.exposureNs)
        b.set(CaptureRequest.SENSOR_SENSITIVITY, iso)
        b.set(CaptureRequest.SENSOR_FRAME_DURATION, (1e9 / cfg.fps).toLong())
        repeat(s, b)
    }

    private fun beginRecording() {
        recorder!!.start()
        recording = true
        startNs = SystemClock.elapsedRealtimeNanos()
        progress("RECORDING")
        onRecording()
        handler.postDelayed({ stop() }, recordMs)
    }

    private val captureCb = object : CameraCaptureSession.CaptureCallback() {
        override fun onCaptureCompleted(s: CameraCaptureSession, r: CaptureRequest, result: TotalCaptureResult) {
            val exp = result.get(CaptureResult.SENSOR_EXPOSURE_TIME)
            val iso = result.get(CaptureResult.SENSOR_SENSITIVITY)
            if (!recording) {
                if (exp != null) meterExposure = exp
                if (iso != null) meterIso = iso
                return
            }
            // Skip the first half second while exposure settles.
            if (SystemClock.elapsedRealtimeNanos() - startNs < 500_000_000L) return
            val ts = result.get(CaptureResult.SENSOR_TIMESTAMP) ?: return
            callbacks++
            if (!timestamps.add(ts)) return
            if (exp != null) { minExposure = minOf(minExposure, exp); maxExposure = maxOf(maxExposure, exp) }
            if (iso != null) { minIso = minOf(minIso, iso); maxIso = maxOf(maxIso, iso) }
        }
    }

    private fun stop() {
        if (finished) return
        recording = false
        runCatching { session?.stopRepeating() }
        try {
            recorder?.stop()
        } catch (e: RuntimeException) {
            fail("recorder.stop (no usable video written)", e)
            return
        }
        cleanup()

        val frames = timestamps.size
        val sensorFps = if (frames > 1) (frames - 1) * 1e9 / (timestamps.max() - timestamps.min()) else 0.0
        val dupes = if (callbacks != frames) " [$callbacks callbacks]" else ""
        val exposure = if (maxExposure > 0)
            "shutter %.2f–%.2f ms, ISO %d–%d".format(minExposure / 1e6, maxExposure / 1e6, minIso, maxIso)
        else "exposure n/a"
        val fileInfo = runCatching { analyze(file) }.getOrElse { "file unreadable: ${it.message}" }
        val gallery = runCatching { copyToGallery(file) }.getOrElse { "gallery copy failed: ${it.message}" }
        val note = if (exposureNote.isNotEmpty()) "\n    $exposureNote" else ""
        val sensor = if (cfg.noResults) "sensor not measured" else
            "sensor %.1f fps (%d frames%s), %s".format(sensorFps, frames, dupes, exposure)
        finish("OK  %s%s\n    %s\n    encoder %s; %s".format(sensor, note, fileInfo, codecName, gallery))
    }

    /** Frame count and rate as stored in the MP4 — the number that matters to SwingClips. */
    private fun analyze(f: File): String {
        val ex = MediaExtractor()
        try {
            ex.setDataSource(f.absolutePath)
            val track = (0 until ex.trackCount).firstOrNull {
                ex.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true
            } ?: return "file has no video track"
            ex.selectTrack(track)
            val fmt = ex.getTrackFormat(track)
            val times = ArrayList<Long>()
            while (true) {
                val t = ex.sampleTime
                if (t < 0) break
                times += t
                ex.advance()
            }
            times.sort()
            val n = times.size
            val span = if (n > 1) (times.last() - times.first()) / 1e6 else 0.0
            val fps = if (n > 1 && span > 0) (n - 1) / span else 0.0
            val summary = "file %d frames over %.2f s = %.1f fps, %dx%d, %d KB".format(
                n, span, fps,
                fmt.getInteger(MediaFormat.KEY_WIDTH), fmt.getInteger(MediaFormat.KEY_HEIGHT),
                f.length() / 1024)
            return summary + "\n    " + dropReport(times)
        } finally {
            ex.release()
        }
    }

    /** Gaps longer than 1.5 frame intervals, i.e. frames the encoder dropped, and when they started. */
    private fun dropReport(times: List<Long>): String {
        if (times.size < 2) return "drops: n/a"
        val intervalUs = 1e6 / cfg.fps
        var gaps = 0
        var missing = 0L
        var longestUs = 0L
        var firstDropS = -1.0
        for (i in 1 until times.size) {
            val d = times[i] - times[i - 1]
            if (d > intervalUs * 1.5) {
                gaps++
                missing += (d / intervalUs).roundToInt() - 1
                longestUs = maxOf(longestUs, d)
                if (firstDropS < 0) firstDropS = (times[i - 1] - times[0]) / 1e6
            }
        }
        dropPct = missing * 100.0 / (times.size + missing)
        if (gaps == 0) return "drops: none"
        return "drops: %d gaps, ~%d frames missing (%.1f%%), longest %.1f ms, first at %.2f s"
            .format(gaps, missing, dropPct, longestUs / 1000.0, firstDropS)
    }

    private fun copyToGallery(f: File): String {
        val values = ContentValues().apply {
            put(MediaStore.Video.Media.DISPLAY_NAME, f.name)
            put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
            put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/HSProbe")
        }
        val resolver = ctx.contentResolver
        val uri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values)
            ?: return "gallery copy failed"
        resolver.openOutputStream(uri)!!.use { out -> f.inputStream().use { it.copyTo(out) } }
        return "saved to Movies/HSProbe/${f.name}"
    }

    /** The forced codec, else H.264 if an encoder claims this size and rate, otherwise HEVC. */
    private fun pickEncoder(): Pair<Int, String> {
        when (cfg.codec) {
            "avc" -> return MediaRecorder.VideoEncoder.H264 to "H.264"
            "hevc" -> return MediaRecorder.VideoEncoder.HEVC to "HEVC"
        }
        val codecs = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { it.isEncoder }
        fun supports(mime: String) = codecs.any { c ->
            c.supportedTypes.any { it.equals(mime, true) } &&
                c.getCapabilitiesForType(mime).videoCapabilities
                    ?.areSizeAndRateSupported(cfg.width, cfg.height, cfg.fps.toDouble()) == true
        }
        return when {
            supports("video/avc") -> MediaRecorder.VideoEncoder.H264 to "H.264"
            supports("video/hevc") -> MediaRecorder.VideoEncoder.HEVC to "HEVC"
            else -> MediaRecorder.VideoEncoder.H264 to "H.264 (no encoder claims this rate)"
        }
    }

    private fun fail(stage: String, e: Exception?) {
        if (finished) return
        Log.e(TAG, "FAILED at $stage", e)
        cleanup()
        finish("FAILED at $stage${e?.let { ": ${it.javaClass.simpleName}: ${it.message}" } ?: ""}")
    }

    private fun finish(summary: String) {
        if (finished) return
        finished = true
        thread.quitSafely()
        done(summary, if (summary.startsWith("OK")) dropPct else null)
    }

    private fun cleanup() {
        recording = false
        runCatching { session?.close() }
        runCatching { device?.close() }
        runCatching { recorder?.release() }
        session = null; device = null; recorder = null
    }

    companion object {
        const val TAG = "HSProbe"
    }
}
