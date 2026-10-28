import hashlib
import os
import subprocess
from pathlib import Path

import pytest

from winagent.errors import OpError
from winagent.ops_files import FileOps
from winagent.paths import resolve

HELLO = "Hello from my AI agent."


@pytest.mark.parametrize(
    "rel",
    ["..\\escape.txt", "../escape.txt", "a/../../x", "C:\\Windows\\x.txt", "\\\\server\\share\\x", "/etc/passwd", "file.txt:stream", "CON", "nul.txt", "trailing. ", "a//b"],
)
def test_unsafe_paths_rejected(roots, rel):
    with pytest.raises(OpError) as exc:
        resolve(roots, "test", rel)
    assert exc.value.code == "POLICY_DENIED"


def test_unknown_root_rejected(roots):
    with pytest.raises(OpError, match="not configured"):
        resolve(roots, "system32", "x.txt")


def test_junction_escape_rejected(roots, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    link = Path(roots["test"]) / "link"
    subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(outside)], check=True, capture_output=True)  # noqa: S603,S607
    with pytest.raises(OpError, match="escapes"):
        resolve(roots, "test", "link\\secret.txt")


def test_write_then_read_exact_content(roots, home):
    ops = FileOps(roots, home)
    out = ops.write({"root": "test", "path": "hello.txt", "content": HELLO})
    raw = (Path(roots["test"]) / "hello.txt").read_bytes()
    assert raw == HELLO.encode("utf-8")  # no BOM, no newline added
    assert out["sha256"] == hashlib.sha256(raw).hexdigest() and out["created"]
    back = ops.read({"root": "test", "path": "hello.txt"})
    assert back["content"] == HELLO and back["sha256"] == out["sha256"] and back["hasBom"] is False


def test_write_existing_same_content_is_idempotent_and_different_content_refused(roots, home):
    ops = FileOps(roots, home)
    ops.write({"root": "test", "path": "a.txt", "content": "x"})
    assert ops.write({"root": "test", "path": "a.txt", "content": "x"})["alreadyPresent"]
    with pytest.raises(OpError) as exc:
        ops.write({"root": "test", "path": "a.txt", "content": "y"})
    assert exc.value.code == "ALREADY_EXISTS"


def test_overwrite_preserves_original(roots, home):
    ops = FileOps(roots, home)
    ops.write({"root": "test", "path": "a.txt", "content": "original"})
    out = ops.write({"root": "test", "path": "a.txt", "content": "new", "overwrite": True})
    assert Path(out["backupPath"]).read_text(encoding="utf-8") == "original"
    assert (Path(roots["test"]) / "a.txt").read_text(encoding="utf-8") == "new"


def test_delete_quarantines_instead_of_destroying(roots, home):
    ops = FileOps(roots, home)
    ops.write({"root": "test", "path": "d.txt", "content": "keep me"})
    out = ops.delete({"root": "test", "path": "d.txt"})
    assert not (Path(roots["test"]) / "d.txt").exists()
    assert Path(out["quarantinedTo"]).read_text(encoding="utf-8") == "keep me"


def test_executable_types_refused(roots, home):
    with pytest.raises(OpError):
        FileOps(roots, home).write({"root": "test", "path": "evil.ps1", "content": "x"})


def test_read_missing_large_and_binary(roots, home):
    ops = FileOps(roots, home)
    with pytest.raises(OpError) as e1:
        ops.read({"root": "test", "path": "missing.txt"})
    assert e1.value.code == "NOT_FOUND"
    (Path(roots["test"]) / "bin.dat").write_bytes(b"\xff\xfe\x00")
    with pytest.raises(OpError) as e2:
        ops.read({"root": "test", "path": "bin.dat"})
    assert e2.value.code == "INVALID_ENCODING"
    (Path(roots["test"]) / "big.txt").write_bytes(b"a" * 2000)
    with pytest.raises(OpError) as e3:
        ops.read({"root": "test", "path": "big.txt", "maxBytes": 1000})
    assert e3.value.code == "TOO_LARGE"


def test_stat_and_list(roots, home):
    ops = FileOps(roots, home)
    assert ops.stat({"root": "test", "path": "nope.txt"}) == {"exists": False, "isFile": False}
    ops.write({"root": "test", "path": "sub/x.txt", "content": "1"})
    assert ops.stat({"root": "test", "path": "sub/x.txt"})["exists"]
    names = [e["name"] for e in ops.list({"root": "test", "path": "sub"})["entries"]]
    assert names == ["x.txt"]
    assert not any(n.endswith(".winagent-tmp") for n in os.listdir(Path(roots["test"]) / "sub"))
