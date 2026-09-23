'use client';

import { useEffect, useState } from 'react';
import { Loader2, X, Download, ChevronLeft, ChevronRight } from 'lucide-react';
import { POSE_SAMPLE_FPS, type PoseResult } from '@/utils/poseAnalyzer';
import { drawPoseScene, frameAt, referenceSpine, styleForWidth } from '@/utils/poseRender';
import { detectPhases, type LeadSide, type SwingPhase } from '@/utils/swingPhases';

interface Still extends SwingPhase {
  dataUrl: string;
}

interface KeyPositionsProps {
  src: string;
  pose: PoseResult;
  impactHint: number;
  /** Include the skeleton on the stills. */
  withSkeleton: boolean;
  /** Which arm leads: 'left' for a right-handed golfer. */
  leadSide: LeadSide;
  onToggleLeadSide: () => void;
  onSeek: (t: number) => void;
  onClose: () => void;
  /** Base filename (without extension) for saved images. */
  filenameBase: string;
}

/** Grab one frame of the clip, with the skeleton drawn on if asked. */
async function captureStill(
  video: HTMLVideoElement,
  phase: SwingPhase,
  pose: PoseResult,
  withSkeleton: boolean,
): Promise<Still> {
  video.currentTime = phase.t;
  await new Promise<void>((resolve) => { video.onseeked = () => resolve(); });
  // 'seeked' can fire before the frame is ready to draw.
  await new Promise((r) => setTimeout(r, 80));

  const canvas = document.createElement('canvas');
  canvas.width = pose.videoWidth;
  canvas.height = pose.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a canvas for the still');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  if (withSkeleton) {
    const frame = frameAt(pose, phase.t);
    if (frame?.landmarks) {
      const style = styleForWidth(canvas.width, (p) => ({ x: p.x * canvas.width, y: p.y * canvas.height }));
      drawPoseScene(ctx, frame.landmarks, referenceSpine(pose), pose.videoWidth, pose.videoHeight, style);
    }
  }

  // Caption so a saved still says what it is.
  const caption = `${phase.tag} ${phase.label}`;
  const fontSize = Math.max(16, canvas.width / 24);
  ctx.font = `700 ${fontSize}px system-ui, sans-serif`;
  const padding = fontSize * 0.5;
  const textWidth = ctx.measureText(caption).width;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.fillRect(0, 0, textWidth + padding * 2, fontSize * 1.8);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(caption, padding, fontSize * 1.25);

  return { ...phase, dataUrl: canvas.toDataURL('image/jpeg', 0.9) };
}

function download(dataUrl: string, filename: string) {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/** All stills side by side in one image, for sharing or printing. */
async function buildContactSheet(stills: Still[], width: number, height: number): Promise<string> {
  const columns = Math.min(3, stills.length);
  const rows = Math.ceil(stills.length / columns);
  const cellWidth = Math.round(width / 2);
  const cellHeight = Math.round(height / 2);
  const canvas = document.createElement('canvas');
  canvas.width = cellWidth * columns;
  canvas.height = cellHeight * rows;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a canvas for the contact sheet');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await Promise.all(stills.map((still, i) => new Promise<void>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, (i % columns) * cellWidth, Math.floor(i / columns) * cellHeight, cellWidth, cellHeight);
      resolve();
    };
    img.onerror = () => reject(new Error('Could not load a still'));
    img.src = still.dataUrl;
  })));

  return canvas.toDataURL('image/jpeg', 0.9);
}

