import { PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';

// Runs MediaPipe Pose over a whole clip once, so playback/stepping can draw the
// skeleton for any frame instantly. Everything runs on-device; the runtime and
// model are served from /public/mediapipe so this works offline like ffmpeg.

const WASM_LOADER = '/mediapipe/vision_wasm_internal.js';
const WASM_BINARY = '/mediapipe/vision_wasm_internal.wasm';
const MODEL = '/mediapipe/pose_landmarker_full.task';

/** How many frames per second of clip we run pose detection on. */
export const POSE_SAMPLE_FPS = 30;

// MediaPipe landmark indices (BlazePose 33-point topology)
export const LM = {
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
  L_HEEL: 29, R_HEEL: 30,
  L_FOOT: 31, R_FOOT: 32,
} as const;

export const SKELETON: [number, number][] = [
  [LM.L_SHOULDER, LM.R_SHOULDER],
  [LM.L_SHOULDER, LM.L_ELBOW], [LM.L_ELBOW, LM.L_WRIST],
  [LM.R_SHOULDER, LM.R_ELBOW], [LM.R_ELBOW, LM.R_WRIST],
  [LM.L_SHOULDER, LM.L_HIP], [LM.R_SHOULDER, LM.R_HIP],
  [LM.L_HIP, LM.R_HIP],
  [LM.L_HIP, LM.L_KNEE], [LM.L_KNEE, LM.L_ANKLE],
  [LM.R_HIP, LM.R_KNEE], [LM.R_KNEE, LM.R_ANKLE],
  [LM.L_ANKLE, LM.L_HEEL], [LM.L_HEEL, LM.L_FOOT], [LM.L_ANKLE, LM.L_FOOT],
  [LM.R_ANKLE, LM.R_HEEL], [LM.R_HEEL, LM.R_FOOT], [LM.R_ANKLE, LM.R_FOOT],
];

export interface PoseFrame {
  /** Clip time in seconds */
  t: number;
  /** 33 normalized landmarks (0-1 of video width/height), or null if no person found */
  landmarks: NormalizedLandmark[] | null;
}

export interface PoseResult {
  frames: PoseFrame[];
  videoWidth: number;
  videoHeight: number;
}

let landmarkerPromise: Promise<PoseLandmarker> | null = null;
// detectForVideo requires strictly increasing timestamps for the lifetime of the
// landmarker, across clips, so keep one global clock.
let lastTimestampMs = 0;

function getLandmarker(): Promise<PoseLandmarker> {
  if (!landmarkerPromise) {
    const fileset = { wasmLoaderPath: WASM_LOADER, wasmBinaryPath: WASM_BINARY };
    const create = (delegate: 'GPU' | 'CPU') =>
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
      });
    // GPU is much faster on phones; fall back to CPU where WebGL isn't usable.
    landmarkerPromise = create('GPU').catch(() => create('CPU'));
    landmarkerPromise.catch(() => { landmarkerPromise = null; });
  }
  return landmarkerPromise;
}

function waitForEvent(el: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOk = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error(`Video error while waiting for ${event}`)); };
    const cleanup = () => {
      el.removeEventListener(event, onOk);
      el.removeEventListener('error', onErr);
    };
    el.addEventListener(event, onOk, { once: true });
    el.addEventListener('error', onErr, { once: true });
  });
}

/**
 * Detect the golfer's pose on every sampled frame of a clip.
 * Uses its own hidden <video> so it never disturbs the visible player.
 */
export async function analyzeClip(
  src: string,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<PoseResult> {
  const landmarker = await getLandmarker();

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = src;

  try {
    await waitForEvent(video, 'loadeddata');
    // Some containers (e.g. MediaRecorder WebM) report Infinity until you seek past the end.
    if (!Number.isFinite(video.duration)) {
      video.currentTime = 1e7;
      await waitForEvent(video, 'seeked');
    }
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Clip has no usable duration');
    const step = 1 / POSE_SAMPLE_FPS;
    const frames: PoseFrame[] = [];

    for (let t = 0; t < duration; t += step) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      video.currentTime = t;
      await waitForEvent(video, 'seeked');

      lastTimestampMs += Math.round(step * 1000);
      const result = landmarker.detectForVideo(video, lastTimestampMs);
      frames.push({ t, landmarks: result.landmarks[0] ?? null });
      onProgress?.(Math.min(1, t / duration));
    }

    return { frames, videoWidth: video.videoWidth, videoHeight: video.videoHeight };
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

// Analysis takes seconds per clip, so results are kept for the browser session.
// Shared so both the overlay and the save/share burn-in can use them.
const resultCache = new Map<string, PoseResult>();

export function getCachedPose(src: string): PoseResult | null {
  return resultCache.get(src) ?? null;
}

export function cachePose(src: string, result: PoseResult): void {
  resultCache.set(src, result);
}

/** Nearest analysed frame for a playback time. */
export function frameAt(result: PoseResult, t: number): PoseFrame | null {
  if (result.frames.length === 0) return null;
  const i = Math.max(0, Math.min(result.frames.length - 1, Math.round(t * POSE_SAMPLE_FPS)));
  return result.frames[i];
}

// Kept low on purpose: hands and trail arm are often occluded mid-swing but still
// tracked well, and dropping them leaves the skeleton without forearms.
const MIN_VISIBILITY = 0.25;

export function isVisible(lm: NormalizedLandmark | undefined): lm is NormalizedLandmark {
  return !!lm && (lm.visibility ?? 1) >= MIN_VISIBILITY;
}

function midpoint(a: NormalizedLandmark, b: NormalizedLandmark) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export interface SpineLine {
  hip: { x: number; y: number };
  shoulder: { x: number; y: number };
  /** Degrees the spine leans away from vertical in the image (0 = upright). */
  angle: number;
}

/**
 * Spine = line from mid-hip to mid-shoulder. Angle is measured in pixel space
 * (landmarks are normalized per-axis, so we rescale by the video's aspect).
 * Down-the-line camera → forward bend; face-on camera → side tilt.
 */
export function spineLine(landmarks: NormalizedLandmark[], videoWidth: number, videoHeight: number): SpineLine | null {
  const ls = landmarks[LM.L_SHOULDER], rs = landmarks[LM.R_SHOULDER];
  const lh = landmarks[LM.L_HIP], rh = landmarks[LM.R_HIP];
  if (![ls, rs, lh, rh].every(isVisible)) return null;
  const shoulder = midpoint(ls, rs);
  const hip = midpoint(lh, rh);
  const dx = (shoulder.x - hip.x) * videoWidth;
  const dy = (hip.y - shoulder.y) * videoHeight; // up is positive
  const angle = Math.abs(Math.atan2(dx, dy) * 180 / Math.PI);
  return { hip, shoulder, angle };
}

/** First frame in the clip where the spine is measurable — our "address" reference. */
export function referenceSpine(result: PoseResult): SpineLine | null {
  for (const f of result.frames) {
    if (!f.landmarks) continue;
    const s = spineLine(f.landmarks, result.videoWidth, result.videoHeight);
    if (s) return s;
  }
  return null;
}
