"""Windows OCR (Windows.Media.Ocr through PowerShell). Real engine, no mocks."""

import struct
import zlib

import pytest

from winagent import ocr
from winagent.errors import OpError


def _white_png(path, width=64, height=32):
    """Minimal valid PNG without an imaging library."""
    raw = b"".join(b"\x00" + b"\xff\xff\xff" * width for _ in range(height))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    path.write_bytes(png)
    return path


def test_blank_image_has_no_text(tmp_path):
    try:
        result = ocr.recognize(_white_png(tmp_path / "blank.png"))
    except OpError as exc:
        if exc.code == "UNSUPPORTED":
            pytest.skip(f"Windows OCR not available on this machine: {exc.message}")
        raise
    assert result["lines"] == 0 and result["text"] == "" and result["language"]


def test_missing_image_is_reported(tmp_path):
    with pytest.raises(OpError) as err:
        ocr.recognize(tmp_path / "missing.png")
    assert err.value.code == "NOT_FOUND"
