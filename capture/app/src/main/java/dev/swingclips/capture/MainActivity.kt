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
    private lateinit var uploadView: TextView

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

    // The preview surface has to be exactly the recording size before the camera starts.
    private var surfaceSize: Size? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        buildUi()
        camera = runCatching { Modes.find(getSystemService(CameraManager::class.java)) }.getOrNull()
        mode = camera?.modes?.let { list -> list.firstOrNull { it.key == prefs.getString("mode", null) } ?: list.first() }
        updateModeButton()
        uploader = Uploader(outbox, ::serverUrl) { pending, message -> main.post { showUpload(pending, message) } }
        uploader.start()
        checkServer()
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        val needed = arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
        if (needed.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }) startSession()
        else requestPermissions(needed, 1)
    }

    override fun onPause() {
        resumed = false
        stopSession()
        super.onPause()
    }

    override fun onDestroy() {
        uploader.stop()
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
        recorder = ReplayRecorder(this, cam.cameraId, m, preview.holder.surface, PRE_S + POST_S + 2.0) { msg ->
            main.post { setStatus("Camera problem: $msg", Color.rgb(245, 158, 11)) }
        }.also { it.start() }
        listener = ImpactListener(this,
            onLevel = { level -> main.post { meter.level = level } },
            onImpact = { at -> onImpact(at) },
        ).also {
            it.sensitivity = prefs.getInt("sensitivity", 100)
            it.start()
        }
        setStatus(listeningText(), Color.rgb(74, 222, 128))
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
        val wallMs = System.currentTimeMillis() - (System.nanoTime() - nanoTime) / 1_000_000
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
            val name = "swing_${m.width}x${m.height}_${m.fps}fps_${wallMs / 1000}.mp4"
            val tmp = File(outbox, "$name.tmp")
            val at = runCatching { rec.save(momentUs, (PRE_S * 1e6).toLong(), (POST_S * 1e6).toLong(), tmp) }
                .onFailure { android.util.Log.e(ReplayRecorder.TAG, "save failed", it) }
                .getOrNull()
            main.post {
                if (at != null && tmp.renameTo(File(outbox, name))) {
                    saved++
                    setStatus(listeningText(), Color.rgb(74, 222, 128))
                    uploader.poke()
                } else {
                    tmp.delete()
                    setStatus("Couldn't save that one (camera still starting?)", Color.rgb(245, 158, 11))
                }
            }
        }
    }

    private fun listeningText() =
        "Listening for swings" + if (saved > 0) " · $saved saved" else ""

    // ---- Settings ----

    private fun serverUrl() = prefs.getString("server", DEFAULT_SERVER) ?: DEFAULT_SERVER

    private fun setSensitivity(v: Int) {
        val s = v.coerceIn(0, 100)
        prefs.edit().putInt("sensitivity", s).apply()
        listener?.sensitivity = s
        sensitivityView.text = "$s"
        meter.threshold = ImpactListener.thresholdFor(s)
    }

    private fun chooseMode() {
        val modes = camera?.modes ?: return
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
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    /** Quick reachability check so a wrong address shows up right away, not at the first swing. */
    private fun checkServer() {
        val url = serverUrl()
        serverButton.text = url.removePrefix("http://")
        Thread {
            val msg = try {
                val conn = URL(url.trimEnd('/') + "/api/clips").openConnection() as HttpURLConnection
                conn.connectTimeout = 4000
                conn.readTimeout = 4000
                val code = conn.responseCode
                conn.disconnect()
                if (code == 200) "Server connected" else "Server answered $code"
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
            val i = insets.getInsets(WindowInsets.Type.systemBars())
            v.setPadding(i.left, i.top, i.right, i.bottom)
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
        panel.addView(row(
            button("−") { setSensitivity(prefs.getInt("sensitivity", 100) - 10) },
            sensBox,
            button("+") { setSensitivity(prefs.getInt("sensitivity", 100) + 10) },
            button("Save now") { if (recorder != null) { listener?.holdOff(); onImpact(System.nanoTime()) } },
        ))

        modeButton = button("") { chooseMode() }
        serverButton = button("") { chooseServer() }.apply { textSize = 13f; maxLines = 1 }
        panel.addView(row(modeButton, serverButton))

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
    }
}
