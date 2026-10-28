"""Minimal Windows DPAPI binding (CryptProtectData / CryptUnprotectData) via ctypes.

Data is bound to the current Windows user account, so the encrypted blobs are
useless if copied to another account or machine.
"""

from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes

CRYPTPROTECT_UI_FORBIDDEN = 0x01


class DpapiError(RuntimeError):
    pass


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def _blob(data: bytes) -> tuple[_DataBlob, ctypes.Array]:
    buf = ctypes.create_string_buffer(data, len(data))
    return _DataBlob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_byte))), buf


def available() -> bool:
    return sys.platform == "win32"


def _call(fn_name: str, data: bytes, entropy: bytes) -> bytes:
    if not available():
        raise DpapiError("DPAPI is only available on Windows")
    crypt32 = ctypes.windll.crypt32  # type: ignore[attr-defined]
    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    data_in, _buf_in = _blob(data)
    entropy_blob, _buf_e = _blob(entropy)
    data_out = _DataBlob()
    fn = getattr(crypt32, fn_name)
    if fn_name == "CryptProtectData":
        ok = fn(ctypes.byref(data_in), "winagent", ctypes.byref(entropy_blob), None, None, CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(data_out))
    else:
        ok = fn(ctypes.byref(data_in), None, ctypes.byref(entropy_blob), None, None, CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(data_out))
    if not ok:
        raise DpapiError(f"{fn_name} failed (error {ctypes.GetLastError()})")
    try:
        return ctypes.string_at(data_out.pbData, data_out.cbData)
    finally:
        kernel32.LocalFree(data_out.pbData)


def protect(data: bytes, entropy: bytes = b"winagent") -> bytes:
    return _call("CryptProtectData", data, entropy)


def unprotect(blob: bytes, entropy: bytes = b"winagent") -> bytes:
    return _call("CryptUnprotectData", blob, entropy)
