"""A made-up swing in the pose file's shape, for testing without real clips: a golfer standing still,
hands swinging round the shoulders (back, top, down to impact, through), and a club shaft.

Face-on, right-handed, 240 fps with some frames dropped the way phones drop them. Times in seconds.
"""
import math
import random

TAKEAWAY, TOP, IMPACT, FINISH = 1.0, 1.75, 2.0, 2.3
FPS, SECONDS = 240, 4.0
NAME = "swing_face_1920x1080_240fps_1789123456_2000ms.mp4"
DTL_NAME = "swing_dtl_1920x1080_240fps_1789123456_2010ms.mp4"


def hand_angle(t):
    """Degrees around the shoulders, y down: 90 = hands straight down (address, impact)."""
    def ease(u):
        return 0.5 - 0.5 * math.cos(math.pi * min(1.0, max(0.0, u)))
    if t < TAKEAWAY:
        return 90.0
    if t < TOP:
        return 90 + 115 * ease((t - TAKEAWAY) / (TOP - TAKEAWAY))
    if t < IMPACT:
        u = (t - TOP) / (IMPACT - TOP)
        return 205 - 115 * u * u            # speeding up into impact
    if t < FINISH:
        u = (t - IMPACT) / (FINISH - IMPACT)
        return 90 - 130 * (2 * u - u * u)   # slowing down into the finish
    return -40.0


def landmarks(t, aspect):
    """Flat [x, y, visibility] * 33 in picture units (x across the width, y down the height)."""
    pts = {i: (0.5, 0.5) for i in range(33)}
    X = lambda dx: 0.5 + dx / aspect         # dx in picture heights from the middle
    pts[0] = (X(0), 0.30)                    # nose
    for i in range(1, 11):
        pts[i] = (X(0.01 * (i % 3 - 1)), 0.29)
    pts[7], pts[8] = (X(0.03), 0.30), (X(-0.03), 0.30)
    # The golfer faces the camera: their left is on the picture's right.
    pts[11], pts[12] = (X(0.07), 0.40), (X(-0.07), 0.40)
    pts[23], pts[24] = (X(0.05), 0.56), (X(-0.05), 0.56)
    pts[25], pts[26] = (X(0.05), 0.68), (X(-0.05), 0.68)
    pts[27], pts[28] = (X(0.06), 0.80), (X(-0.06), 0.80)
    pts[29], pts[30] = (X(0.055), 0.81), (X(-0.055), 0.81)
    pts[31], pts[32] = (X(0.08), 0.815), (X(-0.08), 0.815)
    a = math.radians(hand_angle(t))
    # Hands swing to the picture's left (the golfer's right) going back.
    gx, gy = 0.2 * math.cos(a), 0.42 + 0.2 * math.sin(a)
    pts[15], pts[16] = (X(gx + 0.005), gy), (X(gx - 0.005), gy + 0.005)
    pts[19], pts[20] = (X(gx + 0.005), gy + 0.02), (X(gx - 0.005), gy + 0.025)
    pts[17], pts[18], pts[21], pts[22] = pts[19], pts[20], pts[19], pts[20]
    pts[13] = ((pts[11][0] + pts[15][0]) / 2, (pts[11][1] + pts[15][1]) / 2 + 0.01)
    pts[14] = ((pts[12][0] + pts[16][0]) / 2, (pts[12][1] + pts[16][1]) / 2 + 0.01)
    return [v for i in range(33) for v in (round(pts[i][0], 5), round(pts[i][1], 5), 0.95)]


def club(t):
    """[shaft angle in degrees in the picture (0 = right, 90 = down), confidence]."""
    h = hand_angle(t)
    deg = (h + (h - 90) * 0.9) % 360
    blurred = TOP + 0.1 < t < IMPACT + 0.05
    return [round(deg, 2), 0.1 if blurred else 0.8]


def pose_file(drop=0.1, seed=1, rotation=90):
    """The pose file's content for the synthetic swing (as pose.analyze returns it)."""
    rng = random.Random(seed)
    aspect = 1080 / 1920 if rotation in (90, 270) else 1920 / 1080
    frames = []
    for k in range(int(FPS * SECONDS)):
        t = k / FPS
        if k and rng.random() < drop:
            continue
        frames.append({"t": round(t, 6), "lm": landmarks(t, aspect), "w": None, "club": club(t)})
    return {"version": 6, "rotation": rotation, "seconds": 1.0, "ball": {"x": 0.5, "y": 0.8, "r": 0.01},
            "impact": IMPACT, "clubLength": 0.3, "frames": frames}
