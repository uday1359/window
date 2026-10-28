import json

import httpx
import pytest

from app.integrations import MAX_RESPONSE_BYTES, IntegrationError, auth_headers, build_rest_url, mcp_call, mcp_list_tools, parse_mcp_response, rest_call
from app.schemas import IntegrationConfig

REST = IntegrationConfig(name="weather", kind="REST", baseUrl="https://api.example.com", allowedPaths=["/v1/forecast"], authHeader="X-API-Key", secretRef="weather-key")
MCP = IntegrationConfig(name="tickets", kind="MCP", baseUrl="https://mcp.example.com/mcp", allowedTools=["create_ticket"], secretRef="mcp-key", authScheme="Bearer")
SECRETS = {"weather-key": "w-secret", "mcp-key": "m-secret"}


@pytest.mark.parametrize(
    "path",
    ["/v1/other", "/v1/forecast/../admin", "//evil.example/x", "/v1/forecastX", "https://evil.example/v1/forecast", "/v1/forecast/./x"],
)
def test_rest_paths_outside_the_allow_list_are_refused(path):
    with pytest.raises(IntegrationError) as err:
        build_rest_url(REST, path, None)
    assert err.value.code == "POLICY_DENIED"


def test_rest_url_keeps_host_and_encodes_query():
    assert build_rest_url(REST, "/v1/forecast/today", {"city": "Chennai & co"}) == "https://api.example.com/v1/forecast/today?city=Chennai+%26+co"


def test_plain_http_is_only_allowed_to_this_computer():
    with pytest.raises(IntegrationError):
        build_rest_url(REST.model_copy(update={"baseUrl": "http://api.example.com"}), "/v1/forecast", None)
    assert build_rest_url(REST.model_copy(update={"baseUrl": "http://127.0.0.1:9000"}), "/v1/forecast", None).startswith("http://127.0.0.1:9000/")


async def test_rest_call_sends_the_stored_secret_and_parses_json():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["key"] = request.headers.get("x-api-key")
        return httpx.Response(200, json={"temp": 31})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        res = await rest_call(REST, "GET", "/v1/forecast", {"city": "x"}, None, SECRETS.get, client)
    assert seen["key"] == "w-secret"
    assert res["ok"] and res["body"] == {"temp": 31} and res["untrusted"]


async def test_rest_redirects_and_oversized_responses_are_refused():
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(302, headers={"location": "https://evil.example/"}))) as client:
        with pytest.raises(IntegrationError, match="redirect"):
            await rest_call(REST, "GET", "/v1/forecast", None, None, SECRETS.get, client)
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, content=b"x" * (MAX_RESPONSE_BYTES + 1)))) as client:
        with pytest.raises(IntegrationError) as err:
            await rest_call(REST, "GET", "/v1/forecast", None, None, SECRETS.get, client)
    assert err.value.code == "TOO_LARGE"


def test_missing_secret_is_a_configuration_error():
    with pytest.raises(IntegrationError) as err:
        auth_headers(REST, {}.get)
    assert err.value.code == "INVALID_CONFIG"


def mcp_server(calls):
    """A minimal Streamable HTTP MCP server: SSE for initialize, JSON for the rest."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "DELETE":
            calls.append(("DELETE", request.headers.get("mcp-session-id")))
            return httpx.Response(200)
        msg = json.loads(request.content)
        calls.append((msg["method"], request.headers.get("authorization"), request.headers.get("mcp-session-id")))
        if msg["method"] == "initialize":
            body = "event: message\ndata: " + json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"protocolVersion": "2025-06-18", "capabilities": {}}}) + "\n\n"
            return httpx.Response(200, headers={"content-type": "text/event-stream", "mcp-session-id": "sess-1"}, content=body.encode())
        if msg["method"] == "notifications/initialized":
            return httpx.Response(202)
        if msg["method"] == "tools/list":
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": msg["id"], "result": {"tools": [{"name": "create_ticket", "description": "Create a ticket"}]}})
        if msg["method"] == "tools/call":
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": msg["id"], "result": {"content": [{"type": "text", "text": "Ticket 42 created"}], "isError": False}})
        return httpx.Response(400)

    return handler


async def test_mcp_tool_call_runs_a_full_session():
    calls = []
    async with httpx.AsyncClient(transport=httpx.MockTransport(mcp_server(calls))) as client:
        res = await mcp_call(MCP, "create_ticket", {"title": "Printer"}, SECRETS.get, client)
    assert res["text"] == "Ticket 42 created" and not res["isError"]
    assert [c[0] for c in calls] == ["initialize", "notifications/initialized", "tools/call", "DELETE"]
    assert calls[0][1] == "Bearer m-secret" and calls[2][2] == "sess-1"


async def test_mcp_tools_outside_the_allow_list_never_reach_the_server():
    calls = []
    async with httpx.AsyncClient(transport=httpx.MockTransport(mcp_server(calls))) as client:
        with pytest.raises(IntegrationError) as err:
            await mcp_call(MCP, "delete_everything", {}, SECRETS.get, client)
    assert err.value.code == "POLICY_DENIED" and calls == []


async def test_mcp_list_tools():
    async with httpx.AsyncClient(transport=httpx.MockTransport(mcp_server([]))) as client:
        assert await mcp_list_tools(MCP, SECRETS.get, client) == [{"name": "create_ticket", "description": "Create a ticket"}]


def test_mcp_error_responses_are_reported():
    with pytest.raises(IntegrationError, match="MCP error -32602"):
        parse_mcp_response("application/json", json.dumps({"jsonrpc": "2.0", "id": 3, "error": {"code": -32602, "message": "bad args"}}).encode(), 3)
