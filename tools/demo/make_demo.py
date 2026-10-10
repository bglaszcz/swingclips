#!/usr/bin/env python3
"""Generate deterministic demo data for SwingClips documentation and screenshots.

Run with:
    python tools/demo/make_demo.py
or
    ..\\swingclips\\server\\.venv\\Scripts\\python.exe tools/demo/make_demo.py
"""

from __future__ import annotations

import datetime
import json
import math
from pathlib import Path
import random

SEED = 42

DATA_DIR = Path(__file__).resolve().parent / "data"


def make_session_schedule() -> tuple[list[datetime.datetime], str]:
    """Generate 21 sessions spread across 10 weeks ending yesterday."""
    now = datetime.datetime.now()
    today = now.date()
    yesterday = today - datetime.timedelta(days=1)
    this_monday = today - datetime.timedelta(days=today.weekday())

    sessions = []

    # Newest week (ending yesterday): 3 sessions
    # e.g. Monday, Wednesday, Friday (yesterday)
    # If yesterday is Friday (weekday 4):
    if yesterday.weekday() >= 4:
        sessions.append(datetime.datetime.combine(this_monday, datetime.time(10, 0)))
        sessions.append(datetime.datetime.combine(this_monday + datetime.timedelta(days=2), datetime.time(14, 30)))
        sessions.append(datetime.datetime.combine(yesterday, datetime.time(10, 15)))
    elif yesterday.weekday() >= 2:
        sessions.append(datetime.datetime.combine(this_monday, datetime.time(10, 0)))
        sessions.append(datetime.datetime.combine(this_monday + datetime.timedelta(days=1), datetime.time(14, 30)))
        sessions.append(datetime.datetime.combine(yesterday, datetime.time(10, 15)))
    else:
        # Fallback if run on Monday/Tuesday
        sessions.append(datetime.datetime.combine(yesterday - datetime.timedelta(days=4), datetime.time(10, 0)))
        sessions.append(datetime.datetime.combine(yesterday - datetime.timedelta(days=2), datetime.time(14, 30)))
        sessions.append(datetime.datetime.combine(yesterday, datetime.time(10, 15)))

    # Preceding 9 weeks: 2 sessions each (Tuesday, Thursday)
    for w in range(1, 10):
        w_monday = this_monday - datetime.timedelta(weeks=w)
        sessions.append(datetime.datetime.combine(w_monday + datetime.timedelta(days=1), datetime.time(10, 0)))
        sessions.append(datetime.datetime.combine(w_monday + datetime.timedelta(days=3), datetime.time(14, 30)))

    sessions.sort()

    # Focus started about 4 weeks before the latest session
    target_date = sessions[-1].date() - datetime.timedelta(days=28)
    focus_idx = min(range(len(sessions)), key=lambda i: abs((sessions[i].date() - target_date).days))
    focus_start_date = sessions[focus_idx].strftime("%Y-%m-%d")

    return sessions, focus_start_date


