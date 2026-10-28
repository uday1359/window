"""File operations, confined to the configured roots."""

from __future__ import annotations

import hashlib
import os
import shutil
import time
from pathlib import Path
from typing import Any

from .errors import OpError
from .paths import ensure_not_executable, resolve

MAX_READ = 1024 * 1024
MAX_HASH = 50 * 1024 * 1024
MAX_LIST = 500


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


class FileOps:
    def __init__(self, roots: dict[str, str], home: Path) -> None:
        self.roots = roots
        self.backup_dir = home / "backups"
        self.quarantine_dir = home / "quarantine"

    def _backup(self, path: Path, folder: Path) -> str:
        """Preserves the original before a risky change; returns the backup location."""
        stamp = time.strftime("%Y%m%d-%H%M%S")
        dest = folder / stamp / path.name
        n = 1
        while dest.exists():
            dest = folder / stamp / f"{n}-{path.name}"
            n += 1
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, dest)
        return str(dest)

    def write(self, p: dict[str, Any]) -> dict[str, Any]:
        ensure_not_executable(p["path"])
        content = p["content"]
        if not isinstance(content, str):
            raise OpError("INVALID_PARAMS", "content must be text")
        data = content.encode("utf-8")
        target = resolve(self.roots, p["root"], p["path"])
        expected = hashlib.sha256(data).hexdigest()
        backup = None
        if target.exists():
            if not target.is_file():
                raise OpError("ALREADY_EXISTS", "a folder with that name already exists")
            if sha256_file(target) == expected:
                # Same content already present (e.g. a re-run after interruption): nothing to do.
                return {"root": p["root"], "path": p["path"], "absolutePath": str(target), "size": len(data), "sha256": expected, "created": False, "alreadyPresent": True}
            if not p.get("overwrite"):
                raise OpError("ALREADY_EXISTS", f"{p['path']} already exists; set overwrite to replace it")
            backup = self._backup(target, self.backup_dir)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(f".{target.name}.winagent-tmp")
        with tmp.open("wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, target)  # atomic: readers never see a half-written file
        actual = sha256_file(target)
        if actual != expected:
            raise OpError("VERIFICATION_FAILED", "written file does not match the requested content")
        return {"root": p["root"], "path": p["path"], "absolutePath": str(target), "size": len(data), "sha256": actual, "created": backup is None, "backupPath": backup}

    def read(self, p: dict[str, Any]) -> dict[str, Any]:
        target = resolve(self.roots, p["root"], p["path"])
        if not target.is_file():
            raise OpError("NOT_FOUND", f"{p['path']} does not exist")
        limit = min(int(p.get("maxBytes") or MAX_READ), MAX_READ)
        size = target.stat().st_size
        if size > limit:
            raise OpError("TOO_LARGE", f"file is {size} bytes; limit is {limit}")
        raw = target.read_bytes()
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise OpError("INVALID_ENCODING", "file is not valid UTF-8 text") from exc
        return {"root": p["root"], "path": p["path"], "content": content, "size": size, "sha256": hashlib.sha256(raw).hexdigest(), "hasBom": raw.startswith(b"\xef\xbb\xbf")}

    def stat(self, p: dict[str, Any]) -> dict[str, Any]:
        target = resolve(self.roots, p["root"], p["path"])
        if not target.exists():
            return {"exists": False, "isFile": False}
        st = target.stat()
        out: dict[str, Any] = {"exists": True, "isFile": target.is_file(), "size": st.st_size, "modified": st.st_mtime}
        if target.is_file() and st.st_size <= MAX_HASH:
            out["sha256"] = sha256_file(target)
        return out

    def list(self, p: dict[str, Any]) -> dict[str, Any]:
        target = resolve(self.roots, p["root"], p.get("path") or "")
        if not target.is_dir():
            raise OpError("NOT_FOUND", "folder does not exist")
        entries = []
        for i, entry in enumerate(sorted(target.iterdir(), key=lambda e: e.name.lower())):
            if i >= MAX_LIST:
                break
            if entry.name.endswith(".winagent-tmp"):
                continue
            entries.append({"name": entry.name, "type": "dir" if entry.is_dir() else "file", "size": entry.stat().st_size if entry.is_file() else None})
        return {"root": p["root"], "path": p.get("path") or "", "entries": entries, "truncated": len(entries) >= MAX_LIST}

    def mkdir(self, p: dict[str, Any]) -> dict[str, Any]:
        target = resolve(self.roots, p["root"], p["path"])
        if target.exists() and not target.is_dir():
            raise OpError("ALREADY_EXISTS", "a file with that name exists")
        created = not target.exists()
        target.mkdir(parents=True, exist_ok=True)
        return {"root": p["root"], "path": p["path"], "created": created}

    def copy(self, p: dict[str, Any]) -> dict[str, Any]:
        ensure_not_executable(p["destPath"])
        src = resolve(self.roots, p["root"], p["path"])
        dest = resolve(self.roots, p["destRoot"], p["destPath"])
        if not src.is_file():
            raise OpError("NOT_FOUND", "source file does not exist")
        backup = None
        if dest.exists():
            if dest.is_file() and sha256_file(dest) == sha256_file(src):
                return {"destPath": p["destPath"], "sha256": sha256_file(dest), "alreadyPresent": True}
            if not p.get("overwrite"):
                raise OpError("ALREADY_EXISTS", "destination exists")
            backup = self._backup(dest, self.backup_dir)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        return {"destPath": p["destPath"], "absolutePath": str(dest), "sha256": sha256_file(dest), "backupPath": backup}

    def move(self, p: dict[str, Any]) -> dict[str, Any]:
        ensure_not_executable(p["destPath"])
        src = resolve(self.roots, p["root"], p["path"])
        dest = resolve(self.roots, p["destRoot"], p["destPath"])
        if not src.is_file():
            raise OpError("NOT_FOUND", "source file does not exist")
        if dest.exists():
            raise OpError("ALREADY_EXISTS", "destination exists")
        backup = self._backup(src, self.backup_dir)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dest))
        return {"destPath": p["destPath"], "absolutePath": str(dest), "sha256": sha256_file(dest), "backupPath": backup}

    def delete(self, p: dict[str, Any]) -> dict[str, Any]:
        target = resolve(self.roots, p["root"], p["path"])
        if not target.is_file():
            raise OpError("NOT_FOUND", "file does not exist")
        # Never destroy data: move to quarantine so the user can recover it.
        kept = self._backup(target, self.quarantine_dir)
        target.unlink()
        return {"root": p["root"], "path": p["path"], "quarantinedTo": kept}
