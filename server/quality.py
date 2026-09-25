"""Clip quality, without hand labels: how much light the golfer had, how grainy and flickery the
picture is, and how sharp the hands and lower arms stay in the downswing. For judging a fixed short
shutter (capture app 0.4) against Auto, and for warning when a clip has a light problem.

One record per clip, worked out by the server's pose worker once the pose file is there (app.py)
and saved beside it as <clip>.quality.v<VERSION>.json:

- brightness: the golfer's mean luma (0-255) at address, inside the box around the pose landmarks.
- noise: grain at address, from a still background patch: the robust spread of the difference
  between consecutive frames (after taking out any change of the whole frame), in luma levels.
- flicker: LED and fluorescent lights pulse at 100 or 120 Hz (twice the mains frequency). At a short
  shutter that swings the brightness of the whole picture from frame to frame. The background's mean
  brightness per frame is fitted with a sine at each frequency against the clip's real frame times
  (phones drop frames), and the best fit's size is kept. `mains` says which light frequency would
  show at that frequency at the clip's frame rate (at 240 fps 100 Hz shows as 100 Hz; at 120 fps a
  120 Hz flicker lands exactly on the frame rate and can't be seen from frame to frame at all).
  Rolling-shutter banding (brightness changing across the sensor's lines within one frame) is
  measured apart, from line-mean profiles taken along the sensor's lines, not the upright picture's.
- sharpness: variance of the Laplacian (after a light blur, so grain doesn't count as detail) in a
  crop around the hands and lower arms, at address (P1) and at P5, P6 and P7, the later ones as a
  share of address in the same clip, so clips in different light compare fairly.

Nothing here has been tried on real clips yet: the thresholds are first guesses (see HOME-SETUP.md).
"""
import av
import cv2
import numpy as np

import pose

VERSION = 1

# Warnings. Brightness in luma levels (0-255), noise in luma levels (standard deviation), flicker
# and banding as a share of the mean brightness.
DARK = 70
GRAINY = 2.5
FLICKER = 0.02
# The sine must also explain this share of the frame-to-frame swing, so noise alone never counts.
FLICKER_SHARE = 0.3
BANDING = 0.01
# Frequencies searched for flicker (Hz), and the mains light frequencies it's matched against.
FLICKER_HZ = (5.0, 130.0, 0.25)
MAINS = (100, 120)
# Slow changes (auto exposure, the golfer's shadow) are taken out over this window (s) first.
TREND_SECONDS = 0.25
# The background is measured at this scale; noise and sharpness at full size.
SMALL = 0.25
# Room kept round the golfer for the club, in body heights: to each side, above, and below.
CLUB_ROOM = (0.45, 0.45, 0.1)
# Address, if no key positions: the start of the clip, this long (s).
ADDRESS_FALLBACK = 0.5
# The window before P1 (or the takeaway) measured as address (s): as the noise floor's.
ADDRESS_WINDOW = (0.35, 0.05)
# Hands and lower arms: elbows, wrists and the hand points.
HANDS = (13, 14, 15, 16, 17, 18, 19, 20, 21, 22)
HAND_PAD = 0.06          # round the hand points, in body heights
SHARP_KEYS = ("p1", "p5", "p6", "p7")
SHARP_NEIGHBOURS = 1     # frames either side of each key position, for a steadier median
BODY = range(33)


def body_height(lm) -> float | None:
    """Nose to the lower ankle, in picture heights."""
    h = max(lm[27 * 3 + 1], lm[28 * 3 + 1]) - lm[1]
    return h if h > 0 else None


def box_of(lm, idx, w, h, pad):
    """Pixel box (x0, y0, x1, y1) round landmarks `idx`, grown by pad = (left/right, up, down) pixels."""
    xs = [lm[i * 3] * w for i in idx]
    ys = [lm[i * 3 + 1] * h for i in idx]
    x0, x1 = int(max(0, min(xs) - pad[0])), int(min(w, max(xs) + pad[0]))
    y0, y1 = int(max(0, min(ys) - pad[1])), int(min(h, max(ys) + pad[2]))
    return (x0, y0, x1, y1) if x1 > x0 and y1 > y0 else None


