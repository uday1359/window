"""Authenticated, outbound-only WebSocket connection to the WinAgent server."""

from __future__ import annotations

import asyncio
import json
import logging
import platform
import socket
from typing import Any

import websockets
from websockets.exceptions import ConnectionClosed, InvalidStatus

from . import __version__, ops_system, token_store
from .config import AgentConfig
from .executor import Executor, stop_file
from .journal import Journal

log = logging.getLogger("winagent.client")
MAX_BACKOFF_S = 30


class RevokedError(RuntimeError):
    pass


class AgentClient:
    def __init__(self, cfg: AgentConfig, token: str) -> None:
        self.cfg = cfg
        self.token = token
        self.executor = Executor(cfg, Journal(cfg.home / "journal.jsonl"))
        self._ws: Any = None
        self._send_lock = asyncio.Lock()

    async def _send(self, msg: dict[str, Any]) -> None:
        async with self._send_lock:
            if self._ws is not None:
                await self._ws.send(json.dumps(msg))

    def _hello(self) -> dict[str, Any]:
        from .ops_browser import BrowserOps  # noqa: F401 - import check only

        try:
            import pywinauto  # noqa: F401

            uia = True
        except ImportError:
            uia = False
        return {
            "type": "hello",
            "agentVersion": __version__,
            "hostname": socket.gethostname()[:255],
            "osVersion": f"{platform.system()} {platform.version()}"[:100],
            "roots": sorted(self.cfg.roots),
            "apps": sorted(self.cfg.apps),
            "capabilities": {"files": True, "browser": True, "uia": uia, "screenshots": True, "ocr": True},
        }

    async def _heartbeat(self) -> None:
        while True:
            try:
                res = await asyncio.to_thread(ops_system.resources)
            except Exception:  # noqa: BLE001
                res = None
            await self._send({"type": "heartbeat", "resources": res, "emergencyStop": self.executor.stopped})
            await asyncio.sleep(self.cfg.heartbeat_seconds)

    async def _watch_stop_file(self) -> None:
        """A local EMERGENCY_STOP file halts the agent even if the server is unreachable."""
        while True:
            if stop_file(self.cfg.home).exists():
                for op_id in list(self.executor._running):
                    self.executor.cancel(op_id)
            await asyncio.sleep(1)

    async def _run_op(self, msg: dict[str, Any]) -> None:
        result = await self.executor.execute(msg)
        await self._send({"type": "op_result", "operationId": msg.get("operationId"), **result})

    async def _handle(self, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return
        kind = msg.get("type")
        if kind == "op":
            log.info("operation %s (%s)", msg.get("operation"), msg.get("operationId"))
            asyncio.ensure_future(self._run_op(msg))
        elif kind == "cancel":
            self.executor.cancel(str(msg.get("operationId")))
        elif kind == "op_status":
            op_id = str(msg.get("operationId"))
            await self._send({"type": "op_status_result", "operationId": op_id, **self.executor.journal.status(op_id)})
        elif kind == "emergency_stop":
            active = bool(msg.get("active"))
            log.warning("emergency stop %s by server", "ACTIVATED" if active else "cleared")
            await self.executor.emergency_stop(active)
        elif kind == "revoked":
            raise RevokedError(str(msg.get("reason", "revoked")))

    async def run_once(self) -> None:
        headers = {"Authorization": f"Bearer {self.token}"}
        async with websockets.connect(self.cfg.ws_url, additional_headers=headers, max_size=8 * 1024 * 1024, open_timeout=10, ssl=self.cfg.ssl_context()) as ws:
            self._ws = ws
            log.info("connected to %s", self.cfg.ws_url)
            await self._send(self._hello())
            background = [asyncio.ensure_future(self._heartbeat()), asyncio.ensure_future(self._watch_stop_file())]
            try:
                async for raw in ws:
                    await self._handle(raw if isinstance(raw, str) else raw.decode())
            finally:
                for t in background:
                    t.cancel()
                self._ws = None

    async def run_forever(self) -> None:
        backoff = 1
        try:
            while True:
                try:
                    await self.run_once()
                    backoff = 1
                except RevokedError as exc:
                    log.error("device access revoked by server (%s); clearing token", exc)
                    token_store.clear(self.cfg.home)
                    return
                except InvalidStatus as exc:
                    if exc.response.status_code == 401:
                        log.error("server rejected the device token (revoked?). Pair again with: python -m winagent pair")
                        return
                    log.warning("connection refused: HTTP %s", exc.response.status_code)
                except (OSError, ConnectionClosed, asyncio.TimeoutError) as exc:
                    log.warning("connection lost (%s); retrying in %ss", type(exc).__name__, backoff)
                await asyncio.sleep(backoff)
                backoff = min(MAX_BACKOFF_S, backoff * 2)
        finally:
            await self.executor.close()
