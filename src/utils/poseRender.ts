import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import {
  frameAt, isVisible, referenceSpine, spineLine, SKELETON, LM,
  type PoseResult, type SpineLine,
} from './poseAnalyzer';

// Drawing shared by the live overlay (screen space) and the burn-in renderer
// (video space), so a saved clip looks like what you saw on screen.

export const BONE_COLOR = 'rgba(255, 255, 255, 0.85)';
export const JOINT_COLOR = '#22c55e';
export const SPINE_COLOR = '#f59e0b';
export const REF_SPINE_COLOR = 'rgba(255, 255, 255, 0.6)';

export type ToPoint = (p: { x: number; y: number }) => { x: number; y: number };

export interface PoseStyle {
  /** Maps a normalized landmark to the target canvas. */
  toPoint: ToPoint;
  lineWidth: number;
  jointRadius: number;
  fontSize: number;
  /** Width of the target canvas, used to keep the label on screen. */
  canvasWidth: number;
}

/** Line/dot sizes that suit a canvas of this width. */
export function styleForWidth(width: number, toPoint: ToPoint): PoseStyle {
  const k = width / 400; // the on-screen sizes were tuned at ~400px wide
  return {
    toPoint,
    lineWidth: Math.max(2, 3 * k),
    jointRadius: Math.max(2, 4 * k),
    fontSize: Math.max(12, 14 * k),
    canvasWidth: width,
  };
}

export function drawSkeleton(ctx: CanvasRenderingContext2D, lms: NormalizedLandmark[], style: PoseStyle) {
  ctx.lineWidth = style.lineWidth;
  ctx.lineCap = 'round';
  ctx.strokeStyle = BONE_COLOR;
  for (const [a, b] of SKELETON) {
    if (!isVisible(lms[a]) || !isVisible(lms[b])) continue;
    const p = style.toPoint(lms[a]), q = style.toPoint(lms[b]);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
  }
  ctx.fillStyle = JOINT_COLOR;
  const joints = new Set<number>(SKELETON.flat());
  joints.add(LM.NOSE);
  for (const i of joints) {
    if (!isVisible(lms[i])) continue;
    const p = style.toPoint(lms[i]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, style.jointRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function drawSpine(ctx: CanvasRenderingContext2D, spine: SpineLine, style: PoseStyle, isReference: boolean) {
  const hip = style.toPoint(spine.hip), sh = style.toPoint(spine.shoulder);
  // Extend past the shoulders toward the head so the angle is easy to judge.
  const ext = 0.35;
  const top = { x: sh.x + (sh.x - hip.x) * ext, y: sh.y + (sh.y - hip.y) * ext };
  ctx.save();
  ctx.lineWidth = isReference ? style.lineWidth * 0.7 : style.lineWidth * 1.3;
  ctx.strokeStyle = isReference ? REF_SPINE_COLOR : SPINE_COLOR;
  if (isReference) ctx.setLineDash([style.lineWidth * 3, style.lineWidth * 2]);
  ctx.beginPath();
  ctx.moveTo(hip.x, hip.y);
  ctx.lineTo(top.x, top.y);
  ctx.stroke();
  ctx.restore();
}

export function drawSpineLabel(ctx: CanvasRenderingContext2D, spine: SpineLine, reference: SpineLine | null, style: PoseStyle) {
  const hip = style.toPoint(spine.hip);
  const text = reference
    ? `Spine ${spine.angle.toFixed(0)}°  (start ${reference.angle.toFixed(0)}°)`
    : `Spine ${spine.angle.toFixed(0)}°`;
  ctx.font = `600 ${style.fontSize}px system-ui, sans-serif`;
  const padX = style.fontSize * 0.6;
  const w = ctx.measureText(text).width + padX * 2;
  const h = style.fontSize * 1.9;
  const x = Math.min(Math.max(8, hip.x - w / 2), style.canvasWidth - w - 8);
  const y = hip.y + style.fontSize;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = SPINE_COLOR;
  ctx.fillText(text, x + padX, y + h * 0.7);
}

/** Skeleton + spine + label for one frame's landmarks. */
export function drawPoseScene(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  reference: SpineLine | null,
  videoWidth: number,
  videoHeight: number,
  style: PoseStyle,
) {
  drawSkeleton(ctx, landmarks, style);
  if (reference) drawSpine(ctx, reference, style, true);
  const spine = spineLine(landmarks, videoWidth, videoHeight);
  if (spine) {
    drawSpine(ctx, spine, style, false);
    drawSpineLabel(ctx, spine, reference, style);
  }
}

/** PNG data URL -> bytes, without the async toBlob callback (which browsers throttle). */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * One transparent PNG per analysed frame, at the video's own resolution, ready
 * for ffmpeg to overlay. `extraDraw` paints anything that sits under the
 * skeleton (the telestrator drawings) in the same video coordinate space.
 */
export async function renderPoseSequence(
  result: PoseResult,
  options: { extraDraw?: (ctx: CanvasRenderingContext2D) => void; onProgress?: (fraction: number) => void } = {},
): Promise<Uint8Array[]> {
  const { videoWidth: vw, videoHeight: vh, frames } = result;
  const canvas = document.createElement('canvas');
  canvas.width = vw;
  canvas.height = vh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a canvas for the overlay');

  const reference = referenceSpine(result);
  const style = styleForWidth(vw, (p) => ({ x: p.x * vw, y: p.y * vh }));
  const pngs: Uint8Array[] = [];

  for (let i = 0; i < frames.length; i++) {
    ctx.clearRect(0, 0, vw, vh);
    options.extraDraw?.(ctx);
    const lms = frames[i].landmarks;
    if (lms) drawPoseScene(ctx, lms, reference, vw, vh, style);
    pngs.push(dataUrlToBytes(canvas.toDataURL('image/png')));
    options.onProgress?.((i + 1) / frames.length);
    // Yield now and then so the progress message can repaint.
    if (i % 10 === 9) await new Promise((r) => setTimeout(r, 0));
  }
  return pngs;
}

export { frameAt, referenceSpine, spineLine };
