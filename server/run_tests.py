"""Every test, quickly: the Python tests spread over worker processes, the review page's JavaScript tests
(node --test) and the sim laptop's scripts (each parses in Windows PowerShell; ASCII only) at the same
time. Quiet: a test's output is shown only when it fails. The same tests as `python -m unittest discover
tests` (which still runs them all in one process), in about a fifth of the time.

  .venv\\Scripts\\python.exe run_tests.py                 everything
  .venv\\Scripts\\python.exe run_tests.py test_status     only these: test_x, test_x.Class, test_x.Class.test_y,
                                                       or tests\\x.test.js (and nothing else)
  .venv\\Scripts\\python.exe run_tests.py -j 4            4 workers (default: the CPU's threads less 2, at most 12)

From Gemini's worktree: ..\\..\\swingclips\\server\\.venv\\Scripts\\python.exe run_tests.py (its own tests, with
the main checkout's Python).

The pieces handed to the workers: each test of a class that shares nothing between its tests (no
setUpClass, no setUpModule, plain unittest.TestCase), else the whole class. Each piece passes on its own
(checked Oct 2026, every class and every test in a process of its own). The slowest pieces go first, by
their times on the last full run (tests/.last-times.json, not in git).
"""
import argparse
import ast
import concurrent.futures as cf
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
TESTS = HERE / "tests"
RELAY = HERE.parent / "relay"
TIMES = TESTS / ".last-times.json"
TIMEOUT_S = 900


# ---- The pieces ----

