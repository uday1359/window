"""Deterministic planner for common, well-understood instructions.

Rules run before any model: they are fast, private (no model call at all) and
predictable. Anything they do not recognise falls through to the LLM planner.
"""

from __future__ import annotations

import re
from typing import Any

Plan = dict[str, Any]

TASK_FOLDER = "{task}"  # replaced by the server with a dedicated per-task folder name
DEFAULT_ROOT = "workspace"

_FILE_NAME = r"(?P<name>(?:[A-Za-z0-9_\-]+/)*[A-Za-z0-9_\-]+(?:\.[A-Za-z0-9_\-]+)*\.[A-Za-z0-9]{1,8})"
_CREATE = re.compile(
    r"\b(?:create|make|write|save)\b(?:\s+(?:a|an|the|new))*(?:\s+(?:text|txt|plain[- ]text))?(?:\s+file)?(?:\s+(?:named|called))?\s+[\"'“]?" + _FILE_NAME + r"[\"'”]?",
    re.I,
)
_LOCATION = re.compile(r"\b(?:in|into|inside|to)\s+(?:the\s+|my\s+)?(?:approved\s+)?(?P<root>[A-Za-z][A-Za-z0-9_-]{0,31})\s+(?:folder|directory|root)\b", re.I)
_CONTENT_INTRO = re.compile(r"\b(?:containing|contains|with\s+(?:the\s+)?(?:text|content|contents|body))(?:\s+exactly)?\s*:?\s*", re.I)
_QUOTED = re.compile(r"^\s*(?:\"(?P<a>[^\"]*)\"|“(?P<b>[^”]*)”|'(?P<c>[^']*)')")
_NEXT_SENTENCE = re.compile(r"(?<=[.!?])\s+(?=(?:read|then|verify|check|confirm|after|afterwards|and|also|finally|make sure|ensure)\b)", re.I)
_READ_BACK = re.compile(r"\bread\s+(?:the\s+file\s+|it\s+|the\s+contents?\s+)?back\b|\bverify\b|\bcheck\s+(?:its|the)\s+contents?\b|\bconfirm\b", re.I)
_READ_FILE = re.compile(r"^\s*(?:please\s+)?(?:read|show|open|display)\s+(?:the\s+)?(?:file\s+)?[\"'“]?" + _FILE_NAME + r"[\"'”]?", re.I)
_LIST = re.compile(r"^\s*(?:please\s+)?(?:list|show)\s+(?:all\s+)?(?:the\s+)?(?:files|contents)\b", re.I)
_URL = re.compile(r"\bhttps?://[^\s\"'<>]+", re.I)
_OPEN_SITE = re.compile(r"^\s*(?:please\s+)?(?:open|go to|navigate to|visit|browse to)\s+(?P<target>\S+)", re.I)
_SEARCH = re.compile(r"^\s*(?:please\s+)?(?:search|look up|google)\s+(?:the\s+web\s+|online\s+|the\s+internet\s+)?(?:for\s+)?(?P<q>.+?)\s*\.?\s*$", re.I)
_RESEARCH = re.compile(r"^\s*(?:please\s+)?(?:research|find out|investigate)\s+(?:about\s+|on\s+)?(?P<q>.+?)\s*[.?]?\s*$", re.I)
# Multi-step requests ("research X, then compare ...") need a model to plan.
_COMPOUND = re.compile(r"\b(?:then|after that|afterwards|finally|and save|and write|and create)\b|;", re.I)
_LAUNCH = re.compile(r"^\s*(?:please\s+)?(?:open|launch|start|run)\s+(?:the\s+)?(?P<app>[A-Za-z][A-Za-z0-9 _-]{0,31}?)(?:\s+app(?:lication)?)?\s*\.?\s*$", re.I)
_WINDOWS = re.compile(r"^\s*(?:please\s+)?(?:list|show)\s+(?:all\s+)?(?:the\s+)?(?:open\s+)?windows\b", re.I)
_SCREENSHOT = re.compile(r"^\s*(?:please\s+)?(?:take|capture)\s+(?:a\s+)?screenshot\b", re.I)
_OCR = re.compile(
    r"^\s*(?:please\s+)?(?:read|extract|ocr)\s+(?:the\s+)?(?:visible\s+)?text\s+(?:on|from|in)\s+(?:the\s+)?"
    r"(?:screen|window\s+(?:titled\s+)?[\"'](?P<title>[^\"']{1,200})[\"'])",
    re.I,
)
_RESOURCES = re.compile(r"\b(?:system\s+resources|cpu|memory|ram)\s+(?:usage|status)\b|^\s*(?:show|check)\s+(?:system\s+)?resources\b", re.I)