def background_mask(frames, w, h):
    """Where the golfer and club never are, at size (w, h): outside every frame's golfer box grown
    by CLUB_ROOM. The whole picture when no one was tracked; the top and bottom strips if that
    leaves too little."""
    mask = np.ones((h, w), bool)
    for _, lm in frames:
        if lm is None:
            continue
        bh = (body_height(lm) or 0.5) * h
        b = box_of(lm, BODY, w, h, (CLUB_ROOM[0] * bh, CLUB_ROOM[1] * bh, CLUB_ROOM[2] * bh))
        if b:
            mask[b[1]:b[3], b[0]:b[2]] = False
    if mask.mean() < 0.08:
        mask[:] = False
        mask[:max(1, h // 10)] = True
        mask[-max(1, h // 10):] = True
    return mask


def sine_fit(t, y, freqs):
    """For each frequency: amplitude of the best-fitting sine, and the share of y's variance it
    explains. t need not be evenly spaced (a least-squares periodogram); y should have mean 0."""
    arg = 2 * np.pi * np.outer(freqs, t)
    c, s = np.cos(arg), np.sin(arg)
    cc, ss, cs = (c * c).sum(1), (s * s).sum(1), (c * s).sum(1)
    yc, ys = c @ y, s @ y
    det = np.maximum(cc * ss - cs * cs, 1e-12)
    a = (ss * yc - cs * ys) / det
    b = (cc * ys - cs * yc) / det
    total = max(float(y @ y), 1e-12)
    return np.hypot(a, b), (a * yc + b * ys) / total


def detrend(t, y, seconds):
    """y minus its running mean over `seconds` (by time, so dropped frames don't matter)."""
    cum = np.concatenate([[0.0], np.cumsum(y)])
    lo = np.searchsorted(t, t - seconds / 2)
    hi = np.searchsorted(t, t + seconds / 2, side="right")
    return y - (cum[hi] - cum[lo]) / np.maximum(hi - lo, 1)


def alias(f, fs):
    """Where a light flickering at f Hz shows up, sampled at fs frames a second."""
    return abs(f - fs * round(f / fs))


def flicker(t, level):
    """{amplitude, share, hz, mains} of the strongest periodic swing in the background's brightness."""
    t = np.asarray(t, float)
    level = np.asarray(level, float)
    mean = level.mean()
    if len(t) < 20 or mean <= 1:
        return None
    y = detrend(t, level / mean - 1, TREND_SECONDS)
    fs = 1 / float(np.median(np.diff(t)))
    lo, hi, step = FLICKER_HZ
    freqs = np.arange(lo, min(hi, fs / 2) + step / 2, step)
    if not len(freqs):
        return None
    amp, share = sine_fit(t - t[0], y - y.mean(), freqs)
    k = int(np.argmax(share))
    hz = float(freqs[k])
    mains = next((m for m in MAINS if abs(alias(m, fs) - hz) <= 2), None)
    return {"amplitude": float(amp[k]), "share": float(share[k]), "hz": hz, "mains": mains, "fps": fs}


def banding(profiles):
    """How much the brightness varies across the sensor's lines from frame to frame, beyond the
    scene's own light: each frame's line-mean profile over the clip's median one, its spread across
    the lines (the median over frames), as a share of the brightness. Smoothed along the lines
    first: a band spans many of them, grain doesn't (a dark grainy clip otherwise looks banded)."""
    p = np.asarray(profiles, float)
    if len(p) < 5 or p.shape[1] < 8:
        return None
    base = np.median(p, axis=0)
    r = p / np.maximum(base, 1) - 1
    k = max(3, p.shape[1] // 20) | 1
    r = cv2.blur(r.astype(np.float32), (k, 1), borderType=cv2.BORDER_REFLECT)
    r -= r.mean(axis=1, keepdims=True)
    return float(np.median(r.std(axis=1)))


def grain(prev, cur, mask, line_axis):
    """Noise from two frames of a still patch: the robust spread of their difference over the mask,
    per frame (hence the sqrt 2). A change of brightness is taken out first, line by line along the
    sensor's lines (flicker scales every pixel, and with a rolling shutter each line by its own)."""
    a, b = prev.astype(np.float32), cur.astype(np.float32)
    ok = mask & (a > 4) & (a < 250) & (b > 4) & (b < 250)      # clipped pixels have no grain to see
    if ok.sum() < 200:
        return None
    w = ok.astype(np.float32)
    gain = (b * w).sum(axis=line_axis) / np.maximum((a * w).sum(axis=line_axis), 1)
    gain = np.expand_dims(gain, line_axis)
    d = (b - a * gain)[ok]
    d -= np.median(d)
    return float(1.4826 * np.median(np.abs(d)) / np.sqrt(2))


def detail(gray, lm, w, h):
    """Variance of the Laplacian round the hands and lower arms, or None."""
    bh = (body_height(lm) or 0.5) * h
    pad = HAND_PAD * bh
    b = box_of(lm, HANDS, w, h, (pad, pad, pad))
    if b is None or b[2] - b[0] < 8 or b[3] - b[1] < 8:
        return None
    crop = cv2.GaussianBlur(gray[b[1]:b[3], b[0]:b[2]].astype(np.float32), (0, 0), 1.0)
    return float(cv2.Laplacian(crop, cv2.CV_32F).var())


def address_window(times, positions):
    """(from, to) seconds measured as address: just before P1 (or the takeaway), else the start."""
    anchor = positions.get("p1")
    if anchor is not None:
        return anchor - ADDRESS_WINDOW[0] + ADDRESS_WINDOW[1], anchor
    anchor = positions.get("takeaway")
    if anchor is not None:
        return anchor - ADDRESS_WINDOW[0], anchor - ADDRESS_WINDOW[1]
    return times[0], times[0] + ADDRESS_FALLBACK


def nearest(times, t):
    i = int(np.searchsorted(times, t))
    if i > 0 and (i == len(times) or t - times[i - 1] <= times[i] - t):
        i -= 1
    return i


def measure(path: str, frames: list, positions: dict) -> dict:
    """The quality record for one clip.

    frames: [(t, flat [x, y, visibility] * 33 | None)] from its pose file, one per decoded frame.
    positions: {"p1": t, "p5": t, ..., "takeaway": t} in the clip's seconds (any may be missing).
    """
    cv2.setNumThreads(1)
    with av.open(path) as c:
        first = next(c.decode(video=0))
        rotation = int(-getattr(first, "rotation", 0)) % 360
    times = np.array([t for t, _ in frames], float)
    lms = [lm for _, lm in frames]
    # Frame i of the pose file for each decoded frame: they come from the same decode, so the times match.
    key_frames = {}
    for key in SHARP_KEYS:
        if positions.get(key) is not None and len(times):
            i = nearest(times, positions[key])
            key_frames[key] = [j for j in range(i - SHARP_NEIGHBOURS, i + SHARP_NEIGHBOURS + 1) if 0 <= j < len(times)]
    wanted = {j: key for key, js in key_frames.items() for j in js}
    a0, a1 = address_window(times if len(times) else [0.0], positions)

    ts, level, profiles, bright, noise, sharp = [], [], [], [], [], {k: [] for k in SHARP_KEYS}
    mask = mask_full = None
    prev = None
    # Along the sensor's lines: rows of the stored picture, which are columns of an upright portrait one.
    line_axis = 0 if rotation in (90, 270) else 1
    with av.open(path) as c:
        s = c.streams.video[0]
        s.thread_type = "AUTO"
        tb = float(s.time_base)
        for f in c.decode(s):
            if f.pts is None:
                continue
            t = f.pts * tb
            gray = pose.upright_gray(f, rotation)
            h, w = gray.shape
            if mask is None:
                sw, sh = max(8, int(w * SMALL)), max(8, int(h * SMALL))
                mask = background_mask(frames, sw, sh)
                mask_full = cv2.resize(mask.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST) > 0
                weight = mask.astype(np.float32)
                line_n = weight.sum(axis=line_axis)
                lines = line_n >= 0.25 * weight.shape[line_axis]
            small = cv2.resize(gray, mask.shape[::-1], interpolation=cv2.INTER_AREA).astype(np.float32)
            ts.append(t)
            level.append(float(small[mask].mean()))
            if lines.sum() >= 8:
                profiles.append(((small * weight).sum(axis=line_axis)[lines]) / line_n[lines])
            k = nearest(times, t) if len(times) else None
            lm = lms[k] if k is not None and abs(times[k] - t) < 1e-3 else None
            if a0 <= t <= a1:
                if lm is not None:
                    b = box_of(lm, BODY, w, h, (0, 0, 0))
                    if b:
                        bright.append(float(gray[b[1]:b[3], b[0]:b[2]].mean()))
                if prev is not None:
                    n = grain(prev, gray, mask_full, line_axis)
                    if n is not None:
                        noise.append(n)
                prev = gray
            else:
                prev = None
            if k in wanted and lm is not None and abs(times[k] - t) < 1e-3:
                v = detail(gray, lm, w, h)
                if v is not None:
                    sharp[wanted[k]].append(v)

    fl = flicker(ts, level)
    band = banding(profiles)
    med = lambda v: float(np.median(v)) if v else None
    sharpness = None
    address = med(sharp["p1"])
    if address:
        sharpness = {"p1": round(address, 1)}
        for key in SHARP_KEYS[1:]:
            v = med(sharp[key])
            sharpness[key] = None if v is None else round(v / address, 3)
        down = [sharpness[k] for k in SHARP_KEYS[1:] if sharpness[k] is not None]
        sharpness["downswing"] = round(float(np.median(down)), 3) if down else None
    out = {
        "version": VERSION,
        "frames": len(ts),
        "fps": round(fl["fps"], 1) if fl else None,
        "brightness": None if not bright else round(med(bright), 1),
        "background": round(float(np.mean(level)), 1) if level else None,
        "noise": None if not noise else round(med(noise), 2),
        "flicker": None if fl is None else {
            "amplitude": round(fl["amplitude"], 4), "share": round(fl["share"], 3), "hz": fl["hz"], "mains": fl["mains"]},
        "banding": None if band is None else round(band, 4),
        "sharpness": sharpness,
    }
    out["warnings"] = warnings(out)
    return out


def warnings(q: dict) -> list[str]:
    """"dark", "flicker", "grainy": what's wrong with a clip's light."""
    out = []
    if q.get("brightness") is not None and q["brightness"] < DARK:
        out.append("dark")
    fl = q.get("flicker")
    if (fl and fl["amplitude"] >= FLICKER and fl["share"] >= FLICKER_SHARE) or (q.get("banding") or 0) >= BANDING:
        out.append("flicker")
    if q.get("noise") is not None and q["noise"] >= GRAINY:
        out.append("grainy")
    return out


def shutter_group(camera: dict | None) -> str:
    """How a clip was shot, for grouping: "Auto", "1/1000", "1/1000 (compensation)" when the phone
    wouldn't fix the shutter and locked darker instead, or "unknown" for clips from before
    capture app 0.4."""
    if not camera:
        return "unknown"
    setting = camera.get("shutter") or ("Auto" if camera.get("exposure") == "auto" else "unknown")
    how = camera.get("exposure")
    if setting != "Auto" and how and how not in ("manual", "auto"):
        setting += f" ({how})"
    return setting
