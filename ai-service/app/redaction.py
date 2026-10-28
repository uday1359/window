"""Redaction applied before any text leaves this machine (cloud models) or is logged.

Mirrors server/src/common/redact.ts. Secrets are always removed; with the
CLOUD_REDACTED privacy level personal data (e-mails, phone numbers, user paths,
IP addresses) is removed as well.
"""

from __future__ import annotations

import re

SECRET_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"), "[REDACTED_PRIVATE_KEY]"),
    (re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}", re.I), "Bearer [REDACTED]"),
    (re.compile(r"\bsk-ant-[A-Za-z0-9_-]{16,}\b"), "[REDACTED_API_KEY]"),
    (re.compile(r"\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b"), "[REDACTED_API_KEY]"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[REDACTED_AWS_KEY]"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"), "[REDACTED_TOKEN]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"), "[REDACTED_JWT]"),
    (re.compile(r"\b(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S+", re.I), r"\1=[REDACTED]"),
    (re.compile(r"\bmysql://[^:\s]+:[^@\s]+@", re.I), "mysql://[REDACTED]@"),
    (re.compile(r"\b(?:\d[ -]?){13,19}\b"), "[REDACTED_NUMBER]"),
]

PII_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[REDACTED_EMAIL]"),
    (re.compile(r"(?<!\w)\+?\d[\d ()-]{7,}\d(?!\w)"), "[REDACTED_PHONE]"),
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "[REDACTED_IP]"),
    (re.compile(r"[A-Za-z]:\\Users\\[^\\\s]+", re.I), r"C:\\Users\\[REDACTED_USER]"),
]


def redact_secrets(text: str) -> str:
    for pattern, replacement in SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def redact_pii(text: str) -> str:
    for pattern, replacement in PII_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def redact_for_cloud(text: str, privacy_level: str) -> tuple[str, bool]:
    """Returns (redacted_text, changed)."""
    out = redact_secrets(text)
    if privacy_level == "CLOUD_REDACTED":
        out = redact_pii(out)
    return out, out != text


def contains_secret(text: str) -> bool:
    return redact_secrets(text) != text
