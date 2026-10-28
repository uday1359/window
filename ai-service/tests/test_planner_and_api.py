import sys

import pytest
from fastapi.testclient import TestClient

from app.llm import ModelError, extract_json
from app.main import create_app
from app.planner import NoModelAvailable, make_plan
from app.schemas import ModelInfo, PlanRequest
from app.secrets_store import SecretStore

TOKEN = "t" * 40
LOCAL = ModelInfo(name="local", provider="ollama", model="m", endpoint="http://127.0.0.1:1", isLocal=True, maxComplexity=5, capabilities=["planning"])
CLOUD = ModelInfo(name="cloud", provider="openai_compatible", model="m", endpoint="https://api.example.com", isLocal=False, maxComplexity=5, latencyClass=1, capabilities=["planning"], secretRef="k")
HARD = "Research three vendors, then compare their prices, then summarise everything; my email is bob@example.com"


async def test_rules_bypass_models():
    async def never(*_a):
        raise AssertionError("model must not be called")

    res = await make_plan(PlanRequest(instruction="Create a.txt in the test folder containing hi", roots=["test"]), lambda _n: None, never)
    assert res.source == "rules" and res.routing.model is None


async def test_local_preferred_then_falls_back_to_cloud_with_redaction():
    seen = {}

    async def caller(model, system, user, key):
        seen[model.name] = (user, key)
        if model.name == "local":
            raise ModelError("boom")
        return {"title": "t", "steps": [], "successCriteria": []}

    req = PlanRequest(instruction=HARD, privacyLevel="CLOUD_REDACTED", models=[CLOUD, LOCAL])
    res = await make_plan(req, lambda n: "secret-key" if n == "k" else None, caller, is_online=lambda m: True)
    assert list(seen) == ["local", "cloud"]  # local first for privacy
    assert "bob@example.com" in seen["local"][0]  # local models may see personal data
    assert "bob@example.com" not in seen["cloud"][0] and seen["cloud"][1] == "secret-key"
    assert res.source == "model:cloud" and res.routing.redacted and any("local: boom" in w for w in res.warnings)


async def test_all_models_failing_raises():
    async def caller(*_a):
        raise ModelError("down")

    with pytest.raises(NoModelAvailable, match="tried: local"):
        await make_plan(PlanRequest(instruction=HARD, models=[LOCAL]), lambda _n: None, caller)


async def test_local_only_with_only_cloud_models_fails():
    async def caller(*_a):
        raise AssertionError("must not call")

    with pytest.raises(NoModelAvailable):
        await make_plan(PlanRequest(instruction=HARD, privacyLevel="LOCAL_ONLY", models=[CLOUD]), lambda _n: None, caller, is_online=lambda m: True)


async def test_offline_model_failure_is_retryable_but_policy_failure_is_not():
    async def caller(*_a):
        raise AssertionError("must not call")

    with pytest.raises(NoModelAvailable) as offline:
        await make_plan(PlanRequest(instruction=HARD, privacyLevel="CLOUD_ALLOWED", models=[CLOUD]), lambda _n: "key", caller, is_online=lambda m: False)
    assert offline.value.retryable

    with pytest.raises(NoModelAvailable) as policy:
        await make_plan(PlanRequest(instruction=HARD, privacyLevel="LOCAL_ONLY", models=[CLOUD]), lambda _n: "key", caller, is_online=lambda m: True)
    assert not policy.value.retryable


PNG_B64 = "iVBORw0KGgo="  # PNG signature only; content is never decoded by the planner
LOCAL_VISION = LOCAL.model_copy(update={"name": "local-vision", "capabilities": ["planning", "vision"]})
CLOUD_VISION = CLOUD.model_copy(update={"name": "cloud-vision", "capabilities": ["planning", "vision"]})


async def test_screenshots_go_to_a_vision_model_and_skip_rules():
    seen = {}

    async def caller(model, system, user, key, images=None):
        seen[model.name] = images
        return {"title": "t", "steps": [], "successCriteria": []}

    # This instruction would normally be rule-planned; with a screenshot it must reach the model.
    req = PlanRequest(instruction="Create a.txt in the test folder containing hi", roots=["test"], models=[LOCAL, LOCAL_VISION], images=[{"mediaType": "image/png", "data": PNG_B64}])
    res = await make_plan(req, lambda _n: None, caller, is_online=lambda m: True)
    assert res.source == "model:local-vision"
    assert seen == {"local-vision": [("image/png", PNG_B64)]}


async def test_screenshots_never_reach_cloud_models_under_redacted_privacy():
    async def caller(*_a, **_k):
        raise AssertionError("images must not be sent to a cloud model under CLOUD_REDACTED")

    req = PlanRequest(instruction=HARD, privacyLevel="CLOUD_REDACTED", models=[CLOUD_VISION], images=[{"mediaType": "image/png", "data": PNG_B64}])
    with pytest.raises(NoModelAvailable):
        await make_plan(req, lambda _n: "key", caller, is_online=lambda m: True)


def test_extract_json_handles_fences_and_rejects_garbage():
    assert extract_json('```json\n{"title":"x","steps":[]}\n```')["title"] == "x"
    with pytest.raises(ModelError):
        extract_json("rm -rf /")


@pytest.fixture
def client(tmp_path):
    return TestClient(create_app(token=TOKEN, store=SecretStore(tmp_path / "s.dpapi")))


def test_token_required(client):
    assert client.post("/v1/plan", json={"instruction": "x"}).status_code == 401
    assert client.get("/v1/secrets", headers={"x-service-token": "wrong" * 10}).status_code == 401
    assert client.get("/health").status_code == 200


def test_plan_endpoint(client):
    res = client.post("/v1/plan", headers={"x-service-token": TOKEN}, json={"instruction": "Create a.txt in the test folder containing hi", "roots": ["test"]})
    assert res.status_code == 200 and res.json()["plan"]["steps"][0]["operation"] == "file.write"
    res = client.post("/v1/plan", headers={"x-service-token": TOKEN}, json={"instruction": HARD, "models": []})
    assert res.status_code == 503 and res.json()["detail"]["retryable"] is False


@pytest.mark.skipif(sys.platform != "win32", reason="DPAPI is Windows-only")
def test_secrets_are_dpapi_encrypted_at_rest(client, tmp_path):
    h = {"x-service-token": TOKEN}
    assert client.put("/v1/secrets/cloud_key", headers=h, json={"value": "sk-test-1234567890abcdef"}).status_code == 200
    assert client.get("/v1/secrets", headers=h).json() == {"names": ["cloud_key"]}
    raw = (tmp_path / "s.dpapi").read_bytes()
    assert b"sk-test-1234567890abcdef" not in raw
    store = SecretStore(tmp_path / "s.dpapi")
    assert store.get("cloud_key") == "sk-test-1234567890abcdef"
    assert client.delete("/v1/secrets/cloud_key", headers=h).status_code == 200
    assert client.put("/v1/secrets/Bad Name", headers=h, json={"value": "x"}).status_code in (400, 404)


def test_criteria_shape_is_normalized_but_unknown_kinds_are_left_for_the_server():
    data = extract_json('{"title":"t","steps":[],"successCriteria":[{"file_exists":{"root":"test","path":"a.txt"}},{"rm_rf":{"path":"/"}}]}')
    assert data["successCriteria"][0] == {"kind": "file_exists", "root": "test", "path": "a.txt"}
    assert data["successCriteria"][1] == {"rm_rf": {"path": "/"}}
