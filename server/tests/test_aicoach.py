"""The AI coach (aicoach.py): any provider (Anthropic through its SDK, OpenAI, Google, other OpenAI-compatible
services over HTTP), kept notes, the daily cap, keys and settings. No network: fake clients and a fake HTTP.

  cd server && python -m unittest tests.test_aicoach
"""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).parent
sys.path[:0] = [str(HERE.parent), str(HERE)]

import aicoach  # noqa: E402
import anthropic  # noqa: E402

KEY_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "AICOACH_OTHER_API_KEY",
            "SWINGCLIPS_SHOTS", "SWINGCLIPS_COACH_NOTES", "SWINGCLIPS_COACH_KEY"]


class FakeBlock:
    def __init__(self, text, block_type="text"):
        self.text, self.type = text, block_type


class FakeUsage:
    def __init__(self, input_tokens=120, output_tokens=65):
        self.input_tokens, self.output_tokens = input_tokens, output_tokens


class FakeResponse:
    def __init__(self, content, stop_reason="end_turn", usage=None):
        self.content, self.stop_reason, self.usage = content, stop_reason, usage or FakeUsage()


class FakeMessages:
    def __init__(self, response=None, exception=None):
        self.response, self.exception, self.last_call, self.call_count = response, exception, None, 0

    def create(self, **kwargs):
        self.call_count += 1
        self.last_call = kwargs
        if self.exception:
            raise self.exception
        return self.response


class FakeModel:
    def __init__(self, id):
        self.id = id


class FakeClient:
    """Stands in for anthropic.Anthropic: .messages, .beta.messages (the same fake) and .models."""
    def __init__(self, response=None, exception=None):
        self.messages = FakeMessages(response=response, exception=exception)
        self.beta = type("Beta", (), {"messages": self.messages})()
        self.models = type("Models", (), {"list": lambda _self: [FakeModel("claude-sonnet-5-5"), FakeModel("claude-opus-5-5")]})()


class FakeHTTP:
    """Stands in for aicoach._http: records each request, answers from a list (or raises a CoachError)."""
    def __init__(self, *answers):
        self.answers, self.calls = list(answers), []

    def __call__(self, method, url, headers, body=None):
        self.calls.append({"method": method, "url": url, "headers": headers, "body": body})
        a = self.answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a


def status_error(cls, code):
    import httpx
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    return cls("x", response=httpx.Response(code, request=req), body=None)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self.saved_env = {k: os.environ.pop(k) for k in KEY_VARS if k in os.environ}
        os.environ["SWINGCLIPS_SHOTS"] = str(d / "shots.jsonl")      # settings and key files go here
        self.notes = d / "coach-notes.jsonl"
        self.key_file = d / "anthropic-key.txt"

    def tearDown(self):
        for k in KEY_VARS:
            os.environ.pop(k, None)
        os.environ.update(self.saved_env)
        self.tmp.cleanup()

    def ask(self, session="s1", brief="A brief.", **kw):
        return aicoach.ask(session=session, brief=brief, notes_file=self.notes, key_file=self.key_file, **kw)


