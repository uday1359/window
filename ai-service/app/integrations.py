"""Calls to administrator-approved external integrations (FR-17).

The server decides *whether* a call may happen (policy, approvals). This module performs it
because the credentials live in this service's DPAPI store. It still re-checks the limits it
is given, as defence in depth:
  - only https://, or http:// to this computer
  - REST paths must start with an allowed prefix, and the final URL must stay on the base host
  - MCP tools must be in the allowed list; only the Streamable HTTP transport is supported
    (an integration never starts a local program)
  - no redirects (they could leave the approved host), 30 s timeout, 1 MB response cap
Responses are untrusted data.
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable
from urllib.parse import urlencode, urlparse

import httpx

from .schemas import IntegrationConfig

TIMEOUT_S = 30.0
MAX_RESPONSE_BYTES = 1_000_000
MCP_PROTOCOL_VERSION = "2025-06-18"
_PATH = re.compile(r"^/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$")
LOOPBACK = {"127.0.0.1", "localhost", "::1"}


class IntegrationError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def check_base_url(base_url: str) -> None:
    u = urlparse(base_url)
    if u.scheme == "https" or (u.scheme == "http" and u.hostname in LOOPBACK):
        if u.username or u.password:
            raise IntegrationError("INVALID_CONFIG", "credentials must not be embedded in the URL")
        return
    raise IntegrationError("INVALID_CONFIG", "integrations must use https:// (or http:// to this computer)")


def build_rest_url(cfg: IntegrationConfig, path: str, query: dict[str, Any] | None) -> str:
    check_base_url(cfg.baseUrl)
    if not _PATH.match(path) or "//" in path or "/../" in f"{path}/" or "/./" in f"{path}/":
        raise IntegrationError("POLICY_DENIED", "path must be a plain absolute path without '..' or '//'")
    if not any(path == p or path.startswith(p.rstrip("/") + "/") for p in cfg.allowedPaths):
        raise IntegrationError("POLICY_DENIED", f"path {path!r} is not allowed for integration {cfg.name!r}")
    url = cfg.baseUrl.rstrip("/") + path
    if urlparse(url).netloc != urlparse(cfg.baseUrl).netloc:
        raise IntegrationError("POLICY_DENIED", "path must not change the integration host")
    if query:
        url += "?" + urlencode({k: str(v) for k, v in query.items()})
    return url


def auth_headers(cfg: IntegrationConfig, get_secret: Callable[[str], "str | None"]) -> dict[str, str]:
    if not cfg.secretRef:
        return {}
    secret = get_secret(cfg.secretRef)
    if not secret:
        raise IntegrationError("INVALID_CONFIG", f"secret {cfg.secretRef!r} is not stored")
    value = f"{cfg.authScheme} {secret}" if cfg.authScheme else secret
    return {cfg.authHeader or "Authorization": value}


async def _read_limited(res: httpx.Response) -> bytes:
    chunks, size = [], 0
    async for chunk in res.aiter_bytes():
        size += len(chunk)
        if size > MAX_RESPONSE_BYTES:
            raise IntegrationError("TOO_LARGE", "response exceeds 1 MB")
        chunks.append(chunk)
    return b"".join(chunks)


def _client(client: httpx.AsyncClient | None) -> tuple[httpx.AsyncClient, bool]:
    if client is not None:
        return client, False
    return httpx.AsyncClient(timeout=TIMEOUT_S, follow_redirects=False), True


async def rest_call(
    cfg: IntegrationConfig, method: str, path: str, query: dict[str, Any] | None, body: Any, get_secret: Callable[[str], "str | None"], client: httpx.AsyncClient | None = None
) -> dict[str, Any]:
    if cfg.kind != "REST":
        raise IntegrationError("INVALID_PARAMS", f"{cfg.name!r} is not a REST integration")
    url = build_rest_url(cfg, path, query)
    headers = {"accept": "application/json", **auth_headers(cfg, get_secret)}
    http, own = _client(client)
    try:
        async with http.stream(method, url, headers=headers, json=body if method == "POST" else None) as res:
            if 300 <= res.status_code < 400:
                raise IntegrationError("POLICY_DENIED", "the integration tried to redirect; redirects are not followed")
            raw = await _read_limited(res)
            content_type = res.headers.get("content-type", "")
            status = res.status_code
    except httpx.TimeoutException as exc:
        raise IntegrationError("TIMEOUT", "integration did not respond in time") from exc
    except httpx.HTTPError as exc:
        raise IntegrationError("UNREACHABLE", f"integration unreachable ({type(exc).__name__})") from exc
    finally:
        if own:
            await http.aclose()
    text = raw.decode("utf-8", "replace")
    data: Any = text
    if "json" in content_type:
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            pass
    return {"status": status, "ok": 200 <= status < 300, "contentType": content_type[:100], "body": data, "untrusted": True}


# ---------------------------------------------------------------- MCP (Streamable HTTP)


def parse_mcp_response(content_type: str, raw: bytes, request_id: int) -> dict[str, Any]:
    """Finds the JSON-RPC response with request_id in a JSON or text/event-stream body."""
    text = raw.decode("utf-8", "replace")
    messages: list[Any] = []
    if "text/event-stream" in content_type:
        for event in re.split(r"\r?\n\r?\n", text):
            data = "\n".join(line[5:].lstrip() for line in event.splitlines() if line.startswith("data:"))
            if data:
                try:
                    messages.append(json.loads(data))
                except json.JSONDecodeError:
                    continue
    else:
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            raise IntegrationError("PROTOCOL", "MCP server returned invalid JSON") from exc
        messages = parsed if isinstance(parsed, list) else [parsed]
    for m in messages:
        if isinstance(m, dict) and m.get("id") == request_id:
            if "error" in m:
                err = m["error"] if isinstance(m["error"], dict) else {}
                raise IntegrationError("REMOTE_ERROR", f"MCP error {err.get('code')}: {str(err.get('message'))[:300]}")
            return m.get("result") or {}
    raise IntegrationError("PROTOCOL", "MCP server sent no response for the request")


class _McpSession:
    def __init__(self, cfg: IntegrationConfig, get_secret: Callable[[str], "str | None"], http: httpx.AsyncClient) -> None:
        check_base_url(cfg.baseUrl)
        self.url = cfg.baseUrl
        self.http = http
        self.headers = {"accept": "application/json, text/event-stream", "content-type": "application/json", **auth_headers(cfg, get_secret)}
        self.next_id = 1

    async def _post(self, payload: dict[str, Any]) -> httpx.Response:
        try:
            res = await self.http.post(self.url, headers=self.headers, content=json.dumps(payload))
        except httpx.TimeoutException as exc:
            raise IntegrationError("TIMEOUT", "MCP server did not respond in time") from exc
        except httpx.HTTPError as exc:
            raise IntegrationError("UNREACHABLE", f"MCP server unreachable ({type(exc).__name__})") from exc
        if 300 <= res.status_code < 400:
            raise IntegrationError("POLICY_DENIED", "the MCP server tried to redirect; redirects are not followed")
        if len(res.content) > MAX_RESPONSE_BYTES:
            raise IntegrationError("TOO_LARGE", "response exceeds 1 MB")
        return res

    async def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        request_id = self.next_id
        self.next_id += 1
        res = await self._post({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        if res.status_code >= 400:
            raise IntegrationError("REMOTE_ERROR", f"MCP server returned HTTP {res.status_code}")
        return parse_mcp_response(res.headers.get("content-type", ""), res.content, request_id)

    async def __aenter__(self) -> "_McpSession":
        res = await self._post(
            {"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {}, "clientInfo": {"name": "winagent", "version": "1.0.0"}}}
        )
        if res.status_code >= 400:
            raise IntegrationError("REMOTE_ERROR", f"MCP initialize failed with HTTP {res.status_code}")
        init = parse_mcp_response(res.headers.get("content-type", ""), res.content, 0)
        session = res.headers.get("mcp-session-id")
        if session:
            self.headers["mcp-session-id"] = session
        self.headers["mcp-protocol-version"] = str(init.get("protocolVersion") or MCP_PROTOCOL_VERSION)
        await self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return self

    async def __aexit__(self, *_exc: object) -> None:
        if "mcp-session-id" in self.headers:
            try:
                await self.http.delete(self.url, headers=self.headers)
            except httpx.HTTPError:
                pass  # best effort: the server expires idle sessions


async def mcp_call(
    cfg: IntegrationConfig, tool: str, arguments: dict[str, Any], get_secret: Callable[[str], "str | None"], client: httpx.AsyncClient | None = None
) -> dict[str, Any]:
    if cfg.kind != "MCP":
        raise IntegrationError("INVALID_PARAMS", f"{cfg.name!r} is not an MCP integration")
    if tool not in cfg.allowedTools:
        raise IntegrationError("POLICY_DENIED", f"tool {tool!r} is not allowed for integration {cfg.name!r}")
    http, own = _client(client)
    try:
        async with _McpSession(cfg, get_secret, http) as session:
            result = await session.request("tools/call", {"name": tool, "arguments": arguments})
    finally:
        if own:
            await http.aclose()
    content = result.get("content") if isinstance(result.get("content"), list) else []
    text = "\n".join(str(c.get("text", "")) for c in content if isinstance(c, dict) and c.get("type") == "text")
    return {"tool": tool, "isError": bool(result.get("isError")), "text": text[:50_000], "structured": result.get("structuredContent"), "untrusted": True}


async def mcp_list_tools(cfg: IntegrationConfig, get_secret: Callable[[str], "str | None"], client: httpx.AsyncClient | None = None) -> list[dict[str, Any]]:
    """Used by administrators to see which tools a server offers before allowing any."""
    http, own = _client(client)
    try:
        async with _McpSession(cfg, get_secret, http) as session:
            result = await session.request("tools/list", {})
    finally:
        if own:
            await http.aclose()
    tools = result.get("tools") if isinstance(result.get("tools"), list) else []
    return [{"name": str(t.get("name")), "description": str(t.get("description", ""))[:500]} for t in tools if isinstance(t, dict) and t.get("name")]
