package dev.swingclips.capture

import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraMetadata
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/**
 * The shutter setting: Auto (the camera's own exposure, 1/fps at 240 fps) or a fixed short
 * exposure with the ISO raised to make up for it, so the club isn't a faint streak.
 */
object Exposure {
    /** The choices, as the shutter's denominator (1/500 s ...); 0 is Auto. */
    val CHOICES = listOf(0, 500, 1000, 2000)

    fun label(denominator: Int) = if (denominator == 0) "Auto" else "1/$denominator"

    /** What the camera says it allows, read once for the chosen camera. */
    class Limits(
        val exposureNs: android.util.Range<Long>?,
        val iso: android.util.Range<Int>?,
        val compensation: android.util.Range<Int>?,
        val manualSensor: Boolean,
    ) {
        fun describe(): String {
            fun shutter(ns: Long) = if (ns >= 1_000_000_000L) "${ns / 1_000_000_000L} s" else "1/${(1e9 / ns).roundToLong()}"
            val parts = mutableListOf<String>()
            parts += if (manualSensor) "manual exposure: yes" else "manual exposure: no"
            exposureNs?.let { parts += "shutter ${shutter(it.upper)} to ${shutter(it.lower)}" }
            iso?.let { parts += "ISO ${it.lower}-${it.upper}" }
            compensation?.let { parts += "compensation ${it.lower} to ${it.upper}" }
            return parts.joinToString(" · ")
        }
    }

    fun limits(ch: CameraCharacteristics) = Limits(
        exposureNs = ch.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE),
        iso = ch.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE),
        compensation = ch.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE)?.takeIf { it.lower < 0 },
        manualSensor = ch.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES)
            ?.contains(CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR) == true,
    )

    /**
     * ISO for [targetNs] from an auto-exposure reading ([autoNs] at [autoIso]): the same light
     * gathered, so the ISO goes up by as much as the shutter got shorter, capped at the sensor's.
     */
    fun isoFor(autoNs: Long, autoIso: Int, targetNs: Long, range: android.util.Range<Int>?): Int {
        val iso = (autoIso.toDouble() * autoNs / targetNs).roundToInt()
        return range?.let { iso.coerceIn(it.lower, it.upper) } ?: iso
    }

    /** "one thousandth", "one two thousandth", "one 730th" for text-to-speech. */
    fun spoken(ns: Long): String {
        val d = (1e9 / ns).roundToInt()
        for ((n, words) in listOf(500 to "five hundredth", 1000 to "thousandth", 2000 to "two thousandth",
                                  250 to "two hundred fiftieth", 240 to "two hundred fortieth", 120 to "one hundred twentieth")) {
            if (abs(d - n) <= n / 20) return "one $words"
        }
        return "one ${d}th"
    }

    /** "1/1000 s" for the screen, from what the camera reported. */
    fun shown(ns: Long) = "1/${(1e9 / ns).roundToInt()} s"
}

/**
 * What exposure the camera is really using, as it reported it (not what was asked for).
 * [kind]: "auto" (the setting is Auto), "manual" (fixed shutter and ISO held), "compensation"
 * (the phone refused manual, so auto exposure turned all the way down and locked), or "refused"
 * (neither gave a shorter shutter, so it's back on auto).
 */
data class ExposureReport(
    val kind: String,
    val requestedNs: Long,
    val exposureNs: Long?,
    val iso: Int?,
    val isoCapped: Boolean = false,
    val frameNs: Long? = null,
)
