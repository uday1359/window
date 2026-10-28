import asyncio
import uuid
from pathlib import Path

from winagent import token_store
from winagent.executor import stop_file
from winagent.journal import Journal


def op(operation, params, **extra):
    return {"operationId": str(uuid.uuid4()), "operation": operation, "params": params, "taskId": str(uuid.uuid4()), **extra}


async def test_duplicate_operation_is_not_executed_twice(executor, roots):
    msg = op("file.write", {"root": "test", "path": "once.txt", "content": "1"})
    first = await executor.execute(msg)
    Path(roots["test"], "once.txt").unlink()  # if it ran again the file would reappear
    second = await executor.execute(msg)
    assert first == second and first["ok"]
    assert not Path(roots["test"], "once.txt").exists()


async def test_emergency_stop_file_blocks_operations(executor, home, roots):
    stop_file(home).write_text("stop")
    res = await executor.execute(op("file.write", {"root": "test", "path": "x.txt", "content": "1"}))
    assert res == {"ok": False, "code": "EMERGENCY_STOP", "error": "emergency stop is active"}
    assert not Path(roots["test"], "x.txt").exists()


async def test_server_emergency_stop_blocks_operations(executor):
    await executor.emergency_stop(True)
    res = await executor.execute(op("system.resources", {}))
    assert res["code"] == "EMERGENCY_STOP"
    await executor.emergency_stop(False)
    assert (await executor.execute(op("system.resources", {})))["ok"]


async def test_sensitive_operations_require_approval_hash(executor, roots):
    Path(roots["test"], "d.txt").write_text("x")
    res = await executor.execute(op("file.delete", {"root": "test", "path": "d.txt"}))
    assert res["code"] == "APPROVAL_MISMATCH" and Path(roots["test"], "d.txt").exists()
    res = await executor.execute(op("file.delete", {"root": "test", "path": "d.txt"}, approvalHash="a" * 64))
    assert res["ok"]


async def test_unsupported_and_bad_params(executor):
    assert (await executor.execute(op("shell.exec", {"cmd": "whoami"})))["code"] == "UNSUPPORTED"
    assert (await executor.execute(op("file.read", {"root": "test"})))["code"] == "INVALID_PARAMS"
    assert (await executor.execute(op("file.read", {"root": "test", "path": "..\\x"})))["code"] == "POLICY_DENIED"


async def test_cancellation_stops_typing(executor, monkeypatch):
    typed = []

    def slow_type(p):
        import time

        time.sleep(0.05)
        typed.append(p["text"])
        return {}

    monkeypatch.setattr(executor.desktop, "type_text", slow_type)
    msg = op("desktop.type_text", {"titleContains": "x", "text": "a" * 2000}, approvalHash="b" * 64)
    run = asyncio.ensure_future(executor.execute(msg))
    await asyncio.sleep(0.2)
    executor.cancel(msg["operationId"])
    res = await run
    assert res["code"] == "CANCELLED"
    await asyncio.sleep(0.2)
    assert len(typed) < 100  # stopped well before all 100 chunks


def test_journal_survives_restart_and_marks_running_as_unknown(home):
    path = home / "journal.jsonl"
    j = Journal(path)
    j.start("op-1", "file.write")
    j.start("op-2", "file.read")
    j.finish("op-2", "file.read", {"ok": True})
    j2 = Journal(path)
    assert j2.status("op-1") == {"state": "unknown"}
    assert j2.status("op-2") == {"state": "completed", "result": {"ok": True}}
    assert j2.status("op-3") == {"state": "unknown"}


def test_device_token_is_dpapi_encrypted(home):
    token_store.save(home, "dev-1", "super-secret-token-value")
    assert b"super-secret-token-value" not in token_store.token_path(home).read_bytes()
    assert token_store.load(home) == ("dev-1", "super-secret-token-value")
