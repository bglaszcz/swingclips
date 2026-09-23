'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { Loader2 } from 'lucide-react';
import { analyzeClip, cachePose, getCachedPose } from '@/utils/poseAnalyzer';
import { drawPoseScene, frameAt, referenceSpine, styleForWidth } from '@/utils/poseRender';

type Status = 'idle' | 'analyzing' | 'ready' | 'error';

interface PoseOverlayProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  src: string;
  enabled: boolean;
}

export default function PoseOverlay({ videoRef, src, enabled }: PoseOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Progress of the analysis job for `job.src`; finished results live in the shared cache.
  const [job, setJob] = useState<{ src: string; progress: number; failed: boolean } | null>(null);

  const result = getCachedPose(src);
  const currentJob = job?.src === src ? job : null;
  const status: Status = result ? 'ready' : currentJob?.failed ? 'error' : enabled ? 'analyzing' : 'idle';
  const progress = currentJob?.progress ?? 0;

  // Run the analysis for this clip when the overlay is switched on (once per clip).
  useEffect(() => {
    if (!enabled || !src || getCachedPose(src)) return;
    const controller = new AbortController();
    analyzeClip(src, (p) => setJob({ src, progress: p, failed: false }), controller.signal)
      .then((r) => {
        cachePose(src, r);
        setJob({ src, progress: 1, failed: false });
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        console.error('Pose analysis failed:', err);
        setJob({ src, progress: 0, failed: true });
      });
    return () => controller.abort();
  }, [enabled, src]);

  // Draw the pose for whatever frame the player is showing.
  useEffect(() => {
    if (!enabled || !result) return;
    const reference = referenceSpine(result);
    let raf = 0;

    const render = () => {
      raf = requestAnimationFrame(render);
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video) return;

      const dpr = window.devicePixelRatio || 1;
      const cw = canvas.clientWidth, ch = canvas.clientHeight;
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      const frame = frameAt(result, video.currentTime);
      if (!frame?.landmarks) return;

      // Match the player's object-cover scaling so joints land on the body.
      const vw = result.videoWidth, vh = result.videoHeight;
      const scale = Math.max(cw / vw, ch / vh);
      const offX = (cw - vw * scale) / 2;
      const offY = (ch - vh * scale) / 2;
      const style = styleForWidth(cw, (p) => ({ x: p.x * vw * scale + offX, y: p.y * vh * scale + offY }));

      drawPoseScene(ctx, frame.landmarks, reference, vw, vh, style);
    };
    render();
    return () => cancelAnimationFrame(raf);
  }, [enabled, result, videoRef]);

  if (!enabled) return null;

  const notice =
    status === 'analyzing' ? `Analyzing swing… ${Math.round(progress * 100)}%`
      : status === 'error' ? "Couldn't analyze this clip"
        : status === 'ready' && result && result.frames.every((f) => !f.landmarks) ? 'No golfer detected in this clip'
          : null;

  return (
    <>
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full z-20 pointer-events-none" />
      {notice && (
        <div className="absolute top-28 inset-x-0 z-40 flex justify-center pointer-events-none">
          <div className={`flex items-center gap-2 px-4 py-2 rounded-full backdrop-blur-md text-white text-sm font-semibold ${status === 'error' ? 'bg-red-900/80' : 'bg-black/70'}`}>
            {status === 'analyzing' && <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />}
            {notice}
          </div>
        </div>
      )}
    </>
  );
}
