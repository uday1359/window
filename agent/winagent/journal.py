"""Idempotency journal: an operation id is executed at most once.

If the server re-sends an operation (after a timeout or reconnect) the recorded
result is returned instead of repeating the action; this prevents duplicate
external actions. The journal survives agent restarts.
"""

from __future__ import annotations

import json
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

MAX_ENTRIES = 2000


class Journal:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._entries: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        for line in self.path.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue  # a torn final line after a crash is ignored
            self._entries[rec["operationId"]] = rec
        # Operations that were "running" when the agent died have unknown outcomes.
        for rec in self._entries.values():
            if rec.get("state") == "running":
                rec["state"] = "interrupted"
        self._compact()

    def _compact(self) -> None:
        while len(self._entries) > MAX_ENTRIES:
            self._entries.popitem(last=False)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text("".join(json.dumps(r) + "\n" for r in self._entries.values()), encoding="utf-8")
        tmp.replace(self.path)

    def _append(self, rec: dict[str, Any]) -> None:
        self._entries[rec["operationId"]] = rec
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
            f.flush()
        if len(self._entries) > MAX_ENTRIES:
            self._compact()

    def get(self, operation_id: str) -> dict[str, Any] | None:
        with self._lock:
            return self._entries.get(operation_id)

    def start(self, operation_id: str, operation: str) -> bool:
        """Returns False if this operation id was already seen (do not execute again)."""
        with self._lock:
            if operation_id in self._entries:
                return False
            self._append({"operationId": operation_id, "operation": operation, "state": "running"})
            return True

    def finish(self, operation_id: str, operation: str, result: dict[str, Any]) -> None:
        with self._lock:
            self._append({"operationId": operation_id, "operation": operation, "state": "completed", "result": result})

    def status(self, operation_id: str) -> dict[str, Any]:
        rec = self.get(operation_id)
        if rec is None or rec["state"] == "interrupted":
            return {"state": "unknown"}
        if rec["state"] == "running":
            return {"state": "running"}
        return {"state": "completed", "result": rec["result"]}
