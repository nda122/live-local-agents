import threading
import time
import unittest
from unittest.mock import Mock

from browser_control import BrowserControl


class ApprovalTests(unittest.TestCase):
    def setUp(self):
        self.browser = BrowserControl()
        self.browser.state = {
            "url": "https://example.com/",
            "revision": 1,
            "screenshot": "",
            "targets": [{"target": 1, "label": "Demo button"}],
        }
        self.browser.command = Mock(
            return_value={"url": "https://example.com/", "targets": []}
        )
        self.events = []
        self.requested = threading.Event()
        self.output = []

    def start_action(self, seconds=3):
        def emit(event):
            self.events.append(event)
            if event["type"] == "approval_required":
                self.requested.set()

        def run():
            try:
                self.output.append(
                    self.browser.action(
                        {"action": "click", "target": 1, "reason": "Demo"},
                        emit,
                        time.monotonic() + seconds,
                    )
                )
            except Exception as error:
                self.output.append(error)

        self.thread = threading.Thread(target=run)
        self.thread.start()
        self.assertTrue(self.requested.wait(1))
        self.token = self.events[0]["id"]

    def test_approval_is_required_and_one_use(self):
        self.start_action()
        self.browser.command.assert_not_called()
        self.browser.decide(self.token, True)
        self.thread.join(2)
        self.assertFalse(self.thread.is_alive())
        self.browser.command.assert_called_once()
        with self.assertRaises(ValueError):
            self.browser.decide(self.token, True)

    def test_reject_never_executes(self):
        self.start_action()
        self.browser.decide(self.token, False)
        self.thread.join(2)
        self.browser.command.assert_not_called()
        self.assertTrue(self.output[0]["cancelled"])

    def test_stop_cancels_waiting_action(self):
        self.start_action()
        self.browser.cancel()
        self.thread.join(2)
        self.browser.command.assert_not_called()
        self.assertTrue(self.output[0]["cancelled"])

    def test_expiry_never_executes(self):
        self.start_action(0.03)
        self.thread.join(2)
        self.browser.command.assert_not_called()
        self.assertIsInstance(self.output[0], TimeoutError)

    def test_unknown_target_rejected(self):
        with self.assertRaises(ValueError):
            self.browser.action(
                {"action": "click", "target": 99},
                self.events.append,
                time.monotonic() + 1,
            )
        self.browser.command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
