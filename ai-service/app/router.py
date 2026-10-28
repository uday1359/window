"""Hybrid model routing: complexity, privacy, capability, latency, cost and resources."""

from __future__ import annotations

import re
from typing import Any, Callable

from .schemas import ModelInfo, RoutingDecision

EST_TOKENS_PER_PLAN = 1500
LOW_MEMORY_MB = 1500
LOW_BATTERY_PERCENT = 20
# Exclusion reason that means "try again later": the planner reports such failures as retryable.
OFFLINE_REASON = "offline / provider unreachable"

_MULTI_STEP = re.compile(r"\b(then|after that|and then|afterwards|finally|next)\b|;", re.I)
_HARD = re.compile(r"\b(compare|analy[sz]e|summari[sz]e|research|reconcile|spreadsheet|report|multiple|every|all of)\b", re.I)


def estimate_complexity(instruction: str) -> int:
    """Cheap 1..5 heuristic; deliberately conservative (prefers smaller local models)."""
    score = 1
    if len(instruction) > 200:
        score += 1
    if len(instruction) > 600:
        score += 1
    score += min(2, len(_MULTI_STEP.findall(instruction)))
    if _HARD.search(instruction):
        score += 1
    return max(1, min(5, score))


def _resource_pressure(resources: dict[str, Any] | None) -> list[str]:
    if not resources:
        return []
    out = []
    mem = resources.get("memoryAvailableMb")
    if isinstance(mem, (int, float)) and mem < LOW_MEMORY_MB:
        out.append("low_memory")
    battery = resources.get("battery") or {}
    if isinstance(battery, dict) and battery.get("plugged") is False and isinstance(battery.get("percent"), (int, float)) and battery["percent"] < LOW_BATTERY_PERCENT:
        out.append("low_battery")
    return out


def route(
    models: list[ModelInfo],
    privacy_level: str,
    complexity: int,
    capability: str,
    cost_limit_usd: float,
    resources: dict[str, Any] | None = None,
    is_online: Callable[[ModelInfo], bool] = lambda _m: True,
) -> RoutingDecision:
    """Selects the best permitted model or explains why none qualifies.

    Privacy is a hard filter: LOCAL_ONLY never yields a cloud model.
    """
    excluded: dict[str, str] = {}
    candidates: list[ModelInfo] = []
    pressure = _resource_pressure(resources)
    for m in models:
        if not m.enabled:
            excluded[m.name] = "disabled"
        elif not m.isLocal and privacy_level == "LOCAL_ONLY":
            excluded[m.name] = "privacy policy is local-only"
        elif capability not in m.capabilities:
            excluded[m.name] = f"lacks capability '{capability}'"
        elif m.maxComplexity < complexity:
            excluded[m.name] = f"max complexity {m.maxComplexity} < {complexity}"
        elif not m.isLocal and m.costPer1kTokens * EST_TOKENS_PER_PLAN / 1000 > cost_limit_usd:
            excluded[m.name] = "estimated cost exceeds limit"
        elif not m.isLocal and not m.secretRef:
            excluded[m.name] = "no API key configured"
        elif not m.isLocal and not is_online(m):
            excluded[m.name] = OFFLINE_REASON
        else:
            candidates.append(m)

    if not candidates:
        return RoutingDecision(model=None, cloud=False, reason="No permitted model is available for this task", excluded=excluded)

    def score(m: ModelInfo) -> tuple:
        # Local first under resource pressure only if it is small; otherwise prefer local for privacy,
        # then lower latency, then lower cost, then the smallest model that is sufficient.
        local_pref = 0 if m.isLocal else 1
        if "low_memory" in pressure and m.isLocal and m.maxComplexity >= 4:
            local_pref = 2  # a large local model would starve the machine
        return (local_pref, m.latencyClass, m.costPer1kTokens, m.maxComplexity)

    candidates.sort(key=score)
    best = candidates[0]
    reason = f"{'local' if best.isLocal else 'cloud'} model '{best.name}' satisfies complexity {complexity}, capability '{capability}'"
    if pressure:
        reason += f" (resource pressure: {', '.join(pressure)})"
    return RoutingDecision(model=best.name, cloud=not best.isLocal, reason=reason, candidates=[c.name for c in candidates], excluded=excluded)
