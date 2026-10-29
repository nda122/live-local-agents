"""User-managed, opt-in persistence. The model cannot write memories."""

import json
import os
import tempfile
import threading
from pathlib import Path


class MemoryStore:
    def __init__(self, file):
        self.file = Path(file)
        self.lock = threading.RLock()

    def view(self):
        with self.lock:
            if not self.file.exists():
                return {
                    "enabled": False,
                    "preferences": "",
                    "facts": [],
                    "summaries": [],
                }
            if self.file.stat().st_size > 100_000:
                raise ValueError("Memory file exceeds its limit")
            return json.loads(self.file.read_text(encoding="utf-8"))

    def update(self, data):
        with self.lock:
            if data.get("enabled") is not True:
                self.delete()
                return self.view()
            preferences = data.get("preferences", "")
            facts = data.get("facts", [])
            summaries = data.get("summaries", [])
            if not isinstance(preferences, str) or len(preferences) > 4000:
                raise ValueError("Preferences exceed the limit")
            for field in (facts, summaries):
                if (
                    not isinstance(field, list)
                    or len(field) > 30
                    or any(not isinstance(x, str) or len(x) > 4000 for x in field)
                ):
                    raise ValueError(
                        "Memory supports up to 30 entries of 4000 characters per section"
                    )
            result = {
                "enabled": True,
                "preferences": preferences,
                "facts": facts,
                "summaries": summaries,
            }
            encoded = json.dumps(result, ensure_ascii=False, indent=2)
            if len(encoded.encode()) > 90_000:
                raise ValueError("Memory is too large")
            self.file.parent.mkdir(parents=True, exist_ok=True)
            name = None
            try:
                with tempfile.NamedTemporaryFile(
                    mode="w", encoding="utf-8", dir=self.file.parent, delete=False
                ) as f:
                    name = f.name
                    f.write(encoded)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(name, self.file)
            finally:
                if name and os.path.exists(name):
                    os.unlink(name)
            return result

    def context(self):
        data = self.view()
        if not data["enabled"]:
            return ""
        return json.dumps(
            {
                "preferences": data["preferences"],
                "facts": data["facts"][:12],
                "recent_recaps": [s[:700] for s in data["summaries"][-2:]],
            },
            ensure_ascii=False,
        )[:3000]

    def delete(self):
        with self.lock:
            self.file.unlink(missing_ok=True)


MEMORY = MemoryStore(
    os.environ.get(
        "LIVE_AGENT_MEMORY_FILE",
        str(Path(__file__).resolve().parent / "data" / "memory.json"),
    )
)
