import tempfile
import unittest
from pathlib import Path

from memory_store import MemoryStore


class MemoryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / "data" / "memory.json"
        self.memory = MemoryStore(self.path)

    def test_reading_does_not_create_persistence(self):
        self.assertFalse(self.memory.view()["enabled"])
        self.assertEqual(self.memory.context(), "")
        self.assertFalse(self.path.exists())

    def test_explicit_save_is_readable_editable_and_deletable(self):
        data = {
            "enabled": True,
            "preferences": "Concise answers",
            "facts": ["Favorite color: blue"],
            "summaries": ["A reviewed recap"],
        }
        self.memory.update(data)
        self.assertEqual(self.memory.view(), data)
        self.assertIn("Favorite color", self.memory.context())
        self.memory.update({"enabled": False})
        self.assertFalse(self.path.exists())

    def test_invalid_values_are_not_persisted(self):
        with self.assertRaises(ValueError):
            self.memory.update({"enabled": True, "facts": ["x" * 4001]})
        self.assertFalse(self.path.exists())


if __name__ == "__main__":
    unittest.main()
