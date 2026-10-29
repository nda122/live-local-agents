import tempfile
import unittest
from pathlib import Path

from local_files import LocalFiles


class FileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.files = LocalFiles()
        self.files.configure(str(self.root))
        self.addCleanup(self.files.configure, "")

    def test_traversal_hidden_files_and_symlinks_are_rejected(self):
        (self.root / "visible.md").write_text("Hello")
        (self.root / "link.md").symlink_to(self.root / "visible.md")
        for path in ("../outside.md", "/tmp/secret.md", ".env", "link.md"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.files.read_file(path)

    def test_draft_does_not_write_until_reviewed(self):
        draft = self.files.draft_note("note.md", "Draft")
        self.assertFalse((self.root / "note.md").exists())
        self.files.decide(draft["id"], True, "Edited and approved")
        self.assertEqual((self.root / "note.md").read_text(), "Edited and approved")
        with self.assertRaises(ValueError):
            self.files.decide(draft["id"], True)

    def test_changed_file_invalidates_preview(self):
        p = self.root / "note.md"
        p.write_text("Before")
        draft = self.files.draft_note("note.md", "Replace")
        p.write_text("Changed outside app")
        with self.assertRaises(ValueError):
            self.files.decide(draft["id"], True)
        self.assertEqual(p.read_text(), "Changed outside app")

    def test_disable_access_revokes_drafts_and_reads(self):
        draft = self.files.draft_note("note.md", "Draft")
        self.files.configure("")
        with self.assertRaises(ValueError):
            self.files.decide(draft["id"], True)
        with self.assertRaises(ValueError):
            self.files.list_files()

    def test_search_is_scoped(self):
        (self.root / "readme.md").write_text("First\nNeedle here\nLast")
        self.assertEqual(self.files.search_files("needle")["matches"][0]["line"], 2)


if __name__ == "__main__":
    unittest.main()
