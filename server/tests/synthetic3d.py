"""A made-up 3D swing seen by two made-up phones, for the 3D tests (test_3d.py).

The golfer is a stick figure with fixed bone lengths in golf axes (x toward the target, y up, z
toward the golfer's front, ball at the origin): legs still, pelvis and thorax turning about their
own axes, both arms straight, and a club. The downswing is timed so the pelvis, thorax, lead arm and
club peak in that order. Two cameras with known lenses and positions (face-on, down the line)
render it into pose-file frames with noise, dropped frames and each clip starting at its own time.
"""
import math

import numpy as np

FPS = 240
DURATION = 3.0
ADDRESS_END, TOP, IMPACT, FINISH = 1.0, 1.8, 2.05, 2.6
# Downswing: (start, duration) of each segment's move from the top; its speed peaks halfway.
PELVIS_DOWN = (1.80, 0.30)
THORAX_DOWN = (1.83, 0.28)
ARM_DOWN = (1.90, 0.20)
CLUB_DOWN = (1.95, 0.12)
PELVIS_TOP, PELVIS_END = 45.0, -40.0
THORAX_TOP, THORAX_END = 90.0, -30.0
ARM_TOP, ARM_END = 150.0, -20.0
HINGE_TOP = 90.0
SPINE_BEND = 35.0               # forward toward the ball
PELVIS_CENTRE = np.array([0.0, 0.95, -0.72])
UPPER_ARM, FOREARM, HAND = 0.30, 0.27, 0.08
THIGH, SHIN = 0.48, 0.46
HANDS_TO_HEAD = 0.81            # a 7 iron: 37 in less the grip above the hands
IMAGE = (1080, 1920)            # upright portrait (w, h)


