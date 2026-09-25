package dev.swingclips.capture

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.text.InputType
import android.util.Size
import android.view.Gravity
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : Activity() {

    private lateinit var previewBox: FrameLayout
    private lateinit var preview: SurfaceView
    private lateinit var flash: View
    private lateinit var statusView: TextView
    private lateinit var meter: MeterView
    private lateinit var sensitivityView: TextView
    private lateinit var modeButton: Button
    private lateinit var serverButton: Button
    private lateinit var angleButton: Button
    private lateinit var shutterButton: Button
    private lateinit var exposureView: TextView
    private lateinit var uploadView: TextView
    private lateinit var setupView: TextView
    private lateinit var cameraSetup: CameraSetup
    private lateinit var practiceButton: Button
    private lateinit var practiceView: TextView
    private lateinit var practiceVoice: PracticeVoice

    private val main = Handler(Looper.getMainLooper())
    private val saver = HandlerThread("saver").apply { start() }
    private val saveHandler by lazy { Handler(saver.looper) }
    private val tones by lazy { ToneGenerator(AudioManager.STREAM_MUSIC, 80) }
    private val prefs by lazy { getSharedPreferences("capture", Context.MODE_PRIVATE) }
    private val outbox by lazy { File(filesDir, "outbox").apply { mkdirs() } }

    private var camera: CameraModes? = null
    private var mode: Mode? = null
    private var recorder: ReplayRecorder? = null
    private var listener: ImpactListener? = null
    private lateinit var uploader: Uploader
    private var saved = 0
    private var resumed = false
    /**
     * Server clock minus this phone's clock (ms), measured when the server is checked. Clips are
     * named on the server's clock, so two phones' clips of one swing get matching times even if the
     * phones' own clocks disagree.
     */
    @Volatile private var clockOffsetMs = 0L
    /** Only saves swings after Start is pressed; the camera and meter run before that for setup. */
    @Volatile private var armed = false
    private lateinit var startButton: Button
    private lateinit var minusButton: Button
    private lateinit var plusButton: Button

    // The preview surface has to be exactly the recording size before the camera starts.
    private var surfaceSize: Size? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        buildUi()
        camera = runCatching { Modes.find(getSystemService(CameraManager::class.java)) }.getOrNull()
        mode = offeredModes().let { list -> list.firstOrNull { it.key == prefs.getString("mode", null) } ?: list.firstOrNull() }
        updateModeButton()
        updateShutterButton()
        showLimits()
        uploader = Uploader(outbox, ::serverUrl) { pending, message -> main.post { showUpload(pending, message) } }
        uploader.start()
        checkServer()
        cameraSetup = CameraSetup(this, preview, ::serverUrl, ::angle, { recorder }, { !armed && resumed }) { ok, text ->
            setupView.text = text
            setupView.setTextColor(if (ok) Color.rgb(74, 222, 128) else Color.rgb(245, 158, 11))
        }
        practiceVoice = PracticeVoice(::serverUrl, ::angle, ::practiceVoiceOn, { cameraSetup.say(it) }) { text ->
            main.post { practiceView.text = text }
        }
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        val needed = arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
        if (needed.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }) startSession()
        else requestPermissions(needed, 1)
        cameraSetup.reset()
        cameraSetup.start()
        practiceVoice.start()
    }

    override fun onPause() {
        resumed = false
        // Leaving the app ends recording; coming back needs another Start.
        setArmed(false)
        cameraSetup.stop()
        practiceVoice.stop()
        stopSession()
        super.onPause()
    }

    override fun onDestroy() {
        uploader.stop()
        cameraSetup.release()
        saver.quitSafely()
        tones.release()
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (grantResults.all { it == PackageManager.PERMISSION_GRANTED }) {
            if (resumed) startSession()
        } else {
            setStatus("SwingClips needs the camera and microphone.", Color.rgb(245, 158, 11))
        }
    }

    // ---- Session: camera buffer + sound trigger ----

    private fun startSession() {
        val cam = camera ?: return setStatus("No usable back camera found.", Color.rgb(245, 158, 11))
        val m = mode ?: return
        if (recorder != null) return
        val want = Size(m.width, m.height)
        if (surfaceSize != want) {
            // Resize first; surfaceChanged calls back here once it has.
            preview.holder.setFixedSize(m.width, m.height)
            layoutPreview()
            setStatus("Starting camera…", Color.WHITE)
            return
        }
        recorder = ReplayRecorder(this, cam.cameraId, m, preview.holder.surface, PRE_S + POST_S + 2.0,
            onError = { msg -> main.post { setStatus("Camera problem: $msg", Color.rgb(245, 158, 11)) } },
            shutter = shutter(),
            onExposure = { report -> main.post { showExposure(report, m) } },
        ).also { it.start() }
        showLimits()
        listener = ImpactListener(this,
            onLevel = { level -> main.post { meter.level = level } },
            onImpact = { at ->
                if (armed) onImpact(at)
                else main.post { flashStatus("Heard a strike (not recording)") }
            },
        ).also {
            it.sensitivity = prefs.getInt("sensitivity", 100)
            it.start()
        }
        showState()
    }

    private fun stopSession() {
        listener?.stop()
        listener = null
        recorder?.close()
        recorder = null
    }

    private fun restartSession() {
        stopSession()
        if (resumed) startSession()
    }

    /** A strike was heard at [nanoTime]: wait for the after-part to be recorded, then cut the clip. */
    private fun onImpact(nanoTime: Long) {
        val rec = recorder ?: return
        val m = rec.mode
        val momentUs = rec.toVideoUs(nanoTime)
        val wallMs = System.currentTimeMillis() - (System.nanoTime() - nanoTime) / 1_000_000 + clockOffsetMs
        val exposure = rec.exposureNow()
        val angle = angle()
        main.post {
            tones.startTone(ToneGenerator.TONE_PROP_ACK, 150)
            flash.animate().cancel()
            flash.alpha = 0.6f
            flash.animate().alpha(0f).setDuration(400).start()
            setStatus("Swing heard — saving…", Color.WHITE)
        }
        android.util.Log.i(ReplayRecorder.TAG, "impact: momentUs=$momentUs newestUs=${rec.newestUs()} " +
            "nanoTime/1000=${System.nanoTime() / 1000} elapsedRealtime/1000=${android.os.SystemClock.elapsedRealtimeNanos() / 1000}")
        saveHandler.post {
            val endUs = momentUs + (POST_S * 1e6).toLong()
            val giveUp = System.currentTimeMillis() + ((POST_S + 3) * 1000).toLong()
            while ((rec.newestUs() ?: 0) < endUs && System.currentTimeMillis() < giveUp) Thread.sleep(100)
            val tmp = File(outbox, "swing_$wallMs.tmp")
            val at = runCatching { rec.save(momentUs, (PRE_S * 1e6).toLong(), (POST_S * 1e6).toLong(), tmp) }
                .onFailure { android.util.Log.e(ReplayRecorder.TAG, "save failed", it) }
                .getOrNull()
            // e.g. swing_dtl_1280x720_240fps_1789123456_2137ms.mp4: the angle, the strike's time (server
            // clock), and how far into the clip it is - which lines up the two angles of one swing.
            val name = "swing_${angle}_${m.width}x${m.height}_${m.fps}fps_${wallMs / 1000}_${at?.let { Math.round(it * 1000) }}ms.mp4"
            // What the camera really used, uploaded with the clip (the name stays as older servers expect).
            val info = File(outbox, "$name.json")
            runCatching {
                info.writeText(org.json.JSONObject().apply {
                    put("shutter", Exposure.label(shutter()))
                    put("exposure", exposure.kind)
                    exposure.exposureNs?.let { put("exposure_ns", it) }
                    exposure.iso?.let { put("iso", it) }
                    exposure.frameNs?.let { put("frame_ns", it) }
                }.toString())
            }
            main.post {
                if (at != null && tmp.renameTo(File(outbox, name))) {
                    saved++
                    showState()
                    uploader.poke()
                } else {
                    tmp.delete()
                    info.delete()
                    setStatus("Couldn't save that one (camera still starting?)", Color.rgb(245, 158, 11))
                }
            }
        }
    }

    private fun setArmed(on: Boolean) {
        armed = on
        // Setup checks (and speech) only run while not recording; start the next setup fresh.
        if (::cameraSetup.isInitialized && !on) cameraSetup.reset()
        if (::setupView.isInitialized) setupView.visibility = if (on) View.GONE else View.VISIBLE
        // Freshen the clock offset as a session starts, and meter again for a fixed shutter.
        if (on) {
            checkServer()
            if (shutter() != 0) recorder?.relockExposure()
        }
        if (::startButton.isInitialized) showState()
    }

    /** Status line and Start/Stop button for the current state. */
    private fun showState() {
        val count = if (saved > 0) " · $saved saved" else ""
        // Settings are for setting up; while recording they're locked so a stray tap can't
        // change them (or restart the camera mid-session). Stop to change them.
        for (b in listOf(minusButton, plusButton, modeButton, serverButton, angleButton, shutterButton)) {
            b.isEnabled = !armed
            b.alpha = if (armed) 0.4f else 1f
        }
        if (armed) {
            setStatus("Recording ${ANGLES.getValue(angle()).lowercase()}$count", Color.rgb(74, 222, 128))
            startButton.text = "Stop"
            startButton.backgroundTintList = android.content.res.ColorStateList.valueOf(Color.rgb(185, 28, 28))
        } else {
            setStatus("Not recording$count — tap Start when you're set up", Color.WHITE)
            startButton.text = "Start recording swings"
            startButton.backgroundTintList = android.content.res.ColorStateList.valueOf(Color.rgb(22, 128, 61))
        }
    }

    /** A short note in the status line, then back to the normal state text. */
    private fun flashStatus(text: String) {
        setStatus(text, Color.rgb(250, 204, 21))
        main.removeCallbacks(restoreState)
        main.postDelayed(restoreState, 1500)
    }

    private val restoreState = Runnable { showState() }

    // ---- Settings ----

    private fun serverUrl() = prefs.getString("server", DEFAULT_SERVER) ?: DEFAULT_SERVER

    private fun setSensitivity(v: Int) {
        val s = v.coerceIn(0, 100)
        prefs.edit().putInt("sensitivity", s).apply()
        listener?.sensitivity = s
        sensitivityView.text = "$s"
        meter.threshold = ImpactListener.thresholdFor(s)
    }

    /** Modes to choose from: the manual-only ones only with a fixed shutter. */
    private fun offeredModes(): List<Mode> = camera?.let { if (shutter() == 0) it.autoModes else it.modes }.orEmpty()

    private fun chooseMode() {
        val modes = offeredModes().ifEmpty { return }
        val labels = modes.map { m ->
            m.label + when {
                m.fps >= 240 -> "  (slow-mo, darker)"
                m.fps >= 120 -> "  (slow-mo)"
                else -> ""
            }
        }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("Recording mode")
            .setSingleChoiceItems(labels, modes.indexOf(mode)) { d, i ->
                mode = modes[i]
                prefs.edit().putString("mode", modes[i].key).apply()
                updateModeButton()
                d.dismiss()
                restartSession()
            }
            .show()
    }

    private fun updateModeButton() {
        modeButton.text = mode?.label ?: "No camera"
    }

    /** Shutter as 1/n s, or 0 for Auto (the camera's own exposure, the default). */
    private fun shutter() = prefs.getInt("shutter", 0).takeIf { it in Exposure.CHOICES } ?: 0

    private fun chooseShutter() {
        val choices = Exposure.CHOICES
        val labels = choices.map { d ->
            when (d) {
                0 -> "Auto (about 1/frame rate: the club blurs)"
                else -> "1/$d s (needs bright light)"
            }
        }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("Shutter")
            .setSingleChoiceItems(labels, choices.indexOf(shutter())) { d, i ->
                prefs.edit().putInt("shutter", choices[i]).apply()
                // Back on Auto, a manual-only mode can't run: go to the fastest one that can.
                if (mode?.manualOnly == true && choices[i] == 0) {
                    mode = offeredModes().firstOrNull()
                    mode?.let { prefs.edit().putString("mode", it.key).apply() }
                    updateModeButton()
                }
                updateShutterButton()
                d.dismiss()
                // Restarting meters and locks again with the new setting.
                restartSession()
            }
            .show()
    }

    private fun updateShutterButton() {
        shutterButton.text = "Shutter " + Exposure.label(shutter())
    }

    /** What this camera allows, before (and as well as) what it did with the setting. */
    private fun showLimits() {
        val cam = camera ?: return
        val lim = runCatching { Exposure.limits(getSystemService(CameraManager::class.java).getCameraCharacteristics(cam.cameraId)) }.getOrNull()
        val m = mode
        val session = if (m?.highSpeed == true) "high-speed session" else "normal session"
        val setting = if (shutter() == 0) "Shutter: Auto" else "Shutter ${Exposure.label(shutter())}: checking the $session…"
        exposureView.text = setting + (lim?.let { "\nThis camera: ${it.describe()}" } ?: "")
        exposureView.setTextColor(Color.rgb(160, 170, 165))
        android.util.Log.i(ReplayRecorder.TAG, "camera ${cam.cameraId} ${m?.label}: ${lim?.describe()}")
    }

    /** Shows and says what exposure the camera really took, not just what was asked. */
    private fun showExposure(r: ExposureReport, m: Mode) {
        if (recorder?.mode != m) return   // from a session that has since been replaced
        val t = r.exposureNs
        val iso = r.iso
        val used = if (t != null && iso != null) "${Exposure.shown(t)}, ISO $iso" else "not reported"
        val refused = "This phone won't allow a fixed shutter at ${m.fps} fps"
        val offer = camera?.modes?.firstOrNull { it.manualOnly && it.fps >= 120 }
            ?.takeIf { m.highSpeed }?.let { " Try ${it.label} in the mode list." } ?: ""
        val (shown, said, ok) = when (r.kind) {
            "manual" -> Triple(
                "Shutter $used${if (r.isoCapped) " (ISO at its maximum: darker picture)" else ""}",
                "Shutter ${Exposure.spoken(t!!)}, ISO $iso${if (r.isoCapped) ". ISO is at its maximum, so the picture will be darker" else ""}",
                true)
            "compensation" -> Triple(
                "No fixed shutter at ${m.fps} fps. Auto exposure turned down and locked instead: $used (darker picture).$offer",
                "$refused. Locked darker instead: shutter ${Exposure.spoken(t!!)}, ISO $iso.$offer",
                false)
            else -> Triple(
                "$refused. Still on auto: $used.$offer",
                "$refused.$offer",
                false)
        }
        exposureView.text = shown
        exposureView.setTextColor(if (ok) Color.rgb(74, 222, 128) else Color.rgb(245, 158, 11))
        cameraSetup.say(said)
    }

    /** Which way this phone looks at the golfer: "face" (face-on) or "dtl" (down the line). */
    private fun angle() = prefs.getString("angle", "face").takeIf { it in ANGLES } ?: "face"

    private fun chooseAngle() {
        val keys = ANGLES.keys.toList()
        AlertDialog.Builder(this)
            .setTitle("This phone films")
            .setSingleChoiceItems(ANGLES.values.toTypedArray(), keys.indexOf(angle())) { d, i ->
                prefs.edit().putString("angle", keys[i]).apply()
                updateAngleButton()
                updatePracticeButton()   // the default follows the angle
                d.dismiss()
            }
            .show()
    }

    private fun updateAngleButton() {
        angleButton.text = ANGLES.getValue(angle())
    }

    private fun chooseServer() {
        val input = EditText(this).apply {
            setText(serverUrl())
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSelection(text.length)
        }
        AlertDialog.Builder(this)
            .setTitle("Home server address")
            .setMessage("Where the SwingClips server runs, e.g. $DEFAULT_SERVER or http://192.168.86.50:8000")
            .setView(input)
            .setPositiveButton("Save") { _, _ ->
                val url = input.text.toString().trim().let { if (it.startsWith("http")) it else "http://$it" }
                prefs.edit().putString("server", url).apply()
                checkServer()
                uploader.poke()
                practiceVoice.restart()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    /**
     * Whether this phone says practice results (the review page's Practice panel turns practice on).
     * Until set by hand: the face-on phone does, the down-the-line one doesn't.
     */
    private fun practiceVoiceOn() =
        if (prefs.contains("practice_voice")) prefs.getBoolean("practice_voice", true)
        else PracticeFeed.speaksByDefault(angle())

    private fun togglePracticeVoice() {
        prefs.edit().putBoolean("practice_voice", !practiceVoiceOn()).apply()
        updatePracticeButton()
    }

    private fun updatePracticeButton() {
        practiceButton.text = if (practiceVoiceOn()) "Practice voice: on" else "Practice voice: off"
    }

    /** Says a sample result at the media volume (what speech uses), and shows that volume. */
    private fun voiceCheck() {
        val audio = getSystemService(AudioManager::class.java)
        val vol = audio.getStreamVolume(AudioManager.STREAM_MUSIC)
        val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        val advice = when {
            vol == 0 -> " — muted: turn the volume up"
            vol * 2 < max -> " — turn it up to hear it over the strike"
            else -> ""
        }
        practiceView.text = if (cameraSetup.canSpeak) "Media volume $vol of $max$advice"
            else "Speech isn't ready on this phone (check the text-to-speech settings)"
        cameraSetup.say("Voice check. Tempo 3.2, in range.")
    }

    /**
     * Quick reachability check so a wrong address shows up right away, not at the first swing. Also
     * reads the server's clock, so this phone can name clips on it.
     */
    private fun checkServer() {
        val url = serverUrl()
        serverButton.text = url.removePrefix("http://")
        Thread {
            val msg = try {
                val sent = System.currentTimeMillis()
                val conn = URL(url.trimEnd('/') + "/api/time").openConnection() as HttpURLConnection
                conn.connectTimeout = 4000
                conn.readTimeout = 4000
                val code = conn.responseCode
                val body = if (code == 200) conn.inputStream.bufferedReader().readText() else ""
                val back = System.currentTimeMillis()
                conn.disconnect()
                // {"ms": <server time>}; assume it was read halfway through the round trip.
                val serverMs = Regex("\"ms\"\\s*:\\s*(\\d+)").find(body)?.groupValues?.get(1)?.toLongOrNull()
                if (serverMs != null) {
                    clockOffsetMs = serverMs - (sent + back) / 2
                    android.util.Log.i(ReplayRecorder.TAG, "clock offset ${clockOffsetMs} ms (round trip ${back - sent} ms)")
                }
                when {
                    code == 404 -> "Server needs updating (no /api/time)"
                    code != 200 -> "Server answered $code"
                    else -> "Server connected"
                }
            } catch (e: Exception) {
                "Can't reach the server — check the address (${e.javaClass.simpleName})"
            }
            main.post {
                val pending = outbox.listFiles { f -> f.name.endsWith(".mp4") }?.size ?: 0
                showUpload(pending, if (pending > 0 && msg == "Server connected") "Uploading $pending…" else msg)
            }
        }.start()
    }

    // ---- UI ----

    private fun setStatus(text: String, color: Int) {
        statusView.text = text
        statusView.setTextColor(color)
    }

    private fun showUpload(pending: Int, message: String) {
        uploadView.text = message
        uploadView.setTextColor(if (message.startsWith("Can't")) Color.rgb(245, 158, 11) else Color.rgb(160, 170, 165))
    }

    private fun buildUi() {
        val density = resources.displayMetrics.density
        fun dp(v: Int) = (v * density).toInt()
        fun button(label: String, onClick: () -> Unit) = Button(this).apply {
            text = label; isAllCaps = false; textSize = 16f; setOnClickListener { onClick() }
        }
        fun row(vararg views: View) = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            views.forEach { addView(it, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)) }
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(15, 20, 17))
        }
        root.setOnApplyWindowInsetsListener { v, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val i = insets.getInsets(WindowInsets.Type.systemBars())
                v.setPadding(i.left, i.top, i.right, i.bottom)
            } else {
                @Suppress("DEPRECATION")
                v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop,
                    insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            }
            insets
        }
        setContentView(root)

        previewBox = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        preview = SurfaceView(this)
        preview.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) {}
            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
                surfaceSize = Size(width, height)
                if (resumed && recorder == null) startSession()
            }
            override fun surfaceDestroyed(holder: SurfaceHolder) {
                surfaceSize = null
                stopSession()
            }
        })
        previewBox.addView(preview, FrameLayout.LayoutParams(1, 1, Gravity.CENTER))
        flash = View(this).apply { setBackgroundColor(Color.WHITE); alpha = 0f }
        previewBox.addView(flash, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        previewBox.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> layoutPreview() }
        root.addView(previewBox, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(12))
        }
        root.addView(panel)

        statusView = TextView(this).apply { textSize = 20f; setTypeface(null, Typeface.BOLD) }
        panel.addView(statusView)
        // What the server's camera check says (it's also spoken, for when this screen faces away).
        setupView = TextView(this).apply { textSize = 15f; setTextColor(Color.rgb(160, 170, 165)); text = "Camera check: waiting for the server…" }
        panel.addView(setupView)

        startButton = button("") { setArmed(!armed) }.apply {
            textSize = 20f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.WHITE)
        }
        panel.addView(startButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(64)).apply {
            topMargin = dp(8)
        })

        meter = MeterView(this)
        panel.addView(meter, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(14)).apply {
            topMargin = dp(10); bottomMargin = dp(4)
        })

        sensitivityView = TextView(this).apply {
            textSize = 22f; setTypeface(null, Typeface.BOLD); gravity = Gravity.CENTER; setTextColor(Color.WHITE)
        }
        val sensLabel = TextView(this).apply {
            text = "Sensitivity"; textSize = 12f; gravity = Gravity.CENTER; setTextColor(Color.rgb(74, 222, 128))
        }
        val sensBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(sensitivityView)
            addView(sensLabel)
        }
        minusButton = button("−") { setSensitivity(prefs.getInt("sensitivity", 100) - 10) }
        plusButton = button("+") { setSensitivity(prefs.getInt("sensitivity", 100) + 10) }
        panel.addView(row(
            minusButton,
            sensBox,
            plusButton,
            button("Save now") { if (recorder != null) { listener?.holdOff(); onImpact(System.nanoTime()) } },
        ))

        modeButton = button("") { chooseMode() }
        angleButton = button("") { chooseAngle() }
        serverButton = button("") { chooseServer() }.apply { textSize = 13f; maxLines = 1 }
        shutterButton = button("") { chooseShutter() }
        panel.addView(row(angleButton, modeButton))
        panel.addView(row(shutterButton, serverButton))
        // Practice mode: not a recording setting, so it stays usable while recording.
        practiceButton = button("") { togglePracticeVoice() }
        panel.addView(row(practiceButton, button("Voice check") { voiceCheck() }))
        practiceView = TextView(this).apply { textSize = 12f; setTextColor(Color.rgb(160, 170, 165)) }
        panel.addView(practiceView)
        exposureView = TextView(this).apply { textSize = 12f; setPadding(0, dp(4), 0, 0) }
        panel.addView(exposureView)

        uploadView = TextView(this).apply { textSize = 14f; setPadding(0, dp(6), 0, 0) }
        panel.addView(uploadView)

        panel.addView(TextView(this).apply {
            textSize = 12f
            setTextColor(Color.rgb(120, 130, 125))
            setPadding(0, dp(6), 0, 0)
            text = "Each swing saves ${PRE_S.toInt()} s before and ${POST_S.toInt()} s after the strike and goes to the server by itself. " +
                "Put the white line just above the room's noise; the bar should jump past it on a strike."
        })

        setSensitivity(prefs.getInt("sensitivity", 100))
        updateAngleButton()
        updatePracticeButton()
    }

    /** Fit the preview to the box with the recording's shape (portrait, so width and height swap). */
    private fun layoutPreview() {
        val m = mode ?: return
        val bw = previewBox.width
        val bh = previewBox.height
        if (bw == 0 || bh == 0) return
        val aspect = m.height.toFloat() / m.width // portrait width / height
        val (w, h) = if (bw.toFloat() / bh > aspect) (bh * aspect).toInt() to bh else bw to (bw / aspect).toInt()
        val lp = preview.layoutParams as FrameLayout.LayoutParams
        if (lp.width != w || lp.height != h) {
            lp.width = w
            lp.height = h
            preview.layoutParams = lp
        }
    }

    /** Level bar (0-150, like the web app) with a white line at the trigger threshold. */
    class MeterView(ctx: Context) : View(ctx) {
        var level = 0f
            set(v) { field = v; invalidate() }
        var threshold = 10f
            set(v) { field = v; invalidate() }
        private val track = Paint().apply { color = Color.argb(40, 255, 255, 255) }
        private val fill = Paint().apply { color = Color.rgb(34, 197, 94) }
        private val over = Paint().apply { color = Color.rgb(250, 204, 21) }
        private val mark = Paint().apply { color = Color.WHITE }

        override fun onDraw(canvas: Canvas) {
            val w = width.toFloat()
            val h = height.toFloat()
            canvas.drawRoundRect(0f, 0f, w, h, h / 2, h / 2, track)
            val lw = (level / ImpactListener.METER_MAX).coerceIn(0f, 1f) * w
            canvas.drawRoundRect(0f, 0f, lw, h, h / 2, h / 2, if (level > threshold) over else fill)
            val x = (threshold / ImpactListener.METER_MAX).coerceIn(0f, 1f) * w
            canvas.drawRect(x - 2, 0f, x + 2, h, mark)
        }
    }

    companion object {
        private const val PRE_S = 2.0
        private const val POST_S = 2.0
        // Android can't look up Windows PC names, so the home server's LAN address.
        private const val DEFAULT_SERVER = "http://192.168.86.250:8000"
        // Camera angles, by the key that goes in clip names. With a phone at each, the server pairs
        // their clips of the same swing.
        private val ANGLES = linkedMapOf("face" to "Face-on", "dtl" to "Down the line")
    }
}
