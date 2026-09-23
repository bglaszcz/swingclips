package dev.swingclips.hsprobe

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.CamcorderProfile
import android.media.MediaCodecList
import android.media.MediaRecorder
import android.os.Build
import kotlin.math.roundToInt

/** One recording configuration the camera claims to support, to be verified by [HighSpeedTest]. */
data class TestConfig(
    val cameraId: String,
    val width: Int,
    val height: Int,
    val fpsMin: Int,
    val fps: Int,
    val highSpeed: Boolean,
    /** Manual shutter in ns (AE off, gain raised to compensate); 0 = auto exposure. */
    val exposureNs: Long = 0,
    /** Auto exposure pushed to the lowest exposure compensation. */
    val evMin: Boolean = false,
    /** "avc" or "hevc" to force an encoder; null picks H.264 when it claims the rate. */
    val codec: String? = null,
    /** Multiplier on the default bitrate (width × height × fps / 10). */
    val bitrateScale: Double = 1.0,
    /** Record without the on-screen preview stream (recorder surface only). */
    val noPreview: Boolean = false,
    /** Don't ask for per-frame capture results (cuts ~480 metadata callbacks/s at 240 fps). */
    val noResults: Boolean = false,
) {
    val isExposureTest get() = exposureNs > 0 || evMin

    val encoderLabel: String
        get() = listOfNotNull(
            codec?.uppercase(),
            if (bitrateScale != 1.0) "${(bitrateScale * 100).toInt()}% bitrate" else null,
            if (noPreview) "no preview" else null,
            if (noResults) "no per-frame results" else null,
        ).joinToString(", ")

    val exposureLabel: String
        get() = when {
            exposureNs > 0 -> "shutter %.2f ms".format(exposureNs / 1e6)
            evMin -> "auto, EV min"
            else -> ""
        }

    val label: String
        get() = "cam $cameraId  ${width}x$height @ ${if (fpsMin == fps) "$fps" else "$fpsMin-$fps"}  " +
            (if (highSpeed) "high-speed" else "normal") +
            (if (isExposureTest) "  $exposureLabel" else "") +
            if (encoderLabel.isNotEmpty()) "  $encoderLabel" else ""
}

class ProbeResult(val report: String, val tests: List<TestConfig>)

/** Reads everything the camera stack advertises to third-party apps about frame rates. */
object Probe {

    private val RECORD_SIZES = listOf(3840 to 2160, 1920 to 1080, 1280 to 720)

