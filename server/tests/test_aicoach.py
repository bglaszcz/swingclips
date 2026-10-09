import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).parent
sys.path[:0] = [str(HERE.parent), str(HERE)]

import aicoach
import anthropic


class FakeBlock:
    def __init__(self, text: str, block_type: str = "text"):
        self.text = text
        self.type = block_type


class FakeUsage:
    def __init__(self, input_tokens: int = 120, output_tokens: int = 65):
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


class FakeResponse:
    def __init__(self, content, stop_reason: str = "end_turn", usage=None):
        self.content = content
        self.stop_reason = stop_reason
        self.usage = usage or FakeUsage()


class FakeMessages:
    def __init__(self, response=None, exception=None):
        self.response = response
        self.exception = exception
        self.last_call = None
        self.call_count = 0

    def create(self, **kwargs):
        self.call_count += 1
        self.last_call = kwargs
        if self.exception:
            raise self.exception
        return self.response


class FakeBeta:
    def __init__(self, messages: FakeMessages):
        self.messages = messages


class FakeClient:
    def __init__(self, response=None, exception=None):
        self.messages = FakeMessages(response=response, exception=exception)
        self.beta = FakeBeta(self.messages)


class TestAICoach(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.notes_file = Path(self.tmp_dir.name) / "coach-notes.jsonl"
        self.key_file = Path(self.tmp_dir.name) / "anthropic-key.txt"
        self.orig_env = os.environ.get("ANTHROPIC_API_KEY")
        if "ANTHROPIC_API_KEY" in os.environ:
            del os.environ["ANTHROPIC_API_KEY"]

    def tearDown(self):
        if self.orig_env is not None:
            os.environ["ANTHROPIC_API_KEY"] = self.orig_env
        elif "ANTHROPIC_API_KEY" in os.environ:
            del os.environ["ANTHROPIC_API_KEY"]
        self.tmp_dir.cleanup()

    def test_call_arguments(self):
        fake_response = FakeResponse(
            [FakeBlock("How it went: Solid.\nYour focus: Good.\nNext session: Half swings.")]
        )
        client = FakeClient(response=fake_response)

        res = aicoach.ask(
            session="1789123456",
            brief="Session with 15 swings: 7-iron carried 155 yd.",
            again=False,
            client=client,
            notes_file=self.notes_file,
            key_file=self.key_file,
        )

        self.assertFalse(res.get("kept"))
        self.assertEqual(res.get("model"), "claude-opus-5-5")
        self.assertIn("Solid", res.get("text"))

        call = client.messages.last_call
        self.assertIsNotNone(call)
        self.assertEqual(call["model"], "claude-opus-5-5")
        self.assertEqual(call["max_tokens"], 2000)
        self.assertEqual(call["output_config"], {"effort": "medium"})
        self.assertEqual(call["betas"], ["server-side-fallback-2026-07-01"])
        self.assertEqual(call["fallbacks"], "default")
        self.assertEqual(call["messages"], [{"role": "user", "content": "Session with 15 swings: 7-iron carried 155 yd."}])
        self.assertIn("single-digit handicap", call["system"])
        self.assertIn("face-centred", call["system"])

        # Check saved note in JSONL
        notes = aicoach.load_notes(self.notes_file)
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0]["session"], "1789123456")
        self.assertEqual(notes[0]["usage"]["input_tokens"], 120)
        self.assertEqual(notes[0]["usage"]["output_tokens"], 65)

    def test_kept_note_reuse_and_again_flag(self):
        fake_response1 = FakeResponse([FakeBlock("Take 1")])
        client1 = FakeClient(response=fake_response1)

        res1 = aicoach.ask(
            session="session_100",
            brief="Brief 1",
            client=client1,
            notes_file=self.notes_file,
            key_file=self.key_file,
        )
        self.assertFalse(res1["kept"])
        self.assertEqual(res1["text"], "Take 1")
        self.assertEqual(client1.messages.call_count, 1)

        # Asking again without again=True should return kept note without calling API
        client_fail = FakeClient(exception=RuntimeError("Should not call API"))
        res2 = aicoach.ask(
            session="session_100",
            brief="Brief 1 updated",
            again=False,
            client=client_fail,
            notes_file=self.notes_file,
            key_file=self.key_file,
        )
        self.assertTrue(res2["kept"])
        self.assertEqual(res2["text"], "Take 1")
        self.assertEqual(client_fail.messages.call_count, 0)

        # Asking with again=True should call API and update kept note
        fake_response2 = FakeResponse([FakeBlock("Take 2")])
        client2 = FakeClient(response=fake_response2)
        res3 = aicoach.ask(
            session="session_100",
            brief="Brief 1 updated",
            again=True,
            client=client2,
            notes_file=self.notes_file,
            key_file=self.key_file,
        )
        self.assertFalse(res3["kept"])
        self.assertEqual(res3["text"], "Take 2")
        self.assertEqual(client2.messages.call_count, 1)

        # The latest note in notes_file should now be Take 2
        latest = aicoach.get_kept_note("session_100", notes_file=self.notes_file)
        self.assertIsNotNone(latest)
        self.assertEqual(latest["text"], "Take 2")

    def test_daily_cap(self):
        # Prepopulate with 10 notes today
        now = time.time()
        for i in range(10):
            aicoach.save_note(
                {
                    "session": f"sess_{i}",
                    "t": now,
                    "model": "claude-opus-5-5",
                    "brief": "b",
                    "text": f"t_{i}",
                    "usage": {},
                },
                notes_file=self.notes_file,
            )

        client = FakeClient(response=FakeResponse([FakeBlock("Call 11")]))
        res = aicoach.ask(
            session="sess_11",
            brief="b",
            client=client,
            notes_file=self.notes_file,
            key_file=self.key_file,
        )

        self.assertIn("error", res)
        self.assertIn("Daily limit reached", res["error"])
        self.assertEqual(client.messages.call_count, 0)

    def test_no_key(self):
        # Key file does not exist, ANTHROPIC_API_KEY is not set
        res = aicoach.ask(
            session="sess_nokey",
            brief="b",
            client=None,
            notes_file=self.notes_file,
            key_file=self.key_file,
        )
        self.assertIn("error", res)
        self.assertIn("Add an API key", res["error"])

    def test_key_from_file_and_env(self):
        self.assertIsNone(aicoach.get_api_key(self.key_file))

        # From file
        self.key_file.write_text("sk-ant-test-key-123\n# comment", encoding="utf-8")
        self.assertEqual(aicoach.get_api_key(self.key_file), "sk-ant-test-key-123")

        # Env overrides file
        os.environ["ANTHROPIC_API_KEY"] = "sk-ant-env-key-456"
        self.assertEqual(aicoach.get_api_key(self.key_file), "sk-ant-env-key-456")

    def test_error_authentication(self):
        client = FakeClient(exception=anthropic.AuthenticationError("invalid_api_key"))
        res = aicoach.ask(
            session="sess_err",
            brief="b",
            client=client,
            notes_file=self.notes_file,
            key_file=self.key_file,
        )
        self.assertEqual(res, {"error": "the API key isn't right"})

    def test_error_ratelimit(self):
        client = FakeClient(exception=anthropic.RateLimitError("rate_limited"))
        res = aicoach.ask(
            session="sess_err",
            brief="b",
            client=client,
            notes_file=self.notes_file,
            key_file=self.key_file,
        )
        self.assertEqual(res, {"error": "try again later"})

    def test_error_apistatus_500(self):
        client = FakeClient(
            exception=anthropic.APIStatusError("server_error", status_code=500, response=None, body=None)
        )
        res = aicoach.ask(
            session="sess_err",
            brief="b",
            client=client,
            notes_file=self.notes_file,
            key_file=self.key_file,
        )
        self.assertEqual(res, {"error": "try again later"})

    def test_error_apiconnection(self):
        client = FakeClient(exception=anthropic.APIConnectionError("connection_failed"))
        res = aicoach.ask(
            session="sess_err",
            brief="b",
            client=client,
            notes_file=self.notes_file,
            key_file=self.key_file,
        )
        self.assertEqual(res, {"error": "no internet?"})

    def test_refusal(self):
        client = FakeClient(response=FakeResponse([], stop_reason="refusal"))
        res = aicoach.ask(
            session="sess_refuse",
            brief="b",
            client=client,
            notes_file=self.notes_file,
            key_file=self.key_file,
        )
        self.assertEqual(res.get("text"), "The coach couldn't answer this one")

    def test_status(self):
        # No key
        st = aicoach.status(notes_file=self.notes_file, key_file=self.key_file)
        self.assertFalse(st["ready"])
        self.assertEqual(st["callsToday"], 0)
        self.assertEqual(st["cap"], 10)
        self.assertIn("anthropic-key.txt", st["howToAdd"])

        # With key
        self.key_file.write_text("secret_key", encoding="utf-8")
        st2 = aicoach.status(notes_file=self.notes_file, key_file=self.key_file)
        self.assertTrue(st2["ready"])
        # Status must never expose the key
        self.assertNotIn("secret_key", json.dumps(st2))


if __name__ == "__main__":
    unittest.main()
