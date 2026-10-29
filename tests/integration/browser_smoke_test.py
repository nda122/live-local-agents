"""Opt-in integration test; opens a fresh browser and rejects a model proposal."""

import json
import os
import re
from urllib.request import Request, urlopen

BASE = os.environ.get("LIVE_AGENT_TEST_URL", "http://127.0.0.1:8766")

with urlopen(BASE + "/") as response:
    TOKEN = re.search(
        r'name="live-agent-token"\s+content="([^"]+)"', response.read().decode()
    ).group(1)


def post(path, data):
    return urlopen(
        Request(
            BASE + path,
            json.dumps(data).encode(),
            {"Content-Type": "application/json", "X-Live-Agent-Token": TOKEN},
        ),
        timeout=100,
    )


with post("/api/browser/open", {"url": "https://www.python.org"}) as r:
    state = json.load(r)
assert state["targets"] and state["screenshot"]
seen = []
try:
    with post(
        "/api/agent",
        {
            "web": False,
            "browser": True,
            "messages": [
                {
                    "role": "user",
                    "content": "Observe the dedicated browser, then propose filling its search field with Live agent test. Do not submit the form.",
                }
            ],
        },
    ) as r:
        for line in r:
            event = json.loads(line)
            seen.append(event["type"])
            if event["type"] == "approval_required":
                print("Model proposed:", event["action"])
                with post(
                    "/api/browser/approve", {"id": event["id"], "approved": False}
                ) as approval:
                    assert json.load(approval)["accepted"]
            if event["type"] == "error":
                raise AssertionError(event)
            if event["type"] == "answer":
                print("Final:", event["text"])
    assert "approval_required" in seen, seen
    assert "answer" in seen, seen
    print("Native model → browser observation → proposal → rejection passed.")
finally:
    with post("/api/browser/close", {}) as r:
        assert json.load(r)["closed"]