    fun run(ctx: Context): ProbeResult {
        val cm = ctx.getSystemService(CameraManager::class.java)
        val body = StringBuilder()
        val tests = mutableListOf<TestConfig>()
        var bestHs: String? = null
        var bestHsFps = 0
        var bestHsCfg: TestConfig? = null
        var bestHsManual = false
        var bestNormal: String? = null
        var bestNormalFps = 0

        val listed = cm.cameraIdList.toList()
        // Samsung sometimes answers for IDs that aren't in cameraIdList (e.g. physical lenses).
        val unlisted = (0..63).map { it.toString() }.filter { id ->
            id !in listed && runCatching { cm.getCameraCharacteristics(id) }.isSuccess
        }
        val physical = mutableSetOf<String>()

        for (id in listed + unlisted) {
            val ch = cm.getCameraCharacteristics(id)
            physical += ch.physicalCameraIds
            val note = if (id in listed) "" else " (unlisted — may refuse to open)"
            body.appendLine()
            body.appendLine("=== Camera $id$note — ${describeLens(ch)}")
            body.appendLine("Capabilities: ${ch.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES)?.joinToString { capName(it) }}")
            if (ch.physicalCameraIds.isNotEmpty()) body.appendLine("Physical cameras behind it: ${ch.physicalCameraIds}")

            val ae = ch.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES).orEmpty()
            body.appendLine("AE target FPS ranges: ${ae.joinToString { "[${it.lower},${it.upper}]" }}")
            val manual = ch.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES)
                ?.contains(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR) == true
            ch.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE)?.let {
                body.appendLine("Shutter range: %.4f–%.1f ms".format(it.lower / 1e6, it.upper / 1e6))
            }
            body.appendLine("ISO range: ${ch.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)}, " +
                "max analog ISO ${ch.get(CameraCharacteristics.SENSOR_MAX_ANALOG_SENSITIVITY)}, " +
                "EV comp ${ch.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE)} × " +
                "${ch.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP)}")

            val map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: continue

            // Normal capture session: the sensor's min frame duration caps the rate per size,
            // and the AE ranges say which rates you can actually request.
            body.appendLine("Normal session (MediaRecorder output):")
            val recSizes = map.getOutputSizes(MediaRecorder::class.java).orEmpty()
            for ((w, h) in RECORD_SIZES) {
                val size = recSizes.firstOrNull { it.width == w && it.height == h } ?: continue
                val minDur = map.getOutputMinFrameDuration(MediaRecorder::class.java, size)
                val sensorMax = if (minDur > 0) (1e9 / minDur).roundToInt() else 0
                val usable = ae.filter { it.upper > 30 && it.upper <= sensorMax + 1 }
                    .groupBy { it.upper }
                    .map { (_, rs) -> rs.maxBy { it.lower } } // prefer fixed ranges like [60,60]
                body.appendLine("  ${w}x$h: sensor allows up to $sensorMax fps; >30 fps AE ranges: " +
                    usable.joinToString { "[${it.lower},${it.upper}]" }.ifEmpty { "none" })
                for (r in usable) {
                    tests += TestConfig(id, w, h, r.lower, r.upper, highSpeed = false)
                    if (r.upper > bestNormalFps) { bestNormalFps = r.upper; bestNormal = "cam $id ${w}x$h @ ${r.upper}" }
                }
            }

            // Constrained high-speed session: the only official route to 120/240 fps.
            val hsSizes = map.highSpeedVideoSizes.orEmpty()
            if (hsSizes.isEmpty()) {
                body.appendLine("High-speed video: NONE advertised")
            } else {
                body.appendLine("High-speed video:")
                for (size in hsSizes.sortedByDescending { it.width * it.height }) {
                    val ranges = map.getHighSpeedVideoFpsRangesFor(size)
                    body.appendLine("  ${size.width}x${size.height}: ${ranges.joinToString { "[${it.lower},${it.upper}]" }}")
                    for (r in ranges.filter { it.lower == it.upper }) {
                        val t = TestConfig(id, size.width, size.height, r.lower, r.upper, highSpeed = true)
                        tests += t
                        if (r.upper > bestHsFps && id in listed) {
                            bestHsFps = r.upper
                            bestHs = "cam $id ${size.width}x${size.height} @ ${r.upper}"
                            bestHsCfg = t
                            bestHsManual = manual
                        }
                    }
                }
            }
        }

        for (id in physical - (listed + unlisted).toSet()) {
            val ch = runCatching { cm.getCameraCharacteristics(id) }.getOrNull() ?: continue
            body.appendLine()
            body.appendLine("=== Physical camera $id (report only) — ${describeLens(ch)}")
            val map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            body.appendLine("High-speed sizes: ${map?.highSpeedVideoSizes?.joinToString().orEmpty().ifEmpty { "none" }}")
        }

        body.appendLine()
        body.appendLine("=== CamcorderProfile high-speed entries")
        for (id in listed.mapNotNull { it.toIntOrNull() }) {
            val found = HS_QUALITIES.mapNotNull { (name, q) ->
                runCatching {
                    if (!CamcorderProfile.hasProfile(id, q)) return@runCatching null
                    @Suppress("DEPRECATION")
                    val p = CamcorderProfile.get(id, q)
                    "$name ${p.videoFrameWidth}x${p.videoFrameHeight}@${p.videoFrameRate}"
                }.getOrNull()
            }
            body.appendLine("  cam $id: ${found.joinToString().ifEmpty { "none" }}")
        }

        body.appendLine()
        body.appendLine("=== Encoders (claims for size @ fps)")
        body.append(encoderTable())

        // Shutter tests on the fastest mode: motion blur, not frame rate, is what limits club positions.
        bestHsCfg?.let { base ->
            val variants = mutableListOf(base.copy(evMin = true))
            if (bestHsManual) {
                variants += listOf(2_000_000L, 1_000_000L, 500_000L, 250_000L).map { base.copy(exposureNs = it) }
            }
            tests.addAll(0, variants)
        }

        val head = StringBuilder()
        head.appendLine("${Build.MANUFACTURER} ${Build.MODEL} (${Build.DEVICE}), Android ${Build.VERSION.RELEASE} / API ${Build.VERSION.SDK_INT}")
        head.appendLine("Listed camera IDs: $listed")
        head.appendLine("Unlisted IDs that answer: ${unlisted.ifEmpty { "none" }}")
        head.appendLine("Best high-speed advertised: ${bestHs ?: "NONE"}")
        head.appendLine("Best normal-session >30 fps: ${bestNormal ?: "NONE"}")
        return ProbeResult(head.toString() + body, tests)
    }

    private val HS_QUALITIES = listOf(
        "HS_LOW" to CamcorderProfile.QUALITY_HIGH_SPEED_LOW,
        "HS_HIGH" to CamcorderProfile.QUALITY_HIGH_SPEED_HIGH,
        "HS_480P" to CamcorderProfile.QUALITY_HIGH_SPEED_480P,
        "HS_720P" to CamcorderProfile.QUALITY_HIGH_SPEED_720P,
        "HS_1080P" to CamcorderProfile.QUALITY_HIGH_SPEED_1080P,
        "HS_2160P" to CamcorderProfile.QUALITY_HIGH_SPEED_2160P,
    )

    private fun describeLens(ch: CameraCharacteristics): String {
        val facing = when (ch.get(CameraCharacteristics.LENS_FACING)) {
            CameraCharacteristics.LENS_FACING_FRONT -> "front"
            CameraCharacteristics.LENS_FACING_BACK -> "back"
            CameraCharacteristics.LENS_FACING_EXTERNAL -> "external"
            else -> "?"
        }
        val focal = ch.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.joinToString { "%.1f".format(it) }
        val level = when (ch.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL)) {
            0 -> "LIMITED"; 1 -> "FULL"; 2 -> "LEGACY"; 3 -> "LEVEL_3"; 4 -> "EXTERNAL"; else -> "?"
        }
        return "$facing, focal $focal mm, level $level"
    }

    private fun capName(c: Int) = when (c) {
        0 -> "BACKWARD_COMPATIBLE"; 1 -> "MANUAL_SENSOR"; 2 -> "MANUAL_POST_PROCESSING"; 3 -> "RAW"
        4 -> "PRIVATE_REPROCESSING"; 5 -> "READ_SENSOR_SETTINGS"; 6 -> "BURST_CAPTURE"
        7 -> "YUV_REPROCESSING"; 8 -> "DEPTH_OUTPUT"; 9 -> "CONSTRAINED_HIGH_SPEED_VIDEO"
        10 -> "MOTION_TRACKING"; 11 -> "LOGICAL_MULTI_CAMERA"; 12 -> "MONOCHROME"
        13 -> "SECURE_IMAGE_DATA"; 14 -> "SYSTEM_CAMERA"; 15 -> "OFFLINE_PROCESSING"
        16 -> "ULTRA_HIGH_RESOLUTION_SENSOR"; 17 -> "REMOSAIC_REPROCESSING"; 18 -> "DYNAMIC_RANGE_TEN_BIT"
        19 -> "STREAM_USE_CASE"; 20 -> "COLOR_SPACE_PROFILES"
        else -> "cap$c"
    }

    private fun encoderTable(): String {
        val codecs = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { it.isEncoder }
        val sb = StringBuilder()
        for (mime in listOf("video/avc", "video/hevc")) {
            val encs = codecs.filter { c -> c.supportedTypes.any { it.equals(mime, true) } }
            for ((w, h) in RECORD_SIZES) {
                val rates = listOf(60, 120, 240, 480, 960).filter { fps ->
                    encs.any { it.getCapabilitiesForType(mime).videoCapabilities?.areSizeAndRateSupported(w, h, fps.toDouble()) == true }
                }
                sb.appendLine("  $mime ${w}x$h: ${rates.joinToString().ifEmpty { "≤30 only" }}")
            }
        }
        return sb.toString()
    }
}