def pieces_of(path: Path) -> list[str]:
    """A test module's pieces (see the top of this file), read from its source without importing it."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    mod = path.stem
    module_level = {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}
    if module_level & {"setUpModule", "tearDownModule", "load_tests"}:
        return [mod]
    out = []
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        methods = {n.name for n in node.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
        tests = sorted(m for m in methods if m.startswith("test"))
        bases = [ast.unparse(b) for b in node.bases]
        if not bases or not any("TestCase" in b or b in {c.name for c in tree.body if isinstance(c, ast.ClassDef)}
                                for b in bases):
            continue   # not a test class (a helper, a fake)
        plain = bases in (["unittest.TestCase"], ["TestCase"])
        if not plain or methods & {"setUpClass", "tearDownClass"} or not tests:
            out.append(f"{mod}.{node.name}")       # inherited tests or a shared setup: the class as one
        else:
            out += [f"{mod}.{node.name}.{t}" for t in tests]
    return out


def all_pieces() -> list[str]:
    return [p for f in sorted(TESTS.glob("test*.py")) for p in pieces_of(f)]


# ---- In each worker ----

# Each worker's libraries on one thread: with a dozen workers, OpenCV's and the maths libraries' own threads
# only fight over the cores (the same tests took twice as long side by side as one after another).
ONE_THREAD = {"OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1", "MKL_NUM_THREADS": "1", "NUMEXPR_NUM_THREADS": "1"}


def worker_start() -> None:
    os.environ.update(ONE_THREAD)
    os.chdir(HERE)
    sys.path[:0] = [str(TESTS), str(HERE)]
    try:
        import cv2
        cv2.setNumThreads(1)
    except ImportError:
        pass
    # What libraries write straight to the console (MediaPipe, FFmpeg, ONNX Runtime) goes nowhere; Python's
    # own output is caught per piece and shown when it fails.
    devnull = os.open(os.devnull, os.O_WRONLY)
    for fd in (1, 2):
        try:
            os.dup2(devnull, fd)
        except OSError:
            pass


def run_piece(name: str) -> dict:
    out = io.StringIO()
    start = time.perf_counter()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        suite = unittest.defaultTestLoader.loadTestsFromName(name)
        result = unittest.TextTestRunner(stream=out, verbosity=0).run(suite)
    bad = [(t.id(), tb) for t, tb in result.failures + result.errors] + \
          [(t.id(), "unexpected success") for t in result.unexpectedSuccesses]
    return {"name": name, "tests": result.testsRun, "skipped": len(result.skipped), "bad": bad,
            "seconds": round(time.perf_counter() - start, 2), "output": out.getvalue() if bad else ""}


# ---- JavaScript and the relay scripts, beside the Python ----

def run_js(files: list[str]) -> dict:
    node = shutil.which("node")
    if not node:
        return {"ok": True, "text": "skipped: node isn't installed"}
    start = time.perf_counter()
    p = subprocess.run([node, "--test", *files], cwd=HERE, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=TIMEOUT_S)
    counts = {}
    for line in p.stdout.splitlines():
        parts = line.replace("ℹ", "").split()   # "ℹ tests 711"
        if len(parts) == 2 and parts[0] in ("tests", "pass", "fail") and parts[1].isdigit():
            counts[parts[0]] = int(parts[1])
    ok = p.returncode == 0 and counts.get("fail", 1) == 0
    text = f"{counts.get('tests', '?')} tests" + ("" if ok else f", {counts.get('fail', '?')} failed")
    detail = ""
    if not ok:
        lines = p.stdout.splitlines()
        cut = next((i for i, line in enumerate(lines) if "failing tests" in line), None)
        detail = "\n".join(lines[cut:] if cut is not None else lines[-120:]) + ("\n" + p.stderr[-2000:] if p.stderr else "")
    return {"ok": ok, "text": text, "seconds": time.perf_counter() - start, "detail": detail}


PARSE_PS = ("$bad = 0; foreach ($f in $args) { $e = $null; [void][System.Management.Automation.Language.Parser]::"
            "ParseFile($f, [ref]$null, [ref]$e); foreach ($x in $e) { $bad++; Write-Output \"$f line "
            "$($x.Extent.StartLineNumber): $($x.Message)\" } }; exit $bad")


def check_relay() -> dict:
    """relay/*.ps1: ASCII only (CLAUDE.md) and each parses in Windows PowerShell 5.1, as the laptop runs them."""
    files = sorted(RELAY.glob("*.ps1"))
    if not files:
        return {"ok": True, "text": "skipped: no relay folder"}
    problems = [f"{f.name}: not ASCII (byte {next(i for i, b in enumerate(f.read_bytes()) if b > 127)})"
                for f in files if any(b > 127 for b in f.read_bytes())]
    ps = shutil.which("powershell")
    if ps:
        quoted = " ".join("'" + str(f).replace("'", "''") + "'" for f in files)
        p = subprocess.run([ps, "-NoProfile", "-NonInteractive", "-Command", f"& {{ {PARSE_PS} }} {quoted}"],
                           capture_output=True, text=True, timeout=120)
        problems += [line for line in p.stdout.splitlines() if line.strip()]
    text = f"{len(files)} scripts" + (", ASCII and parse in PowerShell 5.1" if ps else ", ASCII (no PowerShell here to parse them)")
    return {"ok": not problems, "text": text if not problems else f"{len(problems)} problem(s)", "detail": "\n".join(problems)}


# ---- The run ----

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("names", nargs="*", help="only these tests (default: all)")
    ap.add_argument("-j", "--jobs", type=int, default=max(1, min(12, (os.cpu_count() or 4) - 2)))
    ap.add_argument("--shuffle", type=int, metavar="SEED", help="a random order (checks no test leans on another)")
    args = ap.parse_args(argv)
    started = time.perf_counter()

    js_files = sorted(str(p.relative_to(HERE)) for p in TESTS.glob("*.test.js"))
    if args.names:
        wanted = [n.replace("\\", "/") for n in args.names]
        js_files = [f for f in js_files if any(f.replace("\\", "/").endswith(n) for n in wanted if n.endswith(".js"))]
        py_names = [n for n in args.names if not n.endswith(".js")]
        everything = all_pieces()
        pieces = []
        for n in py_names:
            n = n.removesuffix(".py").split("/")[-1].split("\\")[-1]
            hits = [p for p in everything if p == n or p.startswith(n + ".")]
            pieces += hits or [n]
        relay = False
    else:
        pieces, relay = all_pieces(), True
    try:
        last = json.loads(TIMES.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        last = {}
    pieces.sort(key=lambda p: -last.get(p, 1.0))   # the slowest first; a new one counts as a second
    if args.shuffle is not None:
        import random
        random.Random(args.shuffle).shuffle(pieces)

    side = {}
    threads = []
    if js_files:
        threads.append(threading.Thread(target=lambda: side.__setitem__("js", run_js(js_files))))
    if relay:
        threads.append(threading.Thread(target=lambda: side.__setitem__("relay", check_relay())))
    for t in threads:
        t.start()

    results, timed_out = [], []
    if pieces:
        ex = cf.ProcessPoolExecutor(min(args.jobs, len(pieces)), initializer=worker_start)
        futures = {ex.submit(run_piece, p): p for p in pieces}
        try:
            for f in cf.as_completed(futures, timeout=TIMEOUT_S):
                try:
                    results.append(f.result())
                except Exception as e:   # the worker died (a crash in a library)
                    results.append({"name": futures[f], "tests": 0, "skipped": 0, "seconds": 0, "output": "",
                                    "bad": [(futures[f], f"the worker process died: {e!r}")]})
        except cf.TimeoutError:
            timed_out = [p for f, p in futures.items() if not f.done()]
        # Workers can hang on the way out (a JavaScript engine left open): they're stopped, not waited for.
        procs = list((getattr(ex, "_processes", None) or {}).values())
        ex.shutdown(wait=False, cancel_futures=True)
        for proc in procs:
            proc.terminate()
    for t in threads:
        t.join(TIMEOUT_S)

    ok = True
    if pieces:
        bad = [b for r in results for b in r["bad"]]
        tests, skipped = sum(r["tests"] for r in results), sum(r["skipped"] for r in results)
        took = time.perf_counter() - started
        ok = not bad and not timed_out
        print(f"Python  {tests} tests ({skipped} skipped) in {len(pieces)} pieces on {min(args.jobs, len(pieces))} "
              f"workers: {'ok' if ok else 'FAILED'} ({took:.0f} s)")
        for r in sorted(results, key=lambda r: r["name"]):
            for test_id, tb in r["bad"]:
                print(f"\n---- FAIL {test_id}\n{tb.rstrip()}")
            if r["bad"] and r["output"].strip():
                print(f"---- output of {r['name']} (last part)\n{r['output'][-4000:].rstrip()}")
        for p in timed_out:
            print(f"---- STILL RUNNING after {TIMEOUT_S} s: {p}")
        slow = sorted(results, key=lambda r: -r["seconds"])[:3]
        print("        slowest: " + ", ".join(f"{r['name']} {r['seconds']:.0f} s" for r in slow))
        if not args.names and not timed_out and args.shuffle is None:
            try:
                TIMES.write_text(json.dumps({r["name"]: r["seconds"] for r in results}, indent=0, sort_keys=True),
                                 encoding="utf-8")
            except OSError:
                pass
    for key, label in (("js", "JS     "), ("relay", "Relay  ")):
        if key in side:
            r = side[key]
            ok = ok and r["ok"]
            secs = f" ({r['seconds']:.0f} s)" if "seconds" in r else ""
            print(f"{label} {r['text']}: {'ok' if r['ok'] else 'FAILED'}{secs}")
            if not r["ok"] and r.get("detail"):
                print(r["detail"].rstrip())
        elif key == "js" and js_files:
            ok = False
            print(f"{label} didn't finish")
    print(("All passed" if ok else "FAILED") + f" in {time.perf_counter() - started:.0f} s")
    return 0 if ok else 1


if __name__ == "__main__":
    code = main()
    sys.stdout.flush()
    os._exit(code)   # not waiting on a worker stuck closing a JavaScript engine
