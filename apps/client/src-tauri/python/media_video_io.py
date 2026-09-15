from __future__ import annotations

from pathlib import Path
import subprocess
import tempfile
import threading
from typing import Any


def encode_frames(
    ffmpeg: str,
    destination: Path,
    frames: list[Any],
    fps: int,
    output_arguments: list[str],
    *,
    alpha: bool,
    timeout_seconds: float = 900,
) -> None:
    import numpy as np

    if not frames:
        raise ValueError("Video encoding requires frames")
    height, width = frames[0].shape[:2]
    channels = 4 if alpha else 3
    if any(
        frame.dtype != np.uint8
        or frame.ndim != 3
        or frame.shape[:2] != (height, width)
        or frame.shape[2] < channels
        for frame in frames
    ):
        raise ValueError("Video frames must have matching dimensions and uint8 channels")
    command = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pixel_format", "rgba" if alpha else "rgb24",
        "-video_size", f"{width}x{height}", "-framerate", str(fps),
        "-i", "pipe:0", "-an", *output_arguments,
        "-fps_mode", "passthrough", str(destination),
    ]
    timed_out = threading.Event()
    with tempfile.TemporaryFile() as diagnostics:
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=diagnostics,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )

        def expire() -> None:
            timed_out.set()
            if process.poll() is None:
                process.kill()

        timer = threading.Timer(timeout_seconds, expire)
        timer.daemon = True
        timer.start()
        input_error = None
        try:
            if process.stdin is None:
                raise ValueError("Video encoder input is unavailable")
            try:
                for frame in frames:
                    process.stdin.write(
                        np.ascontiguousarray(frame[..., :channels]).tobytes()
                    )
                process.stdin.close()
            except OSError as error:
                input_error = error
                if process.poll() is None:
                    process.kill()
            process.wait()
            diagnostics.seek(0, 2)
            diagnostics.seek(max(0, diagnostics.tell() - 2_000))
            diagnostic = diagnostics.read().decode("utf-8", errors="replace").strip()
            if timed_out.is_set():
                raise ValueError("Video encoding timed out")
            if process.returncode != 0:
                raise ValueError(
                    "VP9 encoding failed: " + (diagnostic or str(input_error))[-2_000:]
                )
        finally:
            timer.cancel()
            if process.poll() is None:
                process.kill()
            process.wait()
            if process.stdin is not None and not process.stdin.closed:
                try:
                    process.stdin.close()
                except OSError:
                    if process.returncode == 0:
                        raise


def alpha_frame_coverage(frames: Any, label: str) -> list[dict[str, int]]:
    import numpy as np

    coverage = []
    for index, frame in enumerate(frames):
        alpha = frame[..., 3]
        minimum, maximum = int(alpha.min()), int(alpha.max())
        if minimum == 255:
            raise ValueError(
                f"{label} frame {index + 1} is fully opaque. "
                "Regenerate with a plain green background."
            )
        if maximum == 0:
            raise ValueError(
                f"{label} frame {index + 1} has no visible subject. "
                "Use a subject with colors distinct from green."
            )
        coverage.append({
            "minimum": minimum,
            "maximum": maximum,
            "transparentPixels": int(np.count_nonzero(alpha == 0)),
            "softPixels": int(np.count_nonzero((alpha > 0) & (alpha < 255))),
            "opaquePixels": int(np.count_nonzero(alpha == 255)),
        })
    return coverage
