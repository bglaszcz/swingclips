"""The club shaft's angle in every frame, for the key positions defined by the club (P2, P6, P8).

The shaft is a thin straight line running out from the hands. In each frame, rays are cast from the
hands in every direction and scored by how much a thin band along the ray differs from the empty
scene (a median of frames across the clip) compared with the pixels just either side of it. Anything
on the golfer (MediaPipe's person mask) is ignored, since legs and arms make lines too; so are the
directions back up the forearms. What's left is the shaft wherever it sticks out past the body.

In the fastest part of the downswing the shaft blurs into a faint fan and can't be seen, so the
frames are tied together afterwards: a path through the confident detections that the shaft could
actually swing along, with the angle interpolated in between.

With SWINGCLIPS_CLUB_BACKEND=yolo (models.py), a trained model finds the grip end and the clubhead
instead of the rays (model_scores), blurred clubhead included; the same tracking joins its frames up.

Angles are in degrees in the upright picture, 0 = pointing right, 90 = down (y grows downward).
"""
import av
import cv2
import numpy as np

STEP = 2                                    # degrees between rays
ANGLES = np.deg2rad(np.arange(0, 360, STEP))
# Ray span, as a share of the golfer's nose-to-feet height (a 7-iron is ~0.55 of it).
NEAR, FAR, SAMPLES = 0.1, 0.45, 100
# Band half-widths tried (the shaft is thin when sharp, wider when blurred) and the gap to the sides.
BANDS = (0.0, 0.01, 0.02, 0.035)
SIDE_GAP = 0.025
# Ignore directions within this many degrees of hand -> elbow (the forearm) and hand -> shoulder.
# Kept narrow: down the line the shaft often runs close to the forearms' direction (P3, the top, P6),
# and a wide exclusion threw the real shaft out, leaving a leg edge to win. The arms themselves are
# already masked out.
ARM_EXCLUDE = 15
# At least this share of a ray must be off the golfer to count.
MIN_VISIBLE = 0.25
# How fast the shaft can turn (degrees / second); ~2,500 is about the peak at impact.
MAX_TURN = 3600
# A frame's best ray counts as a sighting at this share of a clear sighting's score or more.
CONFIDENT = 0.35

# The club model: the grip -> clubhead direction scores a bump this wide (sd, degrees) at the
# model's confidence. Where it's surer of the hands than of the grip end (under the hands, often),
# the hands stand in for it, worth HANDS_WEIGHT as much. Grip and head closer than MIN_SPAN of the
# golfer's height give no direction.
MODEL_SPREAD = 4
HANDS_WEIGHT = 0.8
MIN_SPAN = 0.05
# The clubhead is kept for a frame when the model is at least this sure of the club (Ultralytics'
# own default) and of the clubhead (where its plots stop drawing a point).
CLUB_SCORE, HEAD_VISIBLE = 0.25, 0.5

L_SHOULDER, R_SHOULDER, L_ELBOW, R_ELBOW, L_WRIST, R_WRIST, L_INDEX, R_INDEX = 11, 12, 13, 14, 15, 16, 19, 20
NOSE, FEET = 0, (27, 28, 29, 30, 31, 32)


def background(path, rotation, rotate_codes):
    """The scene without anyone moving in it: the median of the clip's keyframes, upright, as BGR."""
    frames = []
    with av.open(path) as c:
        s = c.streams.video[0]
        s.codec_context.skip_frame = "NONKEY"
        for f in c.decode(s):
            img = f.to_ndarray(format="bgr24")
            frames.append(cv2.rotate(img, rotate_codes[rotation]) if rotation in rotate_codes else img)
    return np.median(np.stack(frames), axis=0).astype(np.uint8) if frames else None


def grip(lm, w, h):
    """Where the hands hold the club: between the index fingers, in pixels."""
    return np.array([(lm[L_INDEX][0] + lm[R_INDEX][0]) / 2 * w, (lm[L_INDEX][1] + lm[R_INDEX][1]) / 2 * h])


def body_height(lm, h):
    return max(lm[i][1] for i in FEET) * h - lm[NOSE][1] * h


def scores(img, lm, mask, bg):
    """Score for each ray direction (len(ANGLES) floats), or None if the frame can't be scored."""
    h, w = img.shape[:2]
    height = body_height(lm, h)
    if height <= 0:
        return None
    g = grip(lm, w, h)
    # Only the square the rays can reach.
    reach = int(FAR * height + (max(BANDS) + SIDE_GAP) * height) + 2
    x0, y0 = max(0, int(g[0]) - reach), max(0, int(g[1]) - reach)
    x1, y1 = min(w, int(g[0]) + reach), min(h, int(g[1]) + reach)
    if x1 <= x0 or y1 <= y0:
        return None
    diff = np.linalg.norm(img[y0:y1, x0:x1].astype(np.float32) - bg[y0:y1, x0:x1], axis=2)
    diff = cv2.GaussianBlur(diff, (5, 5), 0)
    diff[mask[y0:y1, x0:x1]] = np.nan

    r = np.linspace(NEAR * height, FAR * height, SAMPLES)
    ca, sa = np.cos(ANGLES)[:, None], np.sin(ANGLES)[:, None]
    gx, gy = g[0] - x0, g[1] - y0

    def along(offset):
        x = (gx + ca * r - sa * offset).astype(np.float32)
        y = (gy + sa * r + ca * offset).astype(np.float32)
        return cv2.remap(diff, x, y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=np.nan)

    best = np.zeros(len(ANGLES), np.float32)
    for band in BANDS:
        half = band * height
        centre = np.mean([along(k) for k in np.linspace(-half, half, 3)], axis=0)
        sides = np.minimum(along(half + SIDE_GAP * height), along(-half - SIDE_GAP * height))
        v = centre - sides
        seen = ~np.isnan(v)
        share = seen.mean(axis=1)
        mean = np.where(seen, v, 0).sum(axis=1) / np.maximum(seen.sum(axis=1), 1)
        # Mostly-hidden rays are worth less; a ray has to be off the golfer for a good part of its length.
        best = np.maximum(best, np.where(share > MIN_VISIBLE, mean * np.sqrt(share), 0))

    for a, b in ((L_WRIST, L_ELBOW), (R_WRIST, R_ELBOW), (L_WRIST, L_SHOULDER), (R_WRIST, R_SHOULDER)):
        away = np.arctan2((lm[b][1] - lm[a][1]) * h, (lm[b][0] - lm[a][0]) * w)
        off = np.abs((ANGLES - away + np.pi) % (2 * np.pi) - np.pi)
        best[off < np.deg2rad(ARM_EXCLUDE)] = 0
    return np.clip(best, 0, None)


