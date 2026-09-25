// Personal ranges from your own good shots. Which shots count as good is decided per club from
// Square's numbers, by rules the page lets you edit (server: goodshots.py, goodshots.json):
//   irons and wedges: offline within a share of carry (5%), smash at or above your own median with
//     the club, carry within your usual band (a share either side of your median carry: no chunks,
//     no thins or flyers), and, when Square reports where on the face it was struck, a strike near
//     your usual spot on the face;
//   woods, hybrids and driver: the same, with their own share of carry offline.
// "Your own median" is over the club's shots, good or not (its latest RECENT, swings left out of the
// trends not counted), and only once there are MIN_BASELINE of them.
// Then, for each body number (summary.js BODY) and club: the middle 50% and 80% of the good shots,
// and how many shots it's from. Numbers with no reading under trust.js are left out; below the
// minimum count (8) there is no range; when most of the numbers it's from are shaky under trust.js,
// the range is marked "not reliable". And which numbers most separate good shots from the rest
// (Hedges' g with a 95% confidence interval): a description of your shots, not a cause.
//
// Works in the browser (window.SwingGoodShots) and in Node (module.exports).
(function (root) {
  const Summary = root.SwingSummary || (typeof require !== "undefined" && require("./summary.js"));
  const Trust = root.SwingTrust || (typeof require !== "undefined" && require("./trust.js"));

  // Keep in step with goodshots.py DEFAULTS (tests/test_goodshots.py checks they agree).
  const DEFAULTS = {
    minCount: 8,
    irons: { offlinePct: 5, carryBelowPct: 10, carryAbovePct: 12, smashBelow: 0 },
    woods: { offlinePct: 6, carryBelowPct: 10, carryAbovePct: 12, smashBelow: 0 },
    strike: { on: true, heelToeMm: 20, highLowMm: 20 },
  };
  // Shots with a club before your usual carry, smash and strike with it are known.
  const MIN_BASELINE = 5;
  // Per club, the latest this many shots count (the swing changes over months).
  const RECENT = 200;
  // Square's codes: DR, W3, H4 (woods and hybrids); everything else but the putter is an iron or wedge.
  const WOODS = /^(DR|[WH]\d|\d[WH])$/;
  const EPS = 1e-9;

  const finite = v => typeof v === "number" && Number.isFinite(v);

  /** "irons", "woods", or null (no club, or the putter). */
  function groupOf(club) {
    if (!club || club === "PT") return null;
    return WOODS.test(club) ? "woods" : "irons";
  }

  /** Settings with any missing part filled in from DEFAULTS. */
  function withDefaults(s) {
    s = s || {};
    return {
      minCount: finite(s.minCount) ? s.minCount : DEFAULTS.minCount,
      irons: { ...DEFAULTS.irons, ...(s.irons || {}) },
      woods: { ...DEFAULTS.woods, ...(s.woods || {}) },
      strike: { ...DEFAULTS.strike, ...(s.strike || {}) },
    };
  }

  function quantile(sorted, q) {
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }
  const medianOf = xs => {
    const v = xs.filter(finite).sort((a, b) => a - b);
    return v.length ? quantile(v, 0.5) : null;
  };

  /** A club's usual carry, smash and strike spot: medians over its shots (shotNumbers each). */
  function baselineOf(shots) {
    return {
      n: shots.length,
      carry: medianOf(shots.map(s => s.carry).filter(c => c > 0)),
      smash: medianOf(shots.map(s => s.smash)),
      strikeH: medianOf(shots.map(s => s.strikeH)),
      strikeV: medianOf(shots.map(s => s.strikeV)),
    };
  }

  const r1 = x => Math.round(x * 10) / 10;

  /**
   * Whether one shot is good, against its club's baseline.
   * @param s shotNumbers of the shot
   * @param base baselineOf the club's shots, or null when there are too few of them
   * @param group "irons" | "woods"
   * @returns {good, fails: [why not], skipped: [rules that couldn't be checked]}
   */
  function judgeShot(s, base, group, settings) {
    const st = withDefaults(settings), rules = st[group] || st.irons;
    const fails = [], skipped = [];
    if (!base) return { good: false, fails: [`fewer than ${MIN_BASELINE} shots with this club: your usual carry isn't known yet`], skipped };
    if (!finite(s.carry) || !finite(s.offline) || !(s.carry > 0)) return { good: false, fails: ["no carry or offline from Square"], skipped };
    const maxOff = rules.offlinePct / 100 * s.carry;
    if (Math.abs(s.offline) > maxOff + EPS) {
      fails.push(`offline ${r1(Math.abs(s.offline))} yd: more than ${rules.offlinePct}% of carry (${r1(maxOff)} yd)`);
    }
    if (finite(base.carry)) {
      const lo = base.carry * (1 - rules.carryBelowPct / 100), hi = base.carry * (1 + rules.carryAbovePct / 100);
      if (s.carry < lo - EPS) fails.push(`carry ${r1(s.carry)} yd: short of your usual ${r1(lo)} to ${r1(hi)}`);
      else if (s.carry > hi + EPS) fails.push(`carry ${r1(s.carry)} yd: past your usual ${r1(lo)} to ${r1(hi)}`);
    }
    if (!finite(base.smash)) skipped.push("smash: Square hasn't reported it with this club");
    else if (!finite(s.smash)) skipped.push("smash: not reported for this shot");
    else if (s.smash < base.smash - rules.smashBelow - EPS) {
      fails.push(`smash ${s.smash.toFixed(2)}: under your median ${base.smash.toFixed(2)}${rules.smashBelow ? ` (less ${rules.smashBelow})` : ""}`);
    }
    if (st.strike.on) {
      for (const [k, max, name] of [["strikeH", st.strike.heelToeMm, "heel/toe"], ["strikeV", st.strike.highLowMm, "high/low"]]) {
        if (!finite(base[k]) || !finite(s[k])) { skipped.push(`strike ${name}: not reported`); continue; }
        const d = s[k] - base[k];
        if (Math.abs(d) > max + EPS) fails.push(`strike ${r1(Math.abs(d))} mm ${name} from your usual spot (more than ${max})`);
      }
    }
    return { good: !fails.length, fails, skipped };
  }

  /**
   * The range of one body number over the good shots.
   * @param values [number]; shaky: how many of them trust.js calls shaky; why: {reason: count}
   * @returns {n, enough, need, q10, q25, q50, q75, q90, reliable, why}
   */
  function rangeOf(values, shaky, why, minCount) {
    const n = values.length;
    if (n < minCount) return { n, enough: false, need: minCount };
    const v = [...values].sort((a, b) => a - b);
    const reliable = shaky * 2 <= n;
    const reasons = Object.keys(why || {}).sort((a, b) => why[b] - why[a]);
    return { n, enough: true, need: minCount, q10: quantile(v, 0.1), q25: quantile(v, 0.25), q50: quantile(v, 0.5),
             q75: quantile(v, 0.75), q90: quantile(v, 0.9), shaky, reliable,
             why: reliable ? "" : `${shaky} of ${n} shaky: ${reasons.join("; ")}` };
  }

  /**
   * Good shots and ranges per club.
   * @param swings [{name, t, club, excluded, shot (Square's, as the clip list has it), record (swings.py,
   *   as /api/swings has it; null until worked out), light ({face, dtl}: each camera's light check)}]
   * @param settings as goodshots.json (missing parts from DEFAULTS)
   * @param table the noise table (trust.js), or null
   * @returns {settings, clubs: {club: {group, shots, good, baseline, verdicts: {name: judgeShot},
   *   rows: [{name, good, body: {key: number | null}, shaky: {key: bool}}], ranges: {key: rangeOf}}}}
   */
  function build(swings, settings, table) {
    const st = withDefaults(settings);
    const byClub = {};
    for (const s of swings || []) {
      if (s.excluded || !s.shot || !groupOf(s.club)) continue;
      (byClub[s.club] = byClub[s.club] || []).push(s);
    }
    const clubs = {};
    for (const club in byClub) {
      const group = groupOf(club);
      const list = byClub[club].sort((a, b) => b.t - a.t).slice(0, RECENT);
      const nums = list.map(s => Summary.shotNumbers(s.shot));
      const base = list.length >= MIN_BASELINE ? baselineOf(nums) : null;
      const verdicts = {}, rows = [];
      list.forEach((s, i) => {
        const v = judgeShot(nums[i], base, group, st);
        verdicts[s.name] = v;
        const rec = s.record;
        if (!rec || !rec.body || rec.error) return;
        const trust = Trust.forSwing(rec, s.light || null, table || null);
        const body = {}, shaky = {}, why = {};
        for (const f of Summary.BODY) {
          const j = trust[f.key];
          // No reading (trust.js): left out.
          body[f.key] = j.level === "none" || !finite(rec.body[f.key]) ? null : rec.body[f.key];
          shaky[f.key] = j.level === "shaky";
          why[f.key] = j.why;
        }
        rows.push({ name: s.name, good: v.good, body, shaky, why });
      });
      const ranges = {};
      for (const f of Summary.BODY) {
        const used = rows.filter(r => r.good && r.body[f.key] != null);
        const reasons = {};
        let shaky = 0;
        for (const r of used) {
          if (!r.shaky[f.key]) continue;
          shaky++;
          for (const w of r.why[f.key]) reasons[w] = (reasons[w] || 0) + 1;
        }
        ranges[f.key] = rangeOf(used.map(r => r.body[f.key]), shaky, reasons, st.minCount);
      }
      clubs[club] = { group, shots: list.length, good: Object.values(verdicts).filter(v => v.good).length,
                      baseline: base, verdicts, rows, ranges };
    }
    return { settings: st, clubs };
  }

  /** How a difference in a number is said: "4°", "0.6 in", "0.05 s", "0.3". */
  function amount(x, unit) {
    const a = Math.abs(x);
    if (unit === "°") return (a >= 1 ? a.toFixed(0) : a.toFixed(1)) + "°";
    // Small differences get a decimal more, so they don't read as 0.
    if (unit === "in") return a.toFixed(a < 0.1 ? 2 : 1) + " in";
    if (unit === "s") return a.toFixed(2) + " s";
    return a.toFixed(unit === ":1" && a >= 0.1 ? 1 : 2);
  }
  /** A number as the range shows it, signed where the unit has a direction. */
  function shown(x, unit) {
    if (unit === ":1") return x.toFixed(1);
    if (unit === "s") return x.toFixed(2);
    const t = unit === "in" ? x.toFixed(1) : x.toFixed(0);
    return (x > 0 && Number(t) !== 0 ? "+" : "") + t.replace(/^-0(\.0)?$/, "0");
  }
  /** "+30 to +38°" for a range. */
  function rangeText(lo, hi, unit) {
    const u = unit === "°" ? "°" : unit === "in" ? " in" : unit === "s" ? " s" : unit === ":1" ? " : 1" : "";
    return `${shown(lo, unit)} to ${shown(hi, unit)}${u}`;
  }

  /**
   * Where one swing's number sits against the range.
   * @returns {status: "in" | "above" | "below" | "few" | "none", wide (inside the 80% range),
   *   reliable, text}
   */
  function place(value, range, unit) {
    if (!range || !range.enough) {
      const n = range ? range.n : 0, need = range ? range.need : DEFAULTS.minCount;
      return { status: "few", reliable: false, text: `not enough good shots yet (${n} of ${need})` };
    }
    const tail = range.reliable ? "" : " (range not reliable)";
    if (!finite(value)) return { status: "none", reliable: range.reliable, text: "no reading" };
    const wide = value >= range.q10 - EPS && value <= range.q90 + EPS;
    if (value >= range.q25 - EPS && value <= range.q75 + EPS) {
      return { status: "in", wide: true, reliable: range.reliable, text: "in my good-shot range" + tail };
    }
    const above = value > range.q75;
    const d = above ? value - range.q75 : range.q25 - value;
    return { status: above ? "above" : "below", wide, reliable: range.reliable,
             text: `outside: ${amount(d, unit)} ${above ? "more" : "less"} than usual${wide ? " (inside the 80% range)" : ""}${tail}` };
  }

  /**
   * Which body numbers most separate a club's good shots from the rest: for each, Hedges' g (the
   * difference in means over the pooled standard deviation, bias-corrected) and its 95% confidence
   * interval, largest |g| first; numbers without minCount swings on each side come last.
   * @param club build()'s result for one club
   * @returns [{key, nGood, nRest, enough, meanGood, meanRest, diff, g, lo, hi, clear, shaky}]
   */
  function separation(club, minCount) {
    const min = minCount ?? DEFAULTS.minCount;
    const out = [];
    for (const f of Summary.BODY) {
      const rows = (club ? club.rows : []).filter(r => r.body[f.key] != null);
      const good = rows.filter(r => r.good).map(r => r.body[f.key]);
      const rest = rows.filter(r => !r.good).map(r => r.body[f.key]);
      const item = { key: f.key, nGood: good.length, nRest: rest.length, enough: good.length >= min && rest.length >= min };
      item.shaky = rows.length > 0 && rows.filter(r => r.shaky[f.key]).length * 2 > rows.length;
      if (item.enough) Object.assign(item, hedges(good, rest));
      if (item.enough && item.g == null) item.enough = false;   // no spread at all: nothing to say
      out.push(item);
    }
    return out.sort((a, b) => (b.enough - a.enough) || (b.enough ? Math.abs(b.g) - Math.abs(a.g) : 0));
  }

  function hedges(a, b) {
    const n1 = a.length, n2 = b.length;
    const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
    const m1 = mean(a), m2 = mean(b);
    const ss = (xs, m) => xs.reduce((s, x) => s + (x - m) ** 2, 0);
    const sp = Math.sqrt((ss(a, m1) + ss(b, m2)) / (n1 + n2 - 2));
    if (!(sp > EPS)) return { meanGood: m1, meanRest: m2, diff: m1 - m2, g: null };
    const g = (m1 - m2) / sp * (1 - 3 / (4 * (n1 + n2) - 9));
    const se = Math.sqrt((n1 + n2) / (n1 * n2) + g * g / (2 * (n1 + n2)));
    const lo = g - 1.96 * se, hi = g + 1.96 * se;
    return { meanGood: m1, meanRest: m2, diff: m1 - m2, g, se, lo, hi, clear: lo > 0 || hi < 0 };
  }

  const api = { DEFAULTS, MIN_BASELINE, RECENT, groupOf, withDefaults, baselineOf, judgeShot, rangeOf, build,
                place, separation, hedges, amount, rangeText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingGoodShots = api;
})(typeof window !== "undefined" ? window : globalThis);
