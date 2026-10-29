"""Explicitly scoped text-file tools and reviewed Markdown note writes."""

import hashlib
import os
import secrets
import stat
import threading
import time
from contextlib import contextmanager
from pathlib import Path

TEXT_SUFFIXES = {
    ".txt",
    ".md",
    ".csv",
    ".json",
    ".log",
    ".py",
    ".js",
    ".ts",
    ".html",
    ".css",
    ".yaml",
    ".yml",
    ".toml",
}
EXCLUDED = {".git", ".ssh", ".aws", ".venv", "node_modules", "__pycache__"}


class LocalFiles:
    def __init__(self):
        self.root = None
        self.root_fd = None
        self.drafts = {}
        self.lock = threading.RLock()

    def configure(self, folder):
        with self.lock:
            self.drafts.clear()
            if not folder:
                if self.root_fd is not None:
                    os.close(self.root_fd)
                self.root_fd = None
                self.root = None
                return {"enabled": False}
            root = Path(folder).expanduser().resolve(strict=True)
            if not root.is_dir():
                raise ValueError("Choose an existing folder")
            root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            if self.root_fd is not None:
                os.close(self.root_fd)
            self.root_fd = root_fd
            self.root = root
            return {"enabled": True, "folder": str(root)}

    def path(self, relative):
        if self.root is None:
            raise ValueError("No folder is enabled")
        if not isinstance(relative, str) or len(relative) > 300:
            raise ValueError("Invalid relative path")
        rel = Path(relative)
        if (
            rel.is_absolute()
            or not rel.parts
            or any(
                p in (".", "..") or p.startswith(".") or p in EXCLUDED
                for p in rel.parts
            )
        ):
            raise ValueError("Use a visible file inside the selected folder")
        if rel.suffix.lower() not in TEXT_SUFFIXES:
            raise ValueError("Only supported text files can be accessed")
        current = self.root
        for part in rel.parts:
            current = current / part
            if current.is_symlink():
                raise ValueError("Symbolic links are not allowed")
        current.resolve().relative_to(self.root)
        return current

    @contextmanager
    def parent_fd(self, relative):
        """Walk from the granted directory handle, never through symlinks."""
        with self.lock:
            self.path(relative)
            descriptor = os.dup(self.root_fd)
            try:
                parts = Path(relative).parts
                for part in parts[:-1]:
                    child = os.open(
                        part,
                        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                        dir_fd=descriptor,
                    )
                    os.close(descriptor)
                    descriptor = child
                yield descriptor, parts[-1]
            finally:
                os.close(descriptor)

    @staticmethod
    def read_at(directory, name, missing=False):
        try:
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        except FileNotFoundError:
            if missing:
                return None
            raise
        with os.fdopen(descriptor, "rb") as file:
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise ValueError("Only regular files can be read")
            if info.st_size > 512_000:
                raise ValueError("File exceeds the 512 KB text limit")
            data = file.read(512_001)
            if len(data) > 512_000:
                raise ValueError("File grew beyond the text limit")
            return data

    def list_files(self):
        if self.root is None:
            raise ValueError("No folder is enabled")
        result = []
        for parent, dirs, files in os.walk(self.root, followlinks=False):
            dirs[:] = [
                d
                for d in dirs
                if not d.startswith(".")
                and d not in EXCLUDED
                and not (Path(parent) / d).is_symlink()
            ]
            if len(Path(parent).relative_to(self.root).parts) >= 5:
                dirs.clear()
            for name in sorted(files):
                rel = str((Path(parent) / name).relative_to(self.root))
                try:
                    p = self.path(rel)
                except ValueError:
                    continue
                if p.is_file():
                    result.append({"path": rel, "bytes": p.stat().st_size})
                if len(result) >= 300:
                    return {"files": result, "truncated": True}
        return {"files": result, "truncated": False}

    def read_file(self, path):
        with self.parent_fd(path) as (directory, name):
            text = self.read_at(directory, name).decode("utf-8")
        return {"path": path, "text": text[:12_000], "truncated": len(text) > 12_000}

    def search_files(self, query):
        if not isinstance(query, str) or not 1 <= len(query) <= 200:
            raise ValueError("Search requires 1–200 characters")
        hits = []
        for item in self.list_files()["files"][:150]:
            try:
                text = self.read_file(item["path"])["text"]
            except (OSError, ValueError, UnicodeError):
                continue
            for number, line in enumerate(text.splitlines(), 1):
                if query.casefold() in line.casefold():
                    hits.append(
                        {"path": item["path"], "line": number, "text": line[:240]}
                    )
                if len(hits) >= 15:
                    return {"matches": hits, "truncated": True}
        return {"matches": hits, "truncated": False}

    def draft_note(self, path, content):
        with self.lock:
            p = self.path(path)
            if p.suffix.lower() != ".md":
                raise ValueError("Notes must be Markdown (.md)")
            if not isinstance(content, str) or not 1 <= len(content) <= 30_000:
                raise ValueError("Note must contain 1–30000 characters")
            if not p.parent.is_dir():
                raise ValueError("The note folder must already exist")
            with self.parent_fd(path) as (directory, name):
                before = self.read_at(directory, name, missing=True)
            if before is not None and len(before) > 512_000:
                raise ValueError("Existing note is too large")
            token = secrets.token_urlsafe(24)
            draft = {
                "id": token,
                "path": path,
                "content": content,
                "previous": before.decode("utf-8") if before is not None else None,
                "digest": (
                    hashlib.sha256(before).hexdigest() if before is not None else None
                ),
                "expires": time.monotonic() + 600,
            }
            self.drafts[token] = draft
            while len(self.drafts) > 20:
                self.drafts.pop(next(iter(self.drafts)))
            return {
                k: v for k, v in draft.items() if k not in ("digest", "expires")
            } | {"saved": False, "review_required": True}

    def decide(self, token, approved, content=None):
        with self.lock:
            draft = self.drafts.pop(token, None)
            if not draft or draft["expires"] < time.monotonic():
                raise ValueError("Draft expired or was already reviewed")
            if not approved:
                return {"saved": False}
            self.path(draft["path"])
            text = draft["content"] if content is None else content
            if not isinstance(text, str) or not 1 <= len(text) <= 30_000:
                raise ValueError("Invalid note content")
            with self.parent_fd(draft["path"]) as (directory, name):
                before = self.read_at(directory, name, missing=True)
                digest = (
                    hashlib.sha256(before).hexdigest() if before is not None else None
                )
                if digest != draft["digest"]:
                    raise ValueError(
                        "File changed since the preview; create a new draft"
                    )
                temporary = ".live-note-" + secrets.token_hex(16)
                try:
                    descriptor = os.open(
                        temporary,
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                        0o600,
                        dir_fd=directory,
                    )
                    with os.fdopen(descriptor, "w", encoding="utf-8") as file:
                        file.write(text)
                        file.flush()
                        os.fsync(file.fileno())
                    os.replace(
                        temporary, name, src_dir_fd=directory, dst_dir_fd=directory
                    )
                finally:
                    try:
                        os.unlink(temporary, dir_fd=directory)
                    except FileNotFoundError:
                        pass
            return {"saved": True, "path": draft["path"]}


FILES = LocalFiles()
