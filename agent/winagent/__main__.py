"""Command line: pair | run | status | estop | estop-clear | config."""

from __future__ import annotations

import argparse
import asyncio
import ctypes
import json
import logging
import socket
import sys
import urllib.error
import urllib.request

from . import token_store
from .client import AgentClient
from .config import config_path, load_config, save_config
from .executor import stop_file


def is_elevated() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())  # type: ignore[attr-defined]
    except (AttributeError, OSError):
        return False


def cmd_pair(args: argparse.Namespace) -> int:
    cfg = load_config()
    if args.server or args.ca_file:
        if args.server:
            cfg.server_url = args.server.rstrip("/")
        if args.ca_file:
            cfg.ca_file = args.ca_file
        cfg.validate()
        save_config(cfg)
    body = json.dumps({"code": args.code.strip().upper(), "name": args.name or cfg.device_name, "hostname": socket.gethostname()}).encode()
    req = urllib.request.Request(f"{cfg.server_url}/api/agents/pair", data=body, method="POST", headers={"content-type": "application/json", "x-winagent-csrf": "1"})  # noqa: S310 - URL validated above
    try:
        with urllib.request.urlopen(req, timeout=15, context=cfg.ssl_context()) as res:  # noqa: S310
            data = json.loads(res.read())
    except urllib.error.HTTPError as exc:
        print(f"Pairing failed: HTTP {exc.code} {json.loads(exc.read() or b'{}').get('message', '')}", file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        print(f"Pairing failed: server unreachable ({exc.reason})", file=sys.stderr)
        return 1
    token_store.save(cfg.home, data["deviceId"], data["token"])
    print(f"Paired as device {data['deviceId']}. Token stored with Windows DPAPI at {token_store.token_path(cfg.home)}")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    if is_elevated() and not args.allow_elevated:
        print("Refusing to run elevated (Administrator). Run the agent as a normal user, or pass --allow-elevated.", file=sys.stderr)
        return 2
    cfg = load_config()
    if args.headless:
        cfg.browser_headless = True
    creds = token_store.load(cfg.home)
    if not creds:
        print("Not paired. Create a pairing code in the dashboard (Agent Devices) and run: python -m winagent pair --code <CODE>", file=sys.stderr)
        return 1
    print(f"Agent home: {cfg.home}\nApproved folders: {json.dumps(cfg.roots, indent=2)}\nAllowed apps: {', '.join(cfg.apps)}")
    try:
        asyncio.run(AgentClient(cfg, creds[1]).run_forever())
    except KeyboardInterrupt:
        pass
    return 0


def cmd_status(_args: argparse.Namespace) -> int:
    cfg = load_config()
    creds = token_store.load(cfg.home)
    status = {
        "config": str(config_path()),
        "server": cfg.server_url,
        "paired": bool(creds),
        "deviceId": creds[0] if creds else None,
        "roots": cfg.roots,
        "apps": cfg.apps,
        "emergencyStopFile": stop_file(cfg.home).exists(),
    }
    print(json.dumps(status, indent=2))
    return 0


def cmd_estop(args: argparse.Namespace) -> int:
    cfg = load_config()
    path = stop_file(cfg.home)
    if args.clear:
        path.unlink(missing_ok=True)
        print("Local emergency stop cleared.")
    else:
        path.write_text("stop", encoding="utf-8")
        print(f"Local emergency stop ACTIVE ({path}). Running operations are cancelled; new ones are refused.")
    return 0


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    parser = argparse.ArgumentParser(prog="winagent", description="WinAgent local Windows agent")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("pair", help="pair this computer using a one-time code from the dashboard")
    p.add_argument("--code", required=True)
    p.add_argument("--server", help="server URL; remote servers must use https://")
    p.add_argument("--ca-file", help="PEM certificate to trust for a self-signed https:// server")
    p.add_argument("--name")
    p.set_defaults(fn=cmd_pair)
    r = sub.add_parser("run", help="connect to the server and execute authorised operations")
    r.add_argument("--allow-elevated", action="store_true")
    r.add_argument("--headless", action="store_true", help="run the automated browser without a window")
    r.set_defaults(fn=cmd_run)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    e = sub.add_parser("estop", help="local emergency stop (works without the server)")
    e.add_argument("--clear", action="store_true")
    e.set_defaults(fn=cmd_estop)
    args = parser.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
