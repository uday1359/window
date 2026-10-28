"""Windows desktop automation via UI Automation (pywinauto 'uia' backend).

Accessibility interfaces are used first; screenshots are captured as evidence.
Applications are started only from the local allow list, with normal user
privileges and without a shell.
"""

from __future__ import annotations

import hashlib
import shutil
import subprocess  # noqa: S404 - used without a shell for allow-listed apps only
import time
from pathlib import Path
from typing import Any

from . import ocr
from .errors import OpError

DIALOG_CLASS = "#32770"
_SEND_KEYS_SPECIAL = str.maketrans({c: "{" + c + "}" for c in "{}+^%~()[]"})


def _desktop():
    try:
        from pywinauto import Desktop
    except ImportError as exc:
        raise OpError("UNSUPPORTED", "pywinauto is not installed") from exc
    return Desktop(backend="uia")


def _find_window(title_contains: str):
    needle = title_contains.lower()
    matches = [w for w in _desktop().windows(visible_only=True) if needle in (w.window_text() or "").lower()]
    if not matches:
        raise OpError("NOT_FOUND", f"no visible window title contains {title_contains!r}")
    if len(matches) > 1:
        exact = [w for w in matches if (w.window_text() or "").lower() == needle]
        if len(exact) != 1:
            # Acting on the wrong window is unsafe: pause instead of guessing.
            raise OpError("AMBIGUOUS", f"{len(matches)} windows match {title_contains!r}; be more specific")
        return exact[0]
    return matches[0]


class DesktopOps:
    def __init__(self, apps: dict[str, str], evidence_dir: Path) -> None:
        self.apps = apps
        self.evidence_dir = evidence_dir

    def list_windows(self, _p: dict[str, Any]) -> dict[str, Any]:
        windows = []
        for w in _desktop().windows(visible_only=True):
            title = w.window_text()
            if not title:
                continue
            info = w.element_info
            windows.append({"title": title[:200], "processId": info.process_id, "className": info.class_name, "isDialog": info.class_name == DIALOG_CLASS})
        return {"windows": windows[:200], "count": len(windows)}

    def launch_app(self, p: dict[str, Any]) -> dict[str, Any]:
        exe = self.apps.get(p["app"])
        if not exe:
            raise OpError("POLICY_DENIED", f"application {p['app']!r} is not in the agent allow list")
        resolved = shutil.which(exe) or exe
        before = {w.window_text() for w in _desktop().windows(visible_only=True)}
        proc = subprocess.Popen([resolved], shell=False)  # noqa: S603 - allow-listed executable, no shell
        time.sleep(1.5)
        crashed = proc.poll() not in (None, 0)
        new_windows = [w.window_text() for w in _desktop().windows(visible_only=True) if w.window_text() and w.window_text() not in before]
        dialogs = [w.window_text() for w in _desktop().windows(visible_only=True) if w.element_info.class_name == DIALOG_CLASS]
        if crashed:
            raise OpError("APP_CRASHED", f"{p['app']} exited with code {proc.returncode}")
        return {"app": p["app"], "pid": proc.pid, "newWindows": new_windows[:10], "unexpectedDialogs": dialogs[:10]}

    def read_window_text(self, p: dict[str, Any]) -> dict[str, Any]:
        win = _find_window(p["titleContains"])
        texts: list[str] = []
        for ctrl in win.descendants():
            try:
                ctype = ctrl.element_info.control_type
                if ctype in ("Edit", "Document"):
                    value = ctrl.iface_value.CurrentValue if hasattr(ctrl, "iface_value") else ctrl.window_text()
                    if value:
                        texts.append(str(value))
                elif ctype == "Text" and ctrl.window_text():
                    texts.append(ctrl.window_text())
            except Exception:  # noqa: BLE001,S112 - controls can disappear while being read
                continue
        text = "\n".join(texts)
        limit = int(p.get("maxChars") or 20000)
        return {"window": win.window_text(), "text": text[:limit], "truncated": len(text) > limit, "untrusted": True}

    def type_text(self, p: dict[str, Any]) -> dict[str, Any]:
        win = _find_window(p["titleContains"])
        win.set_focus()
        time.sleep(0.3)
        if win.element_info.class_name == DIALOG_CLASS:
            raise OpError("UNEXPECTED_DIALOG", "target is a dialog box; pausing for the user")
        win.type_keys(p["text"].translate(_SEND_KEYS_SPECIAL), with_spaces=True, with_newlines=True, pause=0.01)
        return {"window": win.window_text(), "typedChars": len(p["text"])}

    def screenshot(self, _p: dict[str, Any], task_id: str, region: dict[str, int] | None = None) -> dict[str, Any]:
        try:
            import mss
            import mss.tools
        except ImportError as exc:
            raise OpError("UNSUPPORTED", "mss is not installed") from exc
        folder = self.evidence_dir / task_id
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"screen-{int(time.time() * 1000)}.png"
        with mss.mss() as sct:
            shot = sct.grab(region or sct.monitors[1])
            mss.tools.to_png(shot.rgb, shot.size, output=str(path))
        return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "width": shot.size[0], "height": shot.size[1]}

    def ocr(self, p: dict[str, Any], task_id: str) -> dict[str, Any]:
        """Reads text from the screen (or one window) with Windows OCR, keeping the image as evidence."""
        region = None
        if p.get("titleContains"):
            rect = _find_window(p["titleContains"]).rectangle()
            if rect.width() <= 0 or rect.height() <= 0:
                raise OpError("NOT_FOUND", "the window is minimised or has no visible area")
            region = {"left": rect.left, "top": rect.top, "width": rect.width(), "height": rect.height()}
        shot = self.screenshot({}, task_id, region)
        result = ocr.recognize(Path(shot["path"]))
        return {**result, "screenshot": shot["path"], "sha256": shot["sha256"], "titleContains": p.get("titleContains")}
