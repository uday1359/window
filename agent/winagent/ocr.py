"""Text recognition with the OCR engine built into Windows 10/11 (Windows.Media.Ocr).

Used as a fallback when UI Automation cannot read text (FR-04). It runs through Windows
PowerShell, so no extra Python packages or cloud services are involved: images never leave
the computer. The script is a constant; the image path is passed in an environment variable
so nothing from a task can be injected into the command.
"""

from __future__ import annotations

import json
import os
import subprocess  # noqa: S404 - fixed command line, no shell
from pathlib import Path

from .errors import OpError

OCR_TIMEOUT_S = 60
MAX_TEXT = 20_000

_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($operation, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  [void]$task.Wait(-1)
  $task.Result
}
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { [Console]::Error.WriteLine('NO_OCR_LANGUAGE'); exit 3 }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:WINAGENT_OCR_IMAGE)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
} finally { $stream.Dispose() }
$lines = @($result.Lines | ForEach-Object { $_.Text })
ConvertTo-Json -Compress @{ language = $engine.RecognizerLanguage.LanguageTag; lines = $lines }
"""


def recognize(image: Path) -> dict:
    """Returns {"language", "lines", "text"} for a PNG/JPEG/BMP image."""
    if not image.is_file():
        raise OpError("NOT_FOUND", "image to read does not exist")
    env = {**os.environ, "WINAGENT_OCR_IMAGE": str(image.resolve())}
    # Full path from the Windows folder, so a powershell.exe planted earlier on PATH is never run.
    windows_dir = os.environ.get("SystemRoot") or os.environ.get("windir")
    if not windows_dir:
        raise OpError("UNSUPPORTED", "the Windows folder is unknown (SystemRoot is not set)")
    powershell = Path(windows_dir) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    try:
        proc = subprocess.run(  # noqa: S603 - constant program and script
            [str(powershell), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", _SCRIPT],
            env=env,
            capture_output=True,
            timeout=OCR_TIMEOUT_S,
            check=False,
        )
    except FileNotFoundError as exc:
        raise OpError("UNSUPPORTED", "Windows PowerShell is not available for OCR") from exc
    except subprocess.TimeoutExpired as exc:
        raise OpError("TIMEOUT", "text recognition took too long") from exc
    if proc.returncode == 3:
        raise OpError("UNSUPPORTED", "no Windows OCR language is installed (Settings > Time & language > Language: add a language with 'Optical character recognition')")
    if proc.returncode != 0:
        detail = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        raise OpError("ERROR", f"text recognition failed: {detail[-1][:200] if detail else 'unknown error'}")
    data = json.loads(proc.stdout.decode("utf-8-sig"))
    lines = data.get("lines") or []
    if isinstance(lines, str):  # ConvertTo-Json flattens a one-element array
        lines = [lines]
    text = "\n".join(lines)
    return {"language": data.get("language"), "lines": len(lines), "text": text[:MAX_TEXT], "truncated": len(text) > MAX_TEXT}
