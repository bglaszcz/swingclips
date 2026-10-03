"""Tools > Update the server (update.py) and the sim laptop's scripts served from relay/.

  cd server && python -m unittest discover tests
"""
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).parent
os.environ.setdefault("SWINGCLIPS_CLIPS", str(Path(tempfile.mkdtemp(prefix="swingclips-test-")) / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import app  # noqa: E402
import update  # noqa: E402
try:
    from fastapi.testclient import TestClient  # needs httpx, which the server itself doesn't
except (ImportError, RuntimeError):
    TestClient = None


class RestartTest(unittest.TestCase):
    def test_what_needs_a_restart(self):
        self.assertEqual(update.restart_needed([]), "none")
        self.assertEqual(update.restart_needed(["server/static/plan.js", "docs/relay.md", "relay/golf-agent.ps1",
                                                "capture/app/build.gradle.kts", "server/tests/test_x.py"]), "none")
        self.assertEqual(update.restart_needed(["server/static/plan.js", "server/app.py"]), "auto")
        self.assertEqual(update.restart_needed(["server/programs.json"]), "auto")
        self.assertEqual(update.restart_needed(["server/requirements.txt"]), "auto")
        # The scripts the server runs in V8 too.
        for f in ("phases.js", "summary.js", "trust.js", "metrics.js", "metrics3d.js", "games.js"):
            self.assertEqual(update.restart_needed(["server/static/" + f]), "auto", f)
        self.assertEqual(update.restart_needed(["server/app.py", "server/Start server.cmd"]), "manual")


class RelayFilesTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="swingclips-relay-"))
        (self.dir / "golf-agent.ps1").write_bytes(b"# agent\r\n")
        (self.dir / "Golf launcher.cmd").write_bytes(b"@echo off\r\n")
        (self.dir / "golf-agent-log.txt").write_text("log")
        (self.dir / "square-app.txt").write_text("C:\\x")
        patcher = mock.patch.object(update, "RELAY_DIR", self.dir)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, self.dir, True)

    def test_only_scripts_listed(self):
        files = update.relay_files()
        self.assertEqual(sorted(files), ["Golf launcher.cmd", "golf-agent.ps1"])
        self.assertEqual(files["golf-agent.ps1"], hashlib.sha256(b"# agent\r\n").hexdigest())

    def test_no_other_files(self):
        self.assertIsNotNone(update.relay_file("golf-agent.ps1"))
        for name in ("golf-agent-log.txt", "square-app.txt", "../server/app.py", "..\\server\\app.py", "nope.ps1"):
            self.assertIsNone(update.relay_file(name), name)

    @unittest.skipIf(TestClient is None, "needs httpx")
    def test_api(self):
        client = TestClient(app.app)
        listing = client.get("/api/relay/files").json()["files"]
        self.assertIn("Golf launcher.cmd", listing)
        r = client.get("/api/relay/files/Golf%20launcher.cmd")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.content, b"@echo off\r\n")
        self.assertEqual(client.get("/api/relay/files/golf-agent-log.txt").status_code, 404)


def run(*args, cwd):
    subprocess.run(args, cwd=cwd, check=True, capture_output=True)


@unittest.skipIf(shutil.which("git") is None, "needs git")
class PullTest(unittest.TestCase):
    """check() and pull() on a real clone of a throwaway repo."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="swingclips-git-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        origin, self.work, self.server = self.tmp / "origin.git", self.tmp / "work", self.tmp / "server"
        run("git", "init", "--bare", "-q", "-b", "main", str(origin), cwd=self.tmp)
        run("git", "clone", "-q", str(origin), str(self.work), cwd=self.tmp)
        for d in (self.work,):
            run("git", "config", "user.email", "t@example.com", cwd=d)
            run("git", "config", "user.name", "T", cwd=d)
        self.commit("server/static/plan.js", "one", "First")
        run("git", "push", "-q", "origin", "main", cwd=self.work)
        run("git", "clone", "-q", str(origin), str(self.server), cwd=self.tmp)
        patcher = mock.patch.object(update, "REPO", self.server)
        patcher.start()
        self.addCleanup(patcher.stop)

    def commit(self, path, text, subject):
        f = self.work / path
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text)
        run("git", "add", "-A", cwd=self.work)
        run("git", "commit", "-q", "-m", subject, cwd=self.work)

    def test_up_to_date(self):
        got = update.check()
        self.assertEqual(got["commits"], [])
        self.assertEqual(got["restart"], "none")

    def test_page_only_then_server_code(self):
        self.commit("server/static/plan.js", "two", "Plan tweak")
        run("git", "push", "-q", "origin", "main", cwd=self.work)
        got = update.check()
        self.assertEqual([c["subject"] for c in got["commits"]], ["Plan tweak"])
        self.assertEqual(got["restart"], "none")
        done = update.pull()
        self.assertEqual(done["files"], ["server/static/plan.js"])
        self.assertEqual((self.server / "server/static/plan.js").read_text(), "two")

        self.commit("server/app.py", "x", "Server change")
        self.commit("server/static/plan.js", "three", "Plan again")
        run("git", "push", "-q", "origin", "main", cwd=self.work)
        got = update.check()
        self.assertEqual([c["subject"] for c in got["commits"]], ["Plan again", "Server change"])
        self.assertEqual(got["restart"], "auto")
        self.assertEqual(update.pull()["restart"], "auto")
        self.assertEqual(update.check()["commits"], [])

    def test_local_edit_in_the_way_refused(self):
        self.commit("server/static/plan.js", "two", "Plan tweak")
        run("git", "push", "-q", "origin", "main", cwd=self.work)
        (self.server / "server/static/plan.js").write_text("edited on the server")
        self.assertEqual(update.check()["changed"], ["server/static/plan.js"])
        with self.assertRaises(update.GitError):
            update.pull()
        self.assertEqual((self.server / "server/static/plan.js").read_text(), "edited on the server")


if __name__ == "__main__":
    unittest.main()