APP_ALIASES = {"calculator": "calculator", "calc": "calculator", "notepad": "notepad", "paint": "paint", "mspaint": "paint", "explorer": "explorer", "file explorer": "explorer"}


def _plan(title: str, steps: list[dict[str, Any]], criteria: list[dict[str, Any]]) -> Plan:
    return {"title": title, "steps": steps, "successCriteria": criteria, "clarification": None}


def _clarify(question: str) -> Plan:
    return {"title": "Clarification needed", "steps": [], "successCriteria": [], "clarification": question}


def _resolve_root(instruction: str, roots: list[str]) -> tuple[str | None, str | None]:
    """Returns (root, error_question)."""
    m = _LOCATION.search(instruction)
    if not m:
        return (DEFAULT_ROOT if DEFAULT_ROOT in roots else None), (None if DEFAULT_ROOT in roots else "Which approved folder should I use? No default workspace folder is configured on the agent.")
    root = m.group("root").lower()
    if root not in roots:
        available = ", ".join(roots) or "none"
        return None, f"The agent has no approved '{root}' folder. Approved folders are: {available}. Which one should I use?"
    return root, None


def _extract_content(instruction: str, after: int) -> str | None:
    intro = _CONTENT_INTRO.search(instruction, after)
    if not intro:
        return None
    rest = instruction[intro.end():]
    quoted = _QUOTED.match(rest)
    if quoted:
        return next(g for g in quoted.groups() if g is not None)
    parts = _NEXT_SENTENCE.split(rest, maxsplit=1)
    content = parts[0].strip()
    return content or None


def plan_file_creation(instruction: str, roots: list[str]) -> Plan | None:
    m = _CREATE.search(instruction)
    if not m:
        return None
    name = m.group("name")
    root, question = _resolve_root(instruction, roots)
    if question:
        return _clarify(question)
    content = _extract_content(instruction, m.end())
    if content is None:
        return _clarify(f"What exactly should {name} contain?")
    path = name if _LOCATION.search(instruction) else f"{TASK_FOLDER}/{name}"
    steps: list[dict[str, Any]] = [
        {"operation": "file.write", "description": f"Create {name} in the {root} folder", "params": {"root": root, "path": path, "content": content, "overwrite": False}},
    ]
    if _READ_BACK.search(instruction[m.end():]):
        steps.append({"operation": "file.read", "description": f"Read {name} back", "params": {"root": root, "path": path}})
    criteria = [{"kind": "file_content_equals", "root": root, "path": path, "expected": content}]
    return _plan(f"Create {name}", steps, criteria)


def plan_read_file(instruction: str, roots: list[str]) -> Plan | None:
    m = _READ_FILE.search(instruction)
    if not m:
        return None
    root, question = _resolve_root(instruction, roots)
    if question:
        return _clarify(question)
    name = m.group("name")
    return _plan(
        f"Read {name}",
        [{"operation": "file.read", "description": f"Read {name}", "params": {"root": root, "path": name}}],
        [{"kind": "file_exists", "root": root, "path": name}, {"kind": "step_succeeded", "stepIndex": 0}],
    )


