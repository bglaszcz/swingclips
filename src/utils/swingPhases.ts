import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { LM, POSE_SAMPLE_FPS, isVisible, type PoseResult } from './poseAnalyzer';

// The P1-P8 checkpoints, found from the pose track. The clip is cut around the
// impact sound, so impact is roughly known up front.
//
// P2, P6 and P8 are defined by the club shaft, which body tracking cannot see
// (tried and rejected: edge and motion detection both locked onto the room and
// the golfer rather than the club). They are marked `estimated` and are meant to
// be nudged frame by frame by the user.

export type PhaseKey = 'p1' | 'p2' | 'p3' | 'p4' | 'p5' | 'p6' | 'p7' | 'p8';

export type LeadSide = 'left' | 'right';

export interface SwingPhase {
  key: PhaseKey;
  /** Short tag shown on the still, e.g. "P4". */
  tag: string;
  label: string;
  /** Clip time in seconds. */
  t: number;
  /** True when the club defines this position and we could only approximate it. */
  estimated: boolean;
}

const LABELS: Record<PhaseKey, string> = {
  p1: 'Address',
  p2: 'Shaft parallel (back)',
  p3: 'Lead arm parallel (back)',
  p4: 'Top',
  p5: 'Lead arm parallel (down)',
  p6: 'Shaft parallel (down)',
  p7: 'Impact',
  p8: 'Shaft parallel (through)',
};

const CLUB_DEFINED: PhaseKey[] = ['p2', 'p6', 'p8'];

interface FrameMetrics {
  index: number;
  t: number;
  /** Midpoint of both wrists, x scaled by aspect so distances are comparable. */
  hand: { x: number; y: number };
  /** Lead arm angle from horizontal in degrees (0 = parallel to the ground). */
  armAngle: number;
  shoulderY: number;
  shoulderWidth: number;
  /** Hand travel since the previous measured frame, per second. */
  speed: number;
}

function mid(a: NormalizedLandmark, b: NormalizedLandmark) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// Down-the-line, the hands spend much of the swing behind the body, so MediaPipe
// reports low "visibility" even while still estimating their position well. Trust
// those estimates here (the torso landmarks, which stay near 1.0, gate the frame).
const HAND_MIN_VISIBILITY = 0.1;

function handPoint(lms: NormalizedLandmark[]): { x: number; y: number } | null {
  const lw = lms[LM.L_WRIST], rw = lms[LM.R_WRIST];
  const hasL = lw && (lw.visibility ?? 1) >= HAND_MIN_VISIBILITY;
  const hasR = rw && (rw.visibility ?? 1) >= HAND_MIN_VISIBILITY;
  if (hasL && hasR) {
    // Both hands grip the same club, so they should agree. When they don't, one
    // is being guessed badly — lean on whichever the model is more sure of.
    const vl = lw.visibility ?? 1, vr = rw.visibility ?? 1;
    const w = vl + vr;
    if (w > 0) return { x: (lw.x * vl + rw.x * vr) / w, y: (lw.y * vl + rw.y * vr) / w };
    return mid(lw, rw);
  }
  if (hasL) return { x: lw.x, y: lw.y };
  if (hasR) return { x: rw.x, y: rw.y };
  // Both hands lost: elbows follow the same arc closely enough for checkpoints.
  const le = lms[LM.L_ELBOW], re = lms[LM.R_ELBOW];
  if (le && re) return mid(le, re);
  return null;
}

function metrics(result: PoseResult, leadSide: LeadSide): FrameMetrics[] {
  const aspect = result.videoWidth / result.videoHeight;
  const leadShoulder = leadSide === 'left' ? LM.L_SHOULDER : LM.R_SHOULDER;
  const out: FrameMetrics[] = [];
  let previous: FrameMetrics | null = null;

  result.frames.forEach((frame, index) => {
    const lms = frame.landmarks;
    if (!lms) return;
    const ls = lms[LM.L_SHOULDER], rs = lms[LM.R_SHOULDER];
    const lh = lms[LM.L_HIP], rh = lms[LM.R_HIP];
    if (![ls, rs, lh, rh].every(isVisible)) return;

    const handRaw = handPoint(lms);
    if (!handRaw) return;
    const hand = { x: handRaw.x * aspect, y: handRaw.y };
    const shoulder = mid(ls, rs);
    const shoulderWidth = Math.abs(ls.x - rs.x) * aspect;

    // Lead arm: lead shoulder -> hands. Horizontal means "arm parallel to the
    // ground". The hand midpoint is used rather than the lead wrist alone, which
    // is often poorly tracked when it hides behind the body.
    const ps = lms[leadShoulder];
    let armAngle = 90;
    if (ps) {
      const dx = (handRaw.x - ps.x) * aspect;
      const dy = handRaw.y - ps.y;
      armAngle = Math.atan2(dy, dx) * 180 / Math.PI;
      if (armAngle > 90) armAngle -= 180;
      if (armAngle < -90) armAngle += 180;
    }

    let speed = 0;
    if (previous) {
      const dt = frame.t - previous.t;
      const d = Math.hypot(hand.x - previous.hand.x, hand.y - previous.hand.y);
      speed = dt > 0 ? d / dt : 0;
    }
    const m: FrameMetrics = { index, t: frame.t, hand, armAngle, shoulderY: shoulder.y, shoulderWidth, speed };
    out.push(m);
    previous = m;
  });

  return out;
}

