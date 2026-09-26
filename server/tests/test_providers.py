"""Where the ONNX models run (SWINGCLIPS_ORT_PROVIDER, models.py), the package switch
(ort_package.py) and the benchmark (bench_models.py), with the tiny made-up ONNX models and drawn
clip of fakes.py.

No GPU here (nor DirectML: onnxruntime-directml is Windows only), so the GPU paths run as far as
they can without one: a provider the installed onnxruntime lacks, a session the GPU won't take, and
the whole pipeline told it's on a GPU while ONNX Runtime quietly runs it on the CPU. Whether DirectML
and CUDA really load and how fast they are is for bench_models.py on the server.

  cd server && python -m unittest discover tests
"""
import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).parent
TMP = Path(tempfile.mkdtemp(prefix="swingclips-providers-test-"))
os.environ.setdefault("SWINGCLIPS_CLIPS", str(TMP / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import app  # noqa: E402
import eval as scorecard  # noqa: E402
import fakes  # noqa: E402
import models  # noqa: E402
import ort_package  # noqa: E402
import pose  # noqa: E402

try:
    import onnxruntime
except ImportError:
    onnxruntime = None
needs_ort = unittest.skipIf(onnxruntime is None, "needs onnxruntime (pip install -r requirements.txt)")

# pose.py, club.py and models.py before the providers: on the CPU the output must be exactly theirs.
REFERENCE_COMMIT = "0fb9385b4a9b790ddb188793ea73b3e60eaece28"
MODELS = TMP / "models"
NO_SETTINGS = {"SWINGCLIPS_ORT_PROVIDER": "", "SWINGCLIPS_ORT_DEVICE": "", "SWINGCLIPS_CLUB_BACKEND": "",
               "SWINGCLIPS_POSE_BACKEND": ""}


def fake_models() -> dict:
    """Environment for a fake rtmpose-m and club model in their own folder."""
    MODELS.mkdir(parents=True, exist_ok=True)
    fakes.simcc_model(MODELS / models.SPECS["rtmpose-m"].file, *models.SPECS["rtmpose-m"].size, fakes.CHANNELS)
    fakes.club_model(MODELS / models.CLUB_FILE)
    return {"SWINGCLIPS_MODELS": str(MODELS), "SWINGCLIPS_POSE_BACKEND": "rtmpose-m", "SWINGCLIPS_CLUB_BACKEND": "",
            "SWINGCLIPS_CLUB_MODEL": ""}


def analyze(module, path) -> dict:
    with fakes.mediapipe(), mock.patch("builtins.print"), contextlib.redirect_stderr(io.StringIO()):
        out = module.analyze(str(path), fakes.Pool(), 2)
    out.pop("seconds")
    out.pop("msPerFrame", None)
    return out


def told() -> list[str]:
    return sorted(models._told)


class SettingTest(unittest.TestCase):
    def setUp(self):
        models._told.clear()

    def test_setting(self):
        with mock.patch.dict(os.environ, {"SWINGCLIPS_ORT_PROVIDER": ""}):
            self.assertEqual(models.provider_setting(), "cpu")
        with mock.patch.dict(os.environ, {"SWINGCLIPS_ORT_PROVIDER": " DML "}):
            self.assertEqual(models.provider_setting(), "dml")
        with mock.patch.dict(os.environ, {"SWINGCLIPS_ORT_PROVIDER": "openvino"}):
            self.assertRaises(ValueError, models.provider_setting)

    def test_default_never_asks_onnxruntime(self):
        """cpu (the default) doesn't even look at what's installed."""
        with mock.patch.dict(os.environ, NO_SETTINGS), mock.patch.object(models, "available", side_effect=AssertionError):
            self.assertEqual(models.provider(), "cpu")
            self.assertFalse(models.on_gpu())

    def test_choice_and_fallback(self):
        cases = [  # (setting, installed, provider, message expected)
            ("auto", ["cpu"], "cpu", False),
            ("auto", ["dml", "cpu"], "dml", False),
            ("auto", ["cuda", "dml", "cpu"], "cuda", False),
            ("auto", ["cuda", "cpu"], "cuda", False),
            ("dml", ["dml", "cpu"], "dml", False),
            ("cuda", ["cuda", "cpu"], "cuda", False),
            ("dml", ["cpu"], "cpu", True),
            ("cuda", ["dml", "cpu"], "cpu", True),
            ("cpu", ["cuda", "dml", "cpu"], "cpu", False),
        ]
        for setting, have, want, message in cases:
            models._told.clear()
            with mock.patch.dict(os.environ, {"SWINGCLIPS_ORT_PROVIDER": setting}), \
                    mock.patch.object(models, "available", return_value=have), \
                    contextlib.redirect_stderr(io.StringIO()) as err:
                self.assertEqual(models.provider(), want, (setting, have))
                models.provider()
            self.assertEqual(bool(err.getvalue()), message, (setting, have))
            if message:
                # Once per process, naming the package and the requirements file to install.
                self.assertEqual(err.getvalue().count("\n"), 1)
                package, reqs = models.PACKAGES[setting]
                self.assertIn(package, err.getvalue())
                self.assertIn(f"SWINGCLIPS_REQUIREMENTS={reqs}", err.getvalue())

    @needs_ort
    def test_available_reads_onnxruntime(self):
        with mock.patch.object(onnxruntime, "get_available_providers",
                               return_value=["DmlExecutionProvider", "CPUExecutionProvider"]):
            self.assertEqual(models.available(), ["dml", "cpu"])
        self.assertIn("cpu", models.available())


@needs_ort
class SessionTest(unittest.TestCase):
    def setUp(self):
        models._told.clear()
        self.path = TMP / "fake-rtmpose.onnx"
        fakes.simcc_model(self.path)

    def test_cpu_as_before(self):
        """The CPU session is set up as it always was: one thread, the CPU provider alone, nothing said."""
        with mock.patch.dict(os.environ, NO_SETTINGS), contextlib.redirect_stderr(io.StringIO()) as err:
            runner = models.Runner("rtmpose-m", self.path)
        self.assertEqual(runner.provider, "cpu")
        self.assertEqual(runner.session.get_providers(), ["CPUExecutionProvider"])
        self.assertEqual(runner.session.get_session_options().intra_op_num_threads, 1)
        self.assertEqual(err.getvalue(), "")

    def test_gpu_asked_for(self):
        """On a GPU: the GPU first with the device chosen, the CPU behind it for what it can't run;
        DirectML's own session options."""
        real = onnxruntime.InferenceSession
        calls = []

        def fake(path, opts, providers):
            calls.append((opts, providers))
            return real(path, opts, providers=["CPUExecutionProvider"])
        for where in ("dml", "cuda"):
            calls.clear()
            with mock.patch.dict(os.environ, {"SWINGCLIPS_ORT_DEVICE": "1"}), \
                    mock.patch.object(onnxruntime, "InferenceSession", fake), \
                    mock.patch.object(onnxruntime, "preload_dlls", create=True) as preload, \
                    contextlib.redirect_stderr(io.StringIO()) as err:
                _, got = models.session(self.path, where=where)
            opts, providers = calls[0]
            self.assertEqual(providers, [(models.PROVIDERS[where], {"device_id": 1}), "CPUExecutionProvider"])
            self.assertEqual(preload.called, where == "cuda")
            if where == "dml":
                self.assertFalse(opts.enable_mem_pattern)
                self.assertEqual(opts.execution_mode, onnxruntime.ExecutionMode.ORT_SEQUENTIAL)
            # What it actually got (here the CPU) is what counts, and it says so.
            self.assertEqual(got, "cpu")
            self.assertIn("instead of", err.getvalue())

    def test_gpu_refuses_the_model(self):
        real = onnxruntime.InferenceSession

        def fake(path, opts, providers):
            if providers != ["CPUExecutionProvider"]:
                raise RuntimeError("D3D12 device removed")
            return real(path, opts, providers=providers)
        with mock.patch.object(onnxruntime, "InferenceSession", fake), \
                contextlib.redirect_stderr(io.StringIO()) as err:
            sess, got = models.session(self.path, where="dml")
        self.assertEqual(got, "cpu")
        self.assertEqual(sess.get_providers(), ["CPUExecutionProvider"])
        self.assertIn("wouldn't load on DirectML (D3D12 device removed); running on the CPU", err.getvalue())

    def test_gpu_missing_from_the_package(self):
        """dml asked for with the CPU package: loads on the CPU, says why, and every model says where it runs."""
        with mock.patch.dict(os.environ, {"SWINGCLIPS_ORT_PROVIDER": "dml"}), \
                mock.patch.object(models, "available", return_value=["cpu"]), \
                contextlib.redirect_stderr(io.StringIO()) as err:
            runner = models.Runner("rtmpose-m", self.path)
        self.assertEqual(runner.provider, "cpu")
        self.assertIn("onnxruntime-directml", err.getvalue())
        self.assertIn(f"{self.path.name} on CPU", err.getvalue())

    def test_loaded_once_per_provider(self):
        with mock.patch.dict(os.environ, NO_SETTINGS):
            a = models.load("rtmpose-m", self.path)
            self.assertIs(models.load("rtmpose-m", self.path), a)
        with mock.patch.dict(os.environ, {"SWINGCLIPS_ORT_PROVIDER": "dml"}), \
                mock.patch.object(models, "available", return_value=["dml", "cpu"]), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertIsNot(models.load("rtmpose-m", self.path), a)

    def test_club_model_kept_until_it_changes(self):
        path = TMP / "club.onnx"
        fakes.club_model(path)
        with mock.patch.dict(os.environ, NO_SETTINGS):
            a = models.load_club(path)
            self.assertIs(models.load_club(path), a)
            self.assertEqual(a.provider, "cpu")
            fakes.club_model(path, size=160)             # retrained: another file in the same place
            os.utime(path, ns=(a.path.stat().st_atime_ns, a.path.stat().st_mtime_ns + 10**9))
            b = models.load_club(path)
        self.assertIsNot(b, a)
        self.assertEqual(b.size, (160, 160))


class StrideTest(unittest.TestCase):
    def test_default_by_provider(self):
        with mock.patch.object(pose, "BODY_STRIDE", None):
            with mock.patch.dict(os.environ, NO_SETTINGS):
                self.assertEqual(pose.body_stride(), 2)
            with mock.patch.object(models, "on_gpu", return_value=True):
                self.assertEqual(pose.body_stride(), 1)
        # SWINGCLIPS_BODY_STRIDE wins either way.
        with mock.patch.object(pose, "BODY_STRIDE", 3), mock.patch.object(models, "on_gpu", return_value=True):
            self.assertEqual(pose.body_stride(), 3)

    def test_setting_read_as_before(self):
        env = {k: v for k, v in os.environ.items() if k != "SWINGCLIPS_BODY_STRIDE"}
        code = "import pose; print(pose.BODY_STRIDE, pose.body_stride())"
        for value, want in ((None, "None 2"), ("1", "1 1"), ("0", "1 1"), ("4", "4 4")):
            e = dict(env, SWINGCLIPS_ORT_PROVIDER="", **({"SWINGCLIPS_BODY_STRIDE": value} if value else {}))
            out = subprocess.run([sys.executable, "-c", code], cwd=HERE.parent, env=e, capture_output=True, text=True)
            self.assertEqual(out.stdout.strip(), want, out.stderr)


def reference_modules():
    """pose.py, club.py and models.py from REFERENCE_COMMIT as modules, or None without git."""
    root = HERE.parent.parent
    try:
        src = {f: subprocess.run(["git", "-C", str(root), "show", f"{REFERENCE_COMMIT}:server/{f}"],
                                 capture_output=True, check=True).stdout for f in ("club.py", "models.py", "pose.py")}
    except (OSError, subprocess.CalledProcessError):
        return None
    folder = TMP / "reference"
    folder.mkdir(exist_ok=True)
    loaded = {}
    for f in ("club.py", "models.py", "pose.py"):
        (folder / f).write_bytes(src[f])
        spec = importlib.util.spec_from_file_location(f"reference_{f[:-3]}", folder / f)
        loaded[f[:-3]] = importlib.util.module_from_spec(spec)
        with mock.patch.dict(sys.modules, {k: v for k, v in loaded.items() if k != f[:-3]}):
            spec.loader.exec_module(loaded[f[:-3]])
    return loaded["pose"]


@needs_ort
class PipelineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.clip = TMP / "clip90.mp4"
        fakes.clip(cls.clip, 90)

    def setUp(self):
        models._told.clear()

    def test_cpu_output_unchanged(self):
        """With the body and club models on the CPU (the default, or cpu or auto set with only the
        CPU package), exactly what pose.py gave before providers."""
        old = reference_modules()
        if old is None:
            self.skipTest(f"needs git and commit {REFERENCE_COMMIT[:7]}")
        for extra in ({}, {"SWINGCLIPS_CLUB_BACKEND": "yolo", "SWINGCLIPS_CLUB_MODEL": str(MODELS / models.CLUB_FILE)}):
            env = {**os.environ, **NO_SETTINGS, **fake_models(), **extra}
            env.pop("SWINGCLIPS_BODY_STRIDE", None)
            with mock.patch.dict(os.environ, env, clear=True):
                before = analyze(old, self.clip)
                for setting in ("", "cpu", "auto"):
                    with mock.patch.dict(os.environ, {"SWINGCLIPS_ORT_PROVIDER": setting}), \
                            mock.patch.object(models, "available", return_value=["cpu"]):
                        now = analyze(pose, self.clip)
                    self.assertNotIn("provider", now)
                    self.assertEqual(json.dumps(now), json.dumps(before), (setting, extra))

    def test_on_a_gpu(self):
        """Told it's on a GPU (ONNX Runtime then runs the fake on the CPU, not having one): the body
        model on every frame, and the pose file says where it ran."""
        env = {**NO_SETTINGS, **fake_models(), "SWINGCLIPS_ORT_PROVIDER": "dml"}
        with mock.patch.dict(os.environ, env), mock.patch.object(pose, "BODY_STRIDE", None), \
                mock.patch.object(models, "available", return_value=["dml", "cpu"]), \
                fakes.mediapipe(), mock.patch("builtins.print"), contextlib.redirect_stderr(io.StringIO()):
            calls = []
            real = pose.run_chunk
            with mock.patch.object(pose, "run_chunk", lambda a: calls.append(a[7]) or real(a)):
                out = pose.analyze(str(self.clip), fakes.Pool(), 2)
        self.assertEqual(out["provider"], "dml")
        self.assertEqual(out["model"], "rtmpose-m-256x192")
        self.assertTrue(calls and all(stride == 1 for _, stride in calls))
        # Where it really ran is said (print is muted here; what it would have said is kept).
        self.assertTrue(any("rtmpose-m-256x192.onnx got CPUExecutionProvider" in m for m in told()), told())


class FingerprintTest(unittest.TestCase):
    def test_provider_in_the_fingerprint(self):
        env = {**NO_SETTINGS, **fake_models()}
        with mock.patch.dict(os.environ, NO_SETTINGS):
            mediapipe = scorecard.pipeline_fingerprint()
        with mock.patch.dict(os.environ, {**NO_SETTINGS, "SWINGCLIPS_ORT_PROVIDER": "dml"}):
            # Nothing runs through ONNX Runtime: the provider can't matter.
            self.assertEqual(scorecard.pipeline_fingerprint(), mediapipe)
            self.assertEqual(scorecard.provider(), "cpu")
        with mock.patch.dict(os.environ, env), mock.patch.object(pose, "BODY_STRIDE", None):
            cpu = scorecard.pipeline_fingerprint()
            with mock.patch.dict(os.environ, {"SWINGCLIPS_ORT_PROVIDER": "cpu"}):
                self.assertEqual(scorecard.pipeline_fingerprint(), cpu)
            with mock.patch.object(models, "available", return_value=["dml", "cpu"]), \
                    contextlib.redirect_stderr(io.StringIO()):
                with mock.patch.dict(os.environ, {"SWINGCLIPS_ORT_PROVIDER": "dml"}):
                    dml = scorecard.pipeline_fingerprint()
                    with mock.patch.object(pose, "BODY_STRIDE", 1):
                        dml_stride1 = scorecard.pipeline_fingerprint()
                with mock.patch.dict(os.environ, {"SWINGCLIPS_ORT_PROVIDER": "auto"}):
                    self.assertEqual(scorecard.pipeline_fingerprint(), dml)
            # Apart from the CPU's, and from the CPU's stride too.
            self.assertEqual(len({cpu, dml}), 2)
            self.assertEqual(dml, dml_stride1)
            with mock.patch.object(pose, "BODY_STRIDE", 1):
                self.assertNotEqual(scorecard.pipeline_fingerprint(), dml)


@needs_ort
class RerunTest(unittest.TestCase):
    def test_rerun_on_a_provider(self):
        """eval.py --rerun --provider: the workers get it, the result and its file name say it."""
        root = TMP / "rerun"
        folders = {"CLIPS_DIR": root / "clips", "POSE_DIR": root / "pose", "TRASH_DIR": root / "trash",
                   "LABELS_DIR": root / "labels"}
        for d in folders.values():
            d.mkdir(parents=True, exist_ok=True)
        name = "swing_face_960x540_60fps_1789123456_400ms.mp4"
        fakes.clip(folders["CLIPS_DIR"] / name, 90)
        k = 20
        ts = [i / fakes.FPS for i in range(fakes.FRAMES)]
        x, y = fakes.dot_at(k)
        label = {"schema": 1, "clip": {"name": name, "angle": "face", "strike": 0.4}, "partner": None,
                 "events": {"takeaway": ts[10], "p4": ts[25], "impact": ts[40]},
                 "frames": {f"{ts[k]:.6f}": {j: {"x": x, "y": y} for j in scorecard.JOINTS}}}
        (folders["LABELS_DIR"] / f"{name}.json").write_text(json.dumps(label))
        out = root / "eval"
        env = {**NO_SETTINGS, **fake_models()}
        seen = []

        def pool(n):
            seen.append(os.environ.get("SWINGCLIPS_ORT_PROVIDER"))
            return fakes.Pool()
        for extra in ([], ["--provider", "dml"]):
            with mock.patch.multiple(app, **folders), mock.patch.object(scorecard, "ProcessPoolExecutor", pool), \
                    mock.patch.object(models, "available", return_value=["dml", "cpu"]), \
                    fakes.mediapipe(), mock.patch.dict(os.environ, env), mock.patch("builtins.print"), \
                    contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(scorecard.main(["--rerun", "--no-noise", "--no-quality", "--out", str(out), *extra]), 0)
        self.assertEqual(seen, ["", "dml"])
        results = sorted(out.glob("*.json"), key=lambda f: f.stat().st_mtime)
        cpu, dml = (json.loads(f.read_text()) for f in results[-2:])
        self.assertNotIn("provider", cpu)
        self.assertEqual(dml["provider"], "dml")
        self.assertTrue(results[-1].name.endswith("_rtmpose-m-256x192_dml.json"), results[-1].name)
        # Cached apart.
        self.assertEqual(len(list((out / "pose").iterdir())), 2)


class PackageTest(unittest.TestCase):
    def test_wanted(self):
        self.assertEqual(ort_package.wanted(HERE.parent / "requirements.txt"), "onnxruntime")
        self.assertEqual(ort_package.wanted(HERE.parent / "requirements-dml.txt"), "onnxruntime-directml")
        self.assertEqual(ort_package.wanted(HERE.parent / "requirements-cuda.txt"), "onnxruntime-gpu")
        self.assertIsNone(ort_package.wanted(HERE.parent / "requirements-common.txt"))

    def test_same_packages_everywhere(self):
        """The three files differ only in the ONNX Runtime package."""
        for f in ("requirements.txt", "requirements-dml.txt", "requirements-cuda.txt"):
            lines = [ln for ln in (HERE.parent / f).read_text().splitlines() if ln and not ln.startswith("#")]
            self.assertEqual(lines[0], "-r requirements-common.txt", f)
            self.assertEqual(len(lines), 2, f)

    def test_to_remove(self):
        self.assertEqual(ort_package.to_remove("onnxruntime", {"onnxruntime"}), [])
        self.assertEqual(ort_package.to_remove("onnxruntime-directml", set()), [])
        self.assertEqual(ort_package.to_remove("onnxruntime-directml", {"onnxruntime"}), ["onnxruntime"])
        # Both there: both out, the wanted one too (the other may have overwritten its files).
        self.assertEqual(ort_package.to_remove("onnxruntime", {"onnxruntime", "onnxruntime-gpu"}),
                         ["onnxruntime", "onnxruntime-gpu"])
        self.assertEqual(ort_package.to_remove(None, {"onnxruntime", "onnxruntime-gpu"}), [])

    def test_nothing_to_do_runs_nothing(self):
        with mock.patch.object(ort_package, "installed", return_value={"onnxruntime"}), \
                mock.patch.object(ort_package.subprocess, "run") as run:
            self.assertEqual(ort_package.main([str(HERE.parent / "requirements.txt")]), 0)
        run.assert_not_called()
        with mock.patch.object(ort_package, "installed", return_value={"onnxruntime"}), \
                mock.patch.object(ort_package.subprocess, "run") as run, mock.patch("builtins.print"):
            run.return_value.returncode = 0
            self.assertEqual(ort_package.main([str(HERE.parent / "requirements-dml.txt")]), 0)
        self.assertEqual(run.call_args[0][0][-4:], ["uninstall", "-y", "-q", "onnxruntime"])


@needs_ort
class BenchTest(unittest.TestCase):
    def test_bench_on_the_cpu(self):
        import bench_models
        clip = TMP / "swing_face_960x540_60fps_1789123456_400ms.mp4"
        fakes.clip(clip, 90)
        env = {**NO_SETTINGS, **fake_models(), "SWINGCLIPS_CLUB_MODEL": str(MODELS / models.CLUB_FILE)}
        out = io.StringIO()
        with mock.patch.dict(os.environ, env), mock.patch.object(bench_models, "ProcessPoolExecutor",
                                                                 lambda n: fakes.Pool()), \
                fakes.mediapipe(), contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(bench_models.main([str(clip), "--frames", "8", "--runs", "1"]), 0)
            self.assertEqual(os.environ["SWINGCLIPS_ORT_PROVIDER"], "")        # put back
        text = out.getvalue()
        verdict = text[text.index("Verdict"):]
        self.assertIn("RTMPose-m: CPU", verdict)
        self.assertIn("Club model: CPU", verdict)
        self.assertIn("Whole clip (rtmpose-m): CPU", verdict)
        self.assertIn("every 2 frames", verdict)
        self.assertIn("Floor, no body model at all:", verdict)
        self.assertIn("Only the CPU here", verdict)

    def test_verdict_with_a_gpu(self):
        import bench_models
        result = {"clip": "c.mp4", "workers": 6, "backend": "rtmpose-m", "providers": ["cpu", "dml"],
                  "gpus": {"dml": "Intel(R) UHD Graphics 730"},
                  "models": {"rtmpose-m": {"cpu": {"ms": 41, "got": "cpu"}, "dml": {"ms": 9, "got": "dml"}}},
                  "diffs": {"dml": {"median": 0.1, "max": 1.2, "conf": 0.004}}, "clip_diffs": {}, "floor": 8.8,
                  "clip_runs": [
                      {"where": "cpu", "stride": 2, "default": True, "seconds": 20.0, "split": {"body": 41}, "provider": "cpu"},
                      {"where": "dml", "stride": 1, "default": True, "seconds": 11.0, "split": {}, "provider": "dml"},
                      {"where": "dml", "stride": 2, "default": False, "seconds": 9.5, "split": {}, "provider": "dml"}]}
        lines = "\n".join(bench_models.verdict(result))
        self.assertIn("RTMPose-m: CPU 41 ms, DirectML (Intel(R) UHD Graphics 730) 9 ms (4.6x) a frame", lines)
        self.assertIn("CPU 20.0 s (every 2 frames) -> DirectML (Intel(R) UHD Graphics 730) 11.0 s (every frame), "
                      "DirectML (Intel(R) UHD Graphics 730) 9.5 s (every 2 frames)", lines)
        self.assertIn("Keeping up (a swing, two clips, every ~20 s: 10 s a clip or less): yes, best 9.5 s", lines)
        self.assertIn("SWINGCLIPS_REQUIREMENTS=requirements-dml.txt, SWINGCLIPS_ORT_PROVIDER=dml and "
                      "SWINGCLIPS_BODY_STRIDE=2", lines)
        self.assertIn("Floor, no body model at all: 8.8 s", lines)
        self.assertIn("DirectML (Intel(R) UHD Graphics 730) against the CPU, same frames: body points 0.10 px apart "
                      "(at most 1.2 px)", lines)
        # Slower than keeping up, with the floor over it too.
        for r in result["clip_runs"]:
            r["seconds"] += 5
        result["floor"] = 12.0
        lines = "\n".join(bench_models.verdict(result))
        self.assertIn("): no, best 14.5 s", lines)
        self.assertIn("a faster GPU for the body model alone won't keep up", lines)


if __name__ == "__main__":
    unittest.main()