class AnthropicTest(Base):
    def setUp(self):
        super().setUp()
        self.key_file.write_text("sk-ant-test\n", encoding="utf-8")

    def test_call_arguments_and_note(self):
        client = FakeClient(FakeResponse([FakeBlock("How it went: solid.")]))
        res = self.ask(brief="Session with 15 swings.", client=client)
        self.assertEqual((res["kept"], res["model"], res["provider"]), (False, "claude-opus-5-5", "anthropic"))
        call = client.messages.last_call
        self.assertEqual(call["model"], "claude-opus-5-5")
        self.assertEqual(call["output_config"], {"effort": "medium"})
        self.assertEqual((call["betas"], call["fallbacks"]), (["server-side-fallback-2026-07-01"], "default"))
        self.assertEqual(call["messages"], [{"role": "user", "content": "Session with 15 swings."}])
        self.assertIn("single-digit handicap", call["system"])
        [note] = aicoach.load_notes(self.notes)
        self.assertEqual((note["session"], note["provider"], note["usage"]["input_tokens"]), ("s1", "anthropic", 120))

    def test_a_model_without_fallbacks_uses_the_plain_call(self):
        aicoach.save_settings("anthropic", "claude-haiku-4-5")
        client = FakeClient(FakeResponse([FakeBlock("ok")]))
        self.ask(client=client)
        self.assertNotIn("fallbacks", client.messages.last_call)
        self.assertNotIn("output_config", client.messages.last_call)

    def test_kept_note_reused_unless_again(self):
        self.assertEqual(self.ask(client=FakeClient(FakeResponse([FakeBlock("Take 1")])))["text"], "Take 1")
        never = FakeClient(exception=RuntimeError("must not call"))
        res = self.ask(client=never)
        self.assertEqual((res["kept"], res["text"], never.messages.call_count), (True, "Take 1", 0))
        res = self.ask(again=True, client=FakeClient(FakeResponse([FakeBlock("Take 2")])))
        self.assertEqual((res["kept"], aicoach.get_kept_note("s1", self.notes)["text"]), (False, "Take 2"))

    def test_daily_cap(self):
        for i in range(aicoach.DAILY_CAP):
            aicoach.save_note({"session": f"x{i}", "t": time.time(), "text": "t"}, notes_file=self.notes)
        client = FakeClient(FakeResponse([FakeBlock("no")]))
        self.assertIn("Daily limit", self.ask(session="new", client=client)["error"])
        self.assertEqual(client.messages.call_count, 0)

    def test_errors_in_words(self):
        cases = [(status_error(anthropic.AuthenticationError, 401), "isn't right"),
                 (status_error(anthropic.RateLimitError, 429), "Rate limited"),
                 (status_error(anthropic.InternalServerError, 500), "having trouble"),
                 (status_error(anthropic.NotFoundError, 404), "pick another"),
                 (anthropic.APIConnectionError(request=__import__("httpx").Request("POST", "https://x")), "no internet")]
        for exc, words in cases:
            res = self.ask(session=f"e{words}", client=FakeClient(exception=exc))
            self.assertIn(words, res["error"])
        self.assertEqual(aicoach.load_notes(self.notes), [])

    def test_refusal(self):
        res = self.ask(client=FakeClient(FakeResponse([], stop_reason="refusal")))
        self.assertEqual(res["text"], "The coach couldn't answer this one.")

    def test_models_from_the_provider(self):
        self.assertEqual(aicoach.list_models("anthropic", client=FakeClient()), ["claude-opus-5-5", "claude-sonnet-5-5"])


