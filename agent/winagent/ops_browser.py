"""Browser automation with Playwright.

Safety properties:
- Ephemeral browser context: no cookies, tokens or logins persist between agent runs.
- CAPTCHA / OTP / MFA / identity checks are detected and reported, never bypassed.
- Page text is untrusted: likely prompt-injection phrases are flagged, never obeyed.
- Unrequested downloads are cancelled; requested downloads reject executables.
- Password and payment-card fields are never filled.
"""

from __future__ import annotations

import hashlib
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus, urlparse

from .errors import OpError
from .paths import EXECUTABLE, ensure_not_executable, resolve
from .research import is_public_host, select_sources

RESEARCH_TEXT_CHARS = 6000

HUMAN_CHECK_SELECTORS = [
    "iframe[src*='recaptcha']",
    "iframe[src*='hcaptcha']",
    "iframe[src*='challenges.cloudflare.com']",
    "[class*='g-recaptcha']",
    "[class*='h-captcha']",
    "input[autocomplete='one-time-code']",
]
HUMAN_CHECK_TEXT = re.compile(
    r"verify (that )?you('| a)re (a )?human|are you a robot|captcha|one[- ]time (pass)?code|verification code|two[- ]factor|2fa|multi[- ]factor|confirm your identity|security check",
    re.I,
)
INJECTION_PATTERNS = re.compile(
    r"ignore (all |any )?(the )?(previous|prior|above) (instructions|prompts)|disregard (all |your )?(previous |prior )?instructions|you are now (a|an|in)\b|"
    r"system prompt|developer mode|execute the following (command|code)|run this (command|script)|send (me )?(your|the) (password|credentials|api key)",
    re.I,
)
SENSITIVE_FIELD = re.compile(r"password|passwd|cc-|card|cvc|cvv|security.?code|otp|one-time", re.I)


def detect_injection(text: str) -> list[str]:
    return sorted({m.group(0)[:80] for m in INJECTION_PATTERNS.finditer(text)})


def looks_executable(data: bytes) -> bool:
    return data[:2] == b"MZ" or data[:4] == b"\x7fELF"


