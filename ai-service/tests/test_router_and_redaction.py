from app.redaction import contains_secret, redact_for_cloud, redact_secrets
from app.router import estimate_complexity, route
from app.schemas import ModelInfo

LOCAL = ModelInfo(name="local-small", provider="ollama", model="qwen2.5:3b", endpoint="http://127.0.0.1:11434", isLocal=True, maxComplexity=3, latencyClass=2, capabilities=["planning"])
CLOUD = ModelInfo(name="cloud-big", provider="anthropic", model="x", endpoint="https://api.example.com", isLocal=False, maxComplexity=5, latencyClass=1, costPer1kTokens=0.003, capabilities=["planning"], secretRef="cloud_key")


def test_local_only_never_routes_to_cloud():
    d = route([CLOUD], "LOCAL_ONLY", 5, "planning", 1.0)
    assert d.model is None and d.excluded["cloud-big"] == "privacy policy is local-only"


def test_complex_task_uses_cloud_when_allowed():
    d = route([LOCAL, CLOUD], "CLOUD_ALLOWED", 5, "planning", 1.0)
    assert d.model == "cloud-big" and d.cloud


def test_simple_task_prefers_local():
    d = route([LOCAL, CLOUD], "CLOUD_ALLOWED", 2, "planning", 1.0)
    assert d.model == "local-small" and not d.cloud


def test_cost_limit_and_offline_and_missing_key():
    assert route([CLOUD], "CLOUD_ALLOWED", 5, "planning", 0.0001).excluded["cloud-big"] == "estimated cost exceeds limit"
    assert route([CLOUD], "CLOUD_ALLOWED", 5, "planning", 1.0, is_online=lambda m: False).excluded["cloud-big"].startswith("offline")
    no_key = CLOUD.model_copy(update={"secretRef": None})
    assert route([no_key], "CLOUD_ALLOWED", 5, "planning", 1.0).excluded["cloud-big"] == "no API key configured"


def test_capability_and_disabled():
    assert route([LOCAL], "LOCAL_ONLY", 1, "vision", 1).model is None
    assert route([LOCAL.model_copy(update={"enabled": False})], "LOCAL_ONLY", 1, "planning", 1).model is None


def test_low_memory_avoids_large_local_model():
    big_local = LOCAL.model_copy(update={"name": "local-big", "maxComplexity": 5})
    d = route([big_local, CLOUD], "CLOUD_ALLOWED", 2, "planning", 1.0, {"memoryAvailableMb": 800})
    assert d.model == "cloud-big" and "low_memory" in d.reason


def test_complexity_heuristic():
    assert estimate_complexity("open notepad") == 1
    assert estimate_complexity("research three vendors, then compare prices, then write a report") >= 4


def test_redaction_removes_secrets_and_pii():
    text = "key sk-ant-abcdefghijklmnopqrstuv password=hunter2 mail bob@example.com C:\\Users\\bob\\x"
    secret_only = redact_secrets(text)
    assert "sk-ant" not in secret_only and "hunter2" not in secret_only and "bob@example.com" in secret_only
    full, changed = redact_for_cloud(text, "CLOUD_REDACTED")
    assert changed and "bob@example.com" not in full and "\\bob\\" not in full
    assert contains_secret("token: abc123") and not contains_secret("hello world")
