// Dev preview for anyone working on the review page (Claude, Gemini, you).
//   node tools/devproxy.js --static <path to a checkout's server/static> [--port 8765] [--upstream 192.168.86.250:8000]
// Serves that folder's pages, so an edit shows on reload. Every other GET (clips, pose, swings, labels...)
// goes to the home server, so the page has real data. Anything that is not a GET is refused, so a preview
// can never write to the real data. Listens on 127.0.0.1 only.
const http = require("http"), fs = require("fs"), path = require("path");

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
if (!args.static) { console.error("Usage: node tools/devproxy.js --static <server/static folder> [--port 8765] [--upstream host:port]"); process.exit(1); }
const STATIC = path.resolve(args.static), PORT = Number(args.port || 8765);
const [UP_HOST, UP_PORT] = (args.upstream || "192.168.86.250:8000").split(":");
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  const rel = u === "/" ? "index.html" : u.startsWith("/static/") ? u.slice(8) : null;
  if (rel && (req.method === "GET" || req.method === "HEAD")) {
    const file = path.join(STATIC, rel);
    if (!file.startsWith(STATIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (e, d) => {
      if (e) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(d);
    });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end("read-only preview: only GET is passed to the home server"); }
  const p = http.request({ host: UP_HOST, port: UP_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `${UP_HOST}:${UP_PORT}` } }, r => {
    res.writeHead(r.statusCode, r.headers); r.pipe(res);
  });
  p.on("error", () => { res.writeHead(502); res.end(); });
  p.end();
}).listen(PORT, "127.0.0.1", () => console.log(`Preview of ${STATIC} on http://127.0.0.1:${PORT} (data from ${UP_HOST}:${UP_PORT}, read-only)`));
