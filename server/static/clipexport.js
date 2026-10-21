/**
 * clipexport.js: Save a swing as a WebM video with its numbers.
 *
 * Face-on video (and DTL partner beside it when present, side-by-side, same height),
 * with overlays drawn at each frame (skeleton, plane line, hand path, user drawings),
 * and a panel under or beside the videos showing the swing's date, club,
 * Square's launch numbers, and coaching card verdict in plain words.
 */
(function (root) {
  "use strict";

  /** Normalizes a speed parameter into a positive numeric multiplier (1, 0.25, 0.125, etc.). */
  function parseSpeed(s) {
    if (typeof s === "number" && Number.isFinite(s) && s > 0) return s;
    if (typeof s === "string") {
      const trimmed = s.trim().toLowerCase().replace(/x$/, "");
      if (trimmed === "1" || trimmed === "real") return 1;
      if (trimmed === "1/4" || trimmed === "0.25") return 0.25;
      if (trimmed === "1/8" || trimmed === "0.125") return 0.125;
      if (trimmed.includes("/")) {
        const [num, den] = trimmed.split("/").map(Number);
        if (den > 0 && Number.isFinite(num / den)) return num / den;
      }
      const val = Number(trimmed);
      if (Number.isFinite(val) && val > 0) return val;
    }
    return 1;
  }

  function speedLabel(speed) {
    const s = parseSpeed(speed);
    if (Math.abs(s - 1) < 1e-4) return "1x";
    if (Math.abs(s - 0.25) < 1e-4) return "1/4x";
    if (Math.abs(s - 0.125) < 1e-4) return "1/8x";
    return `${s}x`;
  }

  /**
   * Plans the output video frames: which clip times to sample, at which speed, for how many output frames at 30 fps.
   * Window: 0.5 s before takeaway to 0.6 s after impact.
   */
  function framePlan(firstArg, secondArg, thirdArg) {
    let takeaway = null;
    let impact = null;
    let duration = null;
    let speed = 1;
    let fps = 30;

    if (Array.isArray(firstArg)) {
      const pos = firstArg;
      duration = typeof secondArg === "number" ? secondArg : null;
      const opts = (typeof thirdArg === "object" ? thirdArg : (typeof secondArg === "object" ? secondArg : {})) || {};
      if (typeof thirdArg === "number" || typeof thirdArg === "string") speed = thirdArg;
      else if (typeof secondArg === "string") speed = secondArg;
      if (opts.speed !== undefined) speed = opts.speed;
      if (opts.fps !== undefined) fps = opts.fps;

      if (pos.takeaway && typeof pos.takeaway.t === "number") {
        takeaway = pos.takeaway.t;
      } else {
        const tk = pos.find(p => p.key === "takeaway" || p.key === "p1");
        if (tk && typeof tk.t === "number") takeaway = tk.t;
      }
      const imp = pos.find(p => p.key === "p7" || p.key === "impact");
      if (imp && typeof imp.t === "number") impact = imp.t;
    } else if (typeof firstArg === "object" && firstArg !== null) {
      const o = firstArg;
      takeaway = o.takeaway != null ? (typeof o.takeaway === "object" ? o.takeaway.t : o.takeaway) : null;
      impact = o.impact != null ? (typeof o.impact === "object" ? o.impact.t : o.impact) : null;
      duration = o.duration != null ? o.duration : null;
      if (o.speed !== undefined) speed = o.speed;
      if (o.fps !== undefined) fps = o.fps;
    }

    if (takeaway == null && impact != null) takeaway = Math.max(0, impact - 1.2);
    if (takeaway == null && impact == null) takeaway = 0.5;
    if (impact == null) impact = takeaway + 1.2;

    const startTime = Math.max(0, takeaway - 0.5);
    const maxDur = duration != null && duration > 0 ? duration : Infinity;
    let endTime = Math.min(maxDur, impact + 0.6);
    if (endTime <= startTime) {
      endTime = Math.min(maxDur, startTime + 0.5);
    }
    const clipDuration = Math.max(0.01, endTime - startTime);
    const speedFactor = parseSpeed(speed);
    const outputDuration = clipDuration / speedFactor;
    const dtClip = speedFactor / fps;

    const times = [];
    const totalFrames = Math.max(1, Math.round(outputDuration * fps));
    for (let k = 0; k < totalFrames; k++) {
      const t = startTime + k * dtClip;
      if (t > endTime + 0.5 * dtClip) break;
      times.push(Number(Math.min(endTime, t).toFixed(4)));
    }
    if (!times.length) times.push(Number(startTime.toFixed(4)));

    return {
      startTime: Number(startTime.toFixed(4)),
      endTime: Number(endTime.toFixed(4)),
      clipDuration: Number(clipDuration.toFixed(4)),
      outputDuration: Number(outputDuration.toFixed(4)),
      speed: speedFactor,
      speedLabel: speedLabel(speedFactor),
      fps,
      frameCount: times.length,
      times
    };
  }

  /** Formats a numeric value with given decimals, or '-' if null/undefined/NaN. */
  function formatNum(v, dec = 1) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return "—";
    return Number(v).toFixed(dec);
  }

  function formatSigned(v, dec = 1) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return "—";
    const n = Number(v);
    const s = n.toFixed(dec);
    return (n > 0 ? "+" : "") + s;
  }

  /**
   * Formats the panel lines: date & club, Square's launch numbers, and coaching card verdict.
   */
  function panelLines(input = {}) {
    const clip = input.clip || {};
    const shot = input.shot || clip.shot || null;
    const card = input.card || null;

    let date = input.date;
    if (!date && (clip.recorded || clip.date)) {
      const raw = clip.recorded || clip.date;
      try {
        date = new Date(raw).toLocaleString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit"
        });
      } catch {
        date = String(raw);
      }
    }
    if (!date) date = "";

    let club = input.club || (shot && shot.club) || clip.club || "";
    if (club) {
      if (typeof clubWords === "function") club = clubWords(club);
      else if (club === "I7" || club === "7i") club = "7-iron";
      else if (club === "DR" || club === "1w") club = "Driver";
    }

    let verdict = "";
    let verdictLevel = "";
    if (typeof input.verdict === "string") {
      verdict = input.verdict;
    } else if (input.verdict && typeof input.verdict === "object") {
      verdict = input.verdict.text || "";
      verdictLevel = input.verdict.level || "";
    } else if (card && card.verdict) {
      verdict = card.verdict.text || "";
      verdictLevel = card.verdict.level || "";
    }

    // Extract Square launch numbers
    let carry = null;
    let ballSpeed = null;
    let clubSpeed = null;
    let launch = null;
    let spin = null;
    let path = null;
    let faceToPath = null;

    if (shot) {
      if (shot.ball || shot.clubData) {
        const b = shot.ball || {};
        const k = shot.clubData || {};
        carry = b.carry > 0 ? b.carry : null;
        ballSpeed = b.speed != null ? b.speed : null;
        clubSpeed = k.speed > 0 ? k.speed : null;
        launch = b.vla != null ? b.vla : null;
        spin = b.totalSpin != null ? b.totalSpin : null;
        path = k.path != null ? k.path : null;
        if (k.faceToTarget != null && k.path != null) {
          faceToPath = k.faceToTarget - k.path;
        }
      } else {
        carry = shot.carry;
        ballSpeed = shot.ballSpeed;
        clubSpeed = shot.clubSpeed;
        launch = shot.launch;
        spin = shot.spin;
        path = shot.path;
        faceToPath = shot.faceToPath;
      }
    }

    const carryStr = carry != null && carry > 0 ? `${Math.round(carry)} yd` : "—";
    const ballSpeedStr = ballSpeed != null ? `${formatNum(ballSpeed, 1)} mph` : "—";
    const clubSpeedStr = clubSpeed != null && clubSpeed > 0 ? `${formatNum(clubSpeed, 1)} mph` : "—";
    const launchStr = launch != null ? `${formatNum(launch, 1)}°` : "—";
    const spinStr = spin != null && spin > 0 ? `${Math.round(spin)} rpm` : "—";
    const pathStr = path != null ? `${formatSigned(path, 1)}°` : "—";
    const faceToPathStr = faceToPath != null ? `${formatSigned(faceToPath, 1)}°` : "—";

    const numbers = [
      { key: "carry", label: "Carry", value: carryStr },
      { key: "ballSpeed", label: "Ball speed", value: ballSpeedStr },
      { key: "clubSpeed", label: "Club speed", value: clubSpeedStr },
      { key: "launch", label: "Launch", value: launchStr },
      { key: "spin", label: "Spin", value: spinStr },
      { key: "path", label: "Path", value: pathStr },
      { key: "faceToPath", label: "Face to path", value: faceToPathStr }
    ];

    const header = [date, club].filter(Boolean).join(" • ");
    const lines = [];
    if (header) lines.push(header);
    if (verdict) lines.push(verdict);
    lines.push(`Carry: ${carryStr}  •  Ball: ${ballSpeedStr}  •  Club: ${clubSpeedStr}`);
    lines.push(`Launch: ${launchStr}  •  Spin: ${spinStr}`);
    lines.push(`Path: ${pathStr}  •  Face to path: ${faceToPathStr}`);

    lines.date = date;
    lines.club = club;
    lines.verdict = verdict;
    lines.verdictLevel = verdictLevel;
    lines.numbers = numbers;
    lines.header = header;

    return lines;
  }

  /**
   * Layout calculation for one or two videos (side by side, same height), and a panel under or beside.
   */
  function layout(options = {}) {
    const faceWidth = options.faceWidth || (options.video1 && options.video1.videoWidth) || 1080;
    const faceHeight = options.faceHeight || (options.video1 && options.video1.videoHeight) || 1920;
    const hasPartner = !!options.hasPartner;
    const dtlWidth = options.dtlWidth || (options.video2 && options.video2.videoWidth) || faceWidth;
    const dtlHeight = options.dtlHeight || (options.video2 && options.video2.videoHeight) || faceHeight;
    const panelPlacement = options.panelPlacement === "beside" || options.panelPlacement === "right" ? "beside" : "bottom";

    const h = options.targetHeight || faceHeight || 720;
    const w1 = Math.round(h * (faceWidth / faceHeight));
    const w2 = hasPartner ? Math.round(h * (dtlWidth / dtlHeight)) : 0;
    const totalVideoW = w1 + w2;

    let totalW, totalH, panelRect;
    if (panelPlacement === "beside") {
      let panelW = Math.max(260, Math.round(totalVideoW * 0.35));
      panelW = panelW - (panelW % 2);
      panelRect = { x: totalVideoW, y: 0, w: panelW, h };
      totalW = totalVideoW + panelW;
      totalH = h;
    } else {
      let panelH = Math.max(120, Math.round(h * 0.16));
      panelH = panelH - (panelH % 2);
      panelRect = { x: 0, y: h, w: totalVideoW, h: panelH };
      totalW = totalVideoW;
      totalH = h + panelH;
    }

    // Ensure dimensions are even numbers for encoder compatibility
    totalW = totalW - (totalW % 2);
    totalH = totalH - (totalH % 2);

    return {
      width: totalW,
      height: totalH,
      video1: { x: 0, y: 0, w: w1, h },
      video2: hasPartner ? { x: w1, y: 0, w: w2, h } : null,
      panel: panelRect,
      hasPartner,
      panelPlacement
    };
  }

  /**
   * Builds the export filename: swing-<date>-<club>.webm
   */
  function formatFilename(clipOrDate, shotOrClub) {
    let datePart = "unknown";
    let clubPart = "swing";

    if (typeof clipOrDate === "string") {
      datePart = clipOrDate.replace(/[^0-9-]/g, "");
    } else if (clipOrDate && typeof clipOrDate === "object") {
      const rawDate = clipOrDate.recorded || clipOrDate.date;
      if (rawDate) {
        if (typeof rawDate === "string") {
          datePart = rawDate.split("T")[0].replace(/[^0-9-]/g, "");
        } else if (rawDate instanceof Date) {
          datePart = rawDate.toISOString().split("T")[0];
        }
      }
      const rawClub = (clipOrDate.shot && clipOrDate.shot.club) || clipOrDate.club;
      if (rawClub) clubPart = String(rawClub).toLowerCase().replace(/[^a-z0-9]/g, "");
    }

    if (typeof shotOrClub === "string") {
      clubPart = shotOrClub.toLowerCase().replace(/[^a-z0-9]/g, "");
    } else if (shotOrClub && typeof shotOrClub === "object") {
      const rawClub = shotOrClub.club;
      if (rawClub) clubPart = String(rawClub).toLowerCase().replace(/[^a-z0-9]/g, "");
    }

    if (!datePart) datePart = "unknown";
    if (!clubPart) clubPart = "swing";
    return `swing-${datePart}-${clubPart}.webm`;
  }

  /**
   * Draws the numbers and coaching verdict panel into a 2D canvas context.
   */
  function drawPanel(ctx, rect, lines, options = {}) {
    if (!ctx || !rect) return;
    ctx.save();

    // Solid dark background and top line
    ctx.fillStyle = "#131a16";
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

    ctx.strokeStyle = "#223029";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rect.x, rect.y + 0.5);
    ctx.lineTo(rect.x + rect.w, rect.y + 0.5);
    ctx.stroke();

    const s = Math.min(2.0, Math.max(0.6, rect.h / 140));
    const padX = Math.round(18 * s);
    const topY = rect.y + Math.round(26 * s);

    // Row 1: Header (date & club)
    const header = lines.header || lines[0] || "";
    ctx.fillStyle = "#e7ede8";
    ctx.font = `600 ${Math.round(15 * s)}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(header, rect.x + padX, topY);

    // Verdict pill badge (top right)
    const verdict = lines.verdict || "";
    if (verdict) {
      const lvl = lines.verdictLevel || "good";
      const badgeText = verdict.toUpperCase();
      ctx.font = `700 ${Math.round(11 * s)}px system-ui, -apple-system, sans-serif`;
      const textW = ctx.measureText(badgeText).width;
      const pillW = textW + Math.round(16 * s);
      const pillH = Math.round(22 * s);
      const pillX = rect.x + rect.w - padX - pillW;
      const pillY = topY - pillH / 2;

      let pillBg = "rgba(52, 194, 111, 0.18)";
      let pillFg = "#34c26f";
      if (lvl === "ok") {
        pillBg = "rgba(245, 158, 11, 0.18)";
        pillFg = "#f59e0b";
      } else if (lvl === "miss") {
        pillBg = "rgba(248, 113, 113, 0.18)";
        pillFg = "#f87171";
      }

      ctx.fillStyle = pillBg;
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(pillX, pillY, pillW, pillH, pillH / 2);
      } else {
        ctx.rect(pillX, pillY, pillW, pillH);
      }
      ctx.fill();

      ctx.fillStyle = pillFg;
      ctx.textAlign = "center";
      ctx.fillText(badgeText, pillX + pillW / 2, topY);
    }

    // Row 2: Square numbers
    const numbers = lines.numbers || [];
    if (numbers.length > 0) {
      const availableW = rect.w - 2 * padX;
      const colW = availableW / numbers.length;
      const metricsY = rect.y + Math.round(62 * s);

      for (let i = 0; i < numbers.length; i++) {
        const m = numbers[i];
        const cx = rect.x + padX + i * colW;

        // Label
        ctx.fillStyle = "#8e9f95";
        ctx.font = `600 ${Math.round(10 * s)}px system-ui, -apple-system, sans-serif`;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(m.label.toUpperCase(), cx, metricsY);

        // Value
        ctx.fillStyle = "#e7ede8";
        ctx.font = `700 ${Math.round(16 * s)}px system-ui, -apple-system, sans-serif`;
        ctx.fillText(m.value, cx, metricsY + Math.round(17 * s));
      }
    }

    ctx.restore();
  }

  /**
   * Waits for a video to complete a seek operation.
   */
  function awaitVideoSeek(v, t) {
    return new Promise((resolve) => {
      if (!v || v.readyState < 1) {
        resolve();
        return;
      }
      if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) {
        resolve();
        return;
      }
      let finished = false;
      const finish = () => {
        if (!finished) {
          finished = true;
          v.removeEventListener("seeked", finish);
          clearTimeout(timer);
          resolve();
        }
      };
      const timer = setTimeout(finish, 150);
      v.addEventListener("seeked", finish, { once: true });
      try {
        v.currentTime = t;
      } catch {
        finish();
      }
    });
  }

  /**
   * Browser export loop: steps videos frame by frame, draws video + overlay + panel,
   * records with MediaRecorder into WebM, and downloads the result.
   */
  async function exportSwing(options = {}) {
    const {
      video,
      video2,
      canvas,
      canvas2,
      draw,
      draw2,
      fitRect,
      toPartnerTime,
      pose,
      partnerPose,
      positions = [],
      shot,
      clip = {},
      card,
      speed = 0.25,
      panelPlacement = "bottom",
      onProgress = () => {},
      isCancelled = () => false
    } = options;

    if (!video) throw new Error("Video element is required");

    const plan = framePlan({
      takeaway: positions.takeaway ? positions.takeaway.t : (positions.find(p => p.key === "p1") || {}).t,
      impact: (positions.find(p => p.key === "p7") || {}).t || (pose && pose.impact),
      duration: video.duration,
      speed,
      fps: 30
    });

    const lines = panelLines({
      clip,
      shot: shot || clip.shot,
      card,
      date: clip.recorded,
      club: (shot && shot.club) || (clip.shot && clip.shot.club) || clip.club,
      verdict: card && card.verdict
    });

    const hasPartner = !!(video2 && partnerPose && video2.videoWidth > 0);
    const lay = layout({
      faceWidth: video.videoWidth || 1080,
      faceHeight: video.videoHeight || 1920,
      dtlWidth: video2 ? video2.videoWidth : null,
      dtlHeight: video2 ? video2.videoHeight : null,
      hasPartner,
      panelPlacement
    });

    const offCanvas = document.createElement("canvas");
    offCanvas.width = lay.width;
    offCanvas.height = lay.height;
    const offCtx = offCanvas.getContext("2d");

    const origTime1 = video.currentTime;
    const origTime2 = video2 ? video2.currentTime : 0;
    const wasPlaying1 = !video.paused;
    if (wasPlaying1) video.pause();
    if (video2 && !video2.paused) video2.pause();

    const stream = offCanvas.captureStream ? offCanvas.captureStream(30) : null;
    if (!stream) throw new Error("Browser canvas.captureStream() is not supported");

    let mimeType = "video/webm";
    const candidates = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm"
    ];
    for (const t of candidates) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) {
        mimeType = t;
        break;
      }
    }

    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6000000 });
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    recorder.start(100);

    const fitFn = fitRect || ((W, H, v) => {
      const vw = v.videoWidth || 1080, vh = v.videoHeight || 1920;
      const k = Math.min(W / vw, H / vh);
      return { x: (W - vw * k) / 2, y: (H - vh * k) / 2, w: vw * k, h: vh * k };
    });

    const loopStart = performance.now();
    let cancelled = false;

    try {
      for (let k = 0; k < plan.frameCount; k++) {
        if (isCancelled()) {
          cancelled = true;
          break;
        }

        const t = plan.times[k];
        await awaitVideoSeek(video, t);
        if (hasPartner && toPartnerTime) {
          const t2 = toPartnerTime(t);
          await awaitVideoSeek(video2, t2);
        }

        if (typeof draw === "function") draw(t);
        if (hasPartner && typeof draw2 === "function" && toPartnerTime) {
          draw2(toPartnerTime(t));
        }

        // Draw offscreen composite
        offCtx.fillStyle = "#0b100d";
        offCtx.fillRect(0, 0, lay.width, lay.height);

        // Video 1 & Overlay 1
        offCtx.drawImage(video, lay.video1.x, lay.video1.y, lay.video1.w, lay.video1.h);
        if (canvas && canvas.width > 0) {
          const r1 = fitFn(canvas.width, canvas.height, video);
          offCtx.drawImage(canvas, r1.x, r1.y, r1.w, r1.h, lay.video1.x, lay.video1.y, lay.video1.w, lay.video1.h);
        }

        // Video 2 & Overlay 2
        if (hasPartner && lay.video2) {
          offCtx.drawImage(video2, lay.video2.x, lay.video2.y, lay.video2.w, lay.video2.h);
          if (canvas2 && canvas2.width > 0) {
            const r2 = fitFn(canvas2.width, canvas2.height, video2);
            offCtx.drawImage(canvas2, r2.x, r2.y, r2.w, r2.h, lay.video2.x, lay.video2.y, lay.video2.w, lay.video2.h);
          }
        }

        // Panel
        drawPanel(offCtx, lay.panel, lines);

        // Pace frames evenly
        const track = stream.getVideoTracks && stream.getVideoTracks()[0];
        if (track && track.requestFrame) track.requestFrame();

        const targetElapsed = (k + 1) * (1000 / plan.fps);
        const actualElapsed = performance.now() - loopStart;
        const delay = Math.max(8, targetElapsed - actualElapsed);
        await new Promise((r) => setTimeout(r, delay));

        onProgress({
          current: k + 1,
          total: plan.frameCount,
          pct: Math.round(((k + 1) / plan.frameCount) * 100),
          time: t
        });
      }
    } finally {
      // Restore video positions
      video.currentTime = origTime1;
      if (video2) video2.currentTime = origTime2;
      if (typeof draw === "function") draw(origTime1);
      if (hasPartner && typeof draw2 === "function") draw2(origTime2);
    }

    if (cancelled) {
      if (recorder.state !== "inactive") recorder.stop();
      return null;
    }

    const blob = await new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
      recorder.stop();
    });

    const filename = formatFilename(clip, shot || clip.shot);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);

    return {
      blob,
      filename,
      plan,
      layout: lay,
      lines
    };
  }

  /**
   * Wires the Save as video button and export dialog in the swing view.
   */
  function attach(options = {}) {
    const btn = options.button || document.getElementById("save-video-btn");
    const dialog = options.dialog || document.getElementById("save-video-dialog");
    if (!btn || !dialog) return;

    let currentSpeed = 0.25;
    let exporting = false;
    let cancelFlag = false;

    const speedBtns = dialog.querySelectorAll(".export-speed-btn");
    speedBtns.forEach((b) => {
      b.onclick = () => {
        if (exporting) return;
        speedBtns.forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
        currentSpeed = parseSpeed(b.dataset.speed);
      };
    });

    const goBtn = dialog.querySelector("#export-go-btn");
    const cancelBtn = dialog.querySelector("#export-cancel-btn");
    const closeBtn = dialog.querySelector("#export-close-btn");
    const bar = dialog.querySelector(".export-progress-fill");
    const status = dialog.querySelector(".export-status");
    const body = dialog.querySelector(".export-body");

    function resetUI() {
      exporting = false;
      cancelFlag = false;
      if (bar) bar.style.width = "0%";
      if (status) status.textContent = "Ready to export";
      if (goBtn) {
        goBtn.hidden = false;
        goBtn.disabled = false;
      }
      if (cancelBtn) cancelBtn.textContent = "Cancel";
    }

    btn.onclick = () => {
      resetUI();
      if (dialog.showModal) dialog.showModal();
      else dialog.hidden = false;
    };

    if (closeBtn) {
      closeBtn.onclick = () => {
        if (exporting) cancelFlag = true;
        if (dialog.close) dialog.close();
        else dialog.hidden = true;
      };
    }

    if (cancelBtn) {
      cancelBtn.onclick = () => {
        if (exporting) {
          cancelFlag = true;
          status.textContent = "Cancelling…";
        } else {
          if (dialog.close) dialog.close();
          else dialog.hidden = true;
        }
      };
    }

    if (goBtn) {
      goBtn.onclick = async () => {
        if (exporting) return;
        exporting = true;
        cancelFlag = false;
        goBtn.disabled = true;
        if (status) status.textContent = "Preparing export…";

        try {
          const exportOpts = {
            video: options.video || document.getElementById("video"),
            video2: options.video2 || document.getElementById("video2"),
            canvas: options.canvas || document.getElementById("overlay"),
            canvas2: options.canvas2 || document.getElementById("overlay2"),
            draw: options.draw || (typeof draw === "function" ? draw : null),
            draw2: options.draw2 || (typeof draw2 === "function" ? draw2 : null),
            fitRect: options.fitRect || (typeof fitRect === "function" ? fitRect : null),
            toPartnerTime: options.toPartnerTime || (typeof toPartnerTime === "function" ? toPartnerTime : null),
            pose: options.getPose ? options.getPose() : (typeof pose !== "undefined" ? pose : null),
            partnerPose: options.getPartnerPose ? options.getPartnerPose() : (typeof partner !== "undefined" && partner ? partner.pose : null),
            positions: options.getPositions ? options.getPositions() : (typeof positions !== "undefined" ? positions : []),
            shot: options.getShot ? options.getShot() : (typeof currentShot !== "undefined" ? currentShot : null),
            clip: options.getClip ? options.getClip() : (typeof currentClip !== "undefined" ? currentClip : {}),
            card: options.getCard ? options.getCard() : (typeof currentCard !== "undefined" ? currentCard : null),
            speed: currentSpeed,
            onProgress: (p) => {
              if (bar) bar.style.width = `${p.pct}%`;
              if (status) status.textContent = `Saving frame ${p.current} of ${p.total} (${p.pct}%)`;
            },
            isCancelled: () => cancelFlag
          };

          const res = await exportSwing(exportOpts);
          if (res) {
            if (status) status.textContent = "Saved " + res.filename;
            setTimeout(() => {
              if (dialog.close) dialog.close();
              else dialog.hidden = true;
              resetUI();
            }, 800);
          } else {
            if (status) status.textContent = "Cancelled";
            setTimeout(resetUI, 600);
          }
        } catch (err) {
          if (status) status.textContent = "Error: " + (err.message || err);
          resetUI();
        }
      };
    }
  }

  const api = {
    parseSpeed,
    speedLabel,
    framePlan,
    panelLines,
    layout,
    formatFilename,
    drawPanel,
    awaitVideoSeek,
    exportSwing,
    attach
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingClipExport = api;
})(typeof window !== "undefined" ? window : globalThis);
