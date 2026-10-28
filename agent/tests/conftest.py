import pytest

from winagent.config import AgentConfig
from winagent.executor import Executor
from winagent.journal import Journal


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "agent-home"
    h.mkdir()
    monkeypatch.setenv("WINAGENT_AGENT_HOME", str(h))
    return h


@pytest.fixture
def roots(tmp_path):
    test = tmp_path / "approved" / "test"
    ws = tmp_path / "approved"
    test.mkdir(parents=True)
    return {"workspace": str(ws), "test": str(test)}


@pytest.fixture
def executor(home, roots):
    cfg = AgentConfig(roots=roots, browser_headless=True)
    return Executor(cfg, Journal(home / "journal.jsonl"))