def model_scores(found, lm, w, h):
    """scores() from the club model's points: (score, [(x, y, visibility)] for grip, hosel, head in
    picture units) from models.ClubRunner.find, on a picture w x h pixels. None if the frame can't
    be scored; all zeros if the model gives no direction."""
    if found is None or lm is None:
        return None
    height = body_height(lm, h)
    if height <= 0:
        return None
    score, (grip_end, _, head) = found
    hands = grip(lm, w, h)
    best = None
    for (x, y, v), weight in (((grip_end[0] * w, grip_end[1] * h, grip_end[2]), 1.0),
                              ((hands[0], hands[1], 1.0), HANDS_WEIGHT)):
        dx, dy = head[0] * w - x, head[1] * h - y
        if np.hypot(dx, dy) < MIN_SPAN * height:
            continue
        conf = score * min(v, head[2]) * weight
        if best is None or conf > best[0]:
            best = (conf, np.arctan2(dy, dx))
    out = np.zeros(len(ANGLES), np.float32)
    if best is not None:
        off = np.abs((ANGLES - best[1] + np.pi) % (2 * np.pi) - np.pi)
        out[:] = best[0] * np.exp(-0.5 * (off / np.deg2rad(MODEL_SPREAD)) ** 2)
    return out


def clubhead(found):
    """The clubhead for the pose file, [x, y, confidence] (picture units, rounded), or None when the
    model isn't sure of it."""
    if found is None:
        return None
    score, (_, _, (x, y, v)) = found
    if score < CLUB_SCORE or v < HEAD_VISIBLE:
        return None
    return [round(x, 4), round(y, 4), round(score * v, 2)]


def track(times, frame_scores):
    """Shaft angle per frame: [(degrees, confidence 0-1) | None].

    A best path through every frame's scores (Viterbi), where the shaft can't turn faster than
    MAX_TURN; then only frames where that path sits on a confident sighting are kept, and the angle
    is interpolated between them (it's None before the first sighting and after the last).
    """
    n, bins = len(times), len(ANGLES)
    have = [s is not None for s in frame_scores]
    if sum(have) < 10:
        return [None] * n
    s = np.array([f if f is not None else np.zeros(bins) for f in frame_scores], dtype=np.float32)
    clear = np.percentile(s[have].max(axis=1), 90)
    if clear <= 0:
        return [None] * n
    e = np.clip(s / clear, 0, 1)

    idx = np.arange(bins)
    turn = np.abs(idx[:, None] - idx[None, :]) * STEP
    turn = np.minimum(turn, 360 - turn)                        # degrees between every pair of bins
    cost = e[0] * -1
    back = np.zeros((n, bins), np.int32)
    for i in range(1, n):
        dt = max(times[i] - times[i - 1], 1e-3)
        # Beyond the fastest possible turn is ruled out in effect; a small charge per degree otherwise
        # keeps the path from wandering when there's nothing to see.
        trans = np.where(turn > MAX_TURN * dt + STEP, 1e3, turn * 0.002)
        total = cost[:, None] + trans
        back[i] = np.argmin(total, axis=0)
        cost = total[back[i], idx] - e[i]
    path = np.empty(n, np.int32)
    path[-1] = int(np.argmin(cost))
    for i in range(n - 1, 0, -1):
        path[i - 1] = back[i][path[i]]

    conf = e[np.arange(n), path]
    keep = np.where(conf >= CONFIDENT)[0]
    if len(keep) < 2:
        return [None] * n
    # Unwrap along the path so interpolation goes the short way round.
    deg = np.unwrap(np.deg2rad(path * STEP)) * 180 / np.pi
    t = np.asarray(times)
    angle = np.interp(t, t[keep], deg[keep])
    out = [None] * n
    for i in range(keep[0], keep[-1] + 1):
        out[i] = (round(float(angle[i] % 360), 1), round(float(conf[i]), 2))
    return out


def length(lm, ball, w, h):
    """How long to draw the shaft, as a share of the picture height: grip to ball at address, if
    the ball was found, else a typical iron for the golfer's size."""
    g = grip(lm, w, h)
    if ball:
        return round(float(np.hypot(ball["x"] * w - g[0], ball["y"] * h - g[1]) / h), 4)
    return round(float(0.5 * body_height(lm, h) / h), 4)
