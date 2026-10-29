"""Single browser session with explicit one-use, expiring action approvals."""

import json
import os
import secrets
import select
import shutil
import subprocess
import threading
import time
from pathlib import Path


class BrowserControl:
    def __init__(self):
        self.process = None
        self.lock = threading.RLock()
        self.condition = threading.Condition()
        self.pending = {}
        self.state = None

    def command(self, command):
        with self.lock:
            if command["op"] == "close" and (
                self.process is None or self.process.poll() is not None
            ):
                self.state = None
                return {"closed": True}
            if self.process is None or self.process.poll() is not None:
                node = os.environ.get("LIVE_AGENT_NODE") or shutil.which("node")
                if not node:
                    raise ValueError(
                        "Node.js is required; install Node 20+ and run npm ci"
                    )
                self.process = subprocess.Popen(
                    [node, str(Path(__file__).with_name("browser-worker.cjs"))],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    text=True,
                    bufsize=1,
                )
            self.process.stdin.write(json.dumps(command) + "\n")
            self.process.stdin.flush()
            if not select.select([self.process.stdout], [], [], 35)[0]:
                self.process.terminate()
                self.process = None
                raise TimeoutError("Browser operation timed out")
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError("Browser closed unexpectedly")
            result = json.loads(line)
            if "error" in result:
                raise ValueError(result["error"])
            self.state = result["result"]
            return self.state

    def cancel(self):
        with self.condition:
            for proposal in self.pending.values():
                proposal["approved"] = False
            self.condition.notify_all()

    def shutdown(self):
        self.cancel()
        if self.process and self.process.poll() is None:
            self.process.terminate()

    def decide(self, token, approved):
        with self.condition:
            proposal = self.pending.get(token)
            if (
                not proposal
                or proposal["expires"] < time.monotonic()
                or "approved" in proposal
            ):
                raise ValueError("Approval expired or was already used")
            proposal["approved"] = approved is True
            self.condition.notify_all()
        return {"accepted": True}

    def action(self, args, emit, deadline, gate=None):
        allowed = {"action", "target", "value", "reason"}
        if (
            not isinstance(args, dict)
            or set(args) - allowed
            or args.get("action")
            not in (
                "click",
                "fill",
                "press",
                "navigate",
                "scroll",
                "back",
                "forward",
                "select",
            )
        ):
            raise ValueError("Invalid browser action")
        if (
            not isinstance(args.get("value", ""), str)
            or len(args.get("value", "")) > 2000
        ):
            raise ValueError("Invalid action text")
        state = self.state
        if not state or "revision" not in state:
            raise ValueError("Open and observe the dedicated browser first")
        target = next(
            (x for x in state["targets"] if x["target"] == args.get("target")), None
        )
        if (
            args["action"] not in ("navigate", "scroll", "back", "forward")
            and target is None
        ):
            raise ValueError("Target not in the latest browser observation")
        token = secrets.token_urlsafe(24)
        proposal = {
            "expires": min(deadline, time.monotonic() + 60),
            "command": {
                "op": "action",
                "action": args["action"],
                "value": args.get("value", ""),
                "target": args.get("target"),
                "label": (target or {}).get("label", ""),
                "url": state["url"],
                "revision": state["revision"],
            },
        }
        with self.condition:
            self.pending[token] = proposal
        try:
            emit(
                {
                    "type": "approval_required",
                    "id": token,
                    "action": args,
                    "target": target,
                    "url": state["url"],
                    "screenshot": state["screenshot"],
                }
            )
            emit({"type": "action_progress", "phase": "proposed", "action": args})
            with self.condition:
                while "approved" not in proposal:
                    remaining = proposal["expires"] - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError(
                            "Browser approval timed out; no action executed"
                        )
                    self.condition.wait(remaining)
                if not proposal["approved"]:
                    return {
                        "cancelled": True,
                        "message": "User rejected or stopped the action. Do not retry.",
                    }
            emit({"type": "action_progress", "phase": "approved", "action": args})
            if gate:
                gate()
            if time.monotonic() > proposal["expires"]:
                raise TimeoutError(
                    "Approval expired while paused; request a fresh approval"
                )
            result = self.command(proposal["command"])
            emit({"type": "action_progress", "phase": "executed", "action": args})
            verification = result.get(
                "verification",
                {"verified": False, "detail": "No verification available."},
            )
            emit(
                {
                    "type": "action_progress",
                    "phase": "verified" if verification["verified"] else "needs_review",
                    "action": args,
                    "detail": verification["detail"],
                }
            )
            emit({"type": "browser_state", "state": result})
            return {k: v for k, v in result.items() if k != "screenshot"}
        finally:
            with self.condition:
                self.pending.pop(token, None)


BROWSER = BrowserControl()
