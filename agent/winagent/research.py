"""Source selection for browser.research (FR-18). Pure functions, no browser.

Search results are untrusted. Only public http(s) pages are kept, never executables,
private or loopback hosts, or domains the user's website policy denies. Sources are
ranked official > reference > general and limited to one per domain, so that "two
domains agree" means two independent sites.
"""

from __future__ import annotations

import ipaddress
import re
from urllib.parse import parse_qs, urlparse

from .paths import EXECUTABLE

OFFICIAL_SUFFIXES = (".gov", ".edu", ".int", ".mil")
OFFICIAL_SECOND_LEVEL = re.compile(r"\.(gov|gob|gouv|govt|edu|ac|nic)\.[a-z]{2}$")
OFFICIAL_HOST_PREFIXES = ("docs.", "developer.", "developers.", "learn.", "support.", "documentation.")
OFFICIAL_DOMAINS = {"w3.org", "ietf.org", "iso.org", "who.int", "europa.eu", "python.org", "nodejs.org", "microsoft.com", "apple.com", "mozilla.org"}
REFERENCE_DOMAINS = {"wikipedia.org", "britannica.com", "stackoverflow.com", "github.com", "developer.mozilla.org"}
TRUST_ORDER = {"official": 0, "reference": 1, "general": 2}


def _matches(host: str, domain: str) -> bool:
    return host == domain or host.endswith("." + domain)


def decode_result_url(href: str | None) -> str | None:
    """DuckDuckGo's HTML results link through /l/?uddg=<target>; return the real target."""
    if not href:
        return None
    if href.startswith("//"):
        href = "https:" + href
    u = urlparse(href)
    if u.hostname and _matches(u.hostname, "duckduckgo.com"):
        target = parse_qs(u.query).get("uddg", [None])[0]
        return target
    return href


def is_public_host(host: str) -> bool:
    if not host or host == "localhost" or host.endswith((".local", ".internal", ".localhost", ".lan")):
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return "." in host
    return ip.is_global


def classify_trust(host: str) -> str:
    host = host.lower().removeprefix("www.")
    if any(_matches(host, d) for d in REFERENCE_DOMAINS):
        return "reference"
    if host.endswith(OFFICIAL_SUFFIXES) or OFFICIAL_SECOND_LEVEL.search(host) or host.startswith(OFFICIAL_HOST_PREFIXES):
        return "official"
    if any(_matches(host, d) for d in OFFICIAL_DOMAINS):
        return "official"
    return "general"


def select_sources(hrefs: list[str | None], max_sources: int, blocked_domains: list[str]) -> tuple[list[dict], list[dict]]:
    """Returns (selected [{url, domain, trust}], skipped [{url, reason}]) in trust order."""
    seen_domains: set[str] = set()
    candidates: list[tuple[int, int, dict]] = []
    skipped: list[dict] = []
    blocked = [d.lower().lstrip("*.") for d in blocked_domains]
    for position, href in enumerate(hrefs):
        url = decode_result_url(href)
        if not url:
            continue
        u = urlparse(url)
        host = (u.hostname or "").lower()
        reason = None
        if u.scheme not in ("http", "https"):
            reason = "not an http(s) page"
        elif not is_public_host(host):
            reason = "private or local address"
        elif _matches(host, "duckduckgo.com"):
            reason = "search engine page or advert"
        elif any(_matches(host, d) for d in blocked):
            reason = "denied by website policy"
        elif EXECUTABLE.search(u.path):
            reason = "executable file"
        domain = host.removeprefix("www.")
        if reason is None and domain in seen_domains:
            continue  # one page per domain keeps sources independent
        if reason:
            skipped.append({"url": url[:500], "reason": reason})
            continue
        seen_domains.add(domain)
        trust = classify_trust(host)
        candidates.append((TRUST_ORDER[trust], position, {"url": url, "domain": domain, "trust": trust}))
    candidates.sort(key=lambda c: (c[0], c[1]))
    return [c[2] for c in candidates[:max_sources]], skipped
