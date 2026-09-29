"""Resource checks used before MiniMax rotation fine-tuning starts."""

import logging
import math
import subprocess
import time
from collections.abc import Callable


logger = logging.getLogger(__name__)

_POLL_INTERVAL_SECONDS = 2.0
_DEFAULT_TIMEOUT_SECONDS = 180.0
_MINIMUM_GPU_FREE_FRACTION = 0.75
_MINIMUM_RAM_AVAILABLE_FRACTION = 0.25


def _available_ram_gb() -> tuple[float | None, float | None]:
    """Return available and total system RAM in decimal GB, or unknown values."""
    try:
        import psutil

        memory = psutil.virtual_memory()
    except (ImportError, OSError, RuntimeError):
        return None, None

    available = memory.available / 1e9
    total = memory.total / 1e9
    if not (math.isfinite(available) and math.isfinite(total)
            and 0 <= available <= total and total > 0):
        return None, None
    return available, total


def _available_gpu_memory_gb() -> tuple[float, float] | None:
    try:
        result = subprocess.run(
            ["nvidia-smi", "--id=0", "--query-gpu=memory.free,memory.total",
             "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None

    if result.returncode != 0:
        return None
    try:
        free_mib, total_mib = (float(value.strip()) for value in result.stdout.splitlines()[0].split(","))
    except (IndexError, ValueError):
        return None
    if not (math.isfinite(free_mib) and math.isfinite(total_mib)
            and 0 <= free_mib <= total_mib and total_mib > 0):
        return None
    return free_mib * 2**20 / 1e9, total_mib * 2**20 / 1e9


def _wait_for_capacity(
    resource: str,
    measure: Callable[[], tuple[float | None, float | None] | None],
    minimum_fraction: float,
    timeout_seconds: float,
) -> None:
    if not math.isfinite(timeout_seconds) or timeout_seconds < 0:
        raise ValueError("timeout_seconds must be finite and non-negative")

    deadline = time.monotonic() + timeout_seconds
    while True:
        capacity = measure()
        if capacity is None or capacity[0] is None or capacity[1] is None:
            logger.warning("%s capacity is unavailable; skipping wait", resource)
            return
        available, total = capacity
        if available >= total * minimum_fraction:
            return

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(
                f"{resource} capacity did not recover within {timeout_seconds:g} seconds"
            )
        time.sleep(min(_POLL_INTERVAL_SECONDS, remaining))


def wait_for_gpu_handoff(timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS) -> None:
    """Wait for the previous process to release GPU memory without opening CUDA."""
    _wait_for_capacity("GPU", _available_gpu_memory_gb,
                       _MINIMUM_GPU_FREE_FRACTION, timeout_seconds)


def wait_for_ram_recovery(timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS) -> None:
    """Wait for the previous process to release system RAM."""
    _wait_for_capacity("RAM", _available_ram_gb,
                       _MINIMUM_RAM_AVAILABLE_FRACTION, timeout_seconds)
