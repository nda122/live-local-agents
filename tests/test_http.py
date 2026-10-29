import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from server import Handler


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.session_token = "test-secret"
        self.server.backend = "http://127.0.0.1:1"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.addCleanup(self.shutdown)

    def shutdown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_page_contains_current_session_token(self):
        with urlopen(self.base + "/") as response:
            html = response.read().decode()
        self.assertIn("test-secret", html)
        self.assertNotIn("__SESSION_TOKEN__", html)

    def test_mutations_require_token(self):
        request = Request(
            self.base + "/api/browser/cancel",
            b"{}",
            {"Content-Type": "application/json"},
        )
        with self.assertRaises(HTTPError) as error:
            urlopen(request)
        self.assertEqual(error.exception.code, 403)

    def test_foreign_origin_and_host_rejected(self):
        for headers in (
            {"Host": "attacker.example"},
            {"Origin": "https://attacker.example"},
        ):
            request = Request(
                self.base + "/api/browser/cancel",
                b"{}",
                {"X-Live-Agent-Token": "test-secret", **headers},
            )
            with self.assertRaises(HTTPError) as error:
                urlopen(request)
            self.assertEqual(error.exception.code, 403)

    def test_authorized_request_works(self):
        request = Request(
            self.base + "/api/browser/cancel",
            b"{}",
            {"X-Live-Agent-Token": "test-secret"},
        )
        with urlopen(request) as response:
            self.assertTrue(json.load(response)["cancelled"])


if __name__ == "__main__":
    unittest.main()
