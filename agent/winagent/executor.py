"""Runs one operation safely: emergency stop, journal (idempotency), approval check, cancellation."""

from __future__ import annotations

import asyncio
import logging
import re
import threading
from pathlib import Path
from typing import Any, Awaitable, Callable

from . import ops_system
from .config import AgentConfig
from .errors import OpError
from .journal import Journal
from .ops_browser import BrowserOps
from .ops_desktop import DesktopOps
from .ops_files import FileOps

log = logging.getLogger("winagent.executor")

# Independently of the server, these operations are refused without an approval hash.
AGENT_APPROVAL_REQUIRED = {"file.delete", "browser.submit", "browser.click", "desktop.type_text"}
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
TYPE_CHUNK = 20


def stop_file(home: Path) -> Path:
    return home / "EMERGENCY_STOP"


class Executor:
    def __init__(self, cfg: AgentConfig, journal: Journal) -> None:
        self.cfg = cfg
        self.journal = journal
        self.home = cfg.home
        evidence = cfg.home / "evidence"
        self.files = FileOps(cfg.roots, cfg.home)
        self.browser = BrowserOps(cfg.roots, evidence, cfg.browser_channel, cfg.browser_headless, cfg.max_download_mb)
        self.desktop = DesktopOps(cfg.apps, evidence)
        self.server_stop = False
        self._lock = asyncio.Lock()
        self._running: dict[str, tuple[asyncio.Task, threading.Event]] = {}

    @property
    def stopped(self) -> bool:
        return self.server_stop or stop_file(self.home).exists()

    def _type_text(self, p: dict[str, Any], cancel: threading.Event) -> dict[str, Any]:
        text = p["text"]
        typed = 0
        for i in range(0, len(text), TYPE_CHUNK):
            if cancel.is_set() or self.stopped:
                raise OpError("CANCELLED", f"typing stopped after {typed} of {len(text)} characters")
            self.desktop.type_text({**p, "text": text[i : i + TYPE_CHUNK]})
            typed += len(text[i : i + TYPE_CHUNK])
        return {"titleContains": p["titleContains"], "typedChars": typed}

    def _handler(self, operation: str, task_id: str, cancel: threading.Event) -> Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]:
        def thread(fn: Callable[[dict[str, Any]], dict[str, Any]]):
            return lambda p: asyncio.to_thread(fn, p)

        table: dict[str, Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]] = {
            "file.write": thread(self.files.write),
            "file.read": thread(self.files.read),
            "file.stat": thread(self.files.stat),
            "file.list": thread(self.files.list),
            "file.mkdir": thread(self.files.mkdir),
            "file.copy": thread(self.files.copy),
            "file.move": thread(self.files.move),
            "file.delete": thread(self.files.delete),
            "browser.open": self.browser.open,
            "browser.search": self.browser.search,
            "browser.extract_text": self.browser.extract_text,
            "browser.research": self.browser.research,
            "browser.screenshot": lambda p: self.browser.screenshot(p, task_id),
            "browser.fill": self.browser.fill,
            "browser.click": self.browser.click,
            "browser.submit": self.browser.submit,
            "browser.download": self.browser.download,
            "desktop.list_windows": thread(self.desktop.list_windows),
            "desktop.launch_app": thread(self.desktop.launch_app),
            "desktop.read_window_text": thread(self.desktop.read_window_text),
            "desktop.type_text": thread(lambda p: self._type_text(p, cancel)),
            "desktop.screenshot": thread(lambda p: self.desktop.screenshot(p, task_id)),
            "desktop.ocr": thread(lambda p: self.desktop.ocr(p, task_id)),
            "system.resources": thread(lambda _p: ops_system.resources()),
        }
        if operation not in table:
            raise OpError("UNSUPPORTED", f"operation {operation!r} is not supported by this agent")
        return table[operation]

    async def execute(self, msg: dict[str, Any]) -> dict[str, Any]:
        op_id = str(msg.get("operationId", ""))
        operation = str(msg.get("operation", ""))
        params = msg.get("params") or {}
        task_id = re.sub(r"[^0-9a-f-]", "", str(msg.get("taskId", "unknown")))[:36] or "unknown"

        previous = self.journal.get(op_id)
        if previous is not None:
            # Duplicate delivery: never execute twice.
            if previous["state"] == "completed":
                return previous["result"]
            return {"ok": False, "code": "UNCERTAIN", "error": "this operation was already started and its outcome is unknown; it will not be repeated"}
        if self.stopped:
            return {"ok": False, "code": "EMERGENCY_STOP", "error": "emergency stop is active"}
        if operation in AGENT_APPROVAL_REQUIRED and not HASH_RE.match(str(msg.get("approvalHash") or "")):
            return {"ok": False, "code": "APPROVAL_MISMATCH", "error": "this operation requires an explicit approval"}
        if not isinstance(params, dict):
            return {"ok": False, "code": "INVALID_PARAMS", "error": "params must be an object"}

        cancel = threading.Event()
        async with self._lock:  # one action at a time: actions on the same desktop/browser must not interleave
            if self.stopped:
                return {"ok": False, "code": "EMERGENCY_STOP", "error": "emergency stop is active"}
            if not self.journal.start(op_id, operation):
                return {"ok": False, "code": "UNCERTAIN", "error": "duplicate operation id"}
            try:
                handler = self._handler(operation, task_id, cancel)
                task = asyncio.ensure_future(handler(params))
                self._running[op_id] = (task, cancel)
                output = await task
                result = {"ok": True, "output": output}
            except asyncio.CancelledError:
                result = {"ok": False, "code": "EMERGENCY_STOP" if self.stopped else "CANCELLED", "error": "operation was cancelled"}
            except OpError as exc:
                result = {"ok": False, "code": exc.code, "error": exc.message}
            except KeyError as exc:
                result = {"ok": False, "code": "INVALID_PARAMS", "error": f"missing parameter {exc.args[0]!r}"}
            except Exception as exc:  # noqa: BLE001 - every failure must be reported, not crash the agent
                log.exception("operation %s failed", operation)
                result = {"ok": False, "code": "ERROR", "error": f"{type(exc).__name__}: {str(exc)[:300]}"}
            finally:
                self._running.pop(op_id, None)
            self.journal.finish(op_id, operation, result)
            return result

    def cancel(self, op_id: str) -> bool:
        entry = self._running.get(op_id)
        if not entry:
            return False
        task, event = entry
        event.set()
        task.cancel()
        return True

    async def emergency_stop(self, active: bool) -> None:
        self.server_stop = active
        if active:
            for op_id in list(self._running):
                self.cancel(op_id)
            await self.browser.close()

    async def close(self) -> None:
        await self.browser.close()
