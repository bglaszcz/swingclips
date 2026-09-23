package dev.swingclips.hsprobe

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.util.Size
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

class MainActivity : Activity() {

    private lateinit var status: TextView
    private lateinit var resultsView: TextView
    private lateinit var reportView: TextView
    private lateinit var testsBox: LinearLayout
    private lateinit var preview: SurfaceView

    private val main = Handler(Looper.getMainLooper())
    private var report = ""
    private var tests = emptyList<TestConfig>()
    private val results = StringBuilder()
    private val queue = ArrayDeque<TestConfig>()
    private var busy = false
    private var counting = false
    private var delayIdx = 2
    private var lengthIdx = 1
    private val tones by lazy { ToneGenerator(AudioManager.STREAM_ALARM, 100) }

    // The preview surface must match the recording size, so each test waits for a resize.
    private var previewSize: Size? = null
    private var wantSize: Size? = null
    private var previewWaiter: ((Surface?) -> Unit)? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        getPreferences(MODE_PRIVATE).let {
            delayIdx = it.getInt("delay", delayIdx).coerceIn(DELAYS.indices)
            lengthIdx = it.getInt("length", lengthIdx).coerceIn(LENGTHS.indices)
        }
        buildUi()
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) scan()
        else requestPermissions(arrayOf(Manifest.permission.CAMERA), 1)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (grantResults.firstOrNull() != PackageManager.PERMISSION_GRANTED) status.text = "Camera permission denied — tests will fail."
        scan()
    }

    private fun buildUi() {
        val density = resources.displayMetrics.density
        fun dp(v: Int) = (v * density).toInt()
        fun mono() = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 11f
            setTextIsSelectable(true)
        }

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val scroll = ScrollView(this).apply { addView(root) }
        scroll.setOnApplyWindowInsetsListener { v, insets ->
            val i = insets.getInsets(WindowInsets.Type.systemBars())
            v.setPadding(i.left + dp(12), i.top + dp(12), i.right + dp(12), i.bottom + dp(12))
            insets
        }
        setContentView(scroll)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        root.addView(TextView(this).apply { text = "High-speed camera probe"; textSize = 20f })

        fun row(vararg views: View) = LinearLayout(this).apply { views.forEach(::addView) }.also(root::addView)
        fun button(label: String, onClick: (Button) -> Unit) =
            Button(this).apply { text = label; isAllCaps = false; setOnClickListener { onClick(this) } }

        row(
            button("240 vs 120") { runAll(fpsCompare()) },
            button("Exposure") { runAll(tests.filter { it.isExposureTest }) },
            button("Run all") { runAll(tests) },
        )
        row(
            button(delayLabel()) { delayIdx = (delayIdx + 1) % DELAYS.size; savePrefs(); it.text = delayLabel() },
            button(lengthLabel()) { lengthIdx = (lengthIdx + 1) % LENGTHS.size; savePrefs(); it.text = lengthLabel() },
            button("Stop") { stopQueue() },
        )
        row(
            button("Drop hunt") { runAll(dropHunt()) },
            button("240 options") { runAll(encoderOptions()) },
            button("Rescan") { scan() },
            button("Share") { share() },
        )

        preview = SurfaceView(this)
        preview.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) {}
            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
                previewSize = Size(width, height)
                deliverPreview()
            }
            override fun surfaceDestroyed(holder: SurfaceHolder) { previewSize = null }
        })
        root.addView(preview, LinearLayout.LayoutParams(dp(180), dp(320)))

        // Big enough to read from the hitting position.
        status = TextView(this).apply { textSize = 28f; setPadding(0, dp(8), 0, dp(8)) }
        root.addView(status)
        root.addView(TextView(this).apply { text = "Results"; textSize = 16f })
        resultsView = mono()
        root.addView(resultsView)
        root.addView(TextView(this).apply { text = "Tests (tap to run one)"; textSize = 16f; setPadding(0, dp(12), 0, 0) })
        testsBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(testsBox)
        root.addView(TextView(this).apply { text = "Camera report"; textSize = 16f; setPadding(0, dp(12), 0, 0) })
        reportView = mono()
        root.addView(reportView)
    }

    private fun scan() {
        val r = try {
            Probe.run(this)
        } catch (e: Exception) {
            ProbeResult("Probe crashed: ${e.javaClass.simpleName}: ${e.message}\n${Log.getStackTraceString(e)}", emptyList())
        }
        report = r.report
        tests = r.tests
        reportView.text = report
        testsBox.removeAllViews()
        for (t in tests) {
            testsBox.addView(Button(this).apply {
                text = t.label
                isAllCaps = false
                setOnClickListener { queue.clear(); queue.add(t); next() }
            })
        }
        status.text = "${tests.size} configurations to verify."
        logLines("REPORT", report)
    }

    /** Auto exposure at 240 and 120 on the fastest camera/size, for comparing grain against smear. */
    private fun fpsCompare(): List<TestConfig> {
        val base = tests.firstOrNull { it.isExposureTest }?.copy(exposureNs = 0, evMin = false) ?: return emptyList()
        return listOf(base, base.copy(fpsMin = 120, fps = 120)).filter { it in tests }
    }

    /** Ways to keep 240 fps from dropping frames: less data per second, or a different encoder. */
    private fun encoderOptions(): List<TestConfig> {
        val base = fpsCompare().firstOrNull() ?: return emptyList()
        val list = listOf(
            base.copy(codec = "avc"),
            base.copy(codec = "avc", bitrateScale = 0.5),
            base.copy(codec = "hevc", bitrateScale = 0.5),
            base.copy(codec = "hevc", bitrateScale = 0.25),
        )
        val hd = tests.firstOrNull {
            it.cameraId == base.cameraId && it.width == 1280 && it.fps == base.fps && !it.isExposureTest
        }
        return list + listOfNotNull(hd?.copy(codec = "avc"))
    }

    /**
     * Drops come in whole 4-frame groups (Qualcomm's 240 fps batches), and shutter, encoder and
     * preview didn't explain them. Does the probe's own per-frame result callback overload the
     * pipeline? Same encoder throughout so it isn't a variable.
     */
    private fun dropHunt(): List<TestConfig> {
        val base = fpsCompare().firstOrNull()?.copy(codec = "hevc", bitrateScale = 0.5) ?: return emptyList()
        // Identical settings varied 56 vs 164 missing frames, so alternate and repeat.
        val quiet = base.copy(noResults = true)
        return listOf(base, quiet, base, quiet, base, quiet)
    }

    private fun runAll(list: List<TestConfig>) {
        if (busy || counting) return
        queue.clear()
        queue.addAll(list)
        next()
    }

    private fun stopQueue() {
        queue.clear()
        if (counting) {
            main.removeCallbacksAndMessages(COUNTDOWN)
            counting = false
            status.text = "Stopped."
        } else if (busy) {
            status.text = "Stopping after this recording…"
        }
    }

    private fun next() {
        if (busy || counting) return
        val t = queue.removeFirstOrNull() ?: run {
            status.text = "Done."
            return
        }
        countdown(t, DELAYS[delayIdx])
    }

    /** Beeps each second so you can walk to the ball and know when to swing. */
    private fun countdown(t: TestConfig, secondsLeft: Int) {
        if (secondsLeft <= 0) {
            counting = false
            record(t)
            return
        }
        counting = true
        status.text = "$secondsLeft…  next: ${t.fps} fps ${t.exposureLabel}".trimEnd()
        if (secondsLeft <= 3) beep(ToneGenerator.TONE_PROP_BEEP, 150)
        main.postAtTime({ countdown(t, secondsLeft - 1) }, COUNTDOWN, SystemClock.uptimeMillis() + 1000)
    }

    private fun record(t: TestConfig) {
        busy = true
        status.text = "Opening camera…"
        val start: (Surface?) -> Unit = { surface ->
            HighSpeedTest(this, t, surface, LENGTHS[lengthIdx] * 1000L,
                onRecording = { runOnUiThread { beep(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 400) } },
                progress = { msg -> runOnUiThread { status.text = if (msg == "RECORDING") "● SWING NOW" else msg } },
                done = { summary -> runOnUiThread { beep(ToneGenerator.TONE_PROP_ACK, 300); onResult(t, surface, summary) } },
            ).start()
        }
        if (t.noPreview) start(null) else withPreview(Size(t.width, t.height), start)
    }

    private fun beep(tone: Int, ms: Int) {
        runCatching { tones.startTone(tone, ms) }
    }

    private fun delayLabel() = "Delay ${DELAYS[delayIdx]}s"
    private fun lengthLabel() = "Record ${LENGTHS[lengthIdx]}s"

    private fun savePrefs() {
        getPreferences(MODE_PRIVATE).edit().putInt("delay", delayIdx).putInt("length", lengthIdx).apply()
    }

    override fun onDestroy() {
        tones.release()
        super.onDestroy()
    }

    private fun onResult(t: TestConfig, surface: Surface?, summary: String) {
        val line = "${t.label}${if (surface == null) " (no preview)" else ""}\n    $summary\n"
        results.append(line)
        resultsView.text = results
        logLines("RESULT", line)
        busy = false
        // Give the camera service a moment to release before the next open.
        main.postDelayed({ next() }, 500)
    }

    private fun withPreview(size: Size, cb: (Surface?) -> Unit) {
        wantSize = size
        previewWaiter = cb
        preview.holder.setFixedSize(size.width, size.height)
        deliverPreview()
        // If the surface never reaches that size, record without a preview rather than hang.
        main.postDelayed({
            if (previewWaiter === cb) {
                previewWaiter = null
                wantSize = null
                cb(null)
            }
        }, 2000)
    }

    private fun deliverPreview() {
        val want = wantSize ?: return
        if (previewSize != want) return
        val cb = previewWaiter ?: return
        previewWaiter = null
        wantSize = null
        cb(preview.holder.surface)
    }

    private fun share() {
        val text = "Results\n$results\n$report"
        startActivity(Intent.createChooser(
            Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), "Share probe report"))
    }

    /** Logcat truncates long lines, so log line by line (read with `adb logcat -s HSProbe`). */
    private fun logLines(tag: String, text: String) {
        text.lineSequence().forEach { Log.i(HighSpeedTest.TAG, "$tag $it") }
    }

    companion object {
        private val DELAYS = listOf(0, 5, 10, 15, 20)
        private val LENGTHS = listOf(3, 5, 8)
        private val COUNTDOWN = Any()
    }
}
