"""Ball flight: carry, total, offline, apex and landing angle from the ball's launch numbers.

For shots from a source that doesn't send them: Square's GSPro connector reports ball speed, launch,
direction, spin and spin axis, but no carry (and club speed 0). The flight is integrated with drag
and Magnus lift (both growing with the spin factor, spin decaying over the flight) at sea level, and
the roll after landing comes from a small linear fit. The coefficients were fit to Square's own
numbers on 126 of its saved driving-range shots (Sept 23-25 2026, driver to gap wedge): carry within
2.1 yd on average (90% within 4.2 yd), 2-3.6 yd on a day left out of the fit; offline 0.8 yd, apex
2 ft, landing angle 1.1 degrees, total 2.6 yd. Wedges come out ~3 yd short of Square's carry.

Units as the shots carry them: mph, degrees, rpm, yards, feet. Direction, spin axis and offline are
positive to the right.
"""
import math

# Drag Cd = CD0 + CD1 * S and lift Cl = CL0 + CL1 * S, S = spin factor (surface speed / ball speed);
# spin decays as exp(-t / SPIN_DECAY_S).
CD0, CD1, CL0, CL1, SPIN_DECAY_S = 0.2141, 0.3805, 0.1818, 0.416, 9.5694
# Roll (yd) = ROLL . (horizontal mph at landing, downward mph at landing, launch spin in 1000 rpm, 1), at least 0.
ROLL = (0.973, -0.405, 0.609, -20.951)

MASS, RADIUS, AIR = 0.04593, 0.021335, 1.194        # kg, m, kg/m^3
K = 0.5 * AIR * math.pi * RADIUS ** 2 / MASS
G = 9.81
MPH, YD, FT = 0.44704, 1.09361, 3.28084
DT = 0.01
MAX_S = 15.0

# What flight() works out, as the shot's ball fields.
FIELDS = ("carry", "total", "side", "apexFt", "landingAngle")


def flight(speed: float, vla: float, hla: float, spin: float, axis: float) -> dict | None:
    """{carry, total, side (yd), apexFt, landingAngle (deg)} for ball speed (mph), launch and
    direction (deg), total spin (rpm) and spin axis (deg); None if the ball never flies."""
    if not (speed > 0) or not all(math.isfinite(v) for v in (speed, vla, hla, spin, axis)):
        return None
    v0, a, h, ax = speed * MPH, math.radians(vla), math.radians(hla), math.radians(axis)
    w0 = max(spin, 0.0) * 2 * math.pi / 60
    # x toward the target, y up, z right. Backspin's axis points right (+z); a spin axis tilted
    # right (positive) curves the ball right.
    wx, wy, wz = 0.0, -math.sin(ax), math.cos(ax)

    def acc(vx, vy, vz, t):
        sp = math.sqrt(vx * vx + vy * vy + vz * vz)
        s = RADIUS * w0 * math.exp(-t / SPIN_DECAY_S) / sp
        cd, cl = CD0 + CD1 * s, CL0 + CL1 * s
        # Lift along (spin axis x velocity), normalized.
        lx, ly, lz = wy * vz - wz * vy, wz * vx - wx * vz, wx * vy - wy * vx
        ln = math.sqrt(lx * lx + ly * ly + lz * lz) or 1.0
        d, l = K * cd * sp, K * cl * sp * sp / ln
        return -d * vx + l * lx, -d * vy + l * ly - G, -d * vz + l * lz

    x = y = z = 0.0
    vx, vy, vz = v0 * math.cos(a) * math.cos(h), v0 * math.sin(a), v0 * math.cos(a) * math.sin(h)
    t, top = 0.0, 0.0
    while t < MAX_S:
        a1 = acc(vx, vy, vz, t)
        v2 = (vx + DT / 2 * a1[0], vy + DT / 2 * a1[1], vz + DT / 2 * a1[2])
        a2 = acc(*v2, t + DT / 2)
        v3 = (vx + DT / 2 * a2[0], vy + DT / 2 * a2[1], vz + DT / 2 * a2[2])
        a3 = acc(*v3, t + DT / 2)
        v4 = (vx + DT * a3[0], vy + DT * a3[1], vz + DT * a3[2])
        a4 = acc(*v4, t + DT)
        nx = x + DT / 6 * (vx + 2 * v2[0] + 2 * v3[0] + v4[0])
        ny = y + DT / 6 * (vy + 2 * v2[1] + 2 * v3[1] + v4[1])
        nz = z + DT / 6 * (vz + 2 * v2[2] + 2 * v3[2] + v4[2])
        nvx = vx + DT / 6 * (a1[0] + 2 * a2[0] + 2 * a3[0] + a4[0])
        nvy = vy + DT / 6 * (a1[1] + 2 * a2[1] + 2 * a3[1] + a4[1])
        nvz = vz + DT / 6 * (a1[2] + 2 * a2[2] + 2 * a3[2] + a4[2])
        t += DT
        top = max(top, ny)
        if ny <= 0 and t > 0.1:
            f = y / (y - ny)   # back to where it crossed the ground
            lx, lz = x + f * (nx - x), z + f * (nz - z)
            lvx, lvy, lvz = vx + f * (nvx - vx), vy + f * (nvy - vy), vz + f * (nvz - vz)
            break
        x, y, z, vx, vy, vz = nx, ny, nz, nvx, nvy, nvz
    else:
        return None
    if t <= 0.1 + DT or top <= 0:
        return None
    carry = math.hypot(lx, lz) * YD
    across, down = math.hypot(lvx, lvz) / MPH, -lvy / MPH
    roll = max(0.0, ROLL[0] * across + ROLL[1] * down + ROLL[2] * spin / 1000 + ROLL[3])
    return {"carry": round(carry, 1), "total": round(carry + roll, 1), "side": round(lz * YD, 1),
            "apexFt": round(top * FT), "landingAngle": round(math.degrees(math.atan2(down, across)), 1)}


def _num(v) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def fill(shot: dict) -> dict:
    """A shot as posted to /api/shots, with what its source couldn't measure worked out or left out:
    club speed 0 (the GSPro connector's "not measured") becomes missing, and a shot with no carry
    gets carry, total, offline, apex and landing angle from its ball numbers, listed in
    ball["computed"]. Square's own numbers are never replaced. Changes and returns the shot."""
    club = shot.get("clubData")
    if isinstance(club, dict):
        for k in ("speed", "smash"):
            if k in club and not ((_num(club[k]) or 0) > 0):
                club[k] = None
    b = shot.get("ball")
    if not isinstance(b, dict) or (_num(b.get("carry")) or 0) > 0:
        return shot
    speed, vla, spin = _num(b.get("speed")), _num(b.get("vla")), _num(b.get("totalSpin"))
    if speed is None or vla is None or spin is None:
        return shot
    got = flight(speed, vla, _num(b.get("hla")) or 0.0, spin, _num(b.get("spinAxis")) or 0.0)
    if got is None:
        return shot
    b["carry"] = None   # (a 0 "not sent")
    computed = [k for k in FIELDS if _num(b.get(k)) is None]
    for k in computed:
        b[k] = got[k]
    b["computed"] = computed
    return shot