export default function KeyPositions({ src, pose, impactHint, withSkeleton, leadSide, onToggleLeadSide, onSeek, onClose, filenameBase }: KeyPositionsProps) {
  const [stills, setStills] = useState<Still[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Kept around so a nudged position can be re-captured without reloading the clip.
  const [scrubVideo, setScrubVideo] = useState<HTMLVideoElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.src = src;

    (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          video.onloadeddata = () => resolve();
          video.onerror = () => reject(new Error('Could not load the clip'));
        });
        const phases = detectPhases(pose, impactHint, leadSide);
        if (phases.length === 0) throw new Error('No swing positions found in this clip');

        const captured: Still[] = [];
        for (const phase of phases) {
          if (cancelled) return;
          captured.push(await captureStill(video, phase, pose, withSkeleton));
        }
        if (cancelled) return;
        setStills(captured);
        setScrubVideo(video);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      video.removeAttribute('src');
      video.load();
    };
  }, [src, pose, impactHint, withSkeleton, leadSide]);

  /** Move one position by a frame or two and re-shoot its still. */
  const nudge = async (key: string, frames: number) => {
    if (!stills || !scrubVideo) return;
    const current = stills.find((s) => s.key === key);
    if (!current) return;
    const duration = pose.frames[pose.frames.length - 1]?.t ?? 0;
    const t = Math.max(0, Math.min(duration, current.t + frames / POSE_SAMPLE_FPS));
    const updated = await captureStill(scrubVideo, { ...current, t }, pose, withSkeleton);
    setStills((prev) => prev?.map((s) => (s.key === key ? { ...updated, estimated: s.estimated } : s)) ?? null);
  };

  return (
    <div className="absolute inset-0 z-[120] bg-black/95 backdrop-blur-sm flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <h3 className="text-white font-bold">Key positions</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={onToggleLeadSide}
            className="px-2.5 py-1.5 rounded-lg bg-white/10 text-white/80 text-xs font-bold active:scale-95 transition-transform"
            title="Which hand you swing with (sets the lead arm)"
          >
            {leadSide === 'left' ? 'RH' : 'LH'}
          </button>
          {stills && (
            <button
              onClick={async () => {
                const sheet = await buildContactSheet(stills, pose.videoWidth, pose.videoHeight);
                download(sheet, `${filenameBase}-positions.jpg`);
              }}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-500 text-black text-sm font-bold active:scale-95 transition-transform"
            >
              <Download className="w-4 h-4" /> Save all
            </button>
          )}
          <button onClick={onClose} className="p-2 rounded-full bg-white/10 text-white active:scale-90 transition-transform">
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {!stills && !error && (
          <div className="h-full flex items-center justify-center text-white/80 gap-2">
            <Loader2 className="w-5 h-5 animate-spin text-emerald-400" /> Finding swing positions…
          </div>
        )}
        {error && (
          <div className="h-full flex items-center justify-center text-center text-white/70 px-6">{error}</div>
        )}
        {stills && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {stills.map((still) => (
              <div key={still.key} className="rounded-xl overflow-hidden bg-white/5 border border-white/10">
                <button onClick={() => { onSeek(still.t); onClose(); }} className="block w-full">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={still.dataUrl} alt={still.label} className="w-full object-cover" />
                </button>
                <div className="px-2 py-1.5">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-emerald-400 text-xs font-bold">{still.tag}</span>
                    <span className="text-white text-xs font-semibold truncate">{still.label}</span>
                    {still.estimated && <span className="text-amber-400 text-[10px] font-bold" title="Estimated: defined by the club, which isn't tracked">~</span>}
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <div className="flex items-center gap-1">
                      <button onClick={() => nudge(still.key, -1)} className="p-1 rounded-md bg-white/10 text-white/70 hover:text-white" title="One frame earlier">
                        <ChevronLeft className="w-3.5 h-3.5" />
                      </button>
                      <span className="text-white/50 text-[10px] font-mono tabular-nums">{still.t.toFixed(2)}s</span>
                      <button onClick={() => nudge(still.key, 1)} className="p-1 rounded-md bg-white/10 text-white/70 hover:text-white" title="One frame later">
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <button
                      onClick={() => download(still.dataUrl, `${filenameBase}-${still.key}.jpg`)}
                      className="p-1.5 rounded-md bg-white/10 text-white/70 hover:text-white"
                      title={`Save ${still.label}`}
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
