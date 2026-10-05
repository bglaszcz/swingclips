"""The improve step's server side (improve.py, app.py /api/improve): judging a candidate club model
against the one in use, the candidates and nights, and the owner's Use it."""
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).parent
TMP = Path(tempfile.mkdtemp(prefix="swingclips-improve-test-"))
os.environ.setdefault("SWINGCLIPS_CLIPS", str(TMP / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import app  # noqa: E402
import improve  # noqa: E402
import night_improve  # noqa: E402

try:
    from fastapi.testclient import TestClient  # needs httpx, which the server itself doesn't
except (ImportError, RuntimeError):
    TestClient = None


def pos(event, p90, within1, angle="face", n=9):
    return {"angle": angle, "event": event, "n": n, "median": 4.2, "p90": p90, "within1": within1}


def club(found, phase="downswing", angle="face", n=30):
    return {"angle": angle, "phase": phase, "n": n, "found": found, "median": 2.0, "p90": 4.5}


def scores(*positions, clubs=(), heads=()):
    return {"positions": list(positions), "club": list(clubs), "clubhead": list(heads)}


class JudgeTest(unittest.TestCase):
    base = scores(pos("takeaway", 38, 33), pos("p2", 21, 55), pos("p8", 8.3, 78), clubs=[club(90)], heads=[club(68)])

    def test_better_on_average(self):
        new = scores(pos("takeaway", 36, 33), pos("p2", 17, 66), pos("p8", 8.3, 78), clubs=[club(91)], heads=[club(70)])
        v = improve.judge(self.base, new)
        self.assertTrue(v["better"], v["why"])

    def test_one_position_much_worse_is_not_better(self):
        """Like club model v3: better elsewhere, P8 a lot worse."""
        new = scores(pos("takeaway", 30, 50), pos("p2", 15, 70), pos("p8", 8.3, 44), clubs=[club(95)], heads=[club(80)])
        v = improve.judge(self.base, new)
        self.assertFalse(v["better"])
        self.assertIn("P8 face-on within one frame 78% -> 44%", v["why"])

    def test_club_found_less_is_not_better(self):
        new = scores(pos("takeaway", 36, 40), pos("p2", 17, 66), pos("p8", 8.3, 78), clubs=[club(80)], heads=[club(68)])
        v = improve.judge(self.base, new)
        self.assertFalse(v["better"])
        self.assertIn("shaft found in the downswing", v["why"])

    def test_about_the_same(self):
        new = scores(pos("takeaway", 38.5, 33), pos("p2", 20.8, 55), pos("p8", 8.3, 78), clubs=[club(90)], heads=[club(69)])
        v = improve.judge(self.base, new)
        self.assertFalse(v["better"])
        self.assertTrue(v["why"].startswith("About the same"))

    def test_more_club_found_with_positions_no_worse(self):
        new = scores(pos("takeaway", 38, 33), pos("p2", 21, 55), pos("p8", 8.3, 78), clubs=[club(90)], heads=[club(78)])
        self.assertTrue(improve.judge(self.base, new)["better"])

    def test_small_rows_and_nothing_to_compare(self):
        tiny = scores(pos("p4", 99, 0, n=2))
        self.assertFalse(improve.judge(scores(pos("p4", 10, 90, n=2)), tiny)["better"])
        self.assertTrue(improve.judge(scores(), scores())["why"].startswith("Nothing to compare"))

    def test_scores_from_eval_tables(self):
        tables = {"events": [{"angle": "face", "event": "p2", "labeled": 9, "median": 8.33, "p90": 20.81, "within1": 55.55},
                             {"angle": "face", "event": "ball gone", "labeled": 9, "median": 0, "p90": 4, "within1": 100}],
                  "club": [{"angle": "face", "phase": "downswing", "labeled": 31, "found": 90.32, "median": 2.01, "p90": 4.6}]}
        s = improve.scores_from(tables)
        self.assertEqual(s["positions"], [{"angle": "face", "event": "p2", "n": 9, "median": 8.3, "p90": 20.8, "within1": 55.5}])
        self.assertEqual(s["club"][0]["found"], 90.3)
        self.assertEqual(s["clubhead"], [])

    def test_summary(self):
        train = {"swings": 52, "frames": 1104, "valSwings": 9}
        text = improve.summary(train, self.base, scores(pos("takeaway", 36, 40), pos("p2", 17, 66), pos("p8", 8.3, 80)),
                               {"better": True})
        self.assertEqual(text, "Trained on 52 labeled swings (1,104 frames). On 9 swings it never saw, key positions "
                               "within one frame went from 55% to 62% on average. Ready to use.")

    def test_dataset_counts(self):
        info = {"swings": {"train": ["a", "b"], "val": ["c"]},
                "images": [{"split": "train"}, {"split": "train"}, {"split": "val"}]}
        self.assertEqual(night_improve.counts(info), {"swings": 2, "valSwings": 1, "frames": 2})


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(dir=TMP))
        self.store = improve.Store(self.dir / "improve")

    def test_labels_sig(self):
        labels = self.dir / "labels"
        labels.mkdir()
        empty = improve.labels_sig(labels)
        (labels / "a.mp4.json").write_text("{}")
        one = improve.labels_sig(labels)
        self.assertNotEqual(empty, one)
        (labels / "a.mp4.pass2.json").write_text("{}")
        self.assertEqual(improve.labels_sig(labels), one)  # the second pass doesn't count
        time.sleep(0.01)
        (labels / "a.mp4.json").write_text('{"x": 1}')
        self.assertNotEqual(improve.labels_sig(labels), one)

    def test_use_keeps_the_old_model_to_go_back_to(self):
        stamp = lambda p: "club-deep@" + Path(p).read_bytes().decode()
        target = self.dir / "models" / "club-deep.onnx"
        target.parent.mkdir()
        target.write_bytes(b"old")
        self.store.save_model("club-1", b"new")
        self.store.save_report("club-1", {"kind": "club", "made": "2026-10-07T02:51:00", "status": "better",
                                          "model": "club-deep@new", "train": {"labelsSig": "s1"}})
        self.store.save_model("club-0", b"bad")
        self.store.save_report("club-0", {"kind": "club", "made": "2026-10-06T02:51:00", "status": "not better",
                                          "model": "club-deep@bad", "train": {"labelsSig": "s0"}})
        with self.assertRaises(ValueError):
            self.store.use("club-0", target, "club-deep@old", self.dir / "trash", stamp)
        self.store.use("club-1", target, "club-deep@old", self.dir / "trash", stamp)
        self.assertEqual(target.read_bytes(), b"new")
        self.assertEqual(len(list((self.dir / "trash").iterdir())), 1)
        listing = {r["model"]: r for r in self.store.listing("club-deep@new")}
        self.assertEqual({m: r["status"] for m, r in listing.items()},
                         {"club-deep@new": "in use", "club-deep@bad": "not better", "club-deep@old": "used before"})
        previous = listing["club-deep@old"]
        # Going back is the same tap.
        self.store.use(previous["id"], target, "club-deep@new", self.dir / "trash", stamp)
        self.assertEqual(target.read_bytes(), b"old")
        self.assertEqual({r["model"]: r["status"] for r in self.store.listing("club-deep@old")},
                         {"club-deep@new": "used before", "club-deep@bad": "not better", "club-deep@old": "in use"})
        self.assertEqual(len(self.store.reports()), 3)  # going back didn't add another copy of the old model
        # The candidate's file is model.onnx, so its stamp names that: told apart by the hash.
        self.assertEqual({r["model"]: r["status"] for r in self.store.listing("model@new")}["club-deep@new"], "in use")
        self.assertTrue(self.store.tried("s1"))
        self.assertFalse(self.store.tried("s2"))

    def test_bad_ids(self):
        for bad in ("", "..", "a/b", "../x"):
            with self.assertRaises(ValueError):
                self.store.save_model(bad, b"x")

    def test_nights(self):
        self.store.note_night({"started": "2026-10-07T02:00:04", "worker": "pc", "clips": 3})
        self.store.note_night({"started": "2026-10-07T02:00:04", "worker": "pc", "clips": 64, "improve": "x"})
        self.store.note_night({"started": "2026-10-06T02:00:00", "worker": "pc", "clips": 70})
        nights = self.store.nights()
        self.assertEqual([(n["date"], n["clips"]) for n in nights], [("2026-10-07", 64), ("2026-10-06", 70)])
        with self.assertRaises(ValueError):
            self.store.note_night({"clips": 1})


@unittest.skipIf(TestClient is None, "needs httpx")
class ImproveApiTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app.app)
        self.dir = Path(tempfile.mkdtemp(dir=TMP))
        self.model = self.dir / "models" / "club-deep.onnx"
        self.model.parent.mkdir()
        self.model.write_bytes(b"old")
        labels = self.dir / "labels"
        labels.mkdir()
        (labels / "a.mp4.json").write_text("{}")
        stamp = lambda p: "club-deep@" + Path(p).read_bytes().decode()
        patches = [mock.patch.object(app, "improve_store", improve.Store(self.dir / "improve")),
                   mock.patch.object(app, "LABELS_DIR", labels), mock.patch.object(app, "TRASH_DIR", self.dir / "trash"),
                   mock.patch.object(app, "club_in_use", lambda: (self.model, stamp(self.model))),
                   mock.patch.object(app.models, "club_stamp", stamp), mock.patch.object(app, "deep_left", lambda s: 7),
                   mock.patch.object(app, "log_event")]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_flow(self):
        nxt = self.client.get("/api/improve/next").json()
        self.assertTrue(nxt["due"])
        self.assertEqual(nxt["labels"], ["a.mp4"])
        self.assertEqual(nxt["clubStamp"], "club-deep@old")
        self.assertEqual(self.client.post("/api/improve/club-1/model", content=b"new").json()["stamp"], "club-deep@new")
        report = {"kind": "club", "made": "2026-10-07T02:51:00", "status": "better", "model": "club-deep@new",
                  "train": {"labelsSig": nxt["labelsSig"]}, "summary": "s", "verdict": {"better": True, "why": "w"}}
        self.assertEqual(self.client.post("/api/improve/club-1/report", json=report).status_code, 200)
        self.assertEqual(self.client.post("/api/improve/club-2/report", json={**report, "status": "odd"}).status_code, 400)
        # Tried on these labels: not again until they change.
        self.assertFalse(self.client.get("/api/improve/next").json()["due"])
        self.client.post("/api/improve/night", json={"started": "2026-10-07T02:00:04", "worker": "pc", "clips": 4})
        got = self.client.get("/api/improve").json()
        self.assertEqual(got["inUse"]["club"], "club-deep@old")
        self.assertEqual([c["status"] for c in got["candidates"]], ["better"])
        self.assertEqual(got["nights"][0]["clips"], 4)
        used = self.client.post("/api/improve/club-1/use").json()
        self.assertEqual(used, {"ok": True, "inUse": {"club": "club-deep@new"}, "deepLeft": 7})
        self.assertEqual(self.model.read_bytes(), b"new")
        self.assertEqual(self.client.post("/api/improve/nope/use").status_code, 400)


if __name__ == "__main__":
    unittest.main()
