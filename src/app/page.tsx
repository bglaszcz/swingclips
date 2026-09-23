"use client";

import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { Video, Square, Loader2, RotateCcw, Download, Archive, X, ChevronLeft, ChevronRight, Share2, FileText, ClipboardList, Eraser, Play, Pause, Gauge, History, Trash2, Circle as CircleIcon, Camera, Star, Plus, Minus, PersonStanding, LayoutGrid, SlidersHorizontal } from 'lucide-react';
import PoseOverlay from '@/components/PoseOverlay';
import KeyPositions from '@/components/KeyPositions';
import type { LeadSide } from '@/utils/swingPhases';
import { processSwings, burnLinesToVideo, burnSequenceToVideo, resetFFmpeg, clearDebugLog, getDebugLog, PRE_IMPACT_SECONDS } from '@/utils/videoProcessor';
import { analyzeClip, cachePose, getCachedPose, POSE_SAMPLE_FPS, type PoseResult } from '@/utils/poseAnalyzer';
import { renderPoseSequence, drawPoseScene, frameAt, referenceSpine, styleForWidth } from '@/utils/poseRender';
import { Session, getAllSessions, saveSession, deleteSession, getSession } from '@/utils/db';
import JSZip from 'jszip';

// Sequential DB queue to prevent overlapping transactions and data corruption on mobile
let dbQueue = Promise.resolve();

// Session Limits
const MAX_RECORDING_MINUTES = 5;
const MAX_SHOTS = 30;

// High-framerate testing flag (Set to false to revert to standard 30fps logic)
// Capture frame rates offered in the UI. Higher is better for frame-by-frame
// review and pose tracking, but the phone may ignore it and clips take longer to
// process, so it stays the user's choice (stored per device).
const CAPTURE_FPS_OPTIONS = [30, 60, 120] as const;
type CaptureFps = (typeof CAPTURE_FPS_OPTIONS)[number];
const FPS_STORAGE_KEY = 'swingclips.captureFps';
const LEAD_SIDE_STORAGE_KEY = 'swingclips.leadSide';


// --- MEMOIZED SUB-COMPONENTS ---

interface GalleryGridProps {
  clips: (string | null)[];
  thumbnails: (string | null)[];
  shotNotes: string[];
  favorites: boolean[];
  clipByteSizes: (number | null)[];
  progressText: string;
  onSelect: (idx: number) => void;
  onDelete: (idx: number, e: React.MouseEvent) => void;
  onShare: (url: string, idx: number) => void;
  onDownload: (url: string, idx: number) => void;
  onToggleFavorite: (idx: number, e: React.MouseEvent) => void;
}

const GalleryGrid = memo(({
  clips, thumbnails, shotNotes, favorites, clipByteSizes, progressText,
  onSelect, onDelete, onShare, onDownload, onToggleFavorite
}: GalleryGridProps) => {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
      {clips.map((clipUrl, idx) => (
        <div key={idx} onClick={() => clipUrl && onSelect(idx)} className={`relative group bg-black/25 rounded-xl overflow-hidden shadow-xl border border-white/10 transition-transform ${clipUrl ? 'cursor-pointer active:scale-95' : 'opacity-70'}`}>
          <div className="aspect-[3/4] bg-black relative flex items-center justify-center">
            {clipUrl ? (
              <>
                {thumbnails[idx] ? (
                  <img
                    src={thumbnails[idx] as string}
                    className="w-full h-full object-cover pointer-events-none"
                    alt={`Swing ${idx + 1}`}
                  />
                ) : (
                  <div className="flex flex-col items-center text-center p-4">
                    <Loader2 className="w-6 h-6 animate-spin text-emerald-400/30 mb-2" />
                    <span className="text-[10px] font-bold uppercase tracking-wider text-white/20">Loading...</span>
                  </div>
                )}
                {shotNotes[idx] && <div className="absolute top-2 right-2 bg-emerald-500 p-1 rounded shadow-lg"><FileText className="w-3 h-3 text-white" /></div>}
                {clipByteSizes[idx] != null && (
                  <div className="absolute bottom-2 left-2 z-10">
                    <span className="bg-black/70 text-white/80 text-[9px] font-mono px-1.5 py-0.5 rounded-full backdrop-blur-sm">
                      {clipByteSizes[idx]! < 1024 * 1024
                        ? `${Math.round(clipByteSizes[idx]! / 1024)}KB`
                        : `${(clipByteSizes[idx]! / (1024 * 1024)).toFixed(1)}MB`}
                    </span>
                  </div>
                )}
                <button
                  onClick={(e) => onToggleFavorite(idx, e)}
                  className="absolute top-2 left-2 p-1.5 bg-black/40 hover:bg-black/60 rounded-full backdrop-blur-md transition-all shadow-lg z-10"
                >
                  <Star className={`w-4 h-4 ${favorites[idx] ? 'fill-white text-white' : 'text-white'}`} />
                </button>
              </>
            ) : (
              <div className="flex flex-col items-center text-center p-4">
                <Loader2 className="w-8 h-8 animate-spin text-emerald-400/50 mb-2" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-white/30">Slicing...</span>
              </div>
            )}
          </div>
          <div className="p-3 flex items-center justify-between bg-black/40 backdrop-blur-sm border-t border-white/10">
            <span className="text-xs font-bold text-white/60">Swing #{idx + 1}</span>
            {clipUrl && (
              <div className="flex gap-2">
                <button onClick={(e) => onDelete(idx, e)} className="p-1.5 bg-white/10 hover:bg-red-900/50 rounded-md text-red-400 transition-colors"><Trash2 className="w-4 h-4" /></button>
                <button onClick={(e) => { e.stopPropagation(); onShare(clipUrl, idx); }} className="p-1.5 bg-white/10 hover:bg-white/15 rounded-md text-green-400 transition-colors"><Share2 className="w-4 h-4" /></button>
                <button onClick={(e) => { e.stopPropagation(); onDownload(clipUrl, idx); }} className="p-1.5 bg-white/10 hover:bg-white/15 rounded-md text-emerald-400 transition-colors"><Download className="w-4 h-4" /></button>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
});
GalleryGrid.displayName = 'GalleryGrid';

interface HistoryListProps {
  sessions: Session[];
  currentSessionId: number | null;
  onLoad: (session: Session) => void;
  onDelete: (e: React.MouseEvent, id: number) => void;
}

// Tool drawer building blocks. Rows are full-width and labeled, which is easier
// to hit on a phone than a row of icon-only buttons.
const DrawerSection = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="px-3 py-3 border-b border-white/5">
    <p className="px-2 pb-2 text-[10px] font-bold uppercase tracking-widest text-white/40">{title}</p>
    <div className="flex flex-col gap-1">{children}</div>
  </div>
);

interface DrawerItemProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  danger?: boolean;
  onClick: (e: React.MouseEvent) => void;
  onPointerDown?: () => void;
  onPointerUp?: () => void;
  onPointerLeave?: () => void;
}

const DrawerItem = ({ icon, label, active, danger, ...handlers }: DrawerItemProps) => (
  <button
    {...handlers}
    className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm font-semibold transition-colors active:scale-[0.98] ${active
      ? 'bg-emerald-500 text-black'
      : danger
        ? 'bg-white/5 text-red-400 hover:bg-red-900/30'
        : 'bg-white/5 text-white/80 hover:bg-white/10'}`}
  >
    {icon}
    {label}
  </button>
);

const HistoryList = memo(({ sessions, currentSessionId, onLoad, onDelete }: HistoryListProps) => {
  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {sessions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-white/50">
          <History className="w-12 h-12 mb-4 opacity-20" />
          <p>No saved sessions yet.</p>
        </div>
      ) : (
        sessions.map((session) => (
          <div key={session.id} onClick={() => onLoad(session)} className="bg-black/25 rounded-xl p-4 border border-white/10 shadow-lg cursor-pointer hover:border-emerald-400/50 transition-all active:scale-[0.98]">
            <div className="flex justify-between items-start mb-3">
              <div>
                <h3 className="font-bold text-white">{session.sessionName || new Date(session.id).toLocaleDateString()}</h3>
                <p className="text-xs text-white/50">{session.sessionName ? new Date(session.id).toLocaleDateString() + ' • ' : ''}{new Date(session.id).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • {session.clips.length} swings</p>
              </div>
              <button onClick={(e) => onDelete(e, session.id)} className="p-2 text-white/50 hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-all"><Trash2 className="w-4 h-4" /></button>
            </div>
            {session.sessionNotes && (
              <p className="text-xs text-white/60 line-clamp-2 bg-black/30 p-2 rounded italic">&quot;{session.sessionNotes}&quot;</p>
            )}
            <div className="flex gap-2 mt-3 overflow-hidden h-12">
              {session.clips.slice(0, 5).map((clip, idx) => (
                <div key={idx} className="aspect-[3/4] h-full bg-black rounded overflow-hidden border border-white/10">
                  {clip.thumbnail ? (
                    <img
                      src={clip.thumbnail}
                      className="w-full h-full object-cover"
                      alt={`Swing ${idx + 1}`}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-white/10">
                      <Video className="w-4 h-4 text-white/30" />
                    </div>
                  )}
                </div>
              ))}
              {session.clips.length > 5 && (
                <div className="h-full aspect-square bg-white/10 rounded flex items-center justify-center text-[10px] font-bold text-white/50">+{session.clips.length - 5}</div>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
});
HistoryList.displayName = 'HistoryList';

interface VideoControlsProps {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  playbackRate: number;
  onTogglePlay: () => void;
  onTogglePlaybackRate: () => void;
  onStartStep: (multiplier: number) => void;
  onStopStep: () => void;
  onScrub: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onScrubStart: () => void;
  onScrubEnd: () => void;
  formatSeconds: (s: number) => string;
}

const VideoControls = memo(({
  currentTime, duration, isPlaying, playbackRate,
  onTogglePlay, onTogglePlaybackRate, onStartStep, onStopStep,
  onScrub, onScrubStart, onScrubEnd, formatSeconds
}: VideoControlsProps) => {
  return (
    <div className="absolute bottom-10 inset-x-0 z-40 px-6 pointer-events-none">
      <div className="max-w-3xl mx-auto w-full flex flex-col gap-3 pointer-events-auto">
        {/* Row 1: Controls */}
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            <button
              onPointerDown={() => onStartStep(-1)}
              onPointerUp={onStopStep}
              onPointerLeave={onStopStep}
              className="p-2 bg-black/75 hover:bg-black/90 rounded-full text-white transition-colors"
              title="Previous Frame"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>

            <button
              onClick={onTogglePlay}
              className="p-2 bg-black/75 hover:bg-black/90 rounded-full text-white transition-colors active:scale-90"
            >
              {isPlaying ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current translate-x-0.5" />}
            </button>

            <button
              onPointerDown={() => onStartStep(1)}
              onPointerUp={onStopStep}
              onPointerLeave={onStopStep}
              className="p-2 bg-black/75 hover:bg-black/90 rounded-full text-white transition-colors"
              title="Next Frame"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>

          <button
            onClick={onTogglePlaybackRate}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-all active:scale-90 ml-4 ${playbackRate === 0.25 ? 'bg-emerald-500 text-white' : 'bg-black/75 hover:bg-black/90 text-white'}`}
          >
            <Gauge className="w-4 h-4" />
            <span className="text-xs font-bold">{playbackRate === 1 ? '1x' : '0.25x'}</span>
          </button>
        </div>

        {/* Row 2: Progress */}
        <div className="w-full flex items-center gap-3">
          <div className="flex-1 flex items-center group relative h-6">
            <input
              type="range"
              min="0"
              max={duration || 0}
              step="0.001"
              value={currentTime}
              onChange={onScrub}
              onMouseDown={onScrubStart}
              onMouseUp={onScrubEnd}
              onTouchStart={onScrubStart}
              onTouchEnd={onScrubEnd}
              className="w-full h-1.5 bg-white/20 rounded-full appearance-none cursor-pointer accent-emerald-400 hover:accent-emerald-300 transition-all focus:outline-none"
            />
            {/* Custom Progress Bar background to show "filled" portion */}
            <div
              className="absolute left-0 top-[10px] h-1.5 bg-emerald-500 rounded-full pointer-events-none"
              style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
            />
          </div>

          <span className="text-[10px] font-mono text-white font-bold bg-black/75 rounded-full px-2.5 py-1 w-auto text-right">
            {currentTime.toFixed(2)}s / {duration.toFixed(2)}s
          </span>
        </div>
      </div>
    </div>
  );
});
VideoControls.displayName = 'VideoControls';

