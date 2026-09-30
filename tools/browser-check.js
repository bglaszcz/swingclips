// Headless Edge driver for click-testing a page (no installs; Node 22+ has fetch and WebSocket).
//   node tools/browser-check.js <url> [--width 1280] [--height 900] [--wait 6000]
//        [--init "<js>"]... [--eval "<js>"]... [--shot out.png] [--shot-el "<css selector>"] [--out-dir dir]
// Opens the URL in a fresh headless Edge, waits, runs each --eval in order (await allowed, the value of the
// last expression is printed as JSON), then saves a PNG: of the viewport, or of one element (--shot-el),
// --init scripts run before the page loads (e.g. stub video sizes: Edge cannot decode the phones' H.265 clips);
// then prints console errors/exceptions collected the whole time. Pair with tools/devproxy.js for real data.
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");

const args = { eval: [], init: [] };
const argv = process.argv.slice(2);
args.url = argv.shift();
for (let i = 0; i < argv.length; i += 2) {
  const k = argv[i].replace(/^--/, "");
  if (k === "eval" || k === "init") args[k].push(argv[i + 1]);
  else if (k === "init-file") args.init.push(fs.readFileSync(argv[i + 1], "utf8"));
  else if (k === "eval-file") args.eval.push(fs.readFileSync(argv[i + 1], "utf8"));
  else args[k] = argv[i + 1];
}
if (!args.url) { console.error("Usage: node tools/browser-check.js <url> [--width n] [--height n] [--wait ms] [--eval js]... [--shot file.png] [--shot-el selector]"); process.exit(1); }
const W = Number(args.width || 1280), H = Number(args.height || 900), WAIT = Number(args.wait || 6000);
const EDGE = process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9300 + Math.floor(Math.random() * 500);

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-check-"));
  const edge = spawn(EDGE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--headless=new", "--no-first-run",
    "--disable-gpu", `--window-size=${W},${H}`, "about:blank"], { stdio: "ignore" });
  const done = code => { try { edge.kill(); } catch {} setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(code); }, 500); };
  try {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(t => t.type === "page"); } catch {}
      if (!target) await new Promise(r => setTimeout(r, 250));
    }
    if (!target) throw new Error("Edge did not start");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const waiting = new Map(); const problems = [];
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
      else if (m.method === "Runtime.exceptionThrown") problems.push("EXCEPTION " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") problems.push("console.error " + m.params.args.map(a => a.value ?? a.description).join(" "));
    };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send("Runtime.enable"); await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: W < 600 });
    for (const js of args.init) await send("Page.addScriptToEvaluateOnNewDocument", { source: js });   // runs before the page's own scripts
    await send("Page.navigate", { url: args.url });
    await new Promise(r => setTimeout(r, WAIT));
    for (const js of args.eval) {
      const r = await send("Runtime.evaluate", { expression: js, awaitPromise: true, returnByValue: true });
      const v = r.result.exceptionDetails ? "EXCEPTION " + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text) : r.result.result.value;
      console.log(typeof v === "string" ? v : JSON.stringify(v, null, 1));
    }
    if (args.shot) {
      let clip;
      if (args["shot-el"]) {
        const r = await send("Runtime.evaluate", { expression: `(()=>{const e=document.querySelector(${JSON.stringify(args["shot-el"])});if(!e)return null;e.scrollIntoView();const b=e.getBoundingClientRect();return {x:b.left+scrollX,y:b.top+scrollY,width:b.width,height:Math.min(b.height,4000),scale:1}})()`, returnByValue: true });
        clip = r.result.result.value;
      }
      const s = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip, captureBeyondViewport: true } : {}) });
      fs.writeFileSync(args.shot, Buffer.from(s.result.data, "base64"));
      console.log("saved " + args.shot);
    }
    console.log(problems.length ? "PROBLEMS:\n" + problems.join("\n") : "no console errors");
    done(0);
  } catch (e) { console.error(e); done(1); }
})();
