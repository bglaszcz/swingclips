// Camera setup (button at the top): each phone's latest preview still with the golfer's skeleton
// and what to fix, refreshed every second. The phones send stills while they aren't recording
// (server/setup.py). Uses the page's globals: showView (trends.js), renderList.

const setupBox = document.getElementById("setup");
let setupTimer = 0;

const SETUP_BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
                     [23, 25], [25, 27], [24, 26], [26, 28], [0, 11], [0, 12]];
// A still older than this means the phone isn't sending (closed, recording, or off the network).
const SETUP_STALE_S = 5;

function openSetup() {
  showView("setup");
  renderList();
  pollSetup();
  if (window.innerWidth < 900) setupBox.scrollIntoView();
}

async function pollSetup() {
  clearTimeout(setupTimer);
  if (setupBox.hidden) return;
  let status = null;
  try {
    const res = await fetch("/api/setup");
    if (res.ok) status = await res.json();
  } catch {}
  for (const angle of ["face", "dtl"]) renderCamera(angle, status && status[angle]);
  setupTimer = setTimeout(pollSetup, 1000);
}

function renderCamera(angle, v) {
  const card = document.getElementById("setup-" + angle);
  const verdict = card.querySelector(".s-verdict"), age = card.querySelector(".s-age");
  const img = card.querySelector("img"), canvas = card.querySelector("canvas");
  const live = v && v.age <= SETUP_STALE_S;
  card.classList.toggle("ok", !!(live && v.ok));
  card.classList.toggle("bad", !!(live && !v.ok));
  if (!v) {
    verdict.textContent = "No picture yet. Open SwingClips on this phone (not recording).";
    age.textContent = "";
    img.hidden = true;
    canvas.hidden = true;
    return;
  }
  verdict.textContent = live ? (v.ok ? "✓ " : "✗ ") + v.text : "This phone stopped sending pictures (recording, or the app is closed).";
  age.textContent = live ? "live" : `last picture ${Math.round(v.age)} s ago`;
  img.hidden = canvas.hidden = false;
  const src = `/api/setup/${angle}.jpg?t=${v.time}`;
  if (img.dataset.t !== String(v.time)) {
    img.dataset.t = String(v.time);
    img.onload = () => drawSetupSkeleton(canvas, img, v.lm, v.ok);
    img.src = src;
  }
}

/** The skeleton over the still, in green when the setup is good, amber when not. */
function drawSetupSkeleton(canvas, img, lm, ok) {
  const dpr = window.devicePixelRatio || 1;
  const w = img.clientWidth, h = img.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!lm) return;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.strokeStyle = ok ? "#22c55e" : "#f59e0b";
  for (const [a, b] of SETUP_BONES) {
    ctx.beginPath();
    ctx.moveTo(lm[a * 3] * w, lm[a * 3 + 1] * h);
    ctx.lineTo(lm[b * 3] * w, lm[b * 3 + 1] * h);
    ctx.stroke();
  }
}

document.getElementById("setup-btn").onclick = () => setupBox.hidden ? openSetup() : closeTrendView();
document.getElementById("s-close").onclick = () => closeTrendView();
