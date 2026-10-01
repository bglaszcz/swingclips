"""Square's CSV export vs what SwingClips read from Square's app database, for the same shots.

    python tools/square_compare.py <export.csv> <square-shots-DATE.jsonl>

The CSV (Square app > export, e.g. Dropbox\\SquareGolf\\bglaszcz_01Oct2026_00-...csv) has no shot times:
rows are grouped by club, in order within a club. The watcher's log (Dropbox\\SwingClips\\square-shots-
DATE.jsonl) has the same shots in order with the club and Square's session name. So the nth CSV row of a
club is the nth logged shot of that club in that session; ball speed and carry confirm each match.

Prints, per number the gates use (impact height and toe/heel, attack, face to path, dynamic loft):
new (database) minus old (CSV) over the matched shots, whether it's a constant offset, a scale or sign
flip (a straight-line fit), and the shots where either source marks a failed read.
"""
import csv
import json
import re
import statistics
import sys
from pathlib import Path

CLUBS = {"Driver": "DR", "3 Wood": "W3", "4 Hybrid": "H4", "5 Iron": "I5", "6 Iron": "I6", "7 Iron": "I7",
         "8 Iron": "I8", "9 Iron": "I9", "P-Wedge": "PW", "G-Wedge": "GW", "S-Wedge": "SW", "L-Wedge": "LW"}
MPS_TO_MPH = 2.23694


def num(s):
    """'L3.7' -> -3.7, 'R5.1' -> 5.1, 'T1.2' / 'H0.0' -> (letter, value), '12.3' -> 12.3."""
    s = (s or "").strip()
    m = re.match(r"^([A-Za-z]?)(-?[\d.]+)$", s)
    if not m:
        return None, None
    return m.group(1) or None, float(m.group(2))


def read_csv(path):
    lines = Path(path).read_text(encoding="utf-8-sig").splitlines()
    head = next(i for i, l in enumerate(lines) if l.startswith("Club,"))
    rows = []
    for r in csv.DictReader(lines[head:]):
        if r["Index"] in ("Average", "Deviation", ""):
            continue
        rows.append(r)
    return rows


def fit(xs, ys):
    """Least-squares y = a + b x, and r."""
    mx, my = statistics.mean(xs), statistics.mean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    b = sxy / sxx if sxx else float("nan")
    r = sxy / (sxx * syy) ** 0.5 if sxx and syy else float("nan")
    return my - b * mx, b, r


def main(csv_path, log_path):
    rows = read_csv(csv_path)
    m = re.search(r"(\d{2}[A-Z][a-z]{2}\d{4}_\d{2})", Path(csv_path).name)
    session = m.group(1) if m else None
    shots = [json.loads(l) for l in Path(log_path).read_text(encoding="utf-8-sig").splitlines() if l.strip()]
    if session:
        shots = [s for s in shots if (s.get("session") or "").endswith(session)]
    by_club = {}
    for s in sorted(shots, key=lambda s: s.get("shotNumber") or 0):
        by_club.setdefault(s.get("club"), []).append(s)
    pairs, unmatched = [], 0
    for club_name in dict.fromkeys(r["Club"] for r in rows):
        mine = [r for r in rows if r["Club"] == club_name]
        theirs = by_club.get(CLUBS.get(club_name, club_name), [])
        if len(mine) != len(theirs):
            print(f"{club_name}: {len(mine)} rows in the CSV, {len(theirs)} in the log: matching the first {min(len(mine), len(theirs))} by order")
        for r, s in zip(mine, theirs):
            b = s.get("ball") or {}
            _, carry = num(r["Carry(yd)"])
            _, speed = num(r["Ball Speed(mph)"])
            ok = (carry is None or b.get("carry") is None or abs(carry - b["carry"]) < 1.5) and \
                 (speed is None or b.get("speed") is None or abs(speed - b["speed"]) < 1.5)
            if not ok:
                unmatched += 1
                print(f"  no match: {club_name} #{r['Index']} csv carry {carry} speed {speed} vs log carry {b.get('carry')} speed {b.get('speed')}")
                continue
            pairs.append((r, s))
    print(f"\n{len(pairs)} shots matched ({unmatched} rows didn't match on carry and ball speed)\n")

    def old_new(key, r, s):
        c = s.get("clubData") or {}
        if key == "V":
            return num(r["ImpactVertical"])[1], c.get("faceImpactV")
        if key == "H":
            letter, v = num(r["ImpactHorizontal"])
            # The database's + is the CSV's T (checked on the Oct 1 export: r = 1.000 this way round).
            return (v if v == 0 else (v if letter == "T" else -v) if letter else v), c.get("faceImpactH")
        if key == "attack":
            return num(r["Attack Angle"])[1], c.get("angleOfAttack")
        if key == "loft":
            return num(r["Dynamic Loft"])[1], c.get("loft")
        if key == "faceToPath":
            f, p = num(r["Face Angle"]), num(r["Club Path"])
            sign = lambda t: (-t[1] if t[0] == "L" else t[1]) if t[1] is not None else None
            fv, pv = sign(f), sign(p)
            new = (c["faceToTarget"] - c["path"]) if c.get("faceToTarget") is not None and c.get("path") is not None else None
            return (fv - pv if fv is not None and pv is not None else None), new

    names = {"V": "Impact height (ImpactVertical)", "H": "Impact toe/heel (ImpactHorizontal; CSV T as +)",
             "attack": "Attack angle", "faceToPath": "Face to path", "loft": "Dynamic loft"}
    for key, name in names.items():
        both = [(o, n) for o, n in (old_new(key, r, s) for r, s in pairs) if o is not None and n is not None]
        if key in ("V", "H"):
            # Failed reads: CSV 'H0.0' with a filler height; the database sends null (IsValidImpact* false).
            both = [(o, n) for (o, n), (r, s) in zip(both, pairs) if num(r["ImpactHorizontal"])[1] != 0]
        if len(both) < 3:
            print(f"{name}: too few shots with both")
            continue
        d = [n - o for o, n in both]
        a, b, rr = fit([o for o, _ in both], [n for _, n in both])
        print(f"{name}: {len(both)} shots. new - old: median {statistics.median(d):+.2f}, "
              f"range {min(d):+.2f} to {max(d):+.2f}, SD {statistics.stdev(d):.2f}. Fit new = {a:+.2f} + {b:.3f} x old (r {rr:.3f})")

    print("\nFailed impact reads:")
    for r, s in pairs:
        c = s.get("clubData") or {}
        csv_bad = num(r["ImpactHorizontal"])[1] == 0
        db_bad = c.get("faceImpactH") is None or c.get("faceImpactV") is None
        if csv_bad or db_bad:
            print(f"  {r['Club']} #{r['Index']}: CSV H {r['ImpactHorizontal']} V {r['ImpactVertical']} | database H {c.get('faceImpactH')} V {c.get('faceImpactV')}"
                  f" (shot {s.get('shotNumber')})")
    speeds = [(num(r["ClubSpeed"])[1], (s.get("clubData") or {}).get("speed")) for r, s in pairs]
    speeds = [(o, n) for o, n in speeds if o and n]
    if speeds:
        print(f"\nClub speed: CSV x {MPS_TO_MPH:.3f} (m/s -> mph) minus database: median "
              f"{statistics.median(n - o * MPS_TO_MPH for o, n in speeds):+.2f} mph")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