class BrowserOps:
    def __init__(self, roots: dict[str, str], evidence_dir: Path, channel: str, headless: bool, max_download_mb: int) -> None:
        self.roots = roots
        self.evidence_dir = evidence_dir
        self.channel = channel
        self.headless = headless
        self.max_download_bytes = max_download_mb * 1024 * 1024
        self._pw = None
        self._browser = None
        self._context = None
        self._page = None

    async def _ensure_page(self):
        if self._page is not None and not self._page.is_closed():
            return self._page
        from playwright.async_api import async_playwright

        if self._pw is None:
            self._pw = await async_playwright().start()
        if self._browser is None:
            try:
                self._browser = await self._pw.chromium.launch(channel=self.channel or None, headless=self.headless)
            except Exception as exc:  # noqa: BLE001 - surfaced as a clear operation error
                raise OpError("UNSUPPORTED", f"browser could not be started ({type(exc).__name__}); install Microsoft Edge or run 'playwright install chromium'") from exc
        self._context = await self._browser.new_context(accept_downloads=True)
        self._page = await self._context.new_page()
        # Downloads that the plan did not request are cancelled (drive-by download protection).
        self._page.on("download", lambda d: d.cancel())
        return self._page

    async def close(self) -> None:
        for closer in (self._context, self._browser):
            if closer is not None:
                try:
                    await closer.close()
                except Exception:  # noqa: BLE001,S110 - best effort shutdown
                    pass
        if self._pw is not None:
            await self._pw.stop()
        self._pw = self._browser = self._context = self._page = None

    async def _human_check(self, page) -> str | None:
        for sel in HUMAN_CHECK_SELECTORS:
            if await page.locator(sel).count() > 0:
                return f"human verification element detected ({sel})"
        try:
            text = await page.locator("body").inner_text(timeout=5000)
        except Exception:  # noqa: BLE001
            return None
        m = HUMAN_CHECK_TEXT.search(text[:20000])
        return f"page asks for human verification ('{m.group(0)}')" if m else None

    async def _page_info(self, page, status: int | None) -> dict[str, Any]:
        return {"url": page.url, "title": await page.title(), "status": status}

    async def open(self, p: dict[str, Any]) -> dict[str, Any]:
        page = await self._ensure_page()
        try:
            res = await page.goto(p["url"], wait_until="domcontentloaded", timeout=40000)
        except Exception as exc:  # noqa: BLE001
            raise OpError("NAVIGATION_FAILED", f"could not open page ({type(exc).__name__})") from exc
        check = await self._human_check(page)
        if check:
            raise OpError("HUMAN_VERIFICATION_REQUIRED", check)
        return await self._page_info(page, res.status if res else None)

    async def search(self, p: dict[str, Any]) -> dict[str, Any]:
        page = await self._ensure_page()
        await page.goto(f"https://html.duckduckgo.com/html/?q={quote_plus(p['query'])}", wait_until="domcontentloaded", timeout=40000)
        check = await self._human_check(page)
        if check:
            raise OpError("HUMAN_VERIFICATION_REQUIRED", check)
        results = []
        for link in (await page.locator("a.result__a").all())[:10]:
            results.append({"title": (await link.inner_text())[:200], "href": await link.get_attribute("href")})
        return {"query": p["query"], "results": results, "untrusted": True}

    async def research(self, p: dict[str, Any]) -> dict[str, Any]:
        """FR-18: search, then read the most trustworthy distinct sources (read-only)."""
        page = await self._ensure_page()
        await page.goto(f"https://html.duckduckgo.com/html/?q={quote_plus(p['query'])}", wait_until="domcontentloaded", timeout=40000)
        check = await self._human_check(page)
        if check:
            raise OpError("HUMAN_VERIFICATION_REQUIRED", check)
        hrefs = [await link.get_attribute("href") for link in (await page.locator("a.result__a").all())[:20]]
        selected, skipped = select_sources(hrefs, int(p.get("maxSources") or 3), list(p.get("blockedDomains") or []))
        sources = []
        for item in selected:
            try:
                res = await page.goto(item["url"], wait_until="domcontentloaded", timeout=30000)
            except Exception as exc:  # noqa: BLE001 - one unreachable source must not fail the research
                skipped.append({"url": item["url"], "reason": f"could not open ({type(exc).__name__})"})
                continue
            if res is not None and res.status >= 400:
                skipped.append({"url": item["url"], "reason": f"HTTP {res.status}"})
                continue
            # Research never bypasses verification: such pages are skipped and reported.
            check = await self._human_check(page)
            if check:
                skipped.append({"url": item["url"], "reason": check})
                continue
            try:
                text = await page.locator("body").inner_text(timeout=10000)
            except Exception:  # noqa: BLE001
                skipped.append({"url": item["url"], "reason": "no readable text"})
                continue
            sources.append({
                "id": f"S{len(sources) + 1}",
                "url": page.url[:2000],
                "title": (await page.title())[:300],
                "domain": item["domain"],
                "trust": item["trust"],
                "text": " ".join(text.split())[:RESEARCH_TEXT_CHARS],
                "injectionWarnings": detect_injection(text),
                "retrievedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })
        if not sources:
            raise OpError("NOT_FOUND", f"no usable sources found for {p['query']!r} ({len(skipped)} skipped)")
        return {"query": p["query"], "sources": sources, "skipped": skipped[:20], "untrusted": True}

    async def extract_text(self, p: dict[str, Any]) -> dict[str, Any]:
        page = await self._ensure_page()
        target = page.locator(p["selector"]).first if p.get("selector") else page.locator("body")
        try:
            text = await target.inner_text(timeout=10000)
        except Exception as exc:  # noqa: BLE001
            raise OpError("NOT_FOUND", "element not found on the page") from exc
        limit = int(p.get("maxChars") or 20000)
        return {"url": page.url, "text": text[:limit], "truncated": len(text) > limit, "untrusted": True, "injectionWarnings": detect_injection(text)}

    async def screenshot(self, p: dict[str, Any], task_id: str) -> dict[str, Any]:
        page = await self._ensure_page()
        folder = self.evidence_dir / task_id
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"browser-{int(time.time() * 1000)}.png"
        data = await page.screenshot(path=str(path), full_page=False)
        return {"path": str(path), "sha256": hashlib.sha256(data).hexdigest(), "url": page.url}

    async def fill(self, p: dict[str, Any]) -> dict[str, Any]:
        page = await self._ensure_page()
        field = page.locator(p["selector"]).first
        if await field.count() == 0:
            raise OpError("NOT_FOUND", "form field not found")
        attrs = " ".join([str(await field.get_attribute(a) or "") for a in ("type", "name", "id", "autocomplete")])
        if SENSITIVE_FIELD.search(attrs):
            raise OpError("PERMISSION_DENIED", "the agent never fills password, payment or one-time-code fields; enter them yourself")
        await field.fill(p["value"], timeout=10000)
        return {"selector": p["selector"], "filled": True}

    async def click(self, p: dict[str, Any]) -> dict[str, Any]:
        page = await self._ensure_page()
        el = page.locator(p["selector"]).first
        if await el.count() == 0:
            raise OpError("NOT_FOUND", "element not found")
        await el.click(timeout=10000)
        await page.wait_for_load_state("domcontentloaded")
        return await self._page_info(page, None)

    async def submit(self, p: dict[str, Any]) -> dict[str, Any]:
        page = await self._ensure_page()
        check = await self._human_check(page)
        if check:
            raise OpError("HUMAN_VERIFICATION_REQUIRED", check)
        el = page.locator(p["selector"]).first
        if await el.count() == 0:
            raise OpError("NOT_FOUND", "submit element not found")
        await el.click(timeout=10000)
        await page.wait_for_load_state("domcontentloaded")
        check = await self._human_check(page)
        if check:
            raise OpError("HUMAN_VERIFICATION_REQUIRED", check)
        return {**(await self._page_info(page, None)), "submitted": True}

    async def download(self, p: dict[str, Any]) -> dict[str, Any]:
        import httpx

        ensure_not_executable(p["path"])
        if EXECUTABLE.search(urlparse(p["url"]).path):
            raise OpError("POLICY_DENIED", "executable downloads are not allowed")
        target = resolve(self.roots, p["root"], p["path"])
        if target.exists():
            raise OpError("ALREADY_EXISTS", "destination already exists")
        h = hashlib.sha256()
        size = 0
        tmp = target.with_name(f".{target.name}.winagent-tmp")
        target.parent.mkdir(parents=True, exist_ok=True)
        start_host = urlparse(p["url"]).hostname

        async def no_private_redirects(request) -> None:
            # Policy approved the starting URL only: a redirect must not lead to the local network.
            if request.url.host != start_host and not is_public_host(request.url.host):
                raise OpError("POLICY_DENIED", "the download redirected to a private or local address")

        try:
            async with httpx.AsyncClient(timeout=60, follow_redirects=True, event_hooks={"request": [no_private_redirects]}) as client:
                async with client.stream("GET", p["url"]) as res:
                    if res.status_code >= 400:
                        raise OpError("DOWNLOAD_FAILED", f"server returned HTTP {res.status_code}")
                    disposition = res.headers.get("content-disposition", "")
                    if EXECUTABLE.search(disposition.strip('"; ')):
                        raise OpError("POLICY_DENIED", "server tried to deliver an executable file")
                    first = True
                    with tmp.open("wb") as f:
                        async for chunk in res.aiter_bytes():
                            if first and looks_executable(chunk):
                                raise OpError("POLICY_DENIED", "downloaded content is an executable program")
                            first = False
                            size += len(chunk)
                            if size > self.max_download_bytes:
                                raise OpError("TOO_LARGE", "download exceeds the configured size limit")
                            h.update(chunk)
                            f.write(chunk)
            tmp.replace(target)
        finally:
            tmp.unlink(missing_ok=True)
        return {"path": p["path"], "absolutePath": str(target), "size": size, "sha256": h.hexdigest(), "untrusted": True}