def smooth(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def ramp(t, a, b, t0, dur):
    return a + (b - a) * smooth((t - t0) / dur)


def turns(t):
    """Degrees (pelvis, thorax, arm, hinge) at time t: + = closed / back."""
    back = smooth((t - ADDRESS_END) / (TOP - ADDRESS_END))
    if t <= TOP:
        return PELVIS_TOP * back, THORAX_TOP * back, ARM_TOP * back, HINGE_TOP * back
    return (ramp(t, PELVIS_TOP, PELVIS_END, *PELVIS_DOWN), ramp(t, THORAX_TOP, THORAX_END, *THORAX_DOWN),
            ramp(t, ARM_TOP, ARM_END, *ARM_DOWN), ramp(t, HINGE_TOP, 0.0, *CLUB_DOWN))


def rot_y(deg):
    a = math.radians(deg)
    return np.array([[math.cos(a), 0, math.sin(a)], [0, 1, 0], [-math.sin(a), 0, math.cos(a)]])


def rot_axis(axis, deg):
    axis = axis / np.linalg.norm(axis)
    a = math.radians(deg)
    k = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + math.sin(a) * k + (1 - math.cos(a)) * k @ k


def skeleton(t):
    """(33 MediaPipe landmarks (33, 3), clubhead (3,)) at time t."""
    p, th, arm, hinge = turns(t)
    X = np.zeros((33, 3))
    # Turning closed (back) swings the lead side toward the ball: -p about y (see metrics3d.js).
    rp = rot_y(-p)
    X[23] = PELVIS_CENTRE + rp @ [0.17, 0, 0]       # lead (left) hip, toward the target
    X[24] = PELVIS_CENTRE + rp @ [-0.17, 0, 0]
    for i, (x, y, z) in {27: (0.22, 0.08, -0.72), 28: (-0.22, 0.08, -0.72), 29: (0.22, 0.03, -0.79),
                         30: (-0.22, 0.03, -0.79), 31: (0.24, 0.02, -0.55), 32: (-0.24, 0.02, -0.55)}.items():
        X[i] = (x, y, z)
    # Knees bent forward, where thigh and shin keep their lengths as the hips turn.
    for hip, knee, ankle in ((23, 25, 27), (24, 26, 28)):
        d = X[ankle] - X[hip]
        n = np.linalg.norm(d)
        u = d / n
        a = (THIGH ** 2 - SHIN ** 2 + n * n) / (2 * n)
        fwd = np.array([0.0, 0, 1]) - u[2] * u
        X[knee] = X[hip] + a * u + math.sqrt(max(THIGH ** 2 - a * a, 0)) * fwd / np.linalg.norm(fwd)
    # Thorax: bent forward, then turned about the vertical.
    rt = rot_y(-th) @ rot_axis(np.array([1.0, 0, 0]), SPINE_BEND)
    up, lat, front = rt @ [0, 1, 0], rt @ [1, 0, 0], rt @ [0, 0, 1]
    chest = PELVIS_CENTRE + 0.5 * up
    X[11], X[12] = chest + 0.2 * lat, chest - 0.2 * lat
    head = chest + 0.25 * up
    X[0] = head + 0.1 * front
    X[7], X[8] = head + 0.08 * lat, head - 0.08 * lat
    for i, s in zip(range(1, 7), (1, 1, 1, -1, -1, -1)):
        X[i] = head + 0.09 * front + 0.035 * s * lat + 0.03 * up
    X[9], X[10] = head + 0.1 * front - 0.05 * up + 0.02 * lat, head + 0.1 * front - 0.05 * up - 0.02 * lat
    # Arms straight, hanging at address, swung about the chest's front axis (to the trail side).
    down = rot_axis(front, -arm) @ (-up)
    for sh, el, wr, idx, pk, th_ in ((11, 13, 15, 19, 17, 21), (12, 14, 16, 20, 18, 22)):
        X[el] = X[sh] + UPPER_ARM * down
        X[wr] = X[el] + FOREARM * down
        X[idx] = X[wr] + HAND * down
        X[pk] = X[wr] + HAND * down - 0.02 * front
        X[th_] = X[wr] + 0.6 * HAND * down + 0.02 * front
    hands = (X[19] + X[20]) / 2
    shaft = rot_axis(front, -hinge) @ down
    return X, hands + HANDS_TO_HEAD * shaft


def look_at(centre, target):
    f = np.asarray(target, float) - centre
    f /= np.linalg.norm(f)
    x = np.cross(f, [0, 1, 0])
    x /= np.linalg.norm(x)
    y = np.cross(f, x)
    R = np.stack([x, y, f])
    return R, -R @ centre


def camera(centre, target=(0.0, 1.0, -0.6), f=1500.0, dist=(0.06, -0.03, 0.0005, -0.0003, 0.0)):
    R, t = look_at(np.asarray(centre, float), target)
    K = [[f, 0, IMAGE[0] / 2 + 7], [0, f * 1.001, IMAGE[1] / 2 - 11], [0, 0, 1]]
    return {"K": K, "dist": list(dist), "R": R.tolist(), "t": t.tolist(), "imageSize": list(IMAGE),
            "position": list(map(float, centre))}


FACE_CAM = (0.1, 1.1, 3.2)
DTL_CAM = (-3.4, 1.25, -0.8)


def session():
    return {"id": "synthetic", "created": 0.0,
            "cameras": {"face": camera(FACE_CAM), "dtl": camera(DTL_CAM)}}


def frame_times(start, drop, rng):
    """Clip times of the frames kept: 240 fps from `start` (world seconds) with a share `drop` lost."""
    t = np.arange(0, DURATION, 1 / FPS)
    keep = rng.random(len(t)) >= drop
    keep[:5] = True
    return t[keep] + start


def render(cam, clip_start, drop, noise_px, rng, hand_vis=0.9, with_club=True):
    """A pose file for one camera: frames [{t (clip seconds), lm, clubhead}], impact (the first
    frame after the ball is hit), rotation 90 (a portrait phone clip). clip_start: world time of the clip's 0 s."""
    import tri
    c = tri.Camera(cam)
    w, h = IMAGE
    frames = []
    world = frame_times(rng.uniform(0, 1 / FPS), drop, rng)
    for tw in world:
        X, head = skeleton(tw)
        px = c.project(np.vstack([X, head[None]]))
        px += rng.normal(0, noise_px, px.shape)
        vis = np.full(33, 0.9)
        vis[[15, 16, 17, 18, 19, 20, 21, 22]] = hand_vis
        lm = [round(float(v), 5) for i in range(33) for v in (px[i, 0] / w, px[i, 1] / h, vis[i])]
        f = {"t": round(float(tw - clip_start), 6), "lm": lm, "club": None}
        if with_club:
            f["clubhead"] = [px[33, 0] / w, px[33, 1] / h, 0.8]
        frames.append(f)
    after = [f["t"] for f in frames if f["t"] + clip_start >= IMPACT]
    # Named 1920x1080 like a phone clip, filmed in portrait: turned 90 degrees to show upright.
    return {"version": 6, "rotation": 90, "frames": frames, "impact": after[0], "ball": None}


def truth(t_world):
    return skeleton(t_world)


# ---- Boards seen by a camera ----

def rays(cam):
    """Each pixel's undistorted normalized ray (h, w, 2) for a camera {K, dist, imageSize}."""
    import cv2
    w, h = cam["imageSize"]
    uu, vv = np.meshgrid(np.arange(w, dtype=np.float64), np.arange(h, dtype=np.float64))
    pts = np.stack([uu, vv], -1).reshape(-1, 1, 2)
    crit = (cv2.TERM_CRITERIA_COUNT | cv2.TERM_CRITERIA_EPS, 30, 1e-10)
    und = cv2.undistortPoints(pts, np.array(cam["K"]), np.array(cam["dist"]), criteria=crit)
    return und.reshape(h, w, 2)


def render_board(spec, rb, tb, cam, ray=None, px_per_mm=4.0, blur=0.8):
    """The board as the camera sees it: board point b (metres, board axes) is at Rb b + tb in the
    camera. Grayscale, grey round the board, with lens distortion, slightly soft."""
    import cv2
    import board as boards
    ray = rays(cam) if ray is None else ray
    margin = spec.square_mm / 2
    img = boards.render(spec, px_per_mm, margin_mm=margin)
    H = np.column_stack([rb[:, 0], rb[:, 1], tb])        # board (x, y, 1) -> camera ray
    Hi = np.linalg.inv(H)
    h, w = ray.shape[:2]
    r = np.concatenate([ray, np.ones((h, w, 1))], -1) @ Hi.T
    bx, by = r[..., 0] / r[..., 2], r[..., 1] / r[..., 2]
    behind = r[..., 2] <= 0
    mx = ((bx * 1000 + margin) * px_per_mm - 0.5).astype(np.float32)
    my = ((by * 1000 + margin) * px_per_mm - 0.5).astype(np.float32)
    mx[behind] = -1
    # Squares much smaller than a board pixel alias: average the board first when it's far.
    out = cv2.remap(img, mx, my, cv2.INTER_AREA if px_per_mm > 2 else cv2.INTER_LINEAR,
                    borderMode=cv2.BORDER_CONSTANT, borderValue=150)
    out = cv2.GaussianBlur(out, (0, 0), blur) if blur else out
    return out


def mat_pose(cam, spec):
    """(Rb, tb) of the mat board lying on the mat, centre on the ball, for a camera in golf axes."""
    import calib
    w, h = spec.size_mm
    centre = np.array([w / 2000, h / 2000, 0.0])
    R, t = np.array(cam["R"]), np.array(cam["t"])
    rb = R @ calib.BOARD_TO_GOLF
    return rb, t - rb @ centre