def generate_demo_data() -> None:
    random.seed(SEED)
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    session_schedule, focus_start_date = make_session_schedule()

    all_clips = []
    swings_records = {}
    shot_number = 1000

    for sess_idx, sess_start in enumerate(session_schedule):
        is_after_focus = sess_start.strftime("%Y-%m-%d") >= focus_start_date
        is_latest_sess = (sess_idx == len(session_schedule) - 1)
        curr_time = sess_start

        # Determine target share for I7 if after focus so bars climb from ~45% to ~75%
        focus_sess_idx = next(i for i, s in enumerate(session_schedule) if s.strftime("%Y-%m-%d") >= focus_start_date)
        num_since = len(session_schedule) - focus_sess_idx
        sess_since = sess_idx - focus_sess_idx
        if is_after_focus and num_since > 1:
            target_share = 0.44 + 0.32 * (sess_since / (num_since - 1))
            num_in_target = int(round(14 * target_share))
            i7_target_set = set(random.sample(range(14), num_in_target))
        else:
            i7_target_set = set()
        i7_counter = 0

        # 28 swings per session: PW, 9 iron, 7 iron, driver (both irons and woods >= 8)
        club_sequence = (
            ["PW"] * 3
            + ["I9"] * 3
            + ["I7"] * 14
            + ["DR"] * 8
        )

        for swing_idx, club in enumerate(club_sequence):
            shot_number += 1
            gap_seconds = random.randint(65, 85)
            curr_time += datetime.timedelta(seconds=gap_seconds)
            ts = int(curr_time.timestamp())
            iso_time = curr_time.isoformat()
            duration_ms = random.randint(2100, 2250)

            face_name = f"swing_face_1920x1080_240fps_{ts}_{duration_ms}ms.mp4"
            dtl_name = f"swing_dtl_1920x1080_240fps_{ts}_{duration_ms - 10}ms.mp4"

            # 1. Within-session correlated hip motion (leads to confirmed link with smash & carry)
            if club == "I7":
                if is_after_focus:
                    in_target = (i7_counter in i7_target_set)
                    delta = random.uniform(0.06, 0.45)
                    if in_target:
                        lead_hip_p6 = round(2.0 + delta, 2)
                        delta_hip = delta
                    else:
                        lead_hip_p6 = round(2.0 - delta, 2)
                        delta_hip = -delta
                    i7_counter += 1
                else:
                    delta_hip = random.normalvariate(0.0, 0.3)
                    lead_hip_p6 = round(2.0 + delta_hip, 2)
            elif club == "DR":
                delta_hip = random.normalvariate(0.0, 0.4)
                base_hip = 4.0 if is_after_focus else 2.5
                lead_hip_p6 = round(base_hip + delta_hip, 2)
            elif club == "PW":
                delta_hip = random.normalvariate(0.0, 0.4)
                base_hip = 3.5 if is_after_focus else 2.2
                lead_hip_p6 = round(base_hip + delta_hip, 2)
            else:  # I9
                delta_hip = random.normalvariate(0.0, 0.4)
                base_hip = 3.8 if is_after_focus else 2.1
                lead_hip_p6 = round(base_hip + delta_hip, 2)

            # 2. Launch monitor metrics per club
            if club == "I7":
                progress_ratio = sess_since / (num_since - 1) if (is_after_focus and num_since > 1) else 0.0
                club_speed = round(random.normalvariate(84.5 + 2.0 * progress_ratio, 0.8), 2)
                base_smash = 1.30 + 0.05 * progress_ratio
                smash = round(base_smash + 0.04 * delta_hip + random.normalvariate(0, 0.003), 2)
                ball_speed = round(club_speed * smash, 2)
                base_carry = 146.0 + 7.5 * progress_ratio
                carry = round(base_carry + 5.0 * delta_hip + random.normalvariate(0, 0.8), 1)
                total = round(carry + 2.8, 1)
                attack = round(random.normalvariate(-3.8 if is_after_focus else -3.2, 0.35), 2)
                loft = round(random.normalvariate(28.0, 0.5), 2)
                path = round(random.normalvariate(-1.0, 0.5), 2)
                face = round(random.normalvariate(0.2, 0.4), 2)
                vla = round(random.normalvariate(20.8, 0.5), 2)
                spin = int(random.normalvariate(6600, 180))
                strike_h = round(random.normalvariate(0.0, 2.5), 2)
                strike_v = round(random.normalvariate(0.0, 2.0), 2)

            elif club == "PW":
                club_speed = round(random.normalvariate(78.0, 1.0), 2)
                smash = round(1.24 + 0.02 * delta_hip + random.normalvariate(0, 0.005), 2)
                ball_speed = round(club_speed * smash, 2)
                carry = round(118.0 + 3.0 * delta_hip + random.normalvariate(0, 1.2), 1)
                total = round(carry + 1.5, 1)
                attack = round(random.normalvariate(-4.5, 0.4), 2)
                loft = round(random.normalvariate(39.0, 0.6), 2)
                path = round(random.normalvariate(-1.2, 0.5), 2)
                face = round(random.normalvariate(0.2, 0.4), 2)
                vla = round(random.normalvariate(25.5, 0.6), 2)
                spin = int(random.normalvariate(8500, 200))
                strike_h = round(random.normalvariate(0.0, 2.2), 2)
                strike_v = round(random.normalvariate(0.0, 1.8), 2)

            elif club == "I9":
                club_speed = round(random.normalvariate(81.0, 0.9), 2)
                smash = round(1.28 + 0.02 * delta_hip + random.normalvariate(0, 0.005), 2)
                ball_speed = round(club_speed * smash, 2)
                carry = round(132.0 + 3.5 * delta_hip + random.normalvariate(0, 1.2), 1)
                total = round(carry + 2.0, 1)
                attack = round(random.normalvariate(-4.0, 0.4), 2)
                loft = round(random.normalvariate(34.0, 0.6), 2)
                path = round(random.normalvariate(-1.4, 0.5), 2)
                face = round(random.normalvariate(0.3, 0.4), 2)
                vla = round(random.normalvariate(22.8, 0.6), 2)
                spin = int(random.normalvariate(7400, 190))
                strike_h = round(random.normalvariate(0.0, 2.4), 2)
                strike_v = round(random.normalvariate(0.0, 2.0), 2)

            else:  # DR
                club_speed = round(random.normalvariate(101.5, 1.2), 2)
                smash = round(1.44 + 0.025 * delta_hip + random.normalvariate(0, 0.006), 2)
                ball_speed = round(club_speed * smash, 2)
                carry = round(234.0 + 5.0 * delta_hip + random.normalvariate(0, 2.5), 1)
                total = round(carry + 16.0, 1)
                attack = round(random.normalvariate(1.5, 0.5), 2)
                loft = round(random.normalvariate(12.5, 0.6), 2)
                path = round(random.normalvariate(-1.0, 0.6), 2)
                face = round(random.normalvariate(0.5, 0.5), 2)
                vla = round(random.normalvariate(13.2, 0.6), 2)
                spin = int(random.normalvariate(2600, 150))
                strike_h = round(random.normalvariate(0.5, 3.0), 2)
                strike_v = round(random.normalvariate(0.5, 2.5), 2)

            # 3. Ball flight shapes to populate all 9 cells of the 3x3 grid
            # Thresholds: start line +-2.0 deg, curve +-0.025 * carry
            thresh_curve = carry * 0.025
            r_cat = random.random()
            if is_latest_sess and club == "I7":
                # Latest session has higher share of straight shots (~60%)
                if r_cat < 0.60:
                    cat_start, cat_curve = "straight", "straight"
                elif r_cat < 0.75:
                    cat_start, cat_curve = "straight", "right"
                elif r_cat < 0.88:
                    cat_start, cat_curve = "straight", "left"
                elif r_cat < 0.94:
                    cat_start, cat_curve = "right", "right"
                elif r_cat < 0.97:
                    cat_start, cat_curve = "left", "left"
                else:
                    cat_start, cat_curve = "right", "straight"
            else:
                if r_cat < 0.44:
                    cat_start, cat_curve = "straight", "straight"
                elif r_cat < 0.60:
                    cat_start, cat_curve = "straight", "right"  # Fade
                elif r_cat < 0.74:
                    cat_start, cat_curve = "straight", "left"   # Draw
                elif r_cat < 0.80:
                    cat_start, cat_curve = "right", "right"     # Push fade
                elif r_cat < 0.86:
                    cat_start, cat_curve = "right", "straight"  # Push
                elif r_cat < 0.91:
                    cat_start, cat_curve = "right", "left"      # Push draw
                elif r_cat < 0.95:
                    cat_start, cat_curve = "left", "left"       # Pull draw
                elif r_cat < 0.98:
                    cat_start, cat_curve = "left", "straight"   # Pull
                else:
                    cat_start, cat_curve = "left", "right"      # Pull fade

            if cat_start == "straight":
                hla = round(random.uniform(-1.4, 1.4), 2)
            elif cat_start == "right":
                hla = round(random.uniform(2.3, 3.8), 2)
            else:  # left
                hla = round(random.uniform(-3.8, -2.3), 2)

            if cat_curve == "straight":
                curve_yd = round(random.uniform(-0.6 * thresh_curve, 0.6 * thresh_curve), 1)
                spin_axis = round(random.uniform(-0.8, 0.8), 2)
            elif cat_curve == "left":
                curve_yd = round(-thresh_curve - random.uniform(0.8, 3.2), 1)
                spin_axis = round(random.uniform(-4.5, -2.2), 2)
            else:  # right
                curve_yd = round(thresh_curve + random.uniform(0.8, 3.2), 1)
                spin_axis = round(random.uniform(2.2, 4.5), 2)

            offline = round(carry * math.tan(math.radians(hla)) + curve_yd, 1)

            strike_v_raw = round(strike_v - 14.0, 2)

            shot_data = {
                "received": f"{iso_time}.000-05:00",
                "source": "square-app",
                "device": "Square Golf app",
                "shotNumber": shot_number,
                "session": f"demo_{sess_start.strftime('%d%b%Y')}",
                "mode": "DrivingRange",
                "club": club,
                "ball": {
                    "speed": ball_speed,
                    "vla": vla,
                    "hla": hla,
                    "totalSpin": spin,
                    "backSpin": int(spin * 0.98),
                    "sideSpin": int(spin * 0.1),
                    "spinAxis": spin_axis,
                    "carry": carry,
                    "total": total,
                    "side": offline,
                    "apexFt": 95 if club != "DR" else 105,
                    "landingAngle": 48 if club != "DR" else 38,
                },
                "clubData": {
                    "speed": club_speed,
                    "smash": smash,
                    "angleOfAttack": attack,
                    "faceToTarget": face,
                    "path": path,
                    "loft": loft,
                    "faceImpactH": strike_h,
                    "faceImpactV": strike_v,
                    "faceImpactVRaw": strike_v_raw,
                },
                "gap": 12.0,
            }

            quality_obj = {
                "version": 2,
                "frames": 516,
                "fps": 240,
                "brightness": 108.5,
                "background": 60.0,
                "noise": 0.4,
                "flicker": {"amplitude": 0.01, "share": 0.05, "hz": 20.0, "mains": None},
                "banding": 0.008,
                "sharpness": {"p1": 2.4, "p5": 0.75, "p6": 0.3, "p7": 0.28, "downswing": 0.3},
                "sharpnessSkipped": None,
                "impact": {"ok": True, "why": None, "clips": [{"angle": "face", "ball": True, "lead": 240}]},
                "shutter": "unknown",
                "warnings": [],
                "flickerLevel": "none",
                "poseVersion": 6,
                "poseModel": "rtmpose-m-256x192+ball4+deep+onset+hip1",
                "positions": {"p1": 0.85, "p5": 2.14, "p6": 2.18, "p7": 2.23},
            }

            face_clip = {
                "name": face_name,
                "size": 14200000,
                "recorded": iso_time,
                "pose": "done",
                "angle": "face",
                "strike": 2.15,
                "partner": dtl_name,
                "camera": None,
                "quality": quality_obj,
                "calib": None,
                "drill": None,
                "excluded": False,
                "shot": shot_data,
            }

            dtl_clip = {
                "name": dtl_name,
                "size": 13900000,
                "recorded": iso_time,
                "pose": "done",
                "angle": "dtl",
                "strike": 2.14,
                "partner": face_name,
                "camera": None,
                "quality": quality_obj,
                "calib": None,
                "drill": None,
                "excluded": False,
                "shot": None,
            }

            all_clips.append(face_clip)
            all_clips.append(dtl_clip)

            # Body record for face-on clip
            body_dict = {
                "tempo": round(random.normalvariate(2.85, 0.08), 2),
                "backswing": round(random.normalvariate(0.78, 0.02), 3),
                "downswing": round(random.normalvariate(0.27, 0.01), 3),
                "releaseArm": round(random.normalvariate(-28.0, 4.5), 1),
                "shoulderTop": round(random.normalvariate(115.5, 2.5), 1),
                "pelvisTop": round(random.normalvariate(46.2, 2.0), 1),
                "xFactor": round(random.normalvariate(69.3, 2.0), 1),
                "hipSway": round(random.normalvariate(4.3, 0.3), 1),
                "leadHipP6": lead_hip_p6,
                "trailHipTop": round(random.normalvariate(-1.5, 0.3), 1),
                "handsAhead": round(random.normalvariate(2.6, 0.3), 1),
                "pelvisBall": round(random.normalvariate(5.8, 0.4), 1),
                "chestBall": round(random.normalvariate(4.8, 0.4), 1),
                "headSway": round(random.normalvariate(1.5, 0.2), 1),
                "headRise": round(random.normalvariate(-0.8, 0.2), 1),
                "spineTiltImpact": round(random.normalvariate(4.1, 0.4), 1),
                "lagP5": round(random.normalvariate(65.5, 1.5), 1),
                "earlyExt": round(random.normalvariate(2.2, 0.3), 1),
                "bendLoss": round(random.normalvariate(-8.5, 0.8), 1),
                "headToBall": round(random.normalvariate(-0.8, 0.2), 1),
                "handsPlaneP6": round(random.normalvariate(4.2, 0.4), 1),
                "shaftPlaneP6": None,
                "handsPlaneTop": round(random.normalvariate(9.8, 0.6), 1),
                "handHeightTop": round(random.normalvariate(10.5, 0.4), 1),
                "handDepthTop": round(random.normalvariate(10.8, 0.4), 1),
            }

            swings_records[face_name] = {
                "body": body_dict,
                "drill": None,
                "quality": {"swingFound": True, "noSwing": None},
                "setup": None,
                "code": "demo",
                "partner": dtl_name,
                "poseModel": "rtmpose-m-256x192+ball4+deep+onset+hip1",
                "key3d": None,
                "body3d": None,
                "why3d": None,
            }

    # Clips list must be newest first
    all_clips.sort(key=lambda c: c["recorded"], reverse=True)

    # 1. clips.json
    with open(DATA_DIR / "clips.json", "w", encoding="utf-8") as f:
        json.dump(all_clips, f, indent=1)

    latest_sess = session_schedule[-1]
    latest_sess_ts = int(latest_sess.timestamp())
    latest_sess_ms = latest_sess_ts * 1000

    # 2. noise.json
    noise_keys = {}
    for k in [
        "tempo", "backswing", "downswing", "releaseArm", "shoulderTop", "pelvisTop",
        "xFactor", "hipSway", "leadHipP6", "trailHipTop", "handsAhead", "pelvisBall",
        "chestBall", "headSway", "headRise", "spineTiltImpact", "lagP5", "earlyExt",
        "bendLoss", "headToBall", "handsPlaneP6", "handsPlaneTop", "handHeightTop",
        "handDepthTop"
    ]:
        noise_keys[f"face.{k}"] = {
            "noise": 0.001,
            "spread": 0.005,
            "ratio": 0.2,
            "clips": len(all_clips) // 2,
            "swings": len(all_clips) // 2,
            "sessions": len(session_schedule),
            "shaky": False,
        }
    noise_obj = {
        "swings": len(all_clips) // 2,
        "sessions": len(session_schedule),
        "share": 0.5,
        "keys": noise_keys,
        "code": "demo",
        "updated": latest_sess.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    with open(DATA_DIR / "noise.json", "w", encoding="utf-8") as f:
        json.dump(noise_obj, f, indent=1)

    # 3. swings.json
    swings_obj = {
        "code": "demo",
        "swings": swings_records,
        "noise": noise_obj,
    }
    with open(DATA_DIR / "swings.json", "w", encoding="utf-8") as f:
        json.dump(swings_obj, f, indent=1)

    # 4. goodshots.json
    goodshots_obj = {
        "settings": {
            "minCount": 8,
            "irons": {
                "offlinePct": 5,
                "carryBelowPct": 10,
                "carryAbovePct": 12,
                "smashBelow": 0,
            },
            "woods": {
                "offlinePct": 6,
                "carryBelowPct": 10,
                "carryAbovePct": 12,
                "smashBelow": 0,
            },
            "strike": {
                "on": True,
                "heelToeMm": 20,
                "highLowMm": 20,
            },
        },
        "defaults": {
            "minCount": 8,
            "irons": {
                "offlinePct": 5,
                "carryBelowPct": 10,
                "carryAbovePct": 12,
                "smashBelow": 0,
            },
            "woods": {
                "offlinePct": 6,
                "carryBelowPct": 10,
                "carryAbovePct": 12,
                "smashBelow": 0,
            },
            "strike": {
                "on": True,
                "heelToeMm": 20,
                "highLowMm": 20,
            },
        },
    }
    with open(DATA_DIR / "goodshots.json", "w", encoding="utf-8") as f:
        json.dump(goodshots_obj, f, indent=1)

    # 5. journal.json
    earliest_date = session_schedule[0].strftime("%Y-%m-%d")
    latest_date = session_schedule[-1].strftime("%Y-%m-%d")
    journal_obj = {
        "handicap": [
            {"date": earliest_date, "index": 9.4},
            {"date": latest_date, "index": 8.8},
        ],
        "notes": {},
        "focus": {
            "move": "leadHipP6",
            "aim": "more",
            "club": "I7",
            "results": ["carry", "smash"],
            "since": focus_start_date,
        },
        "focuses": [
            {
                "move": "leadHipP6",
                "aim": "more",
                "club": "I7",
                "results": ["carry", "smash"],
                "since": focus_start_date,
            }
        ],
    }
    with open(DATA_DIR / "journal.json", "w", encoding="utf-8") as f:
        json.dump(journal_obj, f, indent=1)

    # 6. status.json
    status_obj = {
        "level": "ok",
        "headline": "Ready to hit: Square connected · both phones connected",
        "rows": [
            {"key": "face", "label": "Face-on", "angle": "face", "level": "ok", "text": "connected · battery 95% · Wi-Fi strong"},
            {"key": "dtl", "label": "Down the line", "angle": "dtl", "level": "ok", "text": "connected · battery 91% · Wi-Fi strong"},
            {"key": "square", "label": "Square", "level": "ok", "text": "Square connected (driving range)"},
            {"key": "framing", "label": "Framing", "level": "ok", "text": "both cameras in position"},
            {"key": "server", "label": "Server", "level": "ok", "text": "Pose: up to date"},
            {"key": "agent", "label": "Laptop launcher", "level": "ok", "text": "laptop: running · shots from Square"},
        ],
        "phones": {
            "face": {
                "connected": True,
                "recording": False,
                "age": 1.2,
                "expected": True,
                "speaks": False,
                "trigger": {
                    "sensitivity": 100,
                    "setting": None,
                    "threshold": 10.0,
                    "softest": 38.5,
                    "middle": 71.0,
                    "noise": 1.4,
                    "strikes": 24,
                },
                "command": None,
            },
            "dtl": {
                "connected": True,
                "recording": False,
                "age": 1.5,
                "expected": True,
                "speaks": False,
                "trigger": {
                    "sensitivity": 100,
                    "setting": None,
                    "threshold": 10.0,
                    "softest": 41.0,
                    "middle": 76.5,
                    "noise": 1.6,
                    "strikes": 24,
                },
                "command": None,
            },
        },
        "speaker": None,
        "relay": None,
        "agent": {
            "connected": True,
            "computer": "laptop",
            "source": "Square Golf app",
            "age": 2.1,
            "commands": [],
        },
        "combined": None,
        "session": {
            "start": latest_sess_ts,
            "first": latest_sess_ts,
            "last": latest_sess_ts + 2400,
            "spoken": [],
        },
        "commands": [],
    }
    with open(DATA_DIR / "status.json", "w", encoding="utf-8") as f:
        json.dump(status_obj, f, indent=1)

    # 7. setup.json
    setup_obj = {"face": None, "dtl": None}
    with open(DATA_DIR / "setup.json", "w", encoding="utf-8") as f:
        json.dump(setup_obj, f, indent=1)

    # 8. calib.json
    calib_obj = {
        "enabled": False,
        "phones": {},
        "lenses": [],
        "recording": None,
        "job": None,
        "tripods": None,
        "height": 1.85,
        "swingsSinceTripods": 0,
        "moved": None,
        "clips": {},
        "lensClips": {},
        "leftover": [],
        "session": None,
        "health": [],
    }
    with open(DATA_DIR / "calib.json", "w", encoding="utf-8") as f:
        json.dump(calib_obj, f, indent=1)

    # 9. practice.json
    practice_obj = {
        "config": {"on": False, "metric": "path", "min": -2.0, "max": 2.0, "club": "I7"},
        "metrics": [],
        "log": [],
        "listeners": {},
        "timing": {},
    }
    with open(DATA_DIR / "practice.json", "w", encoding="utf-8") as f:
        json.dump(practice_obj, f, indent=1)

    # 10. plan-step.json
    plan_step_obj = {"step": None}
    with open(DATA_DIR / "plan-step.json", "w", encoding="utf-8") as f:
        json.dump(plan_step_obj, f, indent=1)

    # 11. program.json and program-report.json
    program_obj = {
        "program": None,
        "programs": [
            {
                "id": "lowpoint",
                "name": "Low point forward",
                "from": f"Coach review {latest_sess.strftime('%b %Y')}",
                "cap": 30,
                "clubs": "7 iron only",
                "bringBack": "Per swing: attack angle, dynamic loft, face to path, strike height, carry",
                "blocks": [
                    {"id": "leadfoot", "name": "Lead foot only", "drill": "leadfoot", "ball": False, "reps": 10, "gate": {"kind": "streak", "need": 10}},
                    {"id": "stepthrough", "name": "Step through", "drill": "stepthrough", "ball": False, "reps": 10, "gate": {"kind": "streak", "need": 10}},
                    {"id": "flush", "name": "Flush line", "drill": None, "ball": True, "reps": 10, "gate": {"kind": "count", "need": 8, "of": 10, "checks": [{"key": "attack", "min": -5, "max": -2}]}},
                ],
            }
        ],
        "log": [
            {
                "id": "lowpoint",
                "name": "Low point forward",
                "started": latest_sess_ts,
                "finished": latest_sess_ts + 1800,
                "blocks": [],
            }
        ],
    }
    with open(DATA_DIR / "program.json", "w", encoding="utf-8") as f:
        json.dump(program_obj, f, indent=1)

    prog_report_text = (
        f"Low point forward: {latest_sess.strftime('%b %d %Y, %H:%M')}\n"
        "Swings: 30 of the 30 cap.\n"
        "Club order: 7i x30\n"
        "Setup notes: none (nothing changed)\n"
        "Strike calibration: median -0.2 on the first 10 readable 7i (usual 0 ± 4): IN RANGE: strike gated this session.\n\n"
        "Lead foot only: gate 10 in a row: passed (10 in a row).\n"
        "  10 reps, no ball: ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓\n\n"
        "Step through: gate 10 of 10: passed (10 of 10 passed, 10 needed).\n"
        "  10 reps, no ball: ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓\n\n"
        "Flush line: gate 8 of 10: passed (9 of 10 passed, 8 needed).\n"
        "  Shots 1-10: attack angle -3.8° (-5.1 to -2.0); dynamic loft 28.1° (19.2 to 30.0); face to path +1.8° (-1.5 to +4.2); strike height 1 mm high (4 mm low to 5 mm high); carry 152 yd, SD 4 yd; hands ahead of ball at impact +2.2 in (camera, 10 swings); hips vs ball at impact +4.5 in (camera, 10 swings); chest vs ball at impact +3.4 in (camera, 10 swings)\n"
    )
    program_report_obj = {
        "text": prog_report_text,
        "started": latest_sess_ts,
        "frame": None,
    }
    with open(DATA_DIR / "program-report.json", "w", encoding="utf-8") as f:
        json.dump(program_report_obj, f, indent=1)

    # 12. drill.json and game.json
    with open(DATA_DIR / "drill.json", "w", encoding="utf-8") as f:
        json.dump({"current": None, "drills": [], "periods": []}, f, indent=1)

    with open(DATA_DIR / "game.json", "w", encoding="utf-8") as f:
        json.dump({"game": None, "games": [], "log": []}, f, indent=1)

    # 13. AI coach status, notes, models
    coach_status_obj = {
        "ready": True,
        "provider": "anthropic",
        "model": "claude-opus-5-5",
        "baseUrl": "",
        "providers": [
            {"id": "anthropic", "name": "Anthropic (Claude)", "hasKey": True, "keys": "console.anthropic.com"},
            {"id": "openai", "name": "OpenAI (ChatGPT)", "hasKey": False, "keys": "platform.openai.com"},
            {"id": "google", "name": "Google (Gemini)", "hasKey": False, "keys": "aistudio.google.com"},
            {"id": "other", "name": "Other (OpenAI-compatible)", "hasKey": False, "keys": "your provider's dashboard"},
        ],
        "callsToday": 1,
        "cap": 10,
        "howToAdd": "Make an API key at console.anthropic.com, then paste it here.",
    }
    with open(DATA_DIR / "coach-status.json", "w", encoding="utf-8") as f:
        json.dump(coach_status_obj, f, indent=1)

    coach_models_obj = {
        "models": ["claude-opus-5-5", "claude-sonnet-4-5", "claude-haiku-4-5"]
    }
    with open(DATA_DIR / "coach-models.json", "w", encoding="utf-8") as f:
        json.dump(coach_models_obj, f, indent=1)

    coach_note_text = (
        "**How it went**\n"
        "A solid session: 82% good shots, better than your usual 64%. The 7 iron was crisp and on line, carrying 153 yards with consistent flush contact.\n\n"
        "**Your focus**\n"
        "Your focus on clearing the lead hip in the downswing is clearly taking hold. You hit your target on 11 of 14 swings (79%), and smash and carry followed over the last 10 sessions.\n\n"
        "**Next session**\n"
        "Stick with the hip rotation. Work on the Hip-to-the-stick drill: alignment stick in the ground just outside your lead hip at address. From the top, bump the lead hip into the stick before the arms start down, then turn. Swing thought: Lead hip to the target first."
    )

    coach_week_text = (
        "**The week**\n"
        "Three solid sessions this week with 84 total swings. Your good shot rate reached 78% (up from 65% last week), with 7 iron distance tight at 152 yards median and offline dispersion cut in half.\n\n"
        "**Your focus**\n"
        "The lead hip move in the downswing is clearly taking hold. You are averaging 4.3 inches of hip clearance toward the target, compared to 2.0 inches before starting the focus, and smash factor followed.\n\n"
        "**Next week**\n"
        "Stay the course with the hip rotation. Keep using the Hip-to-the-stick drill during warmups. Swing thought: Lead hip to the target first."
    )

    coach_question_text = (
        "**Why they go right**\n"
        "Your 30-day 7 iron data shows an average offline of +2.1 yards (push-fade tendency). While your club path is slightly in-to-out at +1.8°, your face to path averages +1.2° open at impact, which starts the ball right and curves it further right.\n\n"
        "**What to do**\n"
        "When your lead hip clears aggressively toward the target, ensure your chest doesn't lag behind leaving the face open. Focus on feeling the clubface square up earlier in the delivery. Use the Impact bag drill to feel a square face at delivery without rolling the forearms."
    )

    now_monday = latest_sess.date() - datetime.timedelta(days=latest_sess.date().weekday())
    coach_notes_obj = [
        {
            "kind": "question",
            "question": "Why do my 7 irons go right?",
            "t": latest_sess_ts + 3600,
            "model": "claude-opus-5-5",
            "provider": "anthropic",
            "text": coach_question_text,
            "usage": {"input_tokens": 1850, "output_tokens": 135},
        },
        {
            "kind": "session",
            "session": latest_sess_ms,
            "t": latest_sess_ts + 2460,
            "model": "claude-opus-5-5",
            "provider": "anthropic",
            "text": coach_note_text,
            "usage": {"input_tokens": 1240, "output_tokens": 108},
        },
        {
            "kind": "week",
            "session": now_monday.strftime("%Y-%m-%d"),
            "t": latest_sess_ts + 1200,
            "model": "claude-opus-5-5",
            "provider": "anthropic",
            "text": coach_week_text,
            "usage": {"input_tokens": 1520, "output_tokens": 120},
        },
    ]
    with open(DATA_DIR / "coach-notes.json", "w", encoding="utf-8") as f:
        json.dump(coach_notes_obj, f, indent=1)

    # 14. events, night, improve
    with open(DATA_DIR / "events.json", "w", encoding="utf-8") as f:
        json.dump([], f, indent=1)

    with open(DATA_DIR / "night.json", "w", encoding="utf-8") as f:
        json.dump({"queue": [], "running": None, "done": []}, f, indent=1)

    with open(DATA_DIR / "improve.json", "w", encoding="utf-8") as f:
        json.dump({"candidates": [], "active": None}, f, indent=1)

    with open(DATA_DIR / "improve-next.json", "w", encoding="utf-8") as f:
        json.dump(None, f, indent=1)

    # Summary
    total_size = sum(p.stat().st_size for p in DATA_DIR.glob("*.json"))
    print(f"Generated demo data in {DATA_DIR}:")
    print(f"  Sessions: {len(session_schedule)}")
    print(f"  Clips: {len(all_clips)} ({len(all_clips) // 2} swings)")
    print(f"  Total JSON files: {len(list(DATA_DIR.glob('*.json')))}")
    print(f"  Total data size: {total_size / 1024:.1f} KB")


if __name__ == "__main__":
    generate_demo_data()
