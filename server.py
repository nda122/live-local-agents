#!/usr/bin/env python3
"""Local-only browser UI and narrowly scoped llama.cpp proxy; no dependencies."""

import argparse
import json
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from agent import run_agent
from browser_control import BROWSER
from local_files import FILES
from memory_store import MEMORY
from tasks import TASKS

ROOT = Path(__file__).resolve().parent / "web"


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def valid_host(self):
        return self.headers.get("Host") in (
            f"127.0.0.1:{self.server.server_port}",
            f"localhost:{self.server.server_port}",
        )

    def reply(self, status, data, content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        )
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def proxy(self, path, body=None):
        try:
            request = Request(
                self.server.backend + path,
                data=body,
                headers={"Content-Type": "application/json"},
            )
            with urlopen(request, timeout=180) as response:
                self.reply(
                    200,
                    response.read(),
                    response.headers.get("Content-Type", "application/json"),
                )
        except HTTPError as error:
            self.reply(error.code, error.read())
        except (URLError, TimeoutError, OSError) as error:
            self.reply(
                502,
                json.dumps(
                    {"error": {"message": f"Cannot reach llama server: {error}"}}
                ).encode(),
            )

    def do_GET(self):
        if not self.valid_host():
            return self.reply(403, b'{"error":{"message":"Host rejected"}}')
        if self.path == "/api/health":
            return self.proxy("/health")
        files = {
            "/": ("index.html", "text/html; charset=utf-8"),
            "/app.js": ("app.js", "text/javascript; charset=utf-8"),
            "/capture.js": ("capture.js", "text/javascript; charset=utf-8"),
            "/api.js": ("api.js", "text/javascript; charset=utf-8"),
            "/styles.css": ("styles.css", "text/css; charset=utf-8"),
        }
        if self.path not in files:
            return self.reply(404, b"{}")
        name, mime = files[self.path]
        data = (ROOT / name).read_bytes()
        if name == "index.html":
            data = data.replace(
                b"__SESSION_TOKEN__", self.server.session_token.encode()
            )
        self.reply(200, data, mime)

    def do_POST(self):
        if not self.valid_host():
            return self.reply(403, b'{"error":{"message":"Host rejected"}}')
        # Reject cross-origin browser requests. Never expose arbitrary proxy URLs.
        origin = self.headers.get("Origin")
        if origin and origin not in (
            f"http://127.0.0.1:{self.server.server_port}",
            f"http://localhost:{self.server.server_port}",
        ):
            return self.reply(403, b'{"error":{"message":"Origin rejected"}}')
        routes = {
            "/api/chat": "/v1/chat/completions",
            "/api/tts": "/tts",
            "/api/agent": None,
            "/api/browser/open": None,
            "/api/browser/observe": None,
            "/api/browser/approve": None,
            "/api/browser/cancel": None,
            "/api/browser/close": None,
        }
        routes.update(
            {f"/api/task/{op}": None for op in ("pause", "resume", "cancel", "state")}
        )
        routes.update(
            {f"/api/files/{op}": None for op in ("configure", "draft", "review")}
        )
        routes.update({f"/api/memory/{op}": None for op in ("view", "save", "delete")})
        if self.path not in routes:
            return self.reply(404, b"{}")
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 8_000_000:
                raise ValueError("Request must be between 1 byte and 8 MB")
            body = self.rfile.read(length)
            parsed = json.loads(body)
            if not isinstance(parsed, dict):
                raise ValueError("Expected a JSON object")
        except (ValueError, json.JSONDecodeError) as error:
            return self.reply(
                400, json.dumps({"error": {"message": str(error)}}).encode()
            )
        token = self.headers.get("X-Live-Agent-Token") or parsed.pop("_token", None)
        if not isinstance(token, str) or not secrets.compare_digest(
            token, self.server.session_token
        ):
            return self.reply(
                403,
                b'{"error":{"message":"Session token missing or invalid; reload the app"}}',
            )
        if self.path.startswith("/api/files/") or self.path.startswith("/api/memory/"):
            try:
                op = self.path.rsplit("/", 1)[1]
                if "/files/" in self.path:
                    if op == "configure":
                        result = FILES.configure(parsed.get("folder", ""))
                    elif op == "draft":
                        result = FILES.draft_note(
                            parsed.get("path"), parsed.get("content")
                        )
                    else:
                        result = FILES.decide(
                            parsed.get("id"),
                            parsed.get("approved") is True,
                            parsed.get("content"),
                        )
                else:
                    if op == "view":
                        result = MEMORY.view()
                    elif op == "save":
                        result = MEMORY.update(parsed)
                    else:
                        MEMORY.delete()
                        result = MEMORY.view()
                self.reply(200, json.dumps(result).encode())
            except Exception as error:
                self.reply(400, json.dumps({"error": {"message": str(error)}}).encode())
            return
        if self.path.startswith("/api/task/"):
            try:
                op = self.path.rsplit("/", 1)[1]
                task_id = parsed["id"]
                result = (
                    TASKS.snapshot(task_id)
                    if op == "state"
                    else TASKS.control(task_id, op)
                )
                if op == "cancel":
                    BROWSER.cancel()
                self.reply(200, json.dumps(result).encode())
            except Exception as error:
                self.reply(400, json.dumps({"error": {"message": str(error)}}).encode())
            return
        if self.path.startswith("/api/browser/"):
            try:
                op = self.path.rsplit("/", 1)[1]
                if op == "approve":
                    result = BROWSER.decide(parsed.get("id"), parsed.get("approved"))
                elif op == "cancel":
                    BROWSER.cancel()
                    result = {"cancelled": True}
                elif op == "close":
                    BROWSER.cancel()
                    result = BROWSER.command({"op": "close"})
                else:
                    result = BROWSER.command({"op": op, "url": parsed.get("url", "")})
                self.reply(200, json.dumps(result).encode())
            except Exception as error:
                self.reply(400, json.dumps({"error": {"message": str(error)}}).encode())
            return
        if self.path == "/api/agent":
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

            task_id = parsed.get("task_id") or secrets.token_urlsafe(12)
            started = False

            def send(event):
                self.wfile.write((json.dumps(event) + "\n").encode())
                self.wfile.flush()

            def emit(event):
                send(event)
                if started:
                    send({"type": "task_state", "task": TASKS.record(task_id, event)})

            try:
                messages = parsed.get("messages")
                goal = (
                    messages[-1].get("content", "")
                    if isinstance(messages, list) and messages
                    else ""
                )
                if isinstance(goal, list):
                    goal = " ".join(
                        p.get("text", "") for p in goal if p.get("type") == "text"
                    )
                state = TASKS.start(task_id, goal)
                started = True
                send({"type": "task_state", "task": state})
                run_agent(
                    self.server.backend,
                    parsed.get("messages"),
                    emit,
                    enabled=parsed.get("web", True) is True,
                    browser_enabled=parsed.get("browser", False) is True,
                    task_id=task_id,
                    files_enabled=parsed.get("files", False) is True,
                )
            except (BrokenPipeError, ConnectionResetError):
                if started:
                    try:
                        TASKS.control(task_id, "cancel")
                    except ValueError:
                        pass
            except Exception as error:
                try:
                    emit({"type": "error", "message": str(error)[:700]})
                except (BrokenPipeError, ConnectionResetError):
                    pass
            return
        self.proxy(routes[self.path], body)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--backend", default="http://127.0.0.1:8080")
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.backend = args.backend.rstrip("/")
    server.session_token = secrets.token_urlsafe(32)
    print(f"Live agent: http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        BROWSER.shutdown()
        FILES.configure("")
        server.server_close()
