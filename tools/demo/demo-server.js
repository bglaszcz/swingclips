// Demo server for SwingClips documentation and screenshots.
//   node tools/demo/demo-server.js [--port 8765] [--static server/static]
// Serves static pages from server/static and answers API requests from tools/demo/data.
// Read-only: unknown paths return 404, mutation methods return 403.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
}

const STATIC = path.resolve(args.static || path.join(__dirname, "..", "..", "server", "static"));
const DATA = path.resolve(path.join(__dirname, "data"));
const PORT = Number(args.port || 8765);

const TYPES = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
};

// Route mapping for standard /api/ paths to tools/demo/data/<name>.json
const API_MAP = {
  "/api/status": "status.json",
  "/api/setup": "setup.json",
  "/api/calib": "calib.json",
  "/api/clips": "clips.json",
  "/api/swings": "swings.json",
  "/api/goodshots": "goodshots.json",
  "/api/journal": "journal.json",
  "/api/practice": "practice.json",
  "/api/plan/step": "plan-step.json",
  "/api/program": "program.json",
  "/api/program/report": "program-report.json",
  "/api/drill": "drill.json",
  "/api/game": "game.json",
  "/api/noise": "noise.json",
  "/api/coach/status": "coach-status.json",
  "/api/coach/models": "coach-models.json",
  "/api/events": "events.json",
  "/api/night": "night.json",
  "/api/improve": "improve.json",
  "/api/improve/next": "improve-next.json",
};

function readDataFile(file) {
  try {
    return fs.readFileSync(path.join(DATA, file), "utf8");
  } catch {
    return null;
  }
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);

  // 1. Static HTML and asset files
  const rel = pathname === "/" ? "index.html"
    : pathname === "/start" ? "start.html"
    : pathname === "/calibrate" ? "calibrate.html"
    : pathname === "/tripods" ? "tripods.html"
    : pathname.startsWith("/static/") ? pathname.slice(8)
    : null;

  if (rel && (req.method === "GET" || req.method === "HEAD")) {
    const file = path.join(STATIC, rel);
    if (!file.startsWith(STATIC)) {
      res.writeHead(403);
      return res.end();
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file)] || "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(data);
    });
    return;
  }

  // 2. Special read-only answer for POST /api/coach/ask in demo mode
  if (req.method === "POST" && pathname === "/api/coach/ask") {
    let bodyData = "";
    req.on("data", chunk => { bodyData += chunk; });
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(bodyData); } catch {}
      const notesJson = readDataFile("coach-notes.json");
      if (notesJson) {
        try {
          const notes = JSON.parse(notesJson);
          const reqKind = body.kind || "session";
          let match = Array.isArray(notes)
            ? notes.find(n => (n.kind || "session") === reqKind && (!body.session || String(n.session) === String(body.session)))
            : notes;
          if (!match && Array.isArray(notes)) {
            match = notes.find(n => (n.kind || "session") === reqKind) || notes[0];
          }
          if (match) {
            res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
            return res.end(JSON.stringify({
              text: match.text,
              model: match.model || "claude-opus-5-5",
              provider: match.provider || "anthropic",
              t: match.t || Math.floor(Date.now() / 1000),
              kept: true,
              kind: match.kind || "session",
              question: match.question || body.question || null,
              usage: match.usage || {},
            }));
          }
        } catch {}
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ error: "The coach note is not available in demo." }));
    });
    return;
  }

  // 3. Read-only guard: all other non-GET/HEAD methods are refused
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(403, { "content-type": "text/plain" });
    return res.end("demo: read-only");
  }

  // 4. API endpoints
  if (pathname === "/api/time") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ time: Math.floor(Date.now() / 1000) }));
  }

  if (pathname === "/api/coach/notes") {
    const sessionQuery = parsedUrl.searchParams.get("session");
    const kindQuery = parsedUrl.searchParams.get("kind");
    const notesJson = readDataFile("coach-notes.json");
    if (notesJson) {
      try {
        let notes = JSON.parse(notesJson);
        if (sessionQuery) {
          const found = Array.isArray(notes)
            ? notes.find(n => String(n.session) === sessionQuery && (!kindQuery || (n.kind || "session") === kindQuery))
            : notes;
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          return res.end(JSON.stringify(found || null));
        }
        if (kindQuery && Array.isArray(notes)) {
          notes = notes.filter(n => (n.kind || "session") === kindQuery);
        }
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify(notes));
      } catch {}
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(sessionQuery ? "null" : "[]");
  }

  if (API_MAP[pathname]) {
    const content = readDataFile(API_MAP[pathname]);
    if (content !== null) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(content);
    }
  }

  // Fallback: check if direct data file matches /api/<name>
  if (pathname.startsWith("/api/")) {
    const sub = pathname.slice(5).replace(/\//g, "-") + ".json";
    const content = readDataFile(sub);
    if (content !== null) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(content);
    }
    // Unknown API path
    res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end("{}");
  }

  // 5. Video clips (/clips/*) - return 404 in demo mode
  res.writeHead(404);
  res.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Demo server running on http://127.0.0.1:${PORT}`);
  console.log(`  Static: ${STATIC}`);
  console.log(`  Data:   ${DATA}`);
});
