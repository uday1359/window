from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

PrivacyLevel = Literal["LOCAL_ONLY", "CLOUD_REDACTED", "CLOUD_ALLOWED"]


class ModelInfo(BaseModel):
    name: str
    provider: Literal["ollama", "openai_compatible", "anthropic"]
    model: str
    endpoint: str
    isLocal: bool
    enabled: bool = True
    maxComplexity: int = Field(3, ge=1, le=5)
    latencyClass: int = Field(2, ge=1, le=3)
    costPer1kTokens: float = Field(0, ge=0)
    capabilities: list[str] = []
    secretRef: str | None = None


class OperationInfo(BaseModel):
    name: str
    description: str
    risk: str


class ImageInput(BaseModel):
    """A screenshot attached to a task (FR-01). 1.5 MB of image is ~2 MB of base64."""

    mediaType: Literal["image/png", "image/jpeg"]
    data: str = Field(min_length=1, max_length=2_100_000)


class PlanRequest(BaseModel):
    # The server sends up to 5000 chars of instruction plus up to 5000 of accumulated clarification.
    instruction: str = Field(min_length=1, max_length=12000)
    privacyLevel: PrivacyLevel = "LOCAL_ONLY"
    models: list[ModelInfo] = []
    roots: list[str] = []
    apps: list[str] = []
    operations: list[OperationInfo] = []
    costLimitUsd: float = Field(0.05, ge=0)
    resources: dict[str, Any] | None = None
    images: list[ImageInput] = Field(default=[], max_length=3)


class RouteRequest(BaseModel):
    privacyLevel: PrivacyLevel = "LOCAL_ONLY"
    models: list[ModelInfo] = []
    complexity: int = Field(2, ge=1, le=5)
    capability: str = "planning"
    costLimitUsd: float = Field(0.05, ge=0)
    resources: dict[str, Any] | None = None


class RoutingDecision(BaseModel):
    model: str | None
    cloud: bool
    reason: str
    redacted: bool = False
    candidates: list[str] = []
    excluded: dict[str, str] = {}


class PlanResponse(BaseModel):
    plan: dict[str, Any]
    source: str
    routing: RoutingDecision
    warnings: list[str] = []


class ResearchSource(BaseModel):
    """A web page fetched by the agent's browser.research operation (untrusted content)."""

    id: str = Field(pattern=r"^S[0-9]{1,2}$")
    url: str = Field(max_length=2000)
    title: str = Field("", max_length=300)
    domain: str = Field(max_length=253)
    trust: Literal["official", "reference", "general"]
    text: str = Field("", max_length=8000)


class SynthesizeRequest(BaseModel):
    question: str = Field(min_length=1, max_length=1000)
    sources: list[ResearchSource] = Field(max_length=8)
    privacyLevel: PrivacyLevel = "LOCAL_ONLY"
    models: list[ModelInfo] = []
    costLimitUsd: float = Field(0.05, ge=0)
    resources: dict[str, Any] | None = None


class Claim(BaseModel):
    text: str
    sources: list[str]
    status: Literal["verified", "single-source"]


class SynthesizeResponse(BaseModel):
    claims: list[Claim]
    model: str | None
    note: str
    warnings: list[str] = []


class IntegrationConfig(BaseModel):
    """An administrator-approved integration, as stored by the server."""

    name: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,31}$")
    kind: Literal["REST", "MCP"]
    baseUrl: str = Field(max_length=500)
    allowedPaths: list[str] = Field(default=[], max_length=50)
    allowedTools: list[str] = Field(default=[], max_length=100)
    authHeader: str | None = Field(default=None, pattern=r"^[A-Za-z0-9-]{1,64}$")
    authScheme: str | None = Field(default=None, max_length=32)
    secretRef: str | None = Field(default=None, pattern=r"^[a-z0-9_-]{1,100}$")


class RestCallRequest(BaseModel):
    integration: IntegrationConfig
    method: Literal["GET", "POST"]
    path: str = Field(min_length=1, max_length=1000)
    query: dict[str, str | int | float | bool] | None = None
    body: Any = None


class McpCallRequest(BaseModel):
    integration: IntegrationConfig
    tool: str = Field(min_length=1, max_length=128)
    arguments: dict[str, Any] = {}


class McpToolsRequest(BaseModel):
    integration: IntegrationConfig


class SecretValue(BaseModel):
    value: str = Field(min_length=1, max_length=4096)
