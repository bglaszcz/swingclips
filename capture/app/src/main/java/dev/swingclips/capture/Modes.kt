package dev.swingclips.capture

import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.MediaCodec

/** One way to record: size, frame rate, and whether it needs a constrained high-speed session. */
data class Mode(val width: Int, val height: Int, val fps: Int, val highSpeed: Boolean) {
    val label get() = "${height}p · $fps fps"
    val key get() = "${width}x${height}@$fps${if (highSpeed) "hs" else ""}"
}

/** The main back camera and every recording mode it offers, fastest first. */
class CameraModes(val cameraId: String, val modes: List<Mode>)

object Modes {
    private val SIZES = listOf(1920 to 1080, 1280 to 720)

    fun find(cm: CameraManager): CameraModes? {
        // The back camera that advertises the fastest high-speed mode (on the S23 Ultra, camera 0).
        var best: CameraModes? = null
        for (id in cm.cameraIdList) {
            val ch = cm.getCameraCharacteristics(id)
            if (ch.get(CameraCharacteristics.LENS_FACING) != CameraCharacteristics.LENS_FACING_BACK) continue
            val map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: continue
            val modes = mutableListOf<Mode>()

            for (size in map.highSpeedVideoSizes.orEmpty()) {
                if (SIZES.none { it.first == size.width && it.second == size.height }) continue
                for (r in map.getHighSpeedVideoFpsRangesFor(size)) {
                    if (r.lower == r.upper) modes += Mode(size.width, size.height, r.upper, highSpeed = true)
                }
            }
            // Normal sessions: whatever fixed rates auto exposure offers (30, sometimes 60).
            val recSizes = map.getOutputSizes(MediaCodec::class.java).orEmpty()
            val fixed = ch.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES).orEmpty()
                .filter { it.lower == it.upper && it.upper >= 30 }.map { it.upper }.distinct()
            for ((w, h) in SIZES) {
                val size = recSizes.firstOrNull { it.width == w && it.height == h } ?: continue
                val minDur = map.getOutputMinFrameDuration(MediaCodec::class.java, size)
                for (fps in fixed) {
                    if (minDur == 0L || fps <= 1_000_000_000L / minDur + 1) modes += Mode(w, h, fps, highSpeed = false)
                }
            }

            val list = modes.distinctBy { it.key }
                .sortedWith(compareByDescending<Mode> { it.fps }.thenByDescending { it.width * it.height })
            if (list.isNotEmpty() && (best == null || list.first().fps > best.modes.first().fps)) {
                best = CameraModes(id, list)
            }
        }
        return best
    }
}