// --- MAIN COMPONENT ---

export default function Home() {
  // App states: 'camera' | 'processing' | 'gallery' | 'history'
  const [appState, setAppState] = useState<'camera' | 'processing' | 'gallery' | 'history'>('camera');
  const [showIntro, setShowIntro] = useState<boolean>(true);
  const [recordingTime, setRecordingTime] = useState(0); // Seconds elapsed
  const frameRateRef = useRef(30); // Default to 30fps

  // Persisted voices for Speech Synthesis
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    // On iOS Safari 16.4+, set the audio session type based on app mode.
    // 'ambient'        — respects the hardware mute switch, but blocks audio capture.
    // 'play-and-record'— allows microphone access, but ignores the mute switch.
    // We use 'play-and-record' on the camera screen so the mic works, and switch
    // to 'ambient' in gallery/review so sounds respect the mute switch.
    if (!('audioSession' in navigator)) return;
    (navigator as any).audioSession.type =
      appState === 'camera' ? 'play-and-record' : 'ambient';
  }, [appState]);

  useEffect(() => {
    const loadVoices = () => {
      voicesRef.current = window.speechSynthesis.getVoices();
    };

    loadVoices();
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }, []);
  // Camera & Recording
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [activeDeviceName, setActiveDeviceName] = useState('');
  const [showDeviceToast, setShowDeviceToast] = useState(false);
  const [sensitivity, setSensitivity] = useState(100);
  const sensitivityRef = useRef(100);

  // Real-time audio tracking
  const [shotCount, setShotCount] = useState(0);
  const isRecordingRef = useRef(false);
  const recordingStartTimeRef = useRef(0);
  const impactTimesRef = useRef<number[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const [isPreflightTriggered, setIsPreflightTriggered] = useState(false);
  const audioLoopRef = useRef<number | null>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const playbackAudioContextRef = useRef<AudioContext | null>(null);

  // Audio state refs for real-time detection
  const lastTriggerTimeRef = useRef(0);
  const energyHistoryRef = useRef([0, 0]);


  const playTickSound = () => {
    try {
      if (!playbackAudioContextRef.current) {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        playbackAudioContextRef.current = new AudioContextClass();
      }
      const ctx = playbackAudioContextRef.current;
      if (ctx.state === 'suspended') ctx.resume();

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type = 'sine';
      osc.frequency.setValueAtTime(1200, ctx.currentTime);
      gain.gain.setValueAtTime(0.05, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);

      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.05);
    } catch (e) {
      // Ignore audio errors
    }
  };

  useEffect(() => {
    sensitivityRef.current = sensitivity;
  }, [sensitivity]);

  const playCoinSound = (audioCtx: AudioContext) => {
    const t = audioCtx.currentTime + 0.25;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'square';
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.frequency.setValueAtTime(987.77, t);
    osc.frequency.setValueAtTime(1318.51, t + 0.08);

    gain.gain.setValueAtTime(0.1, t);
    gain.gain.setValueAtTime(0.1, t + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.01, t + 0.4);

    osc.start(t);
    osc.stop(t + 0.4);
  };

  const playLevelCompleteSound = () => {
    try {
      if (!playbackAudioContextRef.current) {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        playbackAudioContextRef.current = new AudioContextClass();
      }
      const ctx = playbackAudioContextRef.current;

      // Explicitly resume for Safari
      if (ctx.state === 'suspended') {
        ctx.resume().then(() => {
          console.log("AudioContext resumed successfully for completion sound");
          triggerLevelCompleteNotes(ctx);
        });
      } else {
        triggerLevelCompleteNotes(ctx);
      }
    } catch (e) {
      console.error("Audio error:", e);
    }
  };

  const triggerLevelCompleteNotes = (ctx: AudioContext) => {
    const t = ctx.currentTime;
    // We'll play a 3-note ascending arpeggio (C4, E4, G4, C5)
    const notes = [261.63, 329.63, 392.00, 523.25];

    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'square'; // 8-bit retro feel
      osc.frequency.setValueAtTime(freq, t + (i * 0.1));

      gain.gain.setValueAtTime(0, t + (i * 0.1));
      gain.gain.linearRampToValueAtTime(0.1, t + (i * 0.1) + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t + (i * 0.1) + 0.15);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(t + (i * 0.1));
      osc.stop(t + (i * 0.1) + 0.15);
    });
  };

  const playPowerDownSound = () => {
    try {
      if (!playbackAudioContextRef.current) {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        playbackAudioContextRef.current = new AudioContextClass();
      }
      const ctx = playbackAudioContextRef.current;
      if (ctx.state === 'suspended') ctx.resume();

      const t = ctx.currentTime;
      // Soft descending chime: A4 → F#4 → D4
      ([[440, 0], [370, 0.13], [294, 0.26]] as [number, number][]).forEach(([freq, delay]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, t + delay);
        gain.gain.setValueAtTime(0, t + delay);
        gain.gain.linearRampToValueAtTime(0.25, t + delay + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t + delay);
        osc.stop(t + delay + 0.4);
      });
    } catch (e) {
      // Ignore
    }
  };

  // Processing
  const [progressText, setProgressText] = useState('');
  const [isBurning, setIsBurning] = useState(false);
  const [burnProgress, setBurnProgress] = useState('');


  // Persistence & History
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<number | null>(null);
  const currentSessionIdRef = useRef<number | null>(null);

  // Gallery
  const [clips, setClips] = useState<(string | null)[]>([]);
  const [thumbnails, setThumbnails] = useState<(string | null)[]>([]);
  const [selectedClipIndex, setSelectedClipIndex] = useState<number | null>(null);
  const [sessionName, setSessionName] = useState('');
  const [sessionNotes, setSessionNotes] = useState('');
  const [shotNotes, setShotNotes] = useState<string[]>([]);
  const [showNotes, setShowNotes] = useState(false);
  const [favorites, setFavorites] = useState<boolean[]>([]);
  const [clipByteSizes, setClipByteSizes] = useState<(number | null)[]>([]);
  const holdStepCountRef = useRef(0);

  // Recording Timer & Limits
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isRecording) {
      setRecordingTime(0);
      interval = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isRecording]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Drawing Tool State
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawMode, setDrawMode] = useState<'line' | 'circle' | 'erase'>('line');
  const [shapes, setShapes] = useState<{ type: 'line' | 'circle', start: { x: number, y: number }, end: { x: number, y: number } }[]>([]);
  const [currentShape, setCurrentShape] = useState<{ type: 'line' | 'circle', start: { x: number, y: number }, end: { x: number, y: number } } | null>(null);
  const [draggedHandle, setDraggedHandle] = useState<{ shapeIndex: number, handle: 'start' | 'end' } | null>(null);
  const [drawColor] = useState('#22c55e'); // Green
  const [showPose, setShowPose] = useState(false);
  // A burned clip waiting for the user's tap to actually share it.
  const [pendingShare, setPendingShare] = useState<{ url: string; index: number } | null>(null);
  const [captureFps, setCaptureFps] = useState<CaptureFps>(30);
  const [cameraInfo, setCameraInfo] = useState<{
    width: number; height: number; fps: number; maxFps: number | null;
    label: string; maxWidth: number | null; maxHeight: number | null;
  } | null>(null);
  // What each getUserMedia attempt returned, for the camera diagnostics readout.
  const [cameraAttempts, setCameraAttempts] = useState<string[]>([]);
  const [showCameraInfo, setShowCameraInfo] = useState(false);
  const fpsLongPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [showKeyPositions, setShowKeyPositions] = useState(false);
  const [keyPositionsPose, setKeyPositionsPose] = useState<PoseResult | null>(null);
  // 'left' lead arm = right-handed golfer, the common case.
  const [leadSide, setLeadSide] = useState<LeadSide>('left');

  // Redraw canvas whenever lines change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = drawColor;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';

    const drawShape = (s: { type: 'line' | 'circle', start: { x: number, y: number }, end: { x: number, y: number } }, isCurrent = false) => {
      ctx.beginPath();
      if (s.type === 'line') {
        ctx.moveTo(s.start.x, s.start.y);
        ctx.lineTo(s.end.x, s.end.y);
      } else {
        const radius = Math.sqrt((s.end.x - s.start.x) ** 2 + (s.end.y - s.start.y) ** 2);
        ctx.arc(s.start.x, s.start.y, radius, 0, Math.PI * 2);
      }
      ctx.strokeStyle = drawColor;
      ctx.lineWidth = 3;
      ctx.stroke();

      // Draw handles
      const drawHandle = (p: { x: number, y: number }) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
        ctx.fillStyle = isCurrent ? '#3b82f6' : 'white';
        ctx.fill();
        ctx.strokeStyle = drawColor;
        ctx.lineWidth = 2;
        ctx.stroke();
      };

      drawHandle(s.start);
      drawHandle(s.end);
    };

    shapes.forEach((s) => drawShape(s));
    if (currentShape) drawShape(currentShape, true);
  }, [shapes, currentShape, drawColor]);

  // Handle Drawing Logic
  const startDrawing = (e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = ('touches' in e) ? e.touches[0].clientX - rect.left : (e as React.MouseEvent).clientX - rect.left;
    const y = ('touches' in e) ? e.touches[0].clientY - rect.top : (e as React.MouseEvent).clientY - rect.top;

    if (drawMode === 'erase') {
      const clickDistThreshold = 15;
      for (let i = shapes.length - 1; i >= 0; i--) {
        const s = shapes[i];
        let isHit = false;

        const distStart = Math.sqrt((x - s.start.x) ** 2 + (y - s.start.y) ** 2);
        const distEnd = Math.sqrt((x - s.end.x) ** 2 + (y - s.end.y) ** 2);

        if (s.type === 'line') {
          const l2 = (s.start.x - s.end.x) ** 2 + (s.start.y - s.end.y) ** 2;
          let hitLine = false;
          if (l2 === 0) {
            hitLine = distStart < clickDistThreshold;
          } else {
            let t = ((x - s.start.x) * (s.end.x - s.start.x) + (y - s.start.y) * (s.end.y - s.start.y)) / l2;
            t = Math.max(0, Math.min(1, t));
            const projX = s.start.x + t * (s.end.x - s.start.x);
            const projY = s.start.y + t * (s.end.y - s.start.y);
            hitLine = Math.sqrt((x - projX) ** 2 + (y - projY) ** 2) < clickDistThreshold;
          }
          isHit = hitLine || distStart < clickDistThreshold || distEnd < clickDistThreshold;
        } else {
          const radius = Math.sqrt((s.end.x - s.start.x) ** 2 + (s.end.y - s.start.y) ** 2);
          const hitCircumference = Math.abs(distStart - radius) < clickDistThreshold;
          isHit = hitCircumference || distStart < clickDistThreshold;
        }

        if (isHit) {
          const newShapes = [...shapes];
          newShapes.splice(i, 1);
          setShapes(newShapes);
          return;
        }
      }
      return;
    }

    // Check if we're grabbing an existing handle
    for (let i = 0; i < shapes.length; i++) {
      const s = shapes[i];
      const distStart = Math.sqrt((x - s.start.x) ** 2 + (y - s.start.y) ** 2);
      const distEnd = Math.sqrt((x - s.end.x) ** 2 + (y - s.end.y) ** 2);

      if (distStart < 15) {
        setDraggedHandle({ shapeIndex: i, handle: 'start' });
        return;
      }
      if (distEnd < 15) {
        setDraggedHandle({ shapeIndex: i, handle: 'end' });
        return;
      }
    }

    // Otherwise, start a new shape
    setCurrentShape({ type: drawMode as 'line' | 'circle', start: { x, y }, end: { x, y } });
  };

  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = ('touches' in e) ? e.touches[0].clientX - rect.left : (e as React.MouseEvent).clientX - rect.left;
    const y = ('touches' in e) ? e.touches[0].clientY - rect.top : (e as React.MouseEvent).clientY - rect.top;

    if (draggedHandle) {
      const newShapes = [...shapes];
      const s = newShapes[draggedHandle.shapeIndex];
      if (draggedHandle.handle === 'start') {
        if (s.type === 'circle') {
          const dx = x - s.start.x;
          const dy = y - s.start.y;
          s.start = { x, y };
          s.end = { x: s.end.x + dx, y: s.end.y + dy };
        } else {
          s.start = { x, y };
        }
      } else {
        s.end = { x, y };
      }
      setShapes(newShapes);
    } else if (currentShape) {
      setCurrentShape({ ...currentShape, end: { x, y } });
    }
  };

  const stopDrawing = () => {
    if (currentShape) {
      setShapes([...shapes, currentShape]);
      setCurrentShape(null);
    }
    setDraggedHandle(null);
  };

  const silentClearCanvas = () => {
    setShapes([]);
    setCurrentShape(null);
  };

  const clearCanvas = () => {
    if (shapes.length > 0) {
      if (window.confirm("Clear all drawings?")) {
        silentClearCanvas();
      }
    } else {
      silentClearCanvas();
    }
  };

  // Player state
  const mainVideoRef = useRef<HTMLVideoElement>(null);
  const stepFrameRequestRef = useRef<number | null>(null);
  const stepDelayTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const continuousStepActiveRef = useRef(false);
  const isSteppingRef = useRef(false);
  const rvfcHandleRef = useRef<number | null>(null);
  const selectedClipIndexRef = useRef<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const wasPlayingBeforeScrub = useRef(false);
  const downloadLongPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const togglePlay = () => {
    if (mainVideoRef.current) {
      if (mainVideoRef.current.paused) {
        mainVideoRef.current.play().catch(() => { });
      } else {
        mainVideoRef.current.pause();
      }
    }
  };

  const togglePlaybackRate = () => {
    const newRate = playbackRate === 1 ? 0.25 : 1;
    setPlaybackRate(newRate);
    if (mainVideoRef.current) {
      mainVideoRef.current.playbackRate = newRate;
    }
  };

  const stepFrame = (delta: number) => {
    if (mainVideoRef.current) {
      const video = mainVideoRef.current;
      video.muted = true;
      video.pause();
      const newTime = Math.max(0, Math.min(duration, video.currentTime + delta));
      video.currentTime = newTime;
      setCurrentTime(newTime);
      playTickSound();
    }
  };

  const startContinuousStep = (direction: number) => {
    if (mainVideoRef.current) mainVideoRef.current.muted = true;
    const delta = direction / frameRateRef.current;
    const isAndroid = /Android/i.test(navigator.userAgent);
    const hasRVFC = typeof (mainVideoRef.current as any)?.requestVideoFrameCallback === 'function';

    // Advance one frame using requestVideoFrameCallback — no currentTime seek,
    // so the MediaCodec decoder pipeline is never flushed. Completes in ~16-33ms
    // regardless of decoder warmup state. Forward only; backward must still seek.
    const stepViaRVFC = (video: HTMLVideoElement): Promise<void> => {
      if (video.ended || video.currentTime >= video.duration - 0.05) return Promise.resolve();
      const startMediaTime = video.currentTime;
      isSteppingRef.current = true;
      return new Promise<void>(resolve => {
        video.play().catch(() => {});
        const cb = (_: number, meta: { mediaTime: number }) => {
          if (meta.mediaTime > startMediaTime + 0.005) {
            rvfcHandleRef.current = null;
            // Guard: if stepping was cancelled while this callback was in flight,
            // don't pause — the user may have already started normal playback.
            if (isSteppingRef.current) {
              video.pause();
              isSteppingRef.current = false;
            }
            setCurrentTime(video.currentTime);
            resolve();
          } else {
            rvfcHandleRef.current = (video as any).requestVideoFrameCallback(cb);
          }
        };
        rvfcHandleRef.current = (video as any).requestVideoFrameCallback(cb);
      });
    };

    // 1. Step once immediately (The Tap)
    if (isAndroid && delta > 0 && hasRVFC) {
      playTickSound();
      stepViaRVFC(mainVideoRef.current!); // fire-and-forget; resolves in ~33ms
    } else {
      stepFrame(delta);
    }

    // 2. Clear any existing state
    continuousStepActiveRef.current = false;
    if (stepDelayTimeoutRef.current) clearTimeout(stepDelayTimeoutRef.current);
    if (stepFrameRequestRef.current) cancelAnimationFrame(stepFrameRequestRef.current);

    // 3. Hold loop — platform-specific to handle decoder differences:
    //
    // Android forward: RVFC-driven. The browser naturally advances the decoder
    //   one frame per step — no flush, no cold-start penalty.
    // Android backward: seeked-event-driven (RVFC can't go backward).
    // Mac/iOS: time-based rAF loop at exactly 10fps.
    stepDelayTimeoutRef.current = setTimeout(() => {
      if (!mainVideoRef.current) return;
      continuousStepActiveRef.current = true;

      const HOLD_STEP_FPS = 8; // Max frame-step rate while holding
      const STEP_INTERVAL_MS = Math.round(1000 / HOLD_STEP_FPS);

      if (isAndroid && delta > 0 && hasRVFC) {
        const runRVFCLoop = async () => {
          while (continuousStepActiveRef.current && mainVideoRef.current) {
            const video = mainVideoRef.current;
            if (video.ended || video.currentTime >= video.duration - 0.05) break;

            // Fire the tick at the top of the iteration so the audio metronome
            // is driven by the loop clock, not by RVFC resolution time.
            playTickSound();

            const stepStart = performance.now();
            await stepViaRVFC(video);
            const elapsed = performance.now() - stepStart;

            // Hard floor: never start the next step sooner than STEP_INTERVAL_MS
            // from when this one started.
            if (elapsed < STEP_INTERVAL_MS) {
              await new Promise<void>(resolve => setTimeout(resolve, STEP_INTERVAL_MS - elapsed));
            }

            if (!continuousStepActiveRef.current) return;
          }
        };
        runRVFCLoop();
      } else if (isAndroid) {
        // Backward on Android: seeked-event-driven (no RVFC for reverse)
        const runSeekLoop = async () => {
          while (continuousStepActiveRef.current && mainVideoRef.current) {
            const stepStart = performance.now();
            stepFrame(delta);

            await new Promise<void>(resolve => {
              mainVideoRef.current!.addEventListener('seeked', () => resolve(), { once: true });
            });

            if (!continuousStepActiveRef.current) return;

            const elapsed = performance.now() - stepStart;
            if (elapsed < STEP_INTERVAL_MS) {
              await new Promise<void>(resolve => setTimeout(resolve, STEP_INTERVAL_MS - elapsed));
            }
          }
        };
        runSeekLoop();
      } else {
        // Mac / iOS: time-based rAF, track targetTime independently of seek speed
        let targetTime = mainVideoRef.current.currentTime;
        let lastStepTime = performance.now();

        const loop = (now: number) => {
          if (!continuousStepActiveRef.current || !mainVideoRef.current) return;

          if (now - lastStepTime >= STEP_INTERVAL_MS) {
            lastStepTime = now;
            targetTime = Math.max(0, Math.min(duration, targetTime + delta));
            mainVideoRef.current.pause();
            mainVideoRef.current.currentTime = targetTime;
            setCurrentTime(targetTime);
            playTickSound();
          }

          stepFrameRequestRef.current = requestAnimationFrame(loop);
        };

        stepFrameRequestRef.current = requestAnimationFrame(loop);
      }
    }, 250); // Wait 250ms of holding before "running"
  };

  const stopContinuousStep = () => {
    continuousStepActiveRef.current = false;
    isSteppingRef.current = false;
    // Cancel any pending RVFC callback so it can't fire during normal playback
    // and call video.pause() unexpectedly.
    if (rvfcHandleRef.current !== null && mainVideoRef.current) {
      (mainVideoRef.current as any).cancelVideoFrameCallback(rvfcHandleRef.current);
      rvfcHandleRef.current = null;
    }
    if (mainVideoRef.current) {
      mainVideoRef.current.muted = false;
      mainVideoRef.current.pause();
    }
    if (stepDelayTimeoutRef.current) {
      clearTimeout(stepDelayTimeoutRef.current);
      stepDelayTimeoutRef.current = null;
    }
    if (stepFrameRequestRef.current) {
      cancelAnimationFrame(stepFrameRequestRef.current);
      stepFrameRequestRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      continuousStepActiveRef.current = false;
      if (stepDelayTimeoutRef.current) clearTimeout(stepDelayTimeoutRef.current);
      if (stepFrameRequestRef.current) cancelAnimationFrame(stepFrameRequestRef.current);
    };
  }, []);

  const handleTimeUpdate = () => {
    if (mainVideoRef.current && !isScrubbing) {
      setCurrentTime(mainVideoRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (mainVideoRef.current) {
      setDuration(mainVideoRef.current.duration);
    }
  };

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    setCurrentTime(time);
    if (mainVideoRef.current) {
      mainVideoRef.current.currentTime = time;
    }
  };

  const handleScrubStart = () => {
    if (mainVideoRef.current) {
      wasPlayingBeforeScrub.current = !mainVideoRef.current.paused;
      mainVideoRef.current.pause();
      setIsScrubbing(true);
    }
  };

  const handleScrubEnd = () => {
    setIsScrubbing(false);
    if (wasPlayingBeforeScrub.current && mainVideoRef.current) {
      mainVideoRef.current.play();
    }
  };

  useEffect(() => {
    selectedClipIndexRef.current = selectedClipIndex;
    // Key positions belong to one clip; drop them when the clip changes.
    setShowTools(false);
    setShowKeyPositions(false);
    setKeyPositionsPose(null);
    if (selectedClipIndex !== null) {
      setIsPlaying(true);
      setCurrentTime(0);
      setPlaybackRate(1);
    } else {
      silentClearCanvas();
    }
  }, [selectedClipIndex]);

  /** Paint the telestrator shapes onto a canvas that is the size of the video itself. */
  const drawShapesToVideoContext = (ctx: CanvasRenderingContext2D) => {
    const video = mainVideoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const cw = canvas.width;
    const ch = canvas.height;

    const scale = Math.max(cw / vw, ch / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const offsetX = (cw - dw) / 2;
    const offsetY = (ch - dh) / 2;

    ctx.strokeStyle = drawColor;
    ctx.lineWidth = 4 / scale; // Scaled line width for video
    ctx.lineCap = 'round';

    const scalePoint = (p: { x: number, y: number }) => ({
      x: (p.x - offsetX) / scale,
      y: (p.y - offsetY) / scale
    });

    const drawShapeToCtx = (s: { type: 'line' | 'circle', start: { x: number, y: number }, end: { x: number, y: number } }) => {
      const start = scalePoint(s.start);
      const end = scalePoint(s.end);

      ctx.beginPath();
      if (s.type === 'line') {
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
      } else {
        const radius = Math.sqrt((end.x - start.x) ** 2 + (end.y - start.y) ** 2);
        ctx.arc(start.x, start.y, radius, 0, Math.PI * 2);
      }
      ctx.stroke();
    };

    shapes.forEach(drawShapeToCtx);
    if (currentShape) drawShapeToCtx(currentShape);
  };

  const generateOverlayBlob = async (): Promise<Blob | null> => {
    if (shapes.length === 0 && !currentShape) return null;
    const video = mainVideoRef.current;
    if (!video) return null;

    const offscreen = document.createElement('canvas');
    offscreen.width = video.videoWidth;
    offscreen.height = video.videoHeight;
    const ctx = offscreen.getContext('2d');
    if (!ctx) return null;

    drawShapesToVideoContext(ctx);

    return new Promise((resolve) => {
      offscreen.toBlob((blob) => resolve(blob), 'image/png');
    });
  };

  /**
   * Key positions needs the pose track. If the skeleton was never switched on
   * for this clip, analyse it now (the result is cached for both features).
   */
  const handleOpenKeyPositions = async () => {
    if (selectedClipIndex === null) return;
    const url = clips[selectedClipIndex];
    if (!url) return;

    setShowKeyPositions(true);
    const cached = getCachedPose(url);
    if (cached) { setKeyPositionsPose(cached); return; }
    try {
      const result = await analyzeClip(url);
      cachePose(url, result);
      setKeyPositionsPose(result);
    } catch (err) {
      console.error('Pose analysis failed:', err);
      setShowKeyPositions(false);
      alert("Couldn't analyze this clip.");
    }
  };

  /** Save the frame on screen, with skeleton and drawings, as a JPEG. */
  const handleSavePhoto = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const video = mainVideoRef.current;
    if (!video || selectedClipIndex === null) return;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    drawShapesToVideoContext(ctx);

    const pose = showPose ? getCachedPose(clips[selectedClipIndex] as string) : null;
    const frame = pose ? frameAt(pose, video.currentTime) : null;
    if (pose && frame?.landmarks) {
      const style = styleForWidth(canvas.width, (p) => ({ x: p.x * canvas.width, y: p.y * canvas.height }));
      drawPoseScene(ctx, frame.landmarks, referenceSpine(pose), pose.videoWidth, pose.videoHeight, style);
    }

    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/jpeg', 0.92);
    link.download = buildPhotoFilename(selectedClipIndex, video.currentTime);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  /**
   * Produce a clip with whatever is on screen burned in. The skeleton moves, so
   * it needs one overlay image per frame; drawings alone need only one.
   * Returns null when there's nothing to burn.
   */
  const buildBurnedClip = async (url: string): Promise<string | null> => {
    const poseResult = showPose ? getCachedPose(url) : null;
    const overlayBlob = await generateOverlayBlob();
    if (!poseResult && !overlayBlob) return null;

    const videoBlob = await (await fetch(url)).blob();

    if (poseResult) {
      setBurnProgress('Drawing skeleton frames...');
      const frames = await renderPoseSequence(poseResult, {
        extraDraw: overlayBlob ? drawShapesToVideoContext : undefined,
        onProgress: (f) => setBurnProgress(`Drawing skeleton frames... ${Math.round(f * 100)}%`),
      });
      return burnSequenceToVideo(videoBlob, frames, POSE_SAMPLE_FPS, frameRateRef.current, setBurnProgress);
    }
    return burnLinesToVideo(videoBlob, overlayBlob!, setBurnProgress);
  };

  const handleFullscreenDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (selectedClipIndex === null) return;
    const url = clips[selectedClipIndex];
    if (!url) return;

    setIsBurning(true);
    setBurnProgress('Processing overlay...');
    try {
      const finalUrl = await buildBurnedClip(url);
      downloadClip(finalUrl ?? url, selectedClipIndex, finalUrl !== null);
    } catch (err) {
      console.error(err);
      alert("Failed to process video overlay.");
    } finally {
      setIsBurning(false);
    }
  };

  const handleFullscreenShare = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (selectedClipIndex === null) return;
    const url = clips[selectedClipIndex];
    if (!url) return;

    setIsBurning(true);
    setBurnProgress('Processing overlay...');
    try {
      const finalUrl = await buildBurnedClip(url);
      if (!finalUrl) {
        // Nothing to burn: still inside the tap, so share straight away.
        await shareClip(url, selectedClipIndex, false);
        return;
      }
      // Burning takes seconds, which uses up the tap that Android requires for
      // sharing, so ask for a fresh tap instead of failing with NotAllowedError.
      setPendingShare({ url: finalUrl, index: selectedClipIndex });
    } catch (err) {
      console.error(err);
      alert("Failed to process video overlay.");
    } finally {
      setIsBurning(false);
    }
  };

  // DB Operations
  const loadHistory = async () => {
    try {
      const data = await getAllSessions();
      setSessions(data);
    } catch (err) {
      console.error("Error loading history:", err);
    }
  };

  const persistIncrementalClip = async (sessionId: number, index: number, videoBlob: Blob, thumbnailData?: Uint8Array) => {
    // Add to sequential queue to prevent overlapping DB transactions
    dbQueue = dbQueue.then(async () => {
      try {
        const currentSession = await getSession(sessionId);
        if (!currentSession) return;

        const arrayBuffer = await videoBlob.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        let thumbnailBase64 = '';
        if (thumbnailData) {
          const binary = Array.from(thumbnailData).map(b => String.fromCharCode(b)).join('');
          thumbnailBase64 = `data:image/jpeg;base64,${window.btoa(binary)}`;
        }

        const updatedClips = [...currentSession.clips];
        updatedClips[index] = {
          ...updatedClips[index],
          data: uint8Array,
          thumbnail: thumbnailBase64 || updatedClips[index]?.thumbnail || ''
        };

        const updatedSession: Session = {
          ...currentSession,
          clips: updatedClips
        };
        await saveSession(updatedSession);

        // Update UI state for thumbnails if we got a new one
        if (thumbnailBase64) {
          setThumbnails(prev => {
            const next = [...prev];
            next[index] = thumbnailBase64;
            return next;
          });
        }
      } catch (err) {
        console.error("Error persisting incremental clip:", err);
        // On mobile Safari, an "Internal Error" often means we need to wait and let 
        // the connection pool clear before trying anything else.
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    });

    return dbQueue;
  };

  const updateNotesInDB = useCallback(async () => {
    if (currentSessionId === null) return;

    // Add to sequential queue
    dbQueue = dbQueue.then(async () => {
      try {
        const currentSession = await getSession(currentSessionId);
        if (!currentSession) return;

        const updatedSession: Session = {
          ...currentSession,
          sessionName,
          sessionNotes,
          clips: currentSession.clips.map((clip, idx) => ({
            ...clip,
            shotNote: shotNotes[idx] || '',
            isFavorite: favorites[idx] || false
          }))
        };
        await saveSession(updatedSession);
      } catch (err) {
        console.error("Error updating notes in DB:", err);
      }
    });

    return dbQueue;
  }, [currentSessionId, sessionName, sessionNotes, shotNotes, favorites]);

  // Debounce note syncing
  useEffect(() => {
    const timer = setTimeout(() => {
      if (appState === 'gallery') updateNotesInDB();
    }, 1000);
    return () => clearTimeout(timer);
  }, [sessionName, sessionNotes, shotNotes, favorites, updateNotesInDB, appState]);

  const loadSession = (session: Session) => {
    // Clear old URLs
    clips.forEach(url => { if (url) URL.revokeObjectURL(url); });

    const newUrls = session.clips.map(c => URL.createObjectURL(new Blob([c.data as any], { type: 'video/mp4' })));
    const newThumbnails = session.clips.map(c => c.thumbnail || null);
    const newShotNotes = session.clips.map(c => c.shotNote);
    const newFavorites = session.clips.map(c => c.isFavorite || false);
    setClips(newUrls);
    setThumbnails(newThumbnails);
    setShotNotes(newShotNotes);
    setFavorites(newFavorites);
    setClipByteSizes(session.clips.map(c => c.data.byteLength > 0 ? c.data.byteLength : null));
    setSessionName(session.sessionName || '');
    setSessionNotes(session.sessionNotes);
    setCurrentSessionId(session.id); currentSessionIdRef.current = session.id;
    setAppState('gallery');
  };

  const deleteHistorySession = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    if (confirm("Delete this session forever?")) {
      await deleteSession(id);
      await loadHistory();
      if (currentSessionId === id) {
        setClips([]);
        setShotNotes([]);
        setSessionNotes('');
        setCurrentSessionId(null); currentSessionIdRef.current = null;
      }
    }
  };

  const startCamera = useCallback(async () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      // Android needs a moment to release the camera; reopening immediately
      // fails with NotReadableError.
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    try {
      const source = selectedDeviceId
        ? { deviceId: { exact: selectedDeviceId } }
        : { facingMode: 'environment' as const };

      // Open the camera at a rate we know works, then ask the live track to go
      // faster only if it says it can. Opening repeatedly with rates the camera
      // refuses can leave it unable to start at all (NotReadableError).
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { ...source, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: captureFps } },
        audio: true,
      });
      streamRef.current = stream;
      setActiveStream(stream);
      if (videoRef.current) videoRef.current.srcObject = stream;



      const track = stream.getVideoTracks()[0];
      const capabilities0 = typeof track.getCapabilities === 'function' ? track.getCapabilities() : undefined;
      const maxFps = capabilities0?.frameRate?.max;
      const attemptLog: string[] = [];

      if (captureFps > 30) {
        if (maxFps && maxFps + 0.5 < captureFps) {
          attemptLog.push(`Camera reports max ${Math.round(maxFps)}fps, so ${captureFps}fps isn't available`);
        } else {
          // Push the live track rather than reopening the camera: if it refuses,
          // we still have a working stream at the rate it gave us.
          try {
            await track.applyConstraints({ frameRate: { exact: captureFps } });
            attemptLog.push(`OK: track accepted exact ${captureFps}fps`);
          } catch (err) {
            attemptLog.push(`${(err as Error).name}: track refused exact ${captureFps}fps`);
          }
        }
      }
      setCameraAttempts(attemptLog);

      const settings = track.getSettings();

      // Detect actual achieved frame rate
      if (settings.frameRate) {
        frameRateRef.current = settings.frameRate;
        console.log(`Camera active: ${settings.width}x${settings.height} @ ${settings.frameRate}fps`);
      } else {
        frameRateRef.current = 30; // Fallback
      }

      // Report what the camera actually gave us — phones silently cap the
      // frame rate, so the request and the result often differ.
      const capabilities = typeof track.getCapabilities === 'function' ? track.getCapabilities() : undefined;
      setCameraInfo({
        width: settings.width ?? 0,
        height: settings.height ?? 0,
        fps: Math.round(settings.frameRate ?? 30),
        maxFps: capabilities?.frameRate?.max ? Math.round(capabilities.frameRate.max) : null,
        label: track.label || 'camera',
        maxWidth: capabilities?.width?.max ?? null,
        maxHeight: capabilities?.height?.max ?? null,
      });

      // Enumerate devices now that we have permissions
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter(d => d.kind === 'videoinput');
      setVideoDevices(videoInputs);
    } catch (err) {
      console.error("Error accessing camera", err);
      alert("Could not access camera. Please allow camera and microphone permissions.");
    }
  }, [selectedDeviceId, captureFps]);

  useEffect(() => {
    if (appState === 'camera' && showIntro === false) startCamera();
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
        setActiveStream(null);
      }
    };
  }, [appState, startCamera, showIntro]);

  useEffect(() => {
    loadHistory();
  }, []);

  // Remember the capture frame rate across visits.
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(FPS_STORAGE_KEY));
      if (CAPTURE_FPS_OPTIONS.includes(saved as CaptureFps)) setCaptureFps(saved as CaptureFps);
    } catch { /* private mode / blocked storage: keep the default */ }
  }, []);

  // Handedness decides which arm is the "lead" arm for the P3/P5 checkpoints.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LEAD_SIDE_STORAGE_KEY);
      if (saved === 'left' || saved === 'right') setLeadSide(saved);
    } catch { /* ignore */ }
  }, []);

  const toggleLeadSide = () => {
    const next: LeadSide = leadSide === 'left' ? 'right' : 'left';
    setLeadSide(next);
    try { localStorage.setItem(LEAD_SIDE_STORAGE_KEY, next); } catch { /* ignore */ }
  };

  const cycleCaptureFps = () => {
    const next = CAPTURE_FPS_OPTIONS[(CAPTURE_FPS_OPTIONS.indexOf(captureFps) + 1) % CAPTURE_FPS_OPTIONS.length];
    setCaptureFps(next);
    try { localStorage.setItem(FPS_STORAGE_KEY, String(next)); } catch { /* ignore */ }
  };

  const toggleCamera = () => {
    if (isRecording || videoDevices.length === 0) return;

    const currentTrack = streamRef.current?.getVideoTracks()[0];
    const currentId = currentTrack?.getSettings().deviceId || selectedDeviceId;

    let currentIndex = videoDevices.findIndex(d => d.deviceId === currentId);
    if (currentIndex === -1) currentIndex = 0;

    const nextIndex = (currentIndex + 1) % videoDevices.length;
    const nextDevice = videoDevices[nextIndex];

    setSelectedDeviceId(nextDevice.deviceId);
    setActiveDeviceName(nextDevice.label || `Camera ${nextIndex + 1}`);
    setShowDeviceToast(true);
    setTimeout(() => setShowDeviceToast(false), 2000);
  };


  useEffect(() => {
    // Only run when in camera view and we have a stream
    if (appState !== 'camera' || !activeStream) {
      if (audioLoopRef.current) {
        cancelAnimationFrame(audioLoopRef.current);
        audioLoopRef.current = null;
      }
      return;
    }

    const stream = activeStream;
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    const audioCtx = new AudioContextClass();
    audioContextRef.current = audioCtx;

    // Resume context if suspended (common in Safari)
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    const dataArray = new Float32Array(analyser.fftSize);

    // Filter state
    let prevRaw = 0;
    let prevFiltered = 0;
    const rc = 1.0 / (2 * Math.PI * 1000); // 1000Hz cutoff
    const dt = 1.0 / audioCtx.sampleRate;
    const alpha = rc / (rc + dt);

    const detectLoop = () => {
      analyser.getFloatTimeDomainData(dataArray);

      // Apply High-Pass Filter and calculate energy for the current frame
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const raw = dataArray[i];
        const filtered = alpha * (prevFiltered + raw - prevRaw);
        prevRaw = raw;
        prevFiltered = filtered;
        sum += Math.abs(filtered);
      }

      // Direct DOM update for the meter bar to bypass React render throttling
      if (meterRef.current) {
        // Unify scale to 150 (the max possible threshold)
        const volPercent = Math.min(100, (sum / 150) * 100);
        meterRef.current.style.width = `${volPercent}%`;
      }

      const threshold = 150 - (sensitivityRef.current / 100) * 140;
      const now = Date.now();

      // Adaptive Spike Logic: current must be > threshold AND significantly louder than previous frames
      const localBackground = (energyHistoryRef.current[0] + energyHistoryRef.current[1]) / 2;
      const isLocalSpike = localBackground === 0 || sum > (localBackground * 2.5); // Unified to 2.5x spike

      if (sum > threshold && isLocalSpike && (now - lastTriggerTimeRef.current > 3000)) {
        const timeSinceStart = recordingStartTimeRef.current ? (now - recordingStartTimeRef.current) : 0;

        // Conditions to trigger:
        // 1. Not recording (Preflight mode)
        // 2. Recording and > 1s has passed
        if (!isRecordingRef.current || timeSinceStart > 1000) {
          lastTriggerTimeRef.current = now;

          if (isRecordingRef.current) {
            impactTimesRef.current.push(timeSinceStart / 1000);
            setShotCount(prev => prev + 1);
          } else {
            setIsPreflightTriggered(true);
            setTimeout(() => setIsPreflightTriggered(false), 500);
          }

          playCoinSound(audioCtx);
        }
      }

      // Update history for next frame
      energyHistoryRef.current.shift();
      energyHistoryRef.current.push(sum);

      audioLoopRef.current = requestAnimationFrame(detectLoop);
    };
    audioLoopRef.current = requestAnimationFrame(detectLoop);

    return () => {
      if (audioLoopRef.current) cancelAnimationFrame(audioLoopRef.current);
      if (audioCtx.state !== 'closed') audioCtx.close();
    };
  }, [appState, activeStream]);

  const startRecording = useCallback(() => {
    if (!streamRef.current) return;
    const stream = streamRef.current;

    recordingStartTimeRef.current = Date.now();
    impactTimesRef.current = [];
    setShotCount(0);

    // Reset audio detection state for the new recording session
    lastTriggerTimeRef.current = 0;
    energyHistoryRef.current = [0, 0];

    // Clear previous session metadata for the new recording
    setSessionName('');
    setSessionNotes('');
    setCurrentSessionId(null); currentSessionIdRef.current = null;

    isRecordingRef.current = true;
    setIsRecording(true);

    const mimeType = MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm;codecs=vp8,opus';
    const mediaRecorder = new MediaRecorder(stream, { mimeType });
    mediaRecorderRef.current = mediaRecorder;
    const chunks: Blob[] = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      isRecordingRef.current = false;
      const impacts = impactTimesRef.current;
      recordingStartTimeRef.current = 0;

      const fullVideoBlob = new Blob(chunks, { type: mediaRecorder.mimeType });
      try {
        if (impacts.length === 0) {
          alert("No swings detected. Try again and adjust sensitivity.");
          setAppState('camera');
          return;
        }

        // 1. Instant UI transition to gallery with placeholders
        const initialNotes = new Array(impacts.length).fill('');
        const initialFavorites = new Array(impacts.length).fill(false);
        setClips(new Array(impacts.length).fill(null));
        setThumbnails(new Array(impacts.length).fill(null));
        setShotNotes(initialNotes);
        setFavorites(initialFavorites);
        setClipByteSizes(new Array(impacts.length).fill(null));
        setAppState('gallery');

        // 2. Create the session in DB immediately with "empty" slots
        const sessionId = Date.now();
        setCurrentSessionId(sessionId); currentSessionIdRef.current = sessionId;
        const placeholderClips = initialNotes.map(() => ({
          data: new Uint8Array(0),
          shotNote: '',
          isFavorite: false
        }));

        const newSession: Session = {
          id: sessionId,
          date: new Date(),
          sessionName: '',
          sessionNotes: '',
          clips: placeholderClips
        };
        await saveSession(newSession);
        await loadHistory();

        // 3. Process and update one-by-one (lightning fast now)
        clearDebugLog();
        const processedUrls: (string | null)[] = new Array(impacts.length).fill(null);
        await processSwings(
          fullVideoBlob,
          impacts,
          setProgressText,
          async (index, clipUrl, clipBlob, thumbnail) => {
            console.log(`[SC] onClipReady index=${index} size=${clipBlob.size}`);
            processedUrls[index] = clipUrl;
            setClips(prev => {
              const next = [...prev];
              next[index] = clipUrl;
              return next;
            });

            // Convert raw thumbnail data to Base64 for immediate UI display if present
            if (thumbnail) {
              const binary = Array.from(thumbnail).map(b => String.fromCharCode(b)).join('');
              const base64 = `data:image/jpeg;base64,${window.btoa(binary)}`;
              setThumbnails(prev => {
                const next = [...prev];
                next[index] = base64;
                return next;
              });
            }

            // Save each clip to DB as soon as it's ready
            try {
              await persistIncrementalClip(sessionId, index, clipBlob, thumbnail);
            } catch (dbErr) {
              console.error(`[SC] persistIncrementalClip failed for index=${index}:`, dbErr);
            }
          }
        );

        // Notify user that processing is complete
        playLevelCompleteSound();
      } catch (err) {
        console.error("Processing error:", err);
        alert("Error processing video.");
      }
    };
    setTimeout(() => {
      mediaRecorder.start(200);
    }, 100);
  }, [sensitivity]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      // Notification sound for stopping
      playPowerDownSound();

      // Delay actual stop/transition so sound is heard
      setTimeout(async () => {
        if (!mediaRecorderRef.current) return;

        // Ensure context exists and is resumed during this user gesture for Safari
        if (!playbackAudioContextRef.current) {
          const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
          playbackAudioContextRef.current = new AudioContextClass();
        }

        if (playbackAudioContextRef.current.state === 'suspended') {
          playbackAudioContextRef.current.resume();
        }

        isRecordingRef.current = false;
        mediaRecorderRef.current.stop();
        setIsRecording(false);
      }, 1000);
    }
  }, [isRecording]);

  // Monitor Session Limits
  useEffect(() => {
    if (isRecording) {
      if (shotCount >= MAX_SHOTS || recordingTime >= MAX_RECORDING_MINUTES * 60) {
        // No need to play sound here, stopRecording handles it
        stopRecording();
      }
    }
  }, [shotCount, recordingTime, isRecording, stopRecording]);

  const dismissIntro = () => {
    setShowIntro(false);
  };

  const resetApp = () => {
    clips.forEach(url => { if (url) URL.revokeObjectURL(url); });
    setClips([]);
    setThumbnails([]);
    setSelectedClipIndex(null);
    setSessionNotes('');
    setShotNotes([]);
    setFavorites([]);
    setActiveDeviceName('');
    setShowDeviceToast(false);
    setAppState('camera');
    // Fire-and-forget: the WASM worker shuts down in the background (300ms).
    // processSwings also calls resetFFmpeg at its own start, so if the worker
    // isn't fully dead yet when the user taps Record again, it gets cleaned up there.
    resetFFmpeg();
  };

  const updateShotNote = (index: number, text: string) => {
    const newNotes = [...shotNotes];
    newNotes[index] = text;
    setShotNotes(newNotes);
  };

  const buildClipFilename = (index: number, withLines?: boolean): string => {
    const ts = currentSessionId ?? Date.now();
    const d = new Date(ts);
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const hm = `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    const num = String(index + 1).padStart(2, '0');
    return `swing-${ymd}-${hm}-${num}${withLines ? '-l' : ''}.mp4`;
  };

  /** Photo filename carries the clip time, so stills from one swing sort in order. */
  const buildPhotoFilename = (index: number, timeSeconds: number): string =>
    buildClipFilename(index).replace(/\.mp4$/, `-${timeSeconds.toFixed(2).replace('.', 'p')}s.jpg`);

  const downloadClip = (url: string, index: number, withLines?: boolean) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = buildClipFilename(index, withLines);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const shareClip = async (url: string, index: number, withLines?: boolean) => {
    try {
      if (!navigator.share) { alert("Sharing not supported."); return; }
      const response = await fetch(url);
      const blob = await response.blob();
      const file = new File([blob], buildClipFilename(index, withLines), { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: `SwingClips #${index + 1}`, text: 'Check out my swing!', });
      }
    } catch (err) { if ((err as any).name !== 'AbortError') console.error("Error sharing:", err); }
  };

  const downloadAllAsZip = async () => {
    const originalText = progressText;
    setProgressText("Creating ZIP archive...");
    setAppState('processing');
    const zip = new JSZip();
    for (let i = 0; i < clips.length; i++) {
      if (!clips[i]) continue;
      const response = await fetch(clips[i] as string);
      const blob = await response.blob();
      zip.file(buildClipFilename(i), blob);
    }
    let reportText = `GOLF SESSION REPORT - ${new Date().toLocaleString()}\n`;
    reportText += `==========================================\n\n`;
    reportText += `SESSION NOTES:\n${sessionNotes || "No notes."}\n\n`;
    shotNotes.forEach((note, idx) => {
      reportText += `SWING #${idx + 1}:\n${note || "No notes."}\n\n`;
    });
    zip.file("session_report.txt", reportText);
    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = `golf_session_${new Date().toISOString().split('T')[0]}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setProgressText(originalText);
    setAppState('gallery');
  };

  const deleteClip = async (index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Delete this swing?")) return;

    const newClips = [...clips];
    const urlToRemove = newClips[index];
    newClips.splice(index, 1);

    const newNotes = [...shotNotes];
    newNotes.splice(index, 1);

    const newThumbnails = [...thumbnails];
    newThumbnails.splice(index, 1);

    const newFavs = [...favorites];
    newFavs.splice(index, 1);

    setClips(newClips);
    setShotNotes(newNotes);
    setThumbnails(newThumbnails);
    setFavorites(newFavs);

    // Update selectedClipIndex if we're deleting from within review or before it
    if (selectedClipIndex !== null) {
      if (newClips.length === 0) {
        setSelectedClipIndex(null);
      } else if (index === selectedClipIndex) {
        if (index >= newClips.length) {
          setSelectedClipIndex(newClips.length - 1);
        }
      } else if (index < selectedClipIndex) {
        setSelectedClipIndex(selectedClipIndex - 1);
      }
    }

    if (urlToRemove) URL.revokeObjectURL(urlToRemove);

    if (currentSessionId !== null) {
      try {
        const allSessions = await getAllSessions();
        const currentSession = allSessions.find(s => s.id === currentSessionId);
        if (currentSession) {
          const newDbClips = [...currentSession.clips];
          newDbClips.splice(index, 1);

          if (newDbClips.length === 0) {
            await deleteSession(currentSessionId);
            setAppState('camera');
            return;
          }

          const updatedSession: Session = {
            ...currentSession,
            clips: newDbClips
          };
          await saveSession(updatedSession);
        }
      } catch (err) {
        console.error("Error updating session after delete:", err);
      }
    }
  };

  const toggleFavorite = (index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const newFavs = [...favorites];
    newFavs[index] = !newFavs[index];
    setFavorites(newFavs);
  };

  if (showIntro === null) {
    return <main className="fixed inset-0" />;
  }

  if (showIntro) {
    return (
      <main className="fixed inset-0 text-white flex flex-col font-sans overflow-y-auto select-none">
        {/* m-auto centers vertically when there's room but lets the content scroll (instead of clipping) on short screens */}
        <div className="flex flex-col items-center p-8 max-w-md m-auto text-center animate-in fade-in duration-500">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/garage-golfers-logo.png"
            alt="Garage Golfers"
            className="h-12 w-auto brightness-0 invert mb-8 drop-shadow-[0_4px_24px_rgba(16,185,129,0.25)]"
          />
          <div className="w-16 h-16 bg-emerald-500 ring-1 ring-emerald-300/40 rounded-2xl flex items-center justify-center mb-6 shadow-2xl shadow-emerald-500/30">
            <Video className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-3xl font-bold mb-4 tracking-tight">Welcome to SwingClips</h1>
          <p className="text-white/80 text-lg leading-relaxed mb-8">
            Record yourself hitting some balls and this app creates clips of each strike with tools for reviewing each shot.
            <br /><br />
            <span className="text-emerald-400 font-semibold">Shots are detected by impact sound</span>, so this works best in an indoor or isolated setting.
          </p>
          <p className="text-white/70 text-base leading-relaxed mb-10">You&apos;ll see an audio preview on the next screen where you can dial in sensitivity for shot detection.</p>
          <button
            onClick={dismissIntro}
            className="w-full py-4 bg-emerald-500 hover:bg-emerald-400 text-black font-bold text-lg rounded-xl shadow-lg shadow-emerald-900/40 active:scale-95 transition-transform"
          >
            Get Started
          </button>
          {sessions.length > 0 && (
            <button
              onClick={() => { setShowIntro(false); setAppState('history'); }}
              className="w-full py-4 mt-3 bg-transparent border border-white/15 text-white/80 font-semibold text-lg rounded-xl active:scale-95 transition-transform hover:bg-white/5"
            >
              View History
            </button>
          )}
          <a
            href="https://www.youtube.com/@garagegolfers"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-10 text-[11px] text-white/40 hover:text-white/70 transition-colors"
          >
            Created by Danny at Garage Golfers ↗
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="fixed inset-0 text-white flex flex-col font-sans overflow-hidden select-none">


      {appState === 'camera' && (
        <div className="relative w-full h-full bg-black flex items-center justify-center overflow-hidden">
          <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover absolute inset-0 z-0" />
          <div className="absolute inset-x-0 top-0 p-6 z-10 flex justify-between items-start bg-gradient-to-b from-black/80 to-transparent">
            <h1 className="text-xl font-bold tracking-tight text-white drop-shadow-md">SwingClips</h1>
            <div className="flex flex-col items-end gap-3">
              {!isRecording && (
                <div className="flex gap-3">
                  <button onClick={() => { loadHistory(); setAppState('history'); }} className="p-3 bg-white/10 hover:bg-white/20 rounded-full backdrop-blur-md border border-white/10 shadow-lg transition-all active:scale-90"><History className="w-6 h-6 text-white" /></button>
                  <button onClick={toggleCamera} className="p-3 bg-white/10 hover:bg-white/20 rounded-full backdrop-blur-md border border-white/10 shadow-lg transition-all active:scale-90"><Camera className="w-6 h-6 text-white" /></button>
                </div>
              )}
              {!isRecording && (
                <button
                  onClick={cycleCaptureFps}
                  onPointerDown={() => {
                    // Long-press: what this phone's camera actually supports. This is
                    // the only reliable way to tell "the app asked wrong" from
                    // "the browser can't do it on this device".
                    fpsLongPressRef.current = setTimeout(() => {
                      fpsLongPressRef.current = null;
                      setShowCameraInfo(true);
                    }, 700);
                  }}
                  onPointerUp={() => { clearTimeout(fpsLongPressRef.current ?? undefined); fpsLongPressRef.current = null; }}
                  onPointerLeave={() => { clearTimeout(fpsLongPressRef.current ?? undefined); fpsLongPressRef.current = null; }}
                  className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-full backdrop-blur-md border border-white/10 shadow-lg transition-all active:scale-90 text-[11px] font-bold text-white/90 whitespace-nowrap"
                  title={cameraInfo
                    ? `Capturing ${cameraInfo.width}x${cameraInfo.height} at ${cameraInfo.fps}fps (asked for ${captureFps}${cameraInfo.maxFps ? `, camera max ${cameraInfo.maxFps}` : ''}). Tap to change.`
                    : 'Capture frame rate (tap to change)'}
                >
                  {/* Kept short so it can't crowd the buttons above it. */}
                  {cameraInfo
                    ? `${cameraInfo.fps}fps${cameraInfo.maxFps && cameraInfo.maxFps <= cameraInfo.fps ? ' max' : cameraInfo.fps < captureFps ? '*' : ''}`
                    : `${captureFps}fps`}
                </button>
              )}
            </div>
          </div>

          {showCameraInfo && (
            <div className="absolute inset-0 z-[120] bg-black/85 backdrop-blur-sm flex items-center justify-center p-5" onClick={() => setShowCameraInfo(false)}>
              <div className="w-full max-w-sm bg-neutral-900 border border-white/10 rounded-2xl p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-white font-bold mb-3">Camera capabilities</h3>
                <dl className="text-xs text-white/80 space-y-1.5 font-mono">
                  <div>Requested: {captureFps}fps</div>
                  <div>Getting: {cameraInfo ? `${cameraInfo.width}x${cameraInfo.height} @ ${cameraInfo.fps}fps` : 'unknown'}</div>
                  <div>Camera max fps: {cameraInfo?.maxFps ?? 'not reported'}</div>
                  <div>Camera max size: {cameraInfo?.maxWidth && cameraInfo?.maxHeight ? `${cameraInfo.maxWidth}x${cameraInfo.maxHeight}` : 'not reported'}</div>
                  <div className="break-words">Device: {cameraInfo?.label ?? 'unknown'}</div>
                  <div>Cameras found: {videoDevices.length}</div>
                  <div>Recording as: {typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/mp4') ? 'mp4' : 'webm'}</div>
                </dl>
                {cameraAttempts.length > 0 && (
                  <>
                    <p className="mt-3 mb-1 text-[10px] font-bold uppercase tracking-widest text-white/40">Attempts</p>
                    <ul className="text-[11px] text-white/70 space-y-1 font-mono">
                      {cameraAttempts.map((a, i) => <li key={i} className="break-words">{a}</li>)}
                    </ul>
                  </>
                )}
                <button
                  onClick={() => setShowCameraInfo(false)}
                  className="mt-4 w-full py-2.5 bg-white/10 text-white font-semibold rounded-xl active:scale-95 transition-transform"
                >
                  Close
                </button>
              </div>
            </div>
          )}

          {/* Camera Switch Toast */}
          <div className={`absolute top-24 inset-x-0 flex justify-center z-20 pointer-events-none transition-all duration-300 ${showDeviceToast ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4'}`}>
            <div className="bg-black/60 backdrop-blur-md text-white text-xs font-bold px-4 py-2 rounded-full border border-white/10 shadow-xl max-w-[80%] text-center truncate">
              {activeDeviceName}
            </div>
          </div>

          <div className="absolute inset-x-0 bottom-0 pb-12 pt-24 bg-gradient-to-t from-black/80 to-transparent z-10 flex flex-col items-center justify-end pointer-events-none">
            {!isRecording && (
              <div className="mb-8 flex flex-col items-center w-72 bg-black/40 backdrop-blur-md p-4 rounded-2xl border border-white/10 shadow-2xl pointer-events-auto">
                <div className="flex justify-between w-full text-[10px] font-bold text-white/60 mb-3 uppercase tracking-widest">
                  <span>Audio Sensitivity Adjustment</span>
                  <div className={`w-2 h-2 rounded-full transition-all duration-300 ${isPreflightTriggered ? 'bg-green-500 shadow-[0_0_10px_#22c55e]' : 'bg-white/20'}`}></div>
                </div>

                {/* Audio Level Meter */}
                <div className="w-full h-1.5 bg-white/10 rounded-full relative mb-6 overflow-hidden">
                  <div
                    ref={meterRef}
                    className="h-full bg-emerald-500/80 transition-[width] duration-75 ease-out"
                    style={{ width: '0%' }}
                  />
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_5px_white] z-10"
                    style={{ left: `${Math.min(100, ((150 - (sensitivity / 100) * 140) / 150) * 100)}%` }}
                  />
                </div>

                {/* Stepped Sensitivity Controls */}
                <div className="flex items-center justify-between w-full px-2">
                  <button
                    onClick={() => setSensitivity(s => Math.max(0, s - 10))}
                    className="p-3 bg-white/5 hover:bg-white/10 rounded-full border border-white/10 active:scale-90 transition-all"
                  >
                    <Minus className="w-5 h-5 text-white" />
                  </button>

                  <div className="flex flex-col items-center">
                    <span className="text-2xl font-black text-white tabular-nums">{sensitivity}</span>
                    <span className="text-[9px] font-bold text-emerald-400 uppercase tracking-tighter">Sensitivity</span>
                  </div>

                  <button
                    onClick={() => setSensitivity(s => Math.min(100, s + 10))}
                    className="p-3 bg-white/5 hover:bg-white/10 rounded-full border border-white/10 active:scale-90 transition-all"
                  >
                    <Plus className="w-5 h-5 text-white" />
                  </button>
                </div>
              </div>
            )}
            {isRecording && (
              <div className="mb-6 flex flex-col items-center pointer-events-auto">
                <div className="flex items-center space-x-2 text-red-500 font-bold animate-pulse mb-3">
                  <div className="w-3 h-3 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)]"></div>
                  <span className="drop-shadow-md uppercase tracking-widest text-xs text-white">Recording</span>
                </div>

                {/* Visual Audio Feedback during recording */}
                <div className="w-48 h-1 bg-white/10 rounded-full relative mb-4 overflow-hidden border border-white/5">
                  <div
                    ref={meterRef}
                    className="h-full bg-emerald-500/80 transition-[width] duration-75 ease-out"
                    style={{ width: '0%' }}
                  />
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-white/50 z-10"
                    style={{ left: `${Math.min(100, ((150 - (sensitivity / 100) * 140) / 150) * 100)}%` }}
                  />
                </div>

                <div className="bg-black/50 border border-white/20 backdrop-blur-md px-6 py-3 rounded-2xl shadow-xl flex flex-col items-center gap-1">
                  <div className="flex items-center gap-4">
                    <div className="flex flex-col items-center">
                      <span className="text-white font-black text-xl tabular-nums">{shotCount}<span className="text-white/50 text-sm font-bold">/{MAX_SHOTS}</span></span>
                      <span className="text-[9px] font-bold text-emerald-400 uppercase tracking-tighter">Shots</span>
                    </div>
                    <div className="w-px h-8 bg-white/10"></div>
                    <div className="flex flex-col items-center">
                      <span className="text-white font-black text-xl tabular-nums">{formatTime(recordingTime)}<span className="text-white/50 text-sm font-bold">/{MAX_RECORDING_MINUTES}:00</span></span>
                      <span className="text-[9px] font-bold text-emerald-400 uppercase tracking-tighter">Elapsed</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
            <button onClick={isRecording ? stopRecording : startRecording} className={`w-20 h-20 rounded-full flex items-center justify-center transition-all shadow-lg active:scale-95 pointer-events-auto ${isRecording ? "bg-red-500 scale-90" : "bg-white hover:bg-gray-200"}`}>{isRecording ? <Square className="text-white w-8 h-8 fill-current" /> : <div className="w-16 h-16 rounded-full border-4 border-black/10 bg-red-500 flex items-center justify-center"><Video className="text-white w-8 h-8" /></div>}</button>
          </div>
        </div>
      )}

      {appState === 'history' && (
        <div className="flex-1 flex flex-col bg-black/40 z-20 overflow-hidden">
          <div className="p-4 pt-8 flex items-center justify-between border-b border-white/10 bg-black/25 shadow-md">
            <div className="flex items-center gap-3">
              <button onClick={() => setAppState('camera')} className="p-2 bg-white/10 hover:bg-white/15 rounded-lg text-white/60"><ChevronLeft className="w-5 h-5" /></button>
              <div><h1 className="text-lg font-bold text-white">History</h1><p className="text-xs text-white/60">{sessions.length} sessions saved</p></div>
            </div>
          </div>
          <HistoryList
            sessions={sessions}
            currentSessionId={currentSessionId}
            onLoad={loadSession}
            onDelete={deleteHistorySession}
          />
        </div>
      )}

      {appState === 'processing' && (
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center z-20 bg-black/25">
          <Loader2 className="w-16 h-16 animate-spin text-emerald-400 mb-6" />
          <h2 className="text-2xl font-bold mb-2 uppercase tracking-tighter text-white">Processing</h2>
          <p className="text-white/60 font-medium px-4 py-2 bg-black/40 rounded-lg">{progressText}</p>
        </div>
      )}

      {appState === 'gallery' && (
        <div className="flex-1 flex flex-col bg-black/40 z-20 overflow-hidden">
          <div className="p-4 pt-8 flex items-center justify-between border-b border-white/10 bg-black/25 shadow-md">
            <div><h1 className="text-lg font-bold text-white">Session Gallery</h1><p className="text-xs text-white/60">{clips.length} swings captured</p></div>
            <div className="flex gap-2">
              <button onClick={() => { loadHistory(); setAppState('history'); }} className="p-2 px-3 bg-white/10 hover:bg-white/15 rounded-lg transition-colors flex items-center gap-2"><History className="w-4 h-4 text-white/80" /><span className="text-sm font-semibold text-white/80">History</span></button>
              <button
                onClick={downloadAllAsZip}
                onPointerDown={() => {
                  downloadLongPressRef.current = setTimeout(() => {
                    downloadLongPressRef.current = null;
                    navigator.clipboard.writeText(getDebugLog()).catch(() => {});
                  }, 700);
                }}
                onPointerUp={() => { clearTimeout(downloadLongPressRef.current ?? undefined); downloadLongPressRef.current = null; }}
                onPointerLeave={() => { clearTimeout(downloadLongPressRef.current ?? undefined); downloadLongPressRef.current = null; }}
                className="p-2 px-3 bg-emerald-500 hover:bg-emerald-600 rounded-lg transition-colors flex items-center gap-2"
                title="ZIP All (long-press to copy debug log)"
              ><Archive className="w-4 h-4 text-white" /><span className="text-sm font-semibold text-white">ZIP All</span></button>
              <button onClick={resetApp} className="p-2 px-3 bg-white/10 hover:bg-white/15 rounded-lg transition-colors flex items-center gap-2"><RotateCcw className="w-4 h-4 text-white/80" /><span className="text-sm font-semibold text-white/80">New</span></button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto bg-black/40">
            <div className="p-4 max-w-7xl mx-auto w-full">
              <div className="flex flex-col md:flex-row gap-4 mb-6">
                <div className="flex-1 bg-black/25 rounded-xl p-4 border border-white/10 shadow-lg">
                  <div className="flex items-center gap-2 mb-2 text-emerald-400"><FileText className="w-5 h-5" /><h3 className="font-bold text-sm uppercase tracking-wider text-emerald-400">Session Name</h3></div>
                  <input type="text" value={sessionName} onChange={(e) => setSessionName(e.target.value)} placeholder="e.g. 7-Iron Drills..." className="w-full bg-black/40 border border-white/10 rounded-lg p-3 text-sm text-white/90 placeholder:text-white/30 focus:ring-1 focus:ring-emerald-400 focus:border-emerald-400 outline-none transition-all" />
                </div>
                <div className="flex-1 bg-black/25 rounded-xl p-4 border border-white/10 shadow-lg">
                  <div className="flex items-center gap-2 mb-2 text-emerald-400"><ClipboardList className="w-5 h-5" /><h3 className="font-bold text-sm uppercase tracking-wider text-emerald-400">Overall Session Notes</h3></div>
                  <textarea value={sessionNotes} onChange={(e) => setSessionNotes(e.target.value)} placeholder="e.g. Focus: Keeping head still..." className="w-full bg-black/40 border border-white/10 rounded-lg p-3 text-sm text-white/90 placeholder:text-white/30 focus:ring-1 focus:ring-emerald-400 focus:border-emerald-400 outline-none transition-all min-h-[45px]" />
                </div>
              </div>
              <GalleryGrid
                clips={clips}
                thumbnails={thumbnails}
                shotNotes={shotNotes}
                favorites={favorites}
                clipByteSizes={clipByteSizes}
                progressText={progressText}
                onSelect={setSelectedClipIndex}
                onDelete={deleteClip}
                onShare={shareClip}
                onDownload={downloadClip}
                onToggleFavorite={toggleFavorite}
              />
            </div>
          </div>

          {selectedClipIndex !== null && (
            <div className="fixed inset-0 z-50 bg-black overflow-hidden select-none">
              {isBurning && (
                <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm">
                  <Loader2 className="w-12 h-12 text-emerald-400 animate-spin mb-4" />
                  <p className="text-white font-bold">{burnProgress}</p>
                </div>
              )}

              {/* Fullscreen Video Container */}              <div className="absolute inset-0 bg-black overflow-hidden">
                <video
                  ref={mainVideoRef}
                  key={clips[selectedClipIndex] as string}
                  src={clips[selectedClipIndex] as string}
                  autoPlay
                  loop
                  playsInline
                  onTimeUpdate={handleTimeUpdate}
                  onLoadedMetadata={handleLoadedMetadata}
                  onPlay={() => { if (!isSteppingRef.current) setIsPlaying(true); }}
                  onPause={() => { if (!isSteppingRef.current) setIsPlaying(false); }}
                  className="w-full h-full object-cover absolute inset-0 z-0"
                />

                <PoseOverlay
                  videoRef={mainVideoRef}
                  src={clips[selectedClipIndex] as string}
                  enabled={showPose}
                />

                {/* Telestrator Canvas */}
                <canvas
                  ref={canvasRef}
                  width={typeof window !== 'undefined' ? window.innerWidth : 1920}
                  height={typeof window !== 'undefined' ? window.innerHeight : 1080}
                  onMouseDown={startDrawing}
                  onMouseMove={draw}
                  onMouseUp={stopDrawing}
                  onMouseLeave={stopDrawing}
                  onTouchStart={startDrawing}
                  onTouchMove={draw}
                  onTouchEnd={stopDrawing}
                  className="absolute inset-0 z-30 touch-none"
                  style={{ cursor: drawMode === 'erase' ? "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='red' stroke-width='4' stroke-linecap='round'><path d='M18 6 6 18'/><path d='m6 6 12 12'/></svg>\") 12 12, crosshair" : "crosshair" }}
                />

                {/* Custom Video Controls */}
                <VideoControls
                  currentTime={currentTime}
                  duration={duration}
                  isPlaying={isPlaying}
                  playbackRate={playbackRate}
                  onTogglePlay={togglePlay}
                  onTogglePlaybackRate={togglePlaybackRate}
                  onStartStep={startContinuousStep}
                  onStopStep={stopContinuousStep}
                  onScrub={handleScrub}
                  onScrubStart={handleScrubStart}
                  onScrubEnd={handleScrubEnd}
                  formatSeconds={(s) => s.toFixed(2)}
                />

                <div className="absolute inset-x-4 top-1/2 -translate-y-1/2 flex items-center justify-between pointer-events-none z-40">
                  <button disabled={selectedClipIndex === 0} onClick={(e) => { e.stopPropagation(); setSelectedClipIndex(selectedClipIndex - 1); }} className={`p-4 bg-black/50 rounded-full text-white pointer-events-auto backdrop-blur-md transition-all active:scale-90 ${selectedClipIndex === 0 ? 'opacity-0 invisible' : 'opacity-100 visible'}`}><ChevronLeft className="w-8 h-8" /></button>
                  <button disabled={selectedClipIndex === clips.length - 1} onClick={(e) => { e.stopPropagation(); setSelectedClipIndex(selectedClipIndex + 1); }} className={`p-4 bg-black/50 rounded-full text-white pointer-events-auto backdrop-blur-md transition-all active:scale-90 ${selectedClipIndex === clips.length - 1 ? 'opacity-0 invisible' : 'opacity-100 visible'}`}><ChevronRight className="w-8 h-8" /></button>
                </div>
              </div>

              {/* Header Overlay */}
              <div className="px-4 py-4 flex items-center justify-between bg-gradient-to-b from-black/90 to-transparent absolute top-0 inset-x-0 z-50 pointer-events-none">
                <div className="flex flex-col text-white pointer-events-auto">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-base font-bold">Swing {selectedClipIndex + 1} of {clips.length}</h2>
                    {clipByteSizes[selectedClipIndex] != null && (
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full bg-black/60 text-white/80">
                        {clipByteSizes[selectedClipIndex]! < 1024 * 1024
                          ? `${Math.round(clipByteSizes[selectedClipIndex]! / 1024)}KB`
                          : `${(clipByteSizes[selectedClipIndex]! / (1024 * 1024)).toFixed(1)}MB`}
                      </span>
                    )}
                  </div>
                  {/* One button instead of a row of them: at phone width the old
                      row ran into the actions on the right and pushed them off screen. */}
                  <button
                    onClick={() => setShowTools(true)}
                    className={`flex items-center gap-1.5 mt-1 px-3 py-2 rounded-lg transition-colors ${showPose || showNotes || shapes.length > 0 ? 'bg-emerald-500 text-white' : 'bg-white/10 text-white/80'}`}
                    title="Tools"
                  >
                    <SlidersHorizontal className="w-4 h-4" />
                    <span className="text-xs font-bold">Tools</span>
                  </button>
                </div>
                <div className="flex items-center gap-2 pointer-events-auto">
                  <button
                    onClick={(e) => selectedClipIndex !== null && toggleFavorite(selectedClipIndex, e)}
                    className={`p-2.5 rounded-full shadow-lg active:scale-90 transition-all ${selectedClipIndex !== null && favorites[selectedClipIndex] ? 'bg-amber-500 text-white' : 'bg-white/10 text-white hover:text-amber-400'}`}
                    title="Favorite"
                  >
                    <Star className={`w-5 h-5 ${selectedClipIndex !== null && favorites[selectedClipIndex] ? 'fill-current' : ''}`} />
                  </button>
                  <button onClick={handleFullscreenShare} className="p-2.5 bg-green-600 rounded-full text-white shadow-lg active:scale-90 transition-transform" title="Share"><Share2 className="w-5 h-5" /></button>
                  <button onClick={(e) => { e.stopPropagation(); setSelectedClipIndex(null); }} className="p-2.5 bg-white/10 rounded-full text-white shadow-lg active:scale-90 transition-transform" title="Close"><X className="w-5 h-5" /></button>
                </div>
              </div>

              {/* Tool drawer: everything that used to crowd the header row. */}
              {showTools && (
                <div className="absolute inset-0 z-[115]" onClick={() => setShowTools(false)}>
                  <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
                  <div
                    className="absolute inset-y-0 right-0 w-72 max-w-[85%] bg-neutral-900 border-l border-white/10 shadow-2xl overflow-y-auto animate-in slide-in-from-right duration-200"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                      <h3 className="text-white font-bold">Tools</h3>
                      <button onClick={() => setShowTools(false)} className="p-2 rounded-full bg-white/10 text-white active:scale-90 transition-transform">
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    <DrawerSection title="Analysis">
                      <DrawerItem
                        icon={<PersonStanding className="w-4 h-4" />}
                        label="Skeleton"
                        active={showPose}
                        onClick={() => setShowPose(!showPose)}
                      />
                      <DrawerItem
                        icon={<LayoutGrid className="w-4 h-4" />}
                        label="Key positions"
                        onClick={() => { setShowTools(false); handleOpenKeyPositions(); }}
                      />
                    </DrawerSection>

                    <DrawerSection title="Draw">
                      <DrawerItem
                        icon={drawMode === 'circle' ? <CircleIcon className="w-4 h-4" /> : (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                            <line x1="5" y1="19" x2="19" y2="5" />
                            <circle cx="5" cy="19" r="1.5" fill="currentColor" />
                            <circle cx="19" cy="5" r="1.5" fill="currentColor" />
                          </svg>
                        )}
                        label={drawMode === 'circle' ? 'Circle' : 'Line'}
                        active={drawMode === 'line' || drawMode === 'circle'}
                        onClick={() => setDrawMode(drawMode === 'line' ? 'circle' : 'line')}
                      />
                      <DrawerItem
                        icon={<Eraser className="w-4 h-4" />}
                        label="Eraser"
                        active={drawMode === 'erase'}
                        onClick={() => setDrawMode(drawMode === 'erase' ? 'line' : 'erase')}
                      />
                      <DrawerItem icon={<X className="w-4 h-4" />} label="Clear drawings" onClick={clearCanvas} />
                    </DrawerSection>

                    <DrawerSection title="This clip">
                      <DrawerItem
                        icon={<FileText className="w-4 h-4" />}
                        label="Notes"
                        active={showNotes}
                        onClick={() => { setShowNotes(!showNotes); setShowTools(false); }}
                      />
                      <DrawerItem
                        icon={<Camera className="w-4 h-4" />}
                        label="Save this frame"
                        onClick={(e) => { setShowTools(false); handleSavePhoto(e); }}
                      />
                      <DrawerItem
                        icon={<Download className="w-4 h-4" />}
                        label="Save clip"
                        onClick={(e) => { setShowTools(false); handleFullscreenDownload(e); }}
                        onPointerDown={() => {
                          downloadLongPressRef.current = setTimeout(() => {
                            downloadLongPressRef.current = null;
                            navigator.clipboard.writeText(getDebugLog()).catch(() => {});
                          }, 700);
                        }}
                        onPointerUp={() => { clearTimeout(downloadLongPressRef.current ?? undefined); downloadLongPressRef.current = null; }}
                        onPointerLeave={() => { clearTimeout(downloadLongPressRef.current ?? undefined); downloadLongPressRef.current = null; }}
                      />
                      <DrawerItem
                        icon={<Trash2 className="w-4 h-4" />}
                        label="Delete clip"
                        danger
                        onClick={(e) => { setShowTools(false); if (selectedClipIndex !== null) deleteClip(selectedClipIndex, e); }}
                      />
                    </DrawerSection>
                  </div>
                </div>
              )}

              {showKeyPositions && (
                keyPositionsPose ? (
                  <KeyPositions
                    src={clips[selectedClipIndex] as string}
                    pose={keyPositionsPose}
                    impactHint={PRE_IMPACT_SECONDS}
                    withSkeleton={showPose}
                    leadSide={leadSide}
                    onToggleLeadSide={toggleLeadSide}
                    filenameBase={buildClipFilename(selectedClipIndex).replace(/\.mp4$/, '')}
                    onSeek={(t) => {
                      if (mainVideoRef.current) {
                        mainVideoRef.current.pause();
                        mainVideoRef.current.currentTime = t;
                        setCurrentTime(t);
                      }
                    }}
                    onClose={() => setShowKeyPositions(false)}
                  />
                ) : (
                  <div className="absolute inset-0 z-[120] bg-black/90 flex items-center justify-center gap-2 text-white">
                    <Loader2 className="w-5 h-5 animate-spin text-emerald-400" /> Analyzing swing…
                  </div>
                )
              )}

              {/* Share confirmation: Android only allows sharing from a tap, and
                  the burn-in above outlives the original one. */}
              {pendingShare && (
                <div className="absolute inset-0 z-[110] flex items-center justify-center bg-black/80 backdrop-blur-sm p-6">
                  <div className="w-full max-w-sm bg-neutral-900 border border-white/10 rounded-2xl p-6 text-center shadow-2xl">
                    <h3 className="text-white font-bold text-lg mb-2">Clip ready</h3>
                    <p className="text-white/70 text-sm mb-6">Your swing has been rendered with the overlay.</p>
                    <div className="flex flex-col gap-2">
                      <button
                        onClick={async () => {
                          const { url, index } = pendingShare;
                          setPendingShare(null);
                          await shareClip(url, index, true);
                        }}
                        className="w-full py-3 bg-green-600 text-white font-bold rounded-xl active:scale-95 transition-transform"
                      >
                        Share
                      </button>
                      <button
                        onClick={() => {
                          const { url, index } = pendingShare;
                          setPendingShare(null);
                          downloadClip(url, index, true);
                        }}
                        className="w-full py-3 bg-emerald-500 text-black font-bold rounded-xl active:scale-95 transition-transform"
                      >
                        Save to device
                      </button>
                      <button
                        onClick={() => setPendingShare(null)}
                        className="w-full py-3 bg-white/10 text-white/80 font-semibold rounded-xl active:scale-95 transition-transform"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Notes Overlay */}
              {showNotes && (
                <div className="absolute inset-x-0 bottom-32 px-6 z-50 animate-in slide-in-from-bottom duration-300">
                  <div className="max-w-xl mx-auto bg-black/40 backdrop-blur-md rounded-2xl p-4 border border-white/10 shadow-2xl">
                    <div className="flex items-center justify-between mb-2 text-emerald-400">
                      <div className="flex items-center gap-2">
                        <FileText className="w-5 h-5" />
                        <h3 className="font-bold text-sm uppercase tracking-wider">Clip Notes</h3>
                      </div>
                      <button onClick={() => setShowNotes(false)} className="p-1 rounded-md text-white/60 hover:text-white transition-colors">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <textarea
                      value={shotNotes[selectedClipIndex]}
                      onChange={(e) => updateShotNote(selectedClipIndex, e.target.value)}
                      placeholder="Record feedback for this swing..."
                      className="w-full bg-black/40 border border-white/10 rounded-xl p-4 text-white/90 placeholder:text-white/30 focus:ring-1 focus:ring-emerald-400 focus:border-emerald-400 outline-none transition-all min-h-[120px]"
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </main>
  );
}
