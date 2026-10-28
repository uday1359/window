"""DPAPI-protected secret store for cloud provider API keys.

Values never appear in MySQL, logs, API responses or model prompts. Only
secret names are listed.
"""

from __future__ import annotations

import base64
import json
import os
import re
import threading
from pathlib import Path

from . import dpapi

NAME_RE = re.compile(r"^[a-z0-9_-]{1,100}$")


class SecretStore:
    def __init__(self, path: Path, entropy: bytes = b"winagent-secrets") -> None:
        self.path = path
        self.entropy = entropy
        self._lock = threading.Lock()

    def _load(self) -> dict[str, str]:
        if not self.path.exists():
            return {}
        return json.loads(self.path.read_text(encoding="utf-8"))

    def _save(self, data: dict[str, str]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=0), encoding="utf-8")
        os.replace(tmp, self.path)  # atomic on the same volume

    def names(self) -> list[str]:
        with self._lock:
            return sorted(self._load().keys())

    def put(self, name: str, value: str) -> None:
        if not NAME_RE.match(name):
            raise ValueError("invalid secret name")
        blob = dpapi.protect(value.encode("utf-8"), self.entropy)
        with self._lock:
            data = self._load()
            data[name] = base64.b64encode(blob).decode("ascii")
            self._save(data)

    def get(self, name: str) -> str | None:
        with self._lock:
            encoded = self._load().get(name)
        if encoded is None:
            return None
        return dpapi.unprotect(base64.b64decode(encoded), self.entropy).decode("utf-8")

    def delete(self, name: str) -> bool:
        with self._lock:
            data = self._load()
            if name not in data:
                return False
            del data[name]
            self._save(data)
            return True
