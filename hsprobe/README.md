# HS Probe

Throwaway Android app: finds out what frame rates the phone's cameras really give a third-party
app, and proves it by recording 3-second test clips.

- **Camera report** — every camera ID (including unlisted ones Samsung answers for), its AE fps
  ranges, the max normal-session fps per size, advertised constrained high-speed sizes/rates,
  CamcorderProfile high-speed entries, and which encoders claim which size@fps.
- **Tests** — one button per advertised >30 fps configuration. Each records 3 s and reports the
  sensor's actual frame rate, the frame rate stored in the MP4, and exposure time (motion blur).
  Clips are copied to `Movies/HSProbe` on the phone.
- **Share** sends the whole report as text. It is also in logcat: `adb logcat -s HSProbe`.

Open this folder in Android Studio, let it sync, plug in the phone with USB debugging on, Run.