class OtherProvidersTest(Base):
    def test_openai(self):
        aicoach.save_key("openai", "sk-openai")
        aicoach.save_settings("openai", "gpt-test")
        http = FakeHTTP({"choices": [{"message": {"content": "Next session: drag the handle."}}],
                         "usage": {"prompt_tokens": 900, "completion_tokens": 80}})
        res = self.ask(http=http)
        self.assertEqual((res["text"], res["provider"], res["model"]), ("Next session: drag the handle.", "openai", "gpt-test"))
        c = http.calls[0]
        self.assertEqual((c["method"], c["url"]), ("POST", "https://api.openai.com/v1/chat/completions"))
        self.assertEqual(c["headers"]["Authorization"], "Bearer sk-openai")
        self.assertEqual([m["role"] for m in c["body"]["messages"]], ["system", "user"])
        self.assertEqual(aicoach.load_notes(self.notes)[0]["usage"], {"input_tokens": 900, "output_tokens": 80})

    def test_google(self):
        aicoach.save_key("google", "AIza-test")
        aicoach.save_settings("google", "gemini-test")
        http = FakeHTTP({"candidates": [{"content": {"parts": [{"text": "How it went: "}, {"text": "good."}]}}],
                         "usageMetadata": {"promptTokenCount": 700, "candidatesTokenCount": 50}})
        res = self.ask(http=http)
        self.assertEqual(res["text"], "How it went: good.")
        c = http.calls[0]
        self.assertTrue(c["url"].endswith("/models/gemini-test:generateContent"))
        self.assertEqual(c["headers"], {"x-goog-api-key": "AIza-test"})
        self.assertIn("single-digit handicap", c["body"]["systemInstruction"]["parts"][0]["text"])

    def test_google_blocked(self):
        aicoach.save_key("google", "k")
        aicoach.save_settings("google", "gemini-test")
        res = self.ask(http=FakeHTTP({"promptFeedback": {"blockReason": "SAFETY"}}))
        self.assertEqual(res["text"], "The coach couldn't answer this one.")

    def test_other_needs_a_base_url_and_uses_it(self):
        aicoach.save_key("other", "xai-key")
        aicoach.save_settings("other", "grok-test")
        self.assertIn("base URL", self.ask(http=FakeHTTP())["error"])
        aicoach.save_settings(base_url="https://api.x.ai/v1/")
        http = FakeHTTP({"choices": [{"message": {"content": "ok"}}]})
        self.ask(http=http)
        self.assertEqual(http.calls[0]["url"], "https://api.x.ai/v1/chat/completions")

    def test_http_errors_in_words(self):
        aicoach.save_key("openai", "k")
        aicoach.save_settings("openai", "gpt-test")
        res = self.ask(http=FakeHTTP(aicoach.CoachError(aicoach.http_problem(401))))
        self.assertIn("isn't right", res["error"])
        self.assertIn("Rate limited", aicoach.http_problem(429))

    def test_no_model_yet(self):
        aicoach.save_key("openai", "k")
        aicoach.save_settings("openai")
        self.assertIn("Pick a model", self.ask(http=FakeHTTP())["error"])

    def test_model_lists(self):
        http = FakeHTTP({"data": [{"id": "gpt-x"}, {"id": "o-y"}, {"id": "text-embedding-3"}, {"id": "gpt-x-audio"}, {"id": "dall-e-3"}]})
        self.assertEqual(aicoach.list_models("openai", key="k", http=http), ["gpt-x", "o-y"])
        http = FakeHTTP({"models": [{"name": "models/gemini-a", "supportedGenerationMethods": ["generateContent"]},
                                    {"name": "models/embed-b", "supportedGenerationMethods": ["embedContent"]}]})
        self.assertEqual(aicoach.list_models("google", key="k", http=http), ["gemini-a"])
        with self.assertRaises(aicoach.CoachError):
            aicoach.list_models("openai", key=None)


