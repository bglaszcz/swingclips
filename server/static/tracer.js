// The shot tracer: the ball's flight drawn into the down-the-line video, from Square's launch numbers
// (ball speed, launch, direction, spin, spin axis) and the down-the-line phone's calibration (where it
// stands and its lens: the 3D calibration session). V1's Ball Tracing and Rapsodo's Shot Vision guess the
// flight from the video; this one is the measured launch, flown by the same flight model as the server
// (server/ballflight.py, within ~2 yd of Square's carry), and put into the picture through the camera.
// Starts at this swing's ball (where the down-the-line view saw it, on the floor), grows from impact; real up
// to the impact screen, then drawn on the screen as a sim draws it (onScreen), so straight reads straight.
// Only for swings with 3D (both phones, on a calibration); the page draws it with Show > Shot tracer.
(function (root) {
  // ---- Flight: server/ballflight.py, step for step (tests/tracer.test.js checks they agree) ----
  const CD0 = 0.2141, CD1 = 0.3805, CL0 = 0.1818, CL1 = 0.416, SPIN_DECAY_S = 9.5694;
  const MASS = 0.04593, RADIUS = 0.021335, AIR = 1.194;
  const K = 0.5 * AIR * Math.PI * RADIUS * RADIUS / MASS;
  const G = 9.81, MPH = 0.44704, YD = 1.09361, FT = 3.28084, DT = 0.01, MAX_S = 15.0;
  const SAMPLE_EVERY = 2;            // keep every 2nd step (0.02 s) of the path
  const MAX_BALL_OFF_M = 0.45;       // a found ball further than this from the calibration's is a misread
  const GROW_S = 0.6;                // clip seconds after impact for the tracer to draw itself out
  // The bay: the ball flies into an impact screen; past it the flight is only the picture the sim draws on
  // the screen. Drawn in true 3D, a straight shot ran off toward the middle of the down-the-line picture
  // (the camera stands 0.6 m toward the golfer, so the target line's far end is left of the ball) and
  // read as a pull (owner, Oct 20, on a 157 yd 7 iron 1.8 yd left). So the flight is real up to the screen
  // and, past it, put on the screen as a sim draws it: seen from an eye behind the ball on the target line.
  const SCREEN_M = 3.05;             // ball to impact screen along the target line: the owner's ~10 ft
  const EYE_BACK_M = 1.0, EYE_UP_M = 1.5;   // the sim's eye (a guess: it only sets how high the flight
                                            // draws on the screen, not its line or curve)

  /**
   * The flight of a ball launched at `speed` mph, `vla` up, `hla` right (deg), `spin` rpm about an axis
   * tilted `axis` deg right: {points: [[t s, x, y, z] m; x toward the target, y up, z right], carry (yd),
   * side (yd), apexFt, seconds} up to landing, or null when the ball never flies.
   */
  function flightPath(speed, vla, hla, spin, axis) {
    if (!(speed > 0) || ![speed, vla, hla, spin, axis].every(Number.isFinite)) return null;
    const v0 = speed * MPH, a = vla * Math.PI / 180, h = hla * Math.PI / 180, ax = axis * Math.PI / 180;
    const w0 = Math.max(spin, 0) * 2 * Math.PI / 60;
    const wx = 0, wy = -Math.sin(ax), wz = Math.cos(ax);
    const acc = (vx, vy, vz, t) => {
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const s = RADIUS * w0 * Math.exp(-t / SPIN_DECAY_S) / sp;
      const cd = CD0 + CD1 * s, cl = CL0 + CL1 * s;
      const lx = wy * vz - wz * vy, ly = wz * vx - wx * vz, lz = wx * vy - wy * vx;
      const ln = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
      const d = K * cd * sp, l = K * cl * sp * sp / ln;
      return [-d * vx + l * lx, -d * vy + l * ly - G, -d * vz + l * lz];
    };
    let x = 0, y = 0, z = 0;
    let vx = v0 * Math.cos(a) * Math.cos(h), vy = v0 * Math.sin(a), vz = v0 * Math.cos(a) * Math.sin(h);
    let t = 0, top = 0, step = 0, landed = null;
    const points = [[0, 0, 0, 0]];
    while (t < MAX_S) {
      const a1 = acc(vx, vy, vz, t);
      const v2 = [vx + DT / 2 * a1[0], vy + DT / 2 * a1[1], vz + DT / 2 * a1[2]];
      const a2 = acc(v2[0], v2[1], v2[2], t + DT / 2);
      const v3 = [vx + DT / 2 * a2[0], vy + DT / 2 * a2[1], vz + DT / 2 * a2[2]];
      const a3 = acc(v3[0], v3[1], v3[2], t + DT / 2);
      const v4 = [vx + DT * a3[0], vy + DT * a3[1], vz + DT * a3[2]];
      const a4 = acc(v4[0], v4[1], v4[2], t + DT);
      const nx = x + DT / 6 * (vx + 2 * v2[0] + 2 * v3[0] + v4[0]);
      const ny = y + DT / 6 * (vy + 2 * v2[1] + 2 * v3[1] + v4[1]);
      const nz = z + DT / 6 * (vz + 2 * v2[2] + 2 * v3[2] + v4[2]);
      const nvx = vx + DT / 6 * (a1[0] + 2 * a2[0] + 2 * a3[0] + a4[0]);
      const nvy = vy + DT / 6 * (a1[1] + 2 * a2[1] + 2 * a3[1] + a4[1]);
      const nvz = vz + DT / 6 * (a1[2] + 2 * a2[2] + 2 * a3[2] + a4[2]);
      t += DT;
      step++;
      top = Math.max(top, ny);
      if (ny <= 0 && t > 0.1) {
        const f = y / (y - ny);
        landed = [t - DT + f * DT, x + f * (nx - x), 0, z + f * (nz - z)];
        break;
      }
      x = nx; y = ny; z = nz; vx = nvx; vy = nvy; vz = nvz;
      if (step % SAMPLE_EVERY === 0) points.push([t, x, y, z]);
    }
    if (!landed || t <= 0.1 + DT || top <= 0) return null;
    points.push(landed);
    return { points, carry: Math.hypot(landed[1], landed[3]) * YD, side: landed[3] * YD, apexFt: top * FT, seconds: landed[0] };
  }

  // ---- The camera: server/tri.py Camera (golf axes: x toward the target, y up, z toward the golfer's front) ----

  function camera(c) {
    if (!c || !c.K || !c.R || !c.t || !c.imageSize) return null;
    const dist = new Array(8).fill(0);
    (c.dist || []).flat().slice(0, 8).forEach((v, i) => { dist[i] = Number(v) || 0; });
    return { K: c.K, R: c.R, t: (c.t.flat ? c.t.flat() : c.t).map(Number), dist, n: (c.dist || []).flat().length, size: c.imageSize };
  }

  /** Golf-axes point X (m) to upright picture pixels [u, v, depth], or null behind (or too near) the lens. */
  function project(cam, X) {
    const R = cam.R, t = cam.t;
    const cx = R[0][0] * X[0] + R[0][1] * X[1] + R[0][2] * X[2] + t[0];
    const cy = R[1][0] * X[0] + R[1][1] * X[1] + R[1][2] * X[2] + t[1];
    const cz = R[2][0] * X[0] + R[2][1] * X[1] + R[2][2] * X[2] + t[2];
    if (!(cz > 0.05)) return null;
    const x = cx / cz, y = cy / cz;
    const [k1, k2, p1, p2, k3, k4, k5, k6] = cam.dist;
    const r2 = x * x + y * y;
    let radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
    if (cam.n >= 8) radial /= 1 + k4 * r2 + k5 * r2 * r2 + k6 * r2 * r2 * r2;
    const xd = x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
    const yd = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
    return [cam.K[0][0] * xd + cam.K[0][1] * yd + cam.K[0][2], cam.K[1][1] * yd + cam.K[1][2], cz];
  }

  /** Pixel (u, v) back to the undistorted normalized ray [x, y] (OpenCV's fixed-point undistortion). */
  function undistort(cam, u, v) {
    const fx = cam.K[0][0], fy = cam.K[1][1], s = cam.K[0][1], cx = cam.K[0][2], cy = cam.K[1][2];
    const yd = (v - cy) / fy, xd = (u - cx - s * yd) / fx;
    const [k1, k2, p1, p2, k3, k4, k5, k6] = cam.dist;
    let x = xd, y = yd;
    for (let i = 0; i < 20; i++) {
      const r2 = x * x + y * y;
      let radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
      if (cam.n >= 8) radial /= 1 + k4 * r2 + k5 * r2 * r2 + k6 * r2 * r2 * r2;
      const dx = 2 * p1 * x * y + p2 * (r2 + 2 * x * x), dy = p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
      x = (xd - dx) / radial;
      y = (yd - dy) / radial;
    }
    return [x, y];
  }

  /** Where the ball seen at pixel (u, v) sits: its ray met with the floor (ball centre one radius up). */
  function ballOnFloor(cam, u, v) {
    const [x, y] = undistort(cam, u, v);
    const R = cam.R, t = cam.t;
    // Camera centre C = -R^T t; ray direction d = R^T [x, y, 1].
    const C = [0, 1, 2].map(j => -(R[0][j] * t[0] + R[1][j] * t[1] + R[2][j] * t[2]));
    const d = [0, 1, 2].map(j => R[0][j] * x + R[1][j] * y + R[2][j]);
    if (!(Math.abs(d[1]) > 1e-9)) return null;
    const k = (RADIUS - C[1]) / d[1];
    if (!(k > 0)) return null;
    return [C[0] + k * d[0], RADIUS, C[2] + k * d[2]];
  }

  const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);

  /**
   * The tracer for one swing: shot = the paired Square shot ({ball: {speed, vla, hla, totalSpin, spinAxis,
   * carry}}), cam = the down-the-line camera from the swing's calibration session, ball = where the
   * down-the-line view saw the ball ({x, y} from 0 to 1 of the upright picture) or null.
   * {points: [[x, y, t, depth]] (x, y from 0 to 1 of the picture), seconds, carry (Square's, else the
   * model's, yd), fromBall} or null.
   */
  function build(shot, camEntry, ball, opts) {
    const b = shot && shot.ball;
    const cam = camera(camEntry);
    if (!b || !cam) return null;
    const speed = num(b.speed), vla = num(b.vla);
    const spin = num(b.totalSpin) ?? (num(b.backSpin) != null ? Math.hypot(b.backSpin, num(b.sideSpin) || 0) : null);
    if (speed == null || vla == null || spin == null) return null;
    const fl = flightPath(speed, vla, num(b.hla) || 0, spin, num(b.spinAxis) || 0);
    if (!fl) return null;
    const W = cam.size[0], H = cam.size[1];
    let origin = [0, RADIUS, 0], fromBall = false;
    if (ball && Number.isFinite(ball.x) && Number.isFinite(ball.y)) {
      const B = ballOnFloor(cam, ball.x * W, ball.y * H);
      if (B && Math.hypot(B[0], B[2]) < MAX_BALL_OFF_M) { origin = B; fromBall = true; }
    }
    const points = [];
    const screen = onScreen(origin, opts && opts.screenM);
    for (const [t, x, y, z] of fl.points) {
      const real = [origin[0] + x, origin[1] + y, origin[2] + z];
      const p = project(cam, screen(real)), far = project(cam, real);
      if (!p || !far) break;
      // The depth is the real ball's: the line thins with how far the ball is, not the screen.
      points.push([p[0] / W, p[1] / H, t, far[2]]);
    }
    if (points.length < 2) return null;
    return { points, seconds: fl.seconds, carry: num(b.carry) ?? fl.carry, modelCarry: fl.carry, fromBall };
  }

  /**
   * Where a point of the flight shows in the bay: itself before the impact screen (screenM along the target
   * line from the ball), and past it, on the screen where a sim would draw it, along the line from an eye
   * EYE_BACK_M behind the ball and EYE_UP_M up, on the target line. A straight shot is then a straight line
   * up the screen; a curve bends on it.
   */
  function onScreen(origin, screenM) {
    const plane = origin[0] + (Number.isFinite(screenM) && screenM > 0 ? screenM : SCREEN_M);
    const E = [origin[0] - EYE_BACK_M, EYE_UP_M, origin[2]];
    return X => {
      if (X[0] <= plane) return X;
      const k = (plane - E[0]) / (X[0] - E[0]);
      return [plane, E[1] + k * (X[1] - E[1]), E[2] + k * (X[2] - E[2])];
    };
  }

  /**
   * Draws the tracer into ctx over the picture at r ({x, y, w, h} on the canvas), the first `frac` (0..1)
   * of the flight: a glow and a line that thins with distance, then the landing spot and carry.
   */
  function draw(ctx, r, tr, frac, lw) {
    if (!tr || !(frac > 0)) return;
    const upTo = Math.min(1, frac) * tr.seconds;
    const P = q => [r.x + q[0] * r.w, r.y + q[1] * r.h];
    const near = tr.points[0][3];
    const width = q => lw * 1.7 * Math.max(0.3, Math.min(1, near / q[3]));
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    let last = null;
    for (let i = 1; i < tr.points.length; i++) {
      const a = tr.points[i - 1];
      let b = tr.points[i];
      if (a[2] >= upTo) break;
      if (b[2] > upTo) {
        const f = (upTo - a[2]) / (b[2] - a[2]);
        b = [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), upTo, a[3] + f * (b[3] - a[3])];
      }
      const [x0, y0] = P(a), [x1, y1] = P(b), w = width(b);
      ctx.strokeStyle = "rgba(255, 90, 40, 0.28)";
      ctx.lineWidth = w * 3;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.strokeStyle = "#ff5a2a";
      ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      last = [x1, y1];
    }
    if (last && frac >= 1) {
      ctx.fillStyle = "#ff5a2a";
      ctx.beginPath(); ctx.arc(last[0], last[1], lw * 1.4, 0, Math.PI * 2); ctx.fill();
      const text = `${Math.round(tr.carry)} yd`;
      ctx.font = `600 ${Math.max(11, Math.round(lw * 5))}px system-ui, sans-serif`;
      const tw = ctx.measureText(text).width, pad = lw * 1.5, th = Math.max(11, lw * 5) + pad * 2;
      const tx = Math.min(r.x + r.w - tw - pad * 2 - 2, Math.max(r.x + 2, last[0] - tw / 2 - pad));
      const ty = Math.max(r.y + 2, last[1] - th - lw * 3);
      ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
      ctx.fillRect(tx, ty, tw + pad * 2, th);
      ctx.fillStyle = "#fff";
      ctx.textBaseline = "middle";
      ctx.fillText(text, tx + pad, ty + th / 2 + 0.5);
    }
    ctx.restore();
  }

  /** How much of the flight to show at clip time t, with the ball leaving at `impact` (clip seconds). */
  function shown(t, impact) {
    if (!Number.isFinite(t) || !Number.isFinite(impact)) return 1;
    return Math.max(0, Math.min(1, (t - impact) / GROW_S));
  }

  const api = { flightPath, camera, project, undistort, ballOnFloor, onScreen, build, draw, shown, GROW_S, RADIUS, SCREEN_M };
  root.SwingTracer = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
