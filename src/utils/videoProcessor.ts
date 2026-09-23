import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

// How many seconds before impact the clip starts.
export const PRE_IMPACT_SECONDS: number =
  parseFloat(process.env.NEXT_PUBLIC_PRE_IMPACT_SECONDS ?? '2');

// How many seconds after impact the clip ends.
export const POST_IMPACT_SECONDS: number =
  parseFloat(process.env.NEXT_PUBLIC_POST_IMPACT_SECONDS ?? '2');

// Total clip duration derived from the above two.
export const CLIP_DURATION = PRE_IMPACT_SECONDS + POST_IMPACT_SECONDS;

// Thumbnail still frame offset from clip start.
// Defaults to PRE_IMPACT_SECONDS (i.e. at impact).
// Set NEXT_PUBLIC_THUMBNAIL_OFFSET to shift it:
//   PRE_IMPACT_SECONDS - 0.5 = half a second before impact
//   PRE_IMPACT_SECONDS + 0.5 = half a second after impact
export const THUMBNAIL_OFFSET: number =
  parseFloat(process.env.NEXT_PUBLIC_THUMBNAIL_OFFSET ?? String(PRE_IMPACT_SECONDS));

let ffmpeg: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

// In-app debug log — captured so the user can copy/share without DevTools.
const _debugEntries: string[] = [];
function scLog(msg: string) {
  const entry = `${new Date().toISOString().slice(11, 23)} ${msg}`;
  console.log(`[SC] ${msg}`);
  _debugEntries.push(entry);
  if (_debugEntries.length > 300) _debugEntries.shift();
}
function scError(msg: string, err?: unknown) {
  const detail = err instanceof Error ? `${err.message}${err.stack ? '\n' + err.stack : ''}` : String(err ?? '');
  const full = detail ? `${msg}: ${detail}` : msg;
  console.error(`[SC] ${full}`);
  _debugEntries.push(`ERROR ${new Date().toISOString().slice(11, 23)} ${full}`);
}
export function getDebugLog(): string { return _debugEntries.join('\n'); }
export function clearDebugLog(): void { _debugEntries.length = 0; }

export async function resetFFmpeg() {
  if (ffmpeg) {
    scLog('resetFFmpeg: terminating existing instance');
    try {
      ffmpeg.terminate();
    } catch (e) {
      scError('resetFFmpeg: terminate threw', e);
    }
    ffmpeg = null;
    loadPromise = null;

    // Crucial for mobile stability: give the browser a moment
    // to actually kill the worker and free the memory handles.
    await new Promise(resolve => setTimeout(resolve, 300));
    scLog('resetFFmpeg: done');
  } else {
    scLog('resetFFmpeg: no-op (ffmpeg already null)');
  }
}

// Per-operation timeout: prevents Android from hanging indefinitely if the
// FFmpeg Worker is killed by the OS (Worker death silently hangs promises).
const EXEC_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 15_000;

// Incremented each time processSwings starts. Old loops check against their
// captured ID and exit early if a newer session has taken over.
let processingId = 0;

async function execWithTimeout(fm: FFmpeg, args: string[], label: string): Promise<number> {
  let timerId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new Error(`${label} exec timed out after ${EXEC_TIMEOUT_MS / 1000}s`)), EXEC_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([fm.exec(args), timeoutPromise]);
    return result as number;
  } finally {
    clearTimeout(timerId!);
  }
}

async function readFileWithTimeout(fm: FFmpeg, path: string, label: string): Promise<Uint8Array<ArrayBuffer>> {
  let timerId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new Error(`${label} readFile timed out after ${READ_TIMEOUT_MS / 1000}s`)), READ_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([fm.readFile(path), timeoutPromise]);
    return new Uint8Array(result as any) as unknown as Uint8Array<ArrayBuffer>;
  } finally {
    clearTimeout(timerId!);
  }
}