/** Hand height/speed per frame — exported for tuning and debugging. */
export function handSeries(result: PoseResult, leadSide: LeadSide = 'left') {
  return metrics(result, leadSide).map((m) => ({
    t: Number(m.t.toFixed(2)),
    handY: Number(m.hand.y.toFixed(3)),
    armAngle: Number(m.armAngle.toFixed(1)),
    speed: Number(m.speed.toFixed(3)),
  }));
}

/** Index in `frames` of the entry closest to time `t`. */
function nearest(frames: FrameMetrics[], t: number): number {
  let best = 0, bestGap = Infinity;
  frames.forEach((f, i) => {
    const gap = Math.abs(f.t - t);
    if (gap < bestGap) { bestGap = gap; best = i; }
  });
  return best;
}

/** Frame in [from, to) whose lead arm is closest to horizontal. */
function armParallel(frames: FrameMetrics[], from: number, to: number): number {
  let best = -1, bestGap = Infinity;
  for (let i = from; i < to && i < frames.length; i++) {
    const gap = Math.abs(frames[i].armAngle);
    if (gap < bestGap) { bestGap = gap; best = i; }
  }
  return best;
}

/**
 * Detect the P1-P8 checkpoints.
 * @param impactHint Expected impact time (the clip is cut around the impact sound).
 * @param leadSide Which arm leads: 'left' for a right-handed golfer.
 */
export function detectPhases(result: PoseResult, impactHint: number, leadSide: LeadSide = 'left'): SwingPhase[] {
  const frames = metrics(result, leadSide);
  if (frames.length < POSE_SAMPLE_FPS / 2) return [];

  // P7 impact: the impact *sound* is accurate, so only nudge within a couple of
  // frames to where the hands are lowest (hand speed peaks before impact).
  const WINDOW = 0.12;
  let impactIdx = nearest(frames, impactHint);
  let lowestHand = -Infinity;
  frames.forEach((f, i) => {
    if (Math.abs(f.t - impactHint) > WINDOW) return;
    if (f.hand.y > lowestHand) { lowestHand = f.hand.y; impactIdx = i; }
  });

  // P4 top: hands highest (smallest y) before impact.
  let topIdx = 0;
  let highest = Infinity;
  for (let i = 0; i < impactIdx; i++) {
    if (frames[i].hand.y < highest) { highest = frames[i].hand.y; topIdx = i; }
  }

  // P1 address: the hands also pause at the top, so a single quiet frame proves
  // nothing. Walk back from the top and require a sustained still stretch.
  const maxSpeed = Math.max(...frames.map((f) => f.speed));
  const movingThreshold = maxSpeed * 0.06;
  const STILL_FRAMES = Math.max(3, Math.round(POSE_SAMPLE_FPS * 0.2));
  let addressIdx = 0;
  let quietRun = 0;
  let quietRunStart = topIdx;
  for (let i = topIdx; i >= 0; i--) {
    if (frames[i].speed <= movingThreshold) {
      if (quietRun === 0) quietRunStart = i;
      quietRun++;
      if (quietRun >= STILL_FRAMES) { addressIdx = quietRunStart; break; }
    } else {
      quietRun = 0;
    }
  }

  // P3 / P5: lead arm parallel to the ground, going back and coming down.
  const p3Idx = armParallel(frames, addressIdx + 1, topIdx);
  const p5Idx = armParallel(frames, topIdx + 1, impactIdx);

  // P2 (estimated): shaft parallel in the takeaway is roughly when the hands have
  // travelled about 1.5 shoulder widths from address.
  const address = frames[addressIdx];
  let p2Idx = -1;
  for (let i = addressIdx + 1; i <= topIdx; i++) {
    const moved = Math.hypot(frames[i].hand.x - address.hand.x, frames[i].hand.y - address.hand.y);
    if (moved >= address.shoulderWidth * 1.5) { p2Idx = i; break; }
  }

  // P6 / P8 (estimated): the shaft passes horizontal roughly this long either
  // side of impact. At 30fps that is only about two frames, which is why these
  // two are the ones most worth nudging — and why a higher capture rate helps.
  const SHAFT_OFFSET_SECONDS = 0.06;
  const impactTime = frames[impactIdx].t;
  const p6Idx = Math.min(impactIdx - 1, nearest(frames, impactTime - SHAFT_OFFSET_SECONDS));
  const p8Idx = Math.max(impactIdx + 1, nearest(frames, impactTime + SHAFT_OFFSET_SECONDS));

  const picks: [PhaseKey, number][] = [
    ['p1', addressIdx],
    ['p2', p2Idx],
    ['p3', p3Idx],
    ['p4', topIdx],
    ['p5', p5Idx],
    ['p6', p6Idx],
    ['p7', impactIdx],
    ['p8', p8Idx],
  ];

  return picks
    .filter(([, i]) => i >= 0 && i < frames.length)
    .map(([key, i]) => ({
      key,
      tag: key.toUpperCase(),
      label: LABELS[key],
      t: frames[i].t,
      estimated: CLUB_DEFINED.includes(key),
    }));
}
