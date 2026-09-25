package dev.swingclips.capture

/** A command from the review page (via the server): "start" or "stop" recording. */
data class PhoneCommand(val id: Long, val action: String)

/** Something the server wants this phone to say: the combined camera setup, or a session check. */
data class PhoneSay(val id: Long, val text: String, val flush: Boolean)

/** This phone's answer to a command, sent with its next poll. */
data class CommandAck(val id: Long, val ok: Boolean, val error: String?)

/** What the command logic needs to know about the phone right now. */
data class PhoneNow(
    val recording: Boolean,
    /** The camera is running (a session is open), so Start would record. */
    val cameraReady: Boolean,
    /** Why the phone can't start now, e.g. a settings dialog is open; null when it can. */
    val busy: String?,
    /** The camera's last error since it was opened, if any (another app has it, it disconnected). */
    val cameraError: String?,
)

/**
 * What to do with a command: [arm] true = start recording, false = stop, null = leave it; whether it
 * [ok]'d, what to [say] out loud, and the [error] to send back.
 */
data class Decision(val arm: Boolean?, val ok: Boolean, val say: String?, val error: String?)

/**
 * The review page's Start and Stop, the auto-start setting and the setup voice setting, as plain
 * Kotlin (no Android) so it's tested on the JVM; [PhoneLink] does the networking and [MainActivity]
 * the recording, exactly as its own Start/Stop button does.
 */
object PhoneControl {
    const val START = "start"
    const val STOP = "stop"
    const val BUSY_SETTING = "a setting is being changed on the phone"

    /** Start or stop, as the phone's own button would; refused while that wouldn't work. */
    fun decide(action: String, now: PhoneNow): Decision = when (action) {
        START -> when {
            now.recording -> Decision(null, true, "Recording", null)
            now.busy != null -> Decision(null, false, null, now.busy)
            now.cameraError != null -> Decision(null, false, null, cameraProblem(now.cameraError))
            !now.cameraReady -> Decision(null, false, null, "the camera isn't running yet")
            else -> Decision(true, true, "Recording", null)
        }
        STOP -> Decision(if (now.recording) false else null, true, "Stopped", null)
        else -> Decision(null, false, null, "unknown command $action")
    }

    /**
     * A camera error from [ReplayRecorder] ("camera error 1 failed", "camera disconnected failed") in
     * words for the review page. Camera2's errors 1 and 2 are the camera in use by another app.
     */
    fun cameraProblem(error: String): String = when {
        error.startsWith("camera error 1 ") || error.startsWith("camera error 2 ") -> "camera busy (another app is using it)"
        error.startsWith("camera disconnected") -> "camera busy (another app took it)"
        else -> "camera problem: $error"
    }

    // ---- The setup voice setting ----

    const val VOICE_COMBINED = "combined"
    const val VOICE_OWN = "own"

    /** The saved setting, or the default: the server combines both phones' verdicts. */
    fun setupVoice(saved: String?) = if (saved == VOICE_OWN) VOICE_OWN else VOICE_COMBINED

    /**
     * Whether this phone says its own camera setup verdicts: set to "own", or the server can't do
     * it (an older server, or not reached lately: then this phone speaks for itself as before).
     */
    fun speaksOwnSetup(setting: String, serverCombines: Boolean) = setting == VOICE_OWN || !serverCombines

    // ---- Talking to the server ----

    /** How long the server may hold a poll open (at most 15); the phone reports in at least this often. */
    const val WAIT_S = 10
    /** A poll answered within this long means the server is doing the combined setup voice. */
    const val LINKED_FOR_MS = 30_000L

    fun url(server: String, angle: String, waitS: Int = WAIT_S): String =
        server.trimEnd('/') + "/api/phones/$angle/poll?wait=$waitS"
}

/**
 * Commands received and answered: each is done once (a poll that's retried can bring one again),
 * and its answer is kept until a poll has taken it to the server.
 */
class CommandInbox(private val remember: Int = 50) {
    private val handled = ArrayDeque<Long>()
    private val acks = mutableListOf<CommandAck>()

    /** True the first time a command id is seen; it's then remembered as handled. */
    @Synchronized fun isNew(id: Long): Boolean {
        if (id in handled) return false
        handled.addLast(id)
        while (handled.size > remember) handled.removeFirst()
        return true
    }

    @Synchronized fun answer(ack: CommandAck) {
        acks.add(ack)
    }

    /** The answers to send with the next poll. */
    @Synchronized fun pending(): List<CommandAck> = acks.toList()

    /** A poll carrying these got through: don't send them again. */
    @Synchronized fun sent(done: List<CommandAck>) {
        acks.removeAll(done.toSet())
    }
}

/**
 * "Start recording when the camera check is good": once per time the app is opened, when this
 * phone's own camera check has held good, start. After any start (and so after a Stop too) it
 * doesn't start again by itself until the app is opened again.
 */
class AutoStart {
    private var used = false

    /** The app was opened again. */
    fun reset() {
        used = false
    }

    /** Recording started, however: auto-start has had its turn. */
    fun started() {
        used = true
    }

    fun shouldStart(enabled: Boolean, checkGood: Boolean, recording: Boolean): Boolean {
        if (!enabled || !checkGood || recording || used) return false
        used = true
        return true
    }
}
