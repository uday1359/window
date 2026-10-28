"""Planning pipeline: deterministic rules first, then the routed model with fallbacks."""

from __future__ import annotations

import asyncio
import time
from typing import Awaitable, Callable
from urllib.parse import urlparse

import httpx

from .llm import ModelError, build_prompt, call_model
from .redaction import redact_for_cloud, redact_secrets
from .router import OFFLINE_REASON, estimate_complexity, route
from .rule_planner import rule_plan
from .schemas import ModelInfo, PlanRequest, PlanResponse, RoutingDecision


class NoModelAvailable(RuntimeError):
    """No permitted model could plan the request.

    ``retryable`` is True when the cause is temporary (a model is offline or unreachable), so
    the server can wait for connectivity and plan again instead of failing the task.
    """

    def __init__(self, message: str, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


ModelCaller = Callable[[ModelInfo, str, str, "str | None"], Awaitable[dict]]


class ConnectivityCache:
    """Caches provider reachability so offline detection is cheap."""

    def __init__(self, ttl_s: float = 30.0) -> None:
        self.ttl_s = ttl_s
        self._cache: dict[str, tuple[float, bool]] = {}

    def is_online(self, model: ModelInfo) -> bool:
        host = urlparse(model.endpoint).netloc
        hit = self._cache.get(host)
        if hit and time.monotonic() - hit[0] < self.ttl_s:
            return hit[1]
        try:
            httpx.head(model.endpoint, timeout=2.0)
            ok = True
        except httpx.HTTPError:
            ok = False
        self._cache[host] = (time.monotonic(), ok)
        return ok


async def make_plan(
    req: PlanRequest,
    get_secret: Callable[[str], "str | None"],
    caller: ModelCaller = call_model,  # type: ignore[assignment]
    is_online: Callable[[ModelInfo], bool] | None = None,
) -> PlanResponse:
    # With screenshots attached the user wants them considered, so the text-only rules are skipped.
    if not req.images:
        rules = rule_plan(req.instruction, req.roots, req.apps)
        if rules is not None:
            return PlanResponse(plan=rules, source="rules", routing=RoutingDecision(model=None, cloud=False, reason="Handled by deterministic rule planner; no model call"))

    complexity = estimate_complexity(req.instruction)
    online = is_online or ConnectivityCache().is_online
    loop = asyncio.get_running_loop()
    capability = "vision" if req.images else "planning"
    # Images cannot be redacted: under CLOUD_REDACTED they may only go to local models.
    eligible = [m for m in req.models if m.isLocal] if req.images and req.privacyLevel == "CLOUD_REDACTED" else req.models

    def _route(excluded: set[str]) -> RoutingDecision:
        remaining = [m for m in eligible if m.name not in excluded]
        return route(remaining, req.privacyLevel, complexity, capability, req.costLimitUsd, req.resources, online)

    warnings: list[str] = []
    tried: set[str] = set()
    while True:
        decision = await loop.run_in_executor(None, _route, tried)
        if decision.model is None:
            reason = decision.reason + (f"; tried: {', '.join(sorted(tried))}" if tried else "")
            offline = OFFLINE_REASON in decision.excluded.values() or any("unreachable" in w or "timed out" in w for w in warnings)
            raise NoModelAvailable(reason + "; " + "; ".join(f"{k}: {v}" for k, v in decision.excluded.items()), retryable=offline)
        model = next(m for m in req.models if m.name == decision.model)
        instruction = redact_secrets(req.instruction)
        redacted = instruction != req.instruction
        if not model.isLocal:
            # Hard privacy gate (defence in depth: routing already filtered LOCAL_ONLY).
            if req.privacyLevel == "LOCAL_ONLY":
                raise NoModelAvailable("privacy policy forbids cloud processing")
            instruction, changed = redact_for_cloud(req.instruction, req.privacyLevel)
            redacted = redacted or changed
        system, user = build_prompt(instruction, req.operations, req.roots, req.apps)
        api_key = get_secret(model.secretRef) if model.secretRef else None
        try:
            if req.images:
                plan = await caller(model, system, user, api_key, images=[(i.mediaType, i.data) for i in req.images])
            else:
                plan = await caller(model, system, user, api_key)
            decision.redacted = redacted
            return PlanResponse(plan=plan, source=f"model:{model.name}", routing=decision, warnings=warnings)
        except ModelError as exc:
            warnings.append(f"{model.name}: {exc}")
            tried.add(model.name)
