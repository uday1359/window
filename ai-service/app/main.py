"""FastAPI entry point. Listens on 127.0.0.1 only; every /v1 route needs the service token."""

from __future__ import annotations

import hmac
import logging
import os
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from . import dpapi
from .integrations import IntegrationError, mcp_call, mcp_list_tools, rest_call
from .planner import NoModelAvailable, make_plan
from .redaction import redact_secrets
from .research import synthesize
from .router import route
from .schemas import McpCallRequest, McpToolsRequest, PlanRequest, PlanResponse, RestCallRequest, RouteRequest, RoutingDecision, SecretValue, SynthesizeRequest, SynthesizeResponse
from .secrets_store import NAME_RE, SecretStore

log = logging.getLogger("winagent.ai")


def _load_env_file() -> None:
    env = Path(__file__).resolve().parent.parent / ".env"
    if not env.exists() or os.environ.get("WINAGENT_SKIP_ENV_FILE"):
        return
    for line in env.read_text(encoding="utf-8-sig").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


_load_env_file()


def create_app(token: str | None = None, store: SecretStore | None = None) -> FastAPI:
    service_token = token or os.environ.get("AI_SERVICE_TOKEN", "")
    if len(service_token) < 32:
        raise RuntimeError("AI_SERVICE_TOKEN must be set (at least 32 characters)")
    secret_store = store or SecretStore(Path(os.environ.get("SECRET_STORE_PATH", "data/secrets.dpapi")))
    ollama_url = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")

    app = FastAPI(title="WinAgent AI service", version="1.0.0", docs_url=None, redoc_url=None, openapi_url=None)

    def require_token(x_service_token: str = Header(default="")) -> None:
        if not hmac.compare_digest(x_service_token.encode(), service_token.encode()):
            raise HTTPException(status_code=401, detail="invalid service token")

    @app.exception_handler(Exception)
    async def unhandled(_request: Request, exc: Exception) -> JSONResponse:
        log.error("unhandled error: %s", redact_secrets(f"{type(exc).__name__}: {exc}"))
        return JSONResponse(status_code=500, content={"detail": "internal error"})

    @app.get("/health")
    async def health() -> dict:
        ollama: dict = {"reachable": False, "models": []}
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                res = await client.get(f"{ollama_url}/api/tags")
                res.raise_for_status()
                ollama = {"reachable": True, "models": [m.get("name") for m in res.json().get("models", [])]}
        except httpx.HTTPError:
            pass
        return {"status": "ok", "ollama": ollama, "secretStore": "dpapi" if dpapi.available() else "unavailable", "ocr": False, "vision": False}

    @app.post("/v1/plan", response_model=PlanResponse, dependencies=[Depends(require_token)])
    async def plan(req: PlanRequest) -> PlanResponse:
        try:
            return await make_plan(req, secret_store.get)
        except NoModelAvailable as exc:
            raise HTTPException(status_code=503, detail={"message": str(exc), "retryable": exc.retryable}) from exc

    @app.post("/v1/route", response_model=RoutingDecision, dependencies=[Depends(require_token)])
    async def route_preview(req: RouteRequest) -> RoutingDecision:
        return route(req.models, req.privacyLevel, req.complexity, req.capability, req.costLimitUsd, req.resources)

    @app.post("/v1/research/synthesize", response_model=SynthesizeResponse, dependencies=[Depends(require_token)])
    async def research_synthesize(req: SynthesizeRequest) -> SynthesizeResponse:
        try:
            return await synthesize(req, secret_store.get)
        except NoModelAvailable as exc:
            raise HTTPException(status_code=503, detail={"message": str(exc), "retryable": exc.retryable}) from exc

    def integration_error(exc: IntegrationError) -> HTTPException:
        # Policy and configuration problems are the caller's; everything else is the remote side's.
        status = 400 if exc.code in ("POLICY_DENIED", "INVALID_CONFIG", "INVALID_PARAMS") else 502
        return HTTPException(status_code=status, detail={"message": str(exc), "code": exc.code})

    @app.post("/v1/integrations/rest", dependencies=[Depends(require_token)])
    async def integration_rest(req: RestCallRequest) -> dict:
        try:
            return await rest_call(req.integration, req.method, req.path, req.query, req.body, secret_store.get)
        except IntegrationError as exc:
            raise integration_error(exc) from exc

    @app.post("/v1/integrations/mcp/call", dependencies=[Depends(require_token)])
    async def integration_mcp_call(req: McpCallRequest) -> dict:
        try:
            return await mcp_call(req.integration, req.tool, req.arguments, secret_store.get)
        except IntegrationError as exc:
            raise integration_error(exc) from exc

    @app.post("/v1/integrations/mcp/tools", dependencies=[Depends(require_token)])
    async def integration_mcp_tools(req: McpToolsRequest) -> dict:
        try:
            return {"tools": await mcp_list_tools(req.integration, secret_store.get)}
        except IntegrationError as exc:
            raise integration_error(exc) from exc

    @app.get("/v1/secrets", dependencies=[Depends(require_token)])
    async def list_secrets() -> dict:
        return {"names": secret_store.names()}

    @app.put("/v1/secrets/{name}", dependencies=[Depends(require_token)])
    async def put_secret(name: str, body: SecretValue) -> dict:
        if not NAME_RE.match(name):
            raise HTTPException(status_code=400, detail="invalid secret name")
        if not dpapi.available():
            raise HTTPException(status_code=503, detail="DPAPI secret storage is unavailable on this platform")
        secret_store.put(name, body.value)
        return {"ok": True}

    @app.delete("/v1/secrets/{name}", dependencies=[Depends(require_token)])
    async def delete_secret(name: str) -> dict:
        if not NAME_RE.match(name):
            raise HTTPException(status_code=400, detail="invalid secret name")
        if not secret_store.delete(name):
            raise HTTPException(status_code=404, detail="secret not found")
        return {"ok": True}

    return app


def run() -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    host = os.environ.get("AI_HOST", "127.0.0.1")
    port = int(os.environ.get("AI_PORT", "8710"))
    uvicorn.run(create_app(), host=host, port=port, log_level="info", access_log=False)


if __name__ == "__main__":
    run()
