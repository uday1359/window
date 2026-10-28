"""Agent configuration.

The approved folders ("roots") and application allow list live ONLY in this local
file, editable by the Windows user. The server can never widen them.
"""

from __future__ import annotations

import json
import os
import re
import ssl
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

ROOT_NAME = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")


def agent_home() -> Path:
    override = os.environ.get("WINAGENT_AGENT_HOME")
    if override:
        return Path(override)
    return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "WinAgent"


def default_workspace() -> Path:
    return Path.home() / "Documents" / "WinAgentWorkspace"


DEFAULT_APPS = {
    "notepad": "notepad.exe",
    "calculator": "calc.exe",
    "paint": "mspaint.exe",
}


@dataclass
class AgentConfig:
    server_url: str = "http://127.0.0.1:3710"
    device_name: str = field(default_factory=lambda: os.environ.get("COMPUTERNAME", "windows-pc"))
    roots: dict[str, str] = field(default_factory=dict)
    apps: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_APPS))
    browser_channel: str = "msedge"
    browser_headless: bool = False
    max_download_mb: int = 50
    heartbeat_seconds: int = 15
    # PEM file of a CA (or self-signed server certificate) to trust for https:// servers, in
    # addition to the Windows defaults. Created by scripts\new-tls-cert.ps1.
    ca_file: str = ""

    @property
    def home(self) -> Path:
        return agent_home()

    def ssl_context(self) -> ssl.SSLContext | None:
        """TLS settings for https:// servers; None for local http://."""
        if urlparse(self.server_url).scheme != "https":
            return None
        ctx = ssl.create_default_context()
        if self.ca_file:
            ctx.load_verify_locations(cafile=self.ca_file)
        return ctx

    @property
    def ws_url(self) -> str:
        u = urlparse(self.server_url)
        scheme = "wss" if u.scheme == "https" else "ws"
        return f"{scheme}://{u.netloc}/ws/agent"

    def validate(self) -> None:
        u = urlparse(self.server_url)
        if u.scheme not in ("http", "https"):
            raise ValueError("server_url must be http(s)")
        if u.scheme == "http" and u.hostname not in ("127.0.0.1", "localhost", "::1"):
            # The device token must never travel unencrypted over a network.
            raise ValueError("Remote servers require https:// (TLS)")
        if self.ca_file and not Path(self.ca_file).is_file():
            raise ValueError(f"ca_file {self.ca_file!r} does not exist")
        for name, path in self.roots.items():
            if not ROOT_NAME.match(name):
                raise ValueError(f"invalid root name {name!r}")
            p = Path(path)
            if not p.is_absolute() or str(p).startswith("\\\\"):
                raise ValueError(f"root {name!r} must be an absolute local path")
        for name in self.apps:
            if not ROOT_NAME.match(name):
                raise ValueError(f"invalid app name {name!r}")


def config_path() -> Path:
    return agent_home() / "agent-config.json"


def load_config() -> AgentConfig:
    path = config_path()
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        cfg = AgentConfig(**{k: v for k, v in data.items() if k in AgentConfig.__dataclass_fields__})
    else:
        ws = default_workspace()
        cfg = AgentConfig(roots={"workspace": str(ws), "test": str(ws / "test")})
        save_config(cfg)
    cfg.validate()
    for p in cfg.roots.values():
        Path(p).mkdir(parents=True, exist_ok=True)
    return cfg


def save_config(cfg: AgentConfig) -> None:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {k: getattr(cfg, k) for k in AgentConfig.__dataclass_fields__}
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
