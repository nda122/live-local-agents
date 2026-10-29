import threading
import unittest

from tasks import TaskCancelled, TaskStore


class TaskTests(unittest.TestCase):
    def test_pause_resumes_without_replaying_completed_steps(self):
        store = TaskStore()
        store.start("task", "Goal")
        store.record(
            "task", {"type": "tool_start", "name": "read_page", "arguments": {}}
        )
        store.record("task", {"type": "tool_result", "name": "read_page", "result": {}})
        store.control("task", "pause")
        passed = threading.Event()
        worker = threading.Thread(
            target=lambda: (store.checkpoint("task"), passed.set())
        )
        worker.start()
        self.assertFalse(passed.wait(0.03))
        store.control("task", "resume")
        worker.join(1)
        self.assertTrue(passed.is_set())
        self.assertEqual(len(store.snapshot("task")["steps"]), 1)
        self.assertEqual(store.snapshot("task")["steps"][0]["phase"], "complete")

    def test_cancel_wakes_paused_task(self):
        store = TaskStore()
        store.start("task", "Goal")
        store.control("task", "pause")
        errors = []

        def check():
            try:
                store.checkpoint("task")
            except TaskCancelled:
                errors.append("cancelled")

        worker = threading.Thread(target=check)
        worker.start()
        store.control("task", "cancel")
        worker.join(1)
        self.assertEqual(errors, ["cancelled"])

    def test_concurrent_task_is_rejected(self):
        store = TaskStore()
        store.start("first", "Goal")
        with self.assertRaises(ValueError):
            store.start("second", "Other")


if __name__ == "__main__":
    unittest.main()