class KeysAndSettingsTest(Base):
    def test_no_key(self):
        self.assertIn("Add an API key", self.ask()["error"])

    def test_key_from_file_and_env(self):
        self.assertIsNone(aicoach.get_api_key("anthropic", self.key_file))
        self.key_file.write_text("sk-ant-file\n# a comment", encoding="utf-8")
        self.assertEqual(aicoach.get_api_key("anthropic", self.key_file), "sk-ant-file")
        os.environ["ANTHROPIC_API_KEY"] = "sk-ant-env"
        self.assertEqual(aicoach.get_api_key("anthropic", self.key_file), "sk-ant-env")
        os.environ["GOOGLE_API_KEY"] = "g-env"
        self.assertEqual(aicoach.get_api_key("google"), "g-env")

    def test_provider_defaults_to_the_one_with_a_key(self):
        self.assertEqual(aicoach.current()["provider"], "anthropic")
        aicoach.save_key("google", "g")
        self.assertEqual(aicoach.current()["provider"], "google")
        aicoach.save_settings("openai")
        self.assertEqual(aicoach.current()["provider"], "openai")

    def test_status_never_shows_a_key(self):
        st = aicoach.status(notes_file=self.notes, key_file=self.key_file)
        self.assertFalse(st["ready"])
        self.assertEqual(st["cap"], aicoach.DAILY_CAP)
        self.key_file.write_text("secret_key_123", encoding="utf-8")
        aicoach.save_key("openai", "secret_openai_456")
        st = aicoach.status(notes_file=self.notes, key_file=self.key_file)
        self.assertTrue(st["ready"])
        self.assertNotIn("secret", json.dumps(st))
        self.assertEqual({p["id"]: p["hasKey"] for p in st["providers"]},
                         {"anthropic": True, "openai": True, "google": False, "other": False})

    def test_bad_provider(self):
        with self.assertRaises(ValueError):
            aicoach.save_settings("myspace")

    def test_endpoints(self):
        from fastapi.testclient import TestClient
        import app
        c = TestClient(app.app)
        st = c.get("/api/coach/status").json()
        self.assertEqual((st["cap"], st["ready"]), (aicoach.DAILY_CAP, False))
        self.assertIsNone(c.get("/api/coach/notes?session=none_999").json())
        self.assertIn("error", c.post("/api/coach/ask", json={"session": "t1", "brief": "b"}).json())
        st = c.post("/api/coach/settings", json={"provider": "openai", "model": "gpt-test", "key": "sk-from-page"}).json()
        self.assertEqual((st["provider"], st["model"], st["ready"]), ("openai", "gpt-test", True))
        self.assertNotIn("sk-from-page", json.dumps(st))
        self.assertEqual(aicoach.get_api_key("openai"), "sk-from-page")
        self.assertEqual(c.post("/api/coach/settings", json={"provider": "nope"}).status_code, 400)
        self.assertEqual(c.get("/api/coach/models?provider=nope").status_code, 400)
        self.assertEqual(c.get("/api/coach/models?provider=google").json()["models"], [])   # no key: an error, no call
        self.assertIn("error", c.post("/api/coach/ask", json={"kind": "question", "question": ""}).json())
        self.assertIsInstance(c.get("/api/coach/notes?kind=week").json(), list)
        self.assertIsInstance(c.get("/api/coach/notes?kind=question").json(), list)