def plan_list(instruction: str, roots: list[str]) -> Plan | None:
    if not _LIST.search(instruction):
        return None
    root, question = _resolve_root(instruction, roots)
    if question:
        return _clarify(question)
    return _plan(f"List files in {root}", [{"operation": "file.list", "description": f"List the {root} folder", "params": {"root": root, "path": ""}}], [{"kind": "step_succeeded", "stepIndex": 0}])


def plan_browser(instruction: str) -> Plan | None:
    m = _OPEN_SITE.search(instruction)
    url_match = _URL.search(instruction)
    if m and (url_match or re.match(r"^[a-z0-9-]+(\.[a-z0-9-]+)+(/\S*)?$", m.group("target"), re.I)):
        url = url_match.group(0).rstrip(".,)") if url_match else f"https://{m.group('target').rstrip('.,')}"
        return _plan(
            f"Open {url}",
            [
                {"operation": "browser.open", "description": f"Open {url}", "params": {"url": url}},
                {"operation": "browser.extract_text", "description": "Read the page text", "params": {"maxChars": 20000}},
            ],
            [{"kind": "step_succeeded", "stepIndex": 0}, {"kind": "step_succeeded", "stepIndex": 1}],
        )
    r = _RESEARCH.search(instruction)
    if r and not _COMPOUND.search(r.group("q")):
        query = r.group("q").strip().strip("\"'“”")[:300]
        return _plan(
            f"Research: {query}",
            [{"operation": "browser.research", "description": f"Research {query} using trustworthy sources", "params": {"query": query, "maxSources": 3}}],
            [{"kind": "step_succeeded", "stepIndex": 0}],
        )
    s = _SEARCH.search(instruction)
    if s:
        query = s.group("q").strip().strip("\"'“”")[:300]
        return _plan(f"Search the web for {query}", [{"operation": "browser.search", "description": f"Search for {query}", "params": {"query": query}}], [{"kind": "step_succeeded", "stepIndex": 0}])
    return None


def plan_desktop(instruction: str, apps: list[str]) -> Plan | None:
    if _WINDOWS.search(instruction):
        return _plan("List open windows", [{"operation": "desktop.list_windows", "description": "List open windows", "params": {}}], [{"kind": "step_succeeded", "stepIndex": 0}])
    if _SCREENSHOT.search(instruction):
        return _plan("Take a screenshot", [{"operation": "desktop.screenshot", "description": "Capture the screen", "params": {}}], [{"kind": "step_succeeded", "stepIndex": 0}])
    m = _OCR.search(instruction)
    if m:
        params = {"titleContains": m.group("title")} if m.group("title") else {}
        where = f'window "{m.group("title")}"' if m.group("title") else "the screen"
        return _plan(f"Read text from {where}", [{"operation": "desktop.ocr", "description": f"Read visible text from {where} with Windows OCR", "params": params}], [{"kind": "step_succeeded", "stepIndex": 0}])
    if _RESOURCES.search(instruction):
        return _plan("Check system resources", [{"operation": "system.resources", "description": "Read CPU, memory and battery usage", "params": {}}], [{"kind": "step_succeeded", "stepIndex": 0}])
    m = _LAUNCH.search(instruction)
    if m:
        requested = m.group("app").strip().lower()
        app = APP_ALIASES.get(requested, requested.replace(" ", "-"))
        if app not in apps:
            return None if "." in requested else _clarify(f"'{requested}' is not in the agent's application allow list ({', '.join(apps) or 'empty'}). Which application should I open?")
        return _plan(f"Open {app}", [{"operation": "desktop.launch_app", "description": f"Launch {app}", "params": {"app": app}}], [{"kind": "step_succeeded", "stepIndex": 0}])
    return None


def rule_plan(instruction: str, roots: list[str], apps: list[str]) -> Plan | None:
    for planner in (
        lambda: plan_file_creation(instruction, roots),
        lambda: plan_read_file(instruction, roots),
        lambda: plan_list(instruction, roots),
        lambda: plan_desktop(instruction, apps),
        lambda: plan_browser(instruction),
    ):
        result = planner()
        if result is not None:
            return result
    return None
