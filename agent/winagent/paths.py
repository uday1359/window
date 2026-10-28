"""Safe resolution of root-relative paths. Every file operation goes through here."""

from __future__ import annotations

import os
import re
from pathlib import Path

from .errors import OpError

RESERVED = re.compile(r"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$", re.I)
EXECUTABLE = re.compile(r"\.(exe|msi|msix|bat|cmd|com|scr|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|dll|sys|reg|jar|appx|cpl)$", re.I)


def check_relative(rel: str) -> list[str]:
    if not isinstance(rel, str) or len(rel) > 260:
        raise OpError("INVALID_PARAMS", "path must be a string of at most 260 characters")
    if rel == "":
        return []
    if re.search(r'[\x00-\x1f<>:"|?*]', rel) or rel[0] in "\\/":
        raise OpError("POLICY_DENIED", "absolute paths, drive letters and alternate data streams are not allowed")
    parts = re.split(r"[\\/]", rel)
    for part in parts:
        if part in ("", ".", "..") or RESERVED.match(part) or part.endswith((".", " ")):
            raise OpError("POLICY_DENIED", f"path segment {part!r} is not allowed")
    return parts


def resolve(roots: dict[str, str], root: str, rel: str) -> Path:
    """Maps root + relative path to an absolute path guaranteed to stay inside the root,
    even through symlinks/junctions (both sides are fully resolved before comparing)."""
    if root not in roots:
        raise OpError("POLICY_DENIED", f"root {root!r} is not configured on this agent")
    base = Path(roots[root]).resolve(strict=False)
    parts = check_relative(rel)
    target = base.joinpath(*parts).resolve(strict=False)
    base_s = os.path.normcase(str(base))
    target_s = os.path.normcase(str(target))
    if target_s != base_s and not target_s.startswith(base_s.rstrip("\\") + "\\"):
        raise OpError("POLICY_DENIED", "path escapes the approved folder")
    return target


def ensure_not_executable(rel: str) -> None:
    if EXECUTABLE.search(rel):
        raise OpError("POLICY_DENIED", "executable or script file types are not allowed")