class KindsAndPromptsTest(Base):
    def setUp(self):
        super().setUp()
        self.key_file.write_text("sk-ant-test\n", encoding="utf-8")

    def test_session_prompt_and_content(self):
        client = FakeClient(FakeResponse([FakeBlock("Take on session.")]))
        res = self.ask(session="s1", brief="Session brief.", kind="session", client=client)
        self.assertEqual(res["text"], "Take on session.")
        call = client.messages.last_call
        self.assertIn("single-digit handicap", call["system"])
        self.assertIn("How it went", call["system"])
        self.assertEqual(call["messages"], [{"role": "user", "content": "Session brief."}])

    def test_week_prompt_and_content(self):
        client = FakeClient(FakeResponse([FakeBlock("The week: solid progress.")]))
        res = self.ask(session="2031-03-24", brief="Week text.", kind="week", client=client)
        self.assertEqual(res["text"], "The week: solid progress.")
        self.assertEqual(res["kind"], "week")
        call = client.messages.last_call
        self.assertIn("The week", call["system"])
        self.assertIn("Next week", call["system"])
        self.assertEqual(call["messages"], [{"role": "user", "content": "Week text."}])

    def test_question_prompt_and_content(self):
        client = FakeClient(FakeResponse([FakeBlock("Your 7 irons go right because...")]))
        res = aicoach.ask(
            kind="question",
            question="Why do my 7 irons go right?",
            brief="30-day brief.",
            client=client,
            notes_file=self.notes,
            key_file=self.key_file,
        )
        self.assertEqual(res["text"], "Your 7 irons go right because...")
        self.assertEqual(res["kind"], "question")
        self.assertEqual(res["question"], "Why do my 7 irons go right?")
        call = client.messages.last_call
        self.assertIn("Answer the question asked", call["system"])
        self.assertEqual(call["messages"], [{"role": "user", "content": "Question: Why do my 7 irons go right?\n\n30-day brief."}])

    def test_week_reused_unless_again(self):
        client1 = FakeClient(FakeResponse([FakeBlock("Week review 1")]))
        res1 = self.ask(session="2031-03-24", brief="Week text.", kind="week", client=client1)
        self.assertFalse(res1["kept"])
        never = FakeClient(exception=RuntimeError("must not call"))
        res2 = self.ask(session="2031-03-24", brief="Week text.", kind="week", client=never)
        self.assertTrue(res2["kept"])
        self.assertEqual(res2["text"], "Week review 1")
        self.assertEqual(never.messages.call_count, 0)
        client2 = FakeClient(FakeResponse([FakeBlock("Week review 2")]))
        res3 = self.ask(session="2031-03-24", brief="Week text.", kind="week", again=True, client=client2)
        self.assertFalse(res3["kept"])
        self.assertEqual(res3["text"], "Week review 2")

    def test_question_never_reused(self):
        client = FakeClient(FakeResponse([FakeBlock("Answer A")]))
        res1 = aicoach.ask(
            kind="question",
            question="Why do my 7 irons go right?",
            brief="Brief.",
            client=client,
            notes_file=self.notes,
            key_file=self.key_file,
        )
        self.assertFalse(res1["kept"])
        self.assertEqual(client.messages.call_count, 1)

        client.messages.response = FakeResponse([FakeBlock("Answer B")])
        res2 = aicoach.ask(
            kind="question",
            question="Why do my 7 irons go right?",
            brief="Brief.",
            client=client,
            notes_file=self.notes,
            key_file=self.key_file,
        )
        self.assertFalse(res2["kept"])
        self.assertEqual(res2["text"], "Answer B")
        self.assertEqual(client.messages.call_count, 2)

    def test_question_requires_question_text(self):
        res = aicoach.ask(kind="question", question="", notes_file=self.notes, key_file=self.key_file)
        self.assertIn("question is required", res["error"])

    def test_shared_cap_across_kinds(self):
        aicoach.save_note({"session": "s1", "kind": "session", "t": time.time(), "text": "t"}, notes_file=self.notes)
        aicoach.save_note({"session": "2031-03-17", "kind": "week", "t": time.time(), "text": "t"}, notes_file=self.notes)
        aicoach.save_note({"kind": "question", "question": "q?", "t": time.time(), "text": "t"}, notes_file=self.notes)
        for i in range(aicoach.DAILY_CAP - 3):
            aicoach.save_note({"session": f"s{i+2}", "t": time.time(), "text": "t"}, notes_file=self.notes)
        client = FakeClient(FakeResponse([FakeBlock("no")]))
        res = aicoach.ask(kind="question", question="one more?", client=client, notes_file=self.notes, key_file=self.key_file)
        self.assertIn("Daily limit", res["error"])
        self.assertEqual(client.messages.call_count, 0)

    def test_old_notes_still_read_as_sessions_and_filtering(self):
        # Note with no kind (legacy note)
        aicoach.save_note({"session": "legacy_s1", "t": time.time() - 100, "text": "Old session take."}, notes_file=self.notes)
        # Note of kind week
        aicoach.save_note({"session": "2031-03-10", "kind": "week", "t": time.time() - 50, "text": "Week take."}, notes_file=self.notes)
        # Note of kind question
        aicoach.save_note({"kind": "question", "question": "Why?", "t": time.time() - 10, "text": "Because."}, notes_file=self.notes)

        # Legacy note can be found by session
        kept = aicoach.get_kept_note("legacy_s1", self.notes)
        self.assertIsNotNone(kept)
        self.assertEqual(kept["text"], "Old session take.")

        # Filtering by kind
        sessions = aicoach.get_all_notes(self.notes, kind="session")
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]["session"], "legacy_s1")

        weeks = aicoach.get_all_notes(self.notes, kind="week")
        self.assertEqual(len(weeks), 1)
        self.assertEqual(weeks[0]["session"], "2031-03-10")

        questions = aicoach.get_all_notes(self.notes, kind="question")
        self.assertEqual(len(questions), 1)
        self.assertEqual(questions[0]["question"], "Why?")

        all_notes = aicoach.get_all_notes(self.notes)
        self.assertEqual(len(all_notes), 3)


if __name__ == "__main__":
    unittest.main()
