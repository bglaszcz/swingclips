"""findserver.py: what counts as the server, the networks looked round, and a sweep that finds a server
answering on this PC (127.0.0.x), not the network."""
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

sys.path[:0] = [str(Path(__file__).parent.parent)]

import findserver  # noqa: E402


class Answer(BaseHTTPRequestHandler):
    body = {"ms": 1792851924727, "app": "swingclips"}

    def do_GET(self):
        data = json.dumps(self.body).encode()
        self.send_response(200 if self.path == "/api/time" else 404)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def serve(handler=Answer):
    srv = HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class IsServer(unittest.TestCase):
    def test_answers(self):
        self.assertTrue(findserver.is_server(b'{"ms": 1792851924727, "app": "swingclips"}'))
        self.assertTrue(findserver.is_server('{"ms": 1792851924727}'))   # a server from before "app"
        self.assertFalse(findserver.is_server('{"ms": 1, "app": "something else"}'))
        self.assertFalse(findserver.is_server('{"ms": true}'))
        self.assertFalse(findserver.is_server('{"time": 1}'))
        self.assertFalse(findserver.is_server("<html>router login</html>"))
        self.assertFalse(findserver.is_server("[1, 2]"))


class Networks(unittest.TestCase):
    def test_network_and_port(self):
        self.assertEqual(findserver.network_of("http://192.168.7.250:8000"), "192.168.7")
        self.assertEqual(findserver.network_of("10.0.1.5"), "10.0.1")
        self.assertIsNone(findserver.network_of("http://homeserver:8000"))
        self.assertIsNone(findserver.network_of(None))
        self.assertEqual(findserver.port_of("http://192.168.7.250:8001/"), 8001)
        self.assertEqual(findserver.port_of("http://192.168.7.250"), findserver.PORT)

    def test_order_and_once_each(self):
        nets = findserver.networks("http://192.168.86.250:8000", ["192.168.86", "10.0.0"], ("192.168.7",))
        self.assertEqual(nets, ["192.168.86", "10.0.0", "192.168.7"])
        self.assertEqual(findserver.networks(None, [], ("192.168.7",)), ["192.168.7"])

    def test_own_networks_are_private_and_unique(self):
        own = findserver.own_networks()
        self.assertEqual(len(own), len(set(own)))
        for n in own:
            self.assertFalse(n.startswith(("127.", "169.254")), n)


class Find(unittest.TestCase):
    def setUp(self):
        self.srv = serve()
        self.url = f"http://127.0.0.1:{self.srv.server_port}"
        self.last = Path(tempfile.mkdtemp()) / "last.txt"
        # Only a few of this PC's 127.0.0.x are looked round (Windows takes a second or so to refuse each
        # one), never the real network.
        for name, value in (("own_networks", lambda: []), ("SWEEP_HOSTS", range(1, 4)), ("CHECK_S", 0.5)):
            patcher = mock.patch.object(findserver, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()

    def test_check(self):
        self.assertTrue(findserver.check(self.url))
        self.assertFalse(findserver.check("http://127.0.0.1:9", timeout=0.5))

    def test_given_is_used_as_it_is(self):
        self.assertEqual(findserver.find("http://10.9.9.9:8000/", last_file=self.last), "http://10.9.9.9:8000")

    def test_last_that_answers_wins(self):
        self.last.write_text(self.url + "\n")
        self.assertEqual(findserver.find(None, say=lambda m: None, last_file=self.last, default="http://127.0.0.1:9"),
                         self.url)

    def test_sweep_finds_it_off_the_usual_host_and_keeps_it(self):
        # Nothing answers at the last address or the default: the look round finds 127.0.0.1 (not HOST).
        self.last.write_text(f"http://127.0.0.{findserver.HOST}:{self.srv.server_port}\n")
        said = []
        got = findserver.find(None, say=said.append, last_file=self.last, default="http://127.0.0.2:9", home=())
        self.assertEqual(got, self.url)
        self.assertEqual(self.last.read_text().strip(), self.url)
        self.assertTrue(any("Found" in s for s in said), said)

    def test_nothing_found_gives_the_last(self):
        self.last.write_text("http://127.0.0.3:9\n")
        got = findserver.find(None, say=lambda m: None, last_file=self.last, default="http://127.0.0.3:9", home=())
        self.assertEqual(got, "http://127.0.0.3:9")

    def test_another_app_on_the_port_is_not_the_server(self):
        class Other(Answer):
            body = {"ms": 5, "app": "camera"}
        other = serve(Other)
        try:
            self.assertFalse(findserver.check(f"http://127.0.0.1:{other.server_port}"))
        finally:
            other.shutdown()
            other.server_close()


if __name__ == "__main__":
    unittest.main()