export async function initFFmpeg(onProgress: (msg: string) => void): Promise<FFmpeg> {
  if (ffmpeg && (ffmpeg as any).isLoaded) { scLog('initFFmpeg: reusing loaded instance'); return ffmpeg; }
  if (loadPromise) { scLog('initFFmpeg: joining in-progress load'); return loadPromise; }

  loadPromise = (async () => {
    onProgress('Loading video engine...');
    const fm = new FFmpeg();

    try {
      const baseURL = window.location.origin + '/ffmpeg';
      scLog('initFFmpeg: loading ST build...');
      await fm.load({
        coreURL: `${baseURL}/ffmpeg-core.js`,
        wasmURL: `${baseURL}/ffmpeg-core.wasm`,
      });
      (fm as any).isLoaded = true;
      scLog('initFFmpeg: load complete');
      onProgress('Engine ready.');
      ffmpeg = fm;
      return fm;
    } catch (err) {
      loadPromise = null;
      scError('initFFmpeg: load failed', err);
      const msg = err instanceof Error ? err.message : String(err);
      onProgress(`Error loading video engine: ${msg}`);
      throw err;
    }
  })();

  return loadPromise;
}

export async function processSwings(
  videoBlob: Blob,
  impacts: number[],
  onProgress: (progress: string) => void,
  onClipReady?: (index: number, clipUrl: string, clipBlob: Blob, thumbnail?: Uint8Array) => void
): Promise<{url: string, blob: Blob, thumbnail?: Uint8Array}[]> {
  // Claim this session's ID. Any older processSwings loop still running will
  // detect the mismatch and exit, preventing them from racing on the new engine.
  const myId = ++processingId;

  scLog(`processSwings start — ${impacts.length} clips, blob ${(videoBlob.size / 1024 / 1024).toFixed(1)}MB, ffmpegLoaded=${!!(ffmpeg && (ffmpeg as any).isLoaded)}`);
  await resetFFmpeg();
  scLog('FFmpeg reset complete, loading engine...');
  let activeFm = await initFFmpeg(onProgress);
  scLog('FFmpeg engine ready');

  const isIOS = typeof navigator !== 'undefined' && (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );

  const ext = videoBlob.type.includes('mp4') || videoBlob.type.includes('quicktime') ? 'mp4' : 'webm';
  const inputFileName = `input.${ext}`;
  const optimizedFileName = `optimized_${inputFileName}`;

  // Helper: write the session video into the active WASM instance.
  const writeInputFile = async (fm: FFmpeg): Promise<string> => {
    onProgress('Reading recorded session...');
    let fileData: Uint8Array | null = await fetchFile(videoBlob);
    const fileSize = fileData.length;
    await fm.writeFile(inputFileName, fileData);
    scLog(`writeFile complete: ${inputFileName} (${fileSize} bytes)`);
    fileData = null;

    if (isIOS) {
      onProgress('Optimizing video for mobile slicing...');
      try {
        await execWithTimeout(fm, ['-i', inputFileName, '-c', 'copy', '-movflags', '+faststart', optimizedFileName], 'faststart');
        await fm.deleteFile(inputFileName);
        return optimizedFileName;
      } catch (err) {
        scError('Fast-start optimization failed, falling back to raw input', err);
      }
    }
    return inputFileName;
  };

  let activeInputFile = await writeInputFile(activeFm);

  // Warm-up exec (non-iOS only): forces FFmpeg's lazy internal initialization
  // (codec/format registry, allocator layout) to complete on a clean heap
  // before any real clip work. Without this, the first thumbnail exec
  // consistently crashes with RuntimeError: memory access out of bounds on
  // Android Chrome, while clips 2+ (which run on a post-reset heap) succeed.
  // iOS already runs a faststart exec in writeInputFile which serves the same
  // purpose, explaining why it doesn't have this problem.
  if (!isIOS) {
    try {
      scLog('Warm-up exec: start');
      const warmRet = await execWithTimeout(activeFm, ['-version'], 'warmup');
      scLog(`Warm-up exec: done (ret=${warmRet})`);
    } catch (err) {
      scError('Warm-up exec failed (non-fatal, continuing)', err);
    }
  }

  // When a clip operation fails (exec timeout or Worker death), set this flag.
  // The next iteration will reset + reinitialise FFmpeg before attempting the clip.
  // The "fresh engine reset every 10 clips" strategy has been removed: re-writing
  // the full session video to a new WASM heap was the memory spike that was killing
  // the Worker on Android for large sessions.
  let needsEngineReset = false;

  for (let i = 0; i < impacts.length; i++) {
    // If a newer session has started, stop immediately to avoid contaminating it.
    if (processingId !== myId) {
      scLog(`processSwings ${myId}: superseded by session ${processingId} at clip ${i + 1}, aborting`);
      return [];
    }

    // Recover from a previous clip's Worker death before attempting this clip.
    if (needsEngineReset) {
      needsEngineReset = false;
      onProgress(`Recovering engine (clip ${i + 1} of ${impacts.length})...`);
      try {
        await resetFFmpeg();
        activeFm = await initFFmpeg(onProgress);
        activeInputFile = await writeInputFile(activeFm);
        scLog(`Engine recovery successful at clip ${i + 1}`);
      } catch (recoveryErr) {
        scError(`Engine recovery failed at clip ${i + 1}, aborting session`, recoveryErr);
        onProgress('Processing stopped — please try recording a shorter session.');
        return [];
      }
    }

    const impactTime = impacts[i];
    const startTime = Math.max(0, impactTime - PRE_IMPACT_SECONDS);
    const duration = CLIP_DURATION;
    const outputFileName = `swing_${i}.mp4`;
    const thumbFileName = `thumb_${i}.jpg`;
    onProgress(`Slicing swing ${i + 1} of ${impacts.length}...`);
    scLog(`Clip ${i + 1}: start=${startTime.toFixed(2)}s input=${activeInputFile}`);
    try {
      const clipRet = await execWithTimeout(activeFm, [
        '-ss', startTime.toString(),
        '-i', activeInputFile,
        '-t', duration.toString(),
        '-c', 'copy',
        outputFileName
      ], `clip ${i + 1}`);
      if (clipRet !== 0) throw new Error(`clip exec returned ${clipRet}`);
      scLog(`Clip ${i + 1}: clip exec done, reading file...`);

      const data = await readFileWithTimeout(activeFm, outputFileName, `clip ${i + 1}`);
      scLog(`Clip ${i + 1}: clip readFile done (${data.length} bytes)`);
      const clipBlob = new Blob([data], { type: 'video/mp4' });
      const url = URL.createObjectURL(clipBlob);

      // Extract thumbnail from the output clip (not the full session video).
      const thumbRet = await execWithTimeout(activeFm, [
        '-ss', THUMBNAIL_OFFSET.toString(),
        '-i', outputFileName,
        '-vframes', '1',
        '-q:v', '4',
        '-update', '1',
        '-f', 'image2',
        thumbFileName
      ], `thumb ${i + 1}`);
      if (thumbRet !== 0) throw new Error(`thumb exec returned ${thumbRet}`);
      scLog(`Clip ${i + 1}: thumb exec done, reading file...`);

      const thumbnail = await readFileWithTimeout(activeFm, thumbFileName, `thumb ${i + 1}`);
      scLog(`Clip ${i + 1}: thumb readFile done (${thumbnail.length} bytes)`);

      // Free WASM heap before the JS-level onClipReady work (Base64, IndexedDB).
      await activeFm.deleteFile(outputFileName);
      await activeFm.deleteFile(thumbFileName);

      scLog(`Clip ${i + 1} ready, size=${clipBlob.size}`);
      if (onClipReady) await onClipReady(i, url, clipBlob, thumbnail);
    } catch (err) {
      scError(`Clip ${i + 1} FAILED`, err);
      onProgress(`Error on swing ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
      // Any error (timeout, WASM crash, non-zero return) means the engine
      // state is unknown — always reset before attempting the next clip.
      needsEngineReset = true;
    }
  }

  onProgress('Finalizing gallery...');
  try {
    await activeFm.deleteFile(activeInputFile);
  } catch (e) {
    // Ignore cleanup errors at the very end
  }
  return [];
}

// Extracts a single still frame from a clip blob at THUMBNAIL_OFFSET seconds
// and returns it as a Base64 data URL. Used for background thumbnail migration
// when NEXT_PUBLIC_THUMBNAIL_OFFSET changes between deploys.
export async function extractThumbnail(clipBlob: Blob): Promise<string> {
  const fm = await initFFmpeg(() => {});
  const inputFile = 'thumb_input.mp4';
  const outputFile = 'thumb_output.jpg';

  const arrayBuffer = await clipBlob.arrayBuffer();
  await fm.writeFile(inputFile, new Uint8Array(arrayBuffer));

  await fm.exec([
    '-ss', THUMBNAIL_OFFSET.toString(),
    '-i', inputFile,
    '-vframes', '1',
    '-q:v', '4',
    '-f', 'image2',
    outputFile,
  ]);

  const data = await fm.readFile(outputFile);
  const binary = Array.from(new Uint8Array(data as any))
    .map(b => String.fromCharCode(b))
    .join('');
  const base64 = `data:image/jpeg;base64,${window.btoa(binary)}`;

  await fm.deleteFile(inputFile);
  await fm.deleteFile(outputFile);

  return base64;
}

/**
 * Burn a per-frame overlay (skeleton, and any drawings rendered into it) onto a
 * clip. `frames` are transparent PNGs at the video's own resolution, one per
 * sampled frame at `overlayFps`; ffmpeg holds the last one when the video runs
 * at a higher frame rate. `videoFps` pins the output rate — without it ffmpeg
 * guesses from the container and can duplicate thousands of frames.
 */
export async function burnSequenceToVideo(
  videoBlob: Blob,
  frames: Uint8Array[],
  overlayFps: number,
  videoFps: number,
  onProgress: (progress: string) => void
): Promise<string> {
  if (frames.length === 0) throw new Error('No overlay frames to burn');
  const fm = await initFFmpeg(onProgress);
  const ext = videoBlob.type.includes('mp4') ? 'mp4' : 'webm';
  const inputFileName = `input_burn_seq.${ext}`;
  const outputFileName = `output_burn_seq.mp4`;
  const frameName = (i: number) => `pose_${String(i).padStart(4, '0')}.png`;

  onProgress('Preparing video for burn-in...');
  await fm.writeFile(inputFileName, await fetchFile(videoBlob));
  for (let i = 0; i < frames.length; i++) {
    await fm.writeFile(frameName(i), frames[i]);
  }

  onProgress('Burning skeleton into video (this takes a few seconds)...');
  // ffmpeg's own stderr is the only clue when a filter graph fails, so keep it
  // in the in-app debug log (long-press Download to copy it).
  const onFfmpegLog = ({ message }: { message: string }) => scLog(`burnSeq ffmpeg: ${message}`);
  fm.on('log', onFfmpegLog);
  try {
    const code = await execWithTimeout(fm, [
      '-i', inputFileName,
      '-framerate', String(overlayFps),
      '-i', 'pose_%04d.png',
      '-filter_complex', '[0:v][1:v]overlay=0:0:eof_action=repeat',
      '-fps_mode', 'cfr',
      '-r', String(videoFps),
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '28',
      '-threads', '0',
      '-c:a', 'copy',
      outputFileName
    ], 'burnSequence');
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
    const data = await fm.readFile(outputFileName) as Uint8Array;
    // Copy out of ffmpeg's heap into a plain buffer the Blob can own.
    const safeData = new Uint8Array(data.byteLength);
    safeData.set(data);
    const clipBlob = new Blob([safeData], { type: 'video/mp4' });
    return URL.createObjectURL(clipBlob);
  } catch (err) {
    scError('burnSequenceToVideo failed', err);
    throw err;
  } finally {
    fm.off('log', onFfmpegLog);
    // Always clear the virtual filesystem; a 4s clip is ~120 PNGs of memory.
    await fm.deleteFile(inputFileName).catch(() => {});
    await fm.deleteFile(outputFileName).catch(() => {});
    for (let i = 0; i < frames.length; i++) {
      await fm.deleteFile(frameName(i)).catch(() => {});
    }
  }
}

export async function burnLinesToVideo(
  videoBlob: Blob,
  imageBlob: Blob,
  onProgress: (progress: string) => void
): Promise<string> {
  const fm = await initFFmpeg(onProgress);
  const ext = videoBlob.type.includes('mp4') ? 'mp4' : 'webm';
  const inputFileName = `input_burn.${ext}`;
  const overlayFileName = `overlay.png`;
  const outputFileName = `output_burn.mp4`;

  onProgress('Preparing video for burn-in...');
  await fm.writeFile(inputFileName, await fetchFile(videoBlob));
  await fm.writeFile(overlayFileName, await fetchFile(imageBlob));

  onProgress('Burning lines into video (this takes a few seconds)...');
  try {
    await fm.exec([
      '-i', inputFileName,
      '-i', overlayFileName,
      '-filter_complex', '[0:v][1:v]overlay=0:0',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '28',
      '-threads', '0',
      '-c:a', 'copy',
      outputFileName
    ]);
    const data = await fm.readFile(outputFileName);
    const safeData = new Uint8Array(data as any);
    const clipBlob = new Blob([safeData], { type: 'video/mp4' });
    
    await fm.deleteFile(inputFileName);
    await fm.deleteFile(overlayFileName);
    await fm.deleteFile(outputFileName);
    
    return URL.createObjectURL(clipBlob);
  } catch (err) {
    console.error("Burn-in error:", err);
    throw err;
  }
}
