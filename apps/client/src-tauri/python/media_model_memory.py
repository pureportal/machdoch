from __future__ import annotations

import gc
import json
import time
from typing import Any


GPU_MEMORY_ERROR = "GPU out of memory. Close other GPU applications, reduce image dimensions, or choose a smaller model, then retry."


def retention_seconds(load_seconds: float) -> float:
    return min(600.0, max(120.0, load_seconds * 4))


def memory_snapshot(torch: Any, device: str) -> dict[str, Any]:
    if device == "cuda":
        free, total = torch.cuda.mem_get_info()
        allocated = torch.cuda.memory_allocated()
        reserved = torch.cuda.memory_reserved()
    elif device == "mps":
        total = torch.mps.recommended_max_memory()
        reserved = torch.mps.driver_allocated_memory()
        allocated = torch.mps.current_allocated_memory()
        free = max(0, total - reserved)
    else:
        return {"device": device, "pressure": False}
    headroom = max(512 * 1024**2, min(2 * 1024**3, int(total * 0.1)))
    return {
        "device": device,
        "freeBytes": int(free),
        "totalBytes": int(total),
        "allocatedBytes": int(allocated),
        "reservedBytes": int(reserved),
        "headroomBytes": headroom,
        "pressure": free < headroom,
    }


def release_allocator(torch: Any, device: str) -> None:
    if device == "cuda":
        torch.cuda.synchronize()
    elif device == "mps":
        torch.mps.synchronize()
    gc.collect()
    if device == "cuda":
        torch.cuda.empty_cache()
    elif device == "mps":
        torch.mps.empty_cache()


def is_gpu_out_of_memory(error: BaseException) -> bool:
    diagnostic = f"{type(error).__name__}: {error}".lower()
    return any(
        part in diagnostic
        for part in (
            "outofmemoryerror", "cuda out of memory", "hip out of memory",
            "mps backend out of memory", "hiperroroutofmemory",
            "cuda error: out of memory", "gpu out of memory",
        )
    )


class ImagePipelineCache:
    def __init__(self, torch: Any, device: str, started_at: float | None = None):
        self.torch = torch
        self.device = device
        self.key: str | None = None
        self.value: dict[str, Any] | None = None
        self.load_started_at = time.monotonic() if started_at is None else started_at
        self.retention = retention_seconds(0)

    def acquire(self, configuration: dict[str, Any]) -> dict[str, Any] | None:
        key = json.dumps(configuration, sort_keys=True, separators=(",", ":"))
        if self.key != key or memory_snapshot(self.torch, self.device)["pressure"]:
            self.clear()
        if memory_snapshot(self.torch, self.device)["pressure"]:
            raise RuntimeError(GPU_MEMORY_ERROR)
        self.key = key
        return self.value

    def store(self, value: dict[str, Any]) -> None:
        self.value = value
        self.retention = retention_seconds(time.monotonic() - self.load_started_at)

    def clear(self) -> None:
        had_value = self.value is not None
        self.value = None
        self.key = None
        release_allocator(self.torch, self.device)
        if had_value:
            self.load_started_at = time.monotonic()
