"""In-memory task progress; pausing preserves the running continuation."""

import threading
import time


class TaskCancelled(Exception):
    pass


class TaskStore:
    def __init__(self):
        self.items = {}
        self.cv = threading.Condition(threading.RLock())

    def start(self, task_id, goal):
        with self.cv:
            if not isinstance(task_id, str) or not 1 <= len(task_id) <= 80:
                raise ValueError("Invalid task ID")
            if any(t["status"] in ("working", "paused") for t in self.items.values()):
                raise ValueError(
                    "Another task is active. Pause/resume or cancel it first."
                )
            self.items[task_id] = {
                "id": task_id,
                "goal": str(goal)[:600],
                "status": "working",
                "steps": [],
            }
            while len(self.items) > 32:
                self.items.pop(next(iter(self.items)))
            return self.snapshot(task_id)

    def snapshot(self, task_id):
        with self.cv:
            t = self.items[task_id]
            return {**t, "steps": [dict(s) for s in t["steps"]]}

    def control(self, task_id, op):
        with self.cv:
            t = self.items[task_id]
            if t["status"] not in ("working", "paused"):
                raise ValueError("Task is no longer active")
            t["status"] = {
                "pause": "paused",
                "resume": "working",
                "cancel": "cancelled",
            }[op]
            self.cv.notify_all()
            return self.snapshot(task_id)

    def checkpoint(self, task_id):
        start = time.monotonic()
        with self.cv:
            while self.items[task_id]["status"] == "paused":
                self.cv.wait()
            if self.items[task_id]["status"] == "cancelled":
                raise TaskCancelled("Task cancelled; no further steps will execute")
        return time.monotonic() - start

    def record(self, task_id, event):
        with self.cv:
            t = self.items[task_id]
            kind = event["type"]
            if kind == "tool_start":
                t["steps"].append(
                    {
                        "name": event["name"],
                        "detail": str(event.get("arguments", {}))[:350],
                        "phase": "working",
                    }
                )
                t["steps"] = t["steps"][-60:]
            elif kind == "action_progress" and t["steps"]:
                t["steps"][-1]["phase"] = event["phase"]
                t["steps"][-1]["detail"] = event.get("detail", t["steps"][-1]["detail"])
            elif kind == "tool_result" and t["steps"]:
                result = event["result"]
                step = t["steps"][-1]
                if result.get("error"):
                    step.update(phase="blocked", detail=result["error"])
                elif result.get("cancelled"):
                    step["phase"] = "cancelled"
                elif event["name"] != "browser_action":
                    step["phase"] = "complete"
            elif kind in ("answer", "error"):
                if t["status"] != "cancelled":
                    t["status"] = "done" if kind == "answer" else "blocked"
            return self.snapshot(task_id)


TASKS = TaskStore()
