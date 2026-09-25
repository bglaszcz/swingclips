package dev.swingclips.capture

import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.MediaCodec

/**
 * One way to record: size, frame rate, and whether it needs a constrained high-speed session.
 * [manualOnly]: a normal (not high-speed) session at a rate auto exposure can't hold, only reached
 * with a fixed shutter setting, for phones that ignore manual exposure in high-speed sessions.
 */
data class Mode(val width: Int, val height: Int, val fps: Int, val highSpeed: Boolean, val manualOnly: Boolean = false) {
    val label get() = "${height}p · $fps fps${if (manualOnly) " (fixed shutter)" else ""}"
    val key get() = "${width}x${height}@$fps${if (highSpeed) "hs" else ""}${if (manualOnly) "m" else ""}"
}

/** The main back camera and every recording mode it offers, fastest first. */
class CameraModes(val cameraId: String, val modes: List<Mode>) {
    /** The modes that work with auto exposure (all but the manual-only ones). */
    val autoModes get() = modes.filter { !it.manualOnly }
}

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
            val manual = Exposure.limits(ch).manualSensor

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
                // With manual exposure the frame duration is set directly, so a normal session can
                // run as fast as the sensor streams this size.
                if (manual && minDur > 0L) {
                    for (fps in listOf(120, 240)) {
                        if (fps !in fixed && fps <= 1_000_000_000L / minDur + 1) modes += Mode(w, h, fps, highSpeed = false, manualOnly = true)
                    }
                }
            }

            val list = modes.distinctBy { it.key }
                .sortedWith(compareByDescending<Mode> { it.fps }.thenBy { it.manualOnly }.thenByDescending { it.width * it.height })
            val fastest = list.firstOrNull { !it.manualOnly }?.fps ?: continue
            if (best == null || fastest > best.autoModes.first().fps) {
                best = CameraModes(id, list)
            }
        }
        return best
    }
}
