"""Device token persistence, encrypted with DPAPI for the current Windows user."""

from __future__ import annotations

import json
from pathlib import Path

from . import dpapi

ENTROPY = b"winagent-device-token"


def token_path(home: Path) -> Path:
    return home / "device-token.dpapi"


def save(home: Path, device_id: str, token: str) -> None:
    home.mkdir(parents=True, exist_ok=True)
    blob = dpapi.protect(json.dumps({"deviceId": device_id, "token": token}).encode("utf-8"), ENTROPY)
    token_path(home).write_bytes(blob)


def load(home: Path) -> tuple[str, str] | None:
    path = token_path(home)
    if not path.exists():
        return None
    data = json.loads(dpapi.unprotect(path.read_bytes(), ENTROPY).decode("utf-8"))
    return data["deviceId"], data["token"]


def clear(home: Path) -> None:
    token_path(home).unlink(missing_ok=True)
