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
    private lateinit var verdictView: TextView
    private lateinit var clipsView: TextView
    private lateinit var resultsView: TextView
    private lateinit var reportView: TextView
    private lateinit var testsBox: LinearLayout
    private lateinit var preview: SurfaceView

    private val main = Handler(Looper.getMainLooper())
    private var report = ""
    private var tests = emptyList<TestConfig>()
    private val results = StringBuilder()
    private val clipLines = StringBuilder()
    private val queue = ArrayDeque<TestConfig>()
    private var busy = false
    private var counting = false
    private var delayIdx = 2
    private var lengthIdx = 1
    private val tones by lazy { ToneGenerator(AudioManager.STREAM_ALARM, 100) }

    // Drop-test bookkeeping: clip number, and drop % per variant (true = per-frame results off).
    private var clipNo = 0
    private var clipTotal = 0
    private var dropRun = false
    private val drops = mutableListOf<Pair<Boolean, Double>>()

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
        fun heading(text: String) = TextView(this).apply {
            this.text = text; textSize = 16f; setTypeface(null, Typeface.BOLD); setPadding(0, dp(12), 0, dp(4))
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

        fun row(parent: LinearLayout, vararg views: View) =
            LinearLayout(this).apply { views.forEach(::addView) }.also(parent::addView)
        fun button(label: String, onClick: (Button) -> Unit) =
            Button(this).apply { text = label; isAllCaps = false; setOnClickListener { onClick(this) } }

        root.addView(TextView(this).apply { text = "Frame-drop test"; textSize = 22f; setTypeface(null, Typeface.BOLD) })
        root.addView(TextView(this).apply {
            textSize = 15f
            setPadding(0, dp(4), 0, dp(8))
            text = """
                At 240 fps this phone loses about 1 frame in 10. This run checks whether the app's own per-frame bookkeeping is the cause.

                1. Prop the phone up facing something that moves — a swing, or just wave a hand in front of it. You don't need to be in the bay.
                2. Tap Start. It records $DROP_CLIPS short clips, alternating A (normal) and B (bookkeeping off). Beeps count down to each clip.
                3. Read the verdict below when it's done, then run "Pull clips" on the PC to send the clips to the server.
            """.trimIndent()
        })

        row(root,
            button("Start drop test") { startDropTest() }.apply { textSize = 18f },
            button("Stop") { stopQueue() },
        )
        row(root,
            button(delayLabel()) { delayIdx = (delayIdx + 1) % DELAYS.size; savePrefs(); it.text = delayLabel() },
            button(lengthLabel()) { lengthIdx = (lengthIdx + 1) % LENGTHS.size; savePrefs(); it.text = lengthLabel() },
        )

        // Big enough to read from the hitting position, and above the preview so it's on screen.
        status = TextView(this).apply { textSize = 28f; setPadding(0, dp(8), 0, dp(8)) }
        root.addView(status)
        verdictView = TextView(this).apply { textSize = 18f; setTypeface(null, Typeface.BOLD) }
        root.addView(verdictView)

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
        root.addView(heading("Clips"))
        clipsView = TextView(this).apply { textSize = 15f; text = "None yet." }
        root.addView(clipsView)

        // Everything from earlier investigations, out of the way.
        val advanced = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        root.addView(button("Show advanced tools") {
            val show = advanced.visibility != View.VISIBLE
            advanced.visibility = if (show) View.VISIBLE else View.GONE
            it.text = if (show) "Hide advanced tools" else "Show advanced tools"
        })
        root.addView(advanced)
        row(advanced,
            button("240 vs 120") { runAll(fpsCompare()) },
            button("Exposure") { runAll(tests.filter { it.isExposureTest }) },
            button("240 options") { runAll(encoderOptions()) },
        )
        row(advanced,
            button("Run all") { runAll(tests) },
            button("Rescan") { scan() },
            button("Share report") { share() },
        )
        advanced.addView(heading("Detailed results"))
        resultsView = mono()
        advanced.addView(resultsView)
        advanced.addView(heading("Single tests (tap to run one)"))
        testsBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        advanced.addView(testsBox)
        advanced.addView(heading("Camera report"))
        reportView = mono()
        advanced.addView(reportView)
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
                setOnClickListener { runAll(listOf(t)) }
            })
        }
        status.text = if (dropHunt().isEmpty()) "This phone has no 240 fps mode to test." else "Ready."
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
        return List(DROP_CLIPS) { i -> base.copy(noResults = i % 2 == 1) }
    }

    private fun startDropTest() {
        if (busy || counting) return
        runAll(dropHunt(), isDropTest = true)
    }

    private fun runAll(list: List<TestConfig>, isDropTest: Boolean = false) {
        if (busy || counting || list.isEmpty()) return
        queue.clear()
        queue.addAll(list)
        clipNo = 0
        clipTotal = list.size
        dropRun = isDropTest
        drops.clear()
        clipLines.clear()
        clipsView.text = ""
        verdictView.text = ""
        next()
    }

    private fun stopQueue() {
        queue.clear()
        if (counting) {
            main.removeCallbacksAndMessages(COUNTDOWN)
            counting = false
            status.text = "Stopped."
        } else if (busy) {
            status.text = "Stopping after this clip…"
        }
    }

    private fun next() {
        if (busy || counting) return
        val t = queue.removeFirstOrNull() ?: run {
            status.text = "Done."
            if (dropRun) verdictView.text = verdict()
            return
        }
        clipNo++
        countdown(t, DELAYS[delayIdx])
    }

    /** Beeps each second so you can get in position and know when it's recording. */
    private fun countdown(t: TestConfig, secondsLeft: Int) {
        if (secondsLeft <= 0) {
            counting = false
            record(t)
            return
        }
        counting = true
        status.text = "Clip $clipNo of $clipTotal in $secondsLeft…"
        if (secondsLeft <= 3) beep(ToneGenerator.TONE_PROP_BEEP, 150)
        main.postAtTime({ countdown(t, secondsLeft - 1) }, COUNTDOWN, SystemClock.uptimeMillis() + 1000)
    }

    private fun record(t: TestConfig) {
        busy = true
        status.text = "Opening camera…"
        val start: (Surface?) -> Unit = { surface ->
            HighSpeedTest(this, t, surface, LENGTHS[lengthIdx] * 1000L,
                onRecording = { runOnUiThread { beep(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 400) } },
                progress = { msg -> runOnUiThread { status.text = if (msg == "RECORDING") "● RECORDING — move!" else msg } },
                done = { summary, dropPct -> runOnUiThread { beep(ToneGenerator.TONE_PROP_ACK, 300); onResult(t, surface, summary, dropPct) } },
            ).start()
        }
        if (t.noPreview) start(null) else withPreview(Size(t.width, t.height), start)
    }

    private fun onResult(t: TestConfig, surface: Surface?, summary: String, dropPct: Double?) {
        val line = "${t.label}${if (surface == null) " (no preview)" else ""}\n    $summary\n"
        results.append(line)
        resultsView.text = results
        logLines("RESULT", line)

        val name = if (dropRun) variantName(t.noResults) else t.label
        clipLines.appendLine(when (dropPct) {
            null -> "$clipNo. $name — failed (see advanced tools)"
            else -> "$clipNo. $name — %.1f%% of frames dropped".format(dropPct)
        })
        clipsView.text = clipLines
        if (dropRun && dropPct != null) drops += t.noResults to dropPct

        busy = false
        // Give the camera service a moment to release before the next open.
        main.postDelayed({ next() }, 500)
    }

    private fun variantName(noResults: Boolean) = if (noResults) "B (bookkeeping off)" else "A (normal)"

    private fun verdict(): String {
        val a = drops.filter { !it.first }.map { it.second }
        val b = drops.filter { it.first }.map { it.second }
        if (a.isEmpty() || b.isEmpty()) return "Not enough clips finished to compare A and B — run it again."
        val avgA = a.average()
        val avgB = b.average()
        val summary = "A dropped %.1f%% on average, B dropped %.1f%%.".format(avgA, avgB)
        return when {
            avgA < 1 && avgB < 1 -> "$summary\nNo meaningful drops either way this time."
            avgB < avgA / 2 -> "$summary\nTurning the bookkeeping off helps a lot — that's (at least part of) the cause."
            avgB < avgA - 2 -> "$summary\nBookkeeping off helps a little, but it isn't the main cause."
            else -> "$summary\nNo real difference — the bookkeeping isn't the cause."
        }
    }

    private fun beep(tone: Int, ms: Int) {
        runCatching { tones.startTone(tone, ms) }
    }

    private fun delayLabel() = "Countdown ${DELAYS[delayIdx]}s"
    private fun lengthLabel() = "Clip length ${LENGTHS[lengthIdx]}s"

    private fun savePrefs() {
        getPreferences(MODE_PRIVATE).edit().putInt("delay", delayIdx).putInt("length", lengthIdx).apply()
    }

    override fun onDestroy() {
        tones.release()
        super.onDestroy()
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
        val text = "Clips\n$clipLines\n${verdictView.text}\n\nDetailed results\n$results\n$report"
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
        private const val DROP_CLIPS = 6
        private val COUNTDOWN = Any()
    }
}
