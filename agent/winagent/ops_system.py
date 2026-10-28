"""Resource monitoring (CPU, RAM, battery, GPU where accessible)."""

from __future__ import annotations

import shutil
import subprocess  # noqa: S404 - fixed nvidia-smi query, no shell
from typing import Any

import psutil


def _gpu() -> list[dict[str, Any]] | None:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        out = subprocess.run(  # noqa: S603
            [exe, "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        ).stdout
    except (subprocess.SubprocessError, OSError):
        return None
    gpus = []
    for line in out.strip().splitlines():
        parts = [s.strip() for s in line.split(",")]
        if len(parts) == 5:
            gpus.append({"name": parts[0], "utilPercent": float(parts[1]), "memUsedMb": float(parts[2]), "memTotalMb": float(parts[3]), "temperatureC": float(parts[4])})
    return gpus


def resources() -> dict[str, Any]:
    vm = psutil.virtual_memory()
    battery = psutil.sensors_battery()
    return {
        "cpuPercent": psutil.cpu_percent(interval=0.2),
        "cpuCount": psutil.cpu_count(),
        "memoryTotalMb": round(vm.total / 1048576),
        "memoryAvailableMb": round(vm.available / 1048576),
        "memoryPercent": vm.percent,
        "battery": {"percent": battery.percent, "plugged": battery.power_plugged} if battery else None,
        "gpu": _gpu(),
        # psutil exposes no CPU temperature on Windows; reported honestly as unavailable.
        "temperature": None,
    }
