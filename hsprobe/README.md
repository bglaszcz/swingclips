# HS Probe

Throwaway Android app for finding out what the phone's cameras really give a third-party app at
high frame rates, by recording short test clips.

The main screen runs the current question: the **frame-drop test**. 240 fps recordings lose about
1 frame in 10; the test records 6 clips alternating A (normal) and B (no per-frame capture results)
and says whether B drops noticeably fewer frames. Any motion in view will do — no swing needed.

**Show advanced tools** has the earlier investigations: 240 vs 120, exposure (manual shutter)
tests, encoder/bitrate options, one button per advertised configuration, and the full camera
report. **Share report** sends everything as text; it is also in logcat: `adb logcat -s HSProbe`.

Clips are copied to `Movies/HSProbe` on the phone; "Pull clips.cmd" on the PC copies them to the
home server.

Open this folder in Android Studio, let it sync, plug in the phone with USB debugging on, Run.
