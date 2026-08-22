"""Encode a PNG sequence through Media Studio's verified WebM path."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image


REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
WORKER_PATH = (
    REPOSITORY_ROOT / "src-tauri" / "python" / "media_diffusers_worker.py"
)


def _load_worker() -> Any:
    specification = importlib.util.spec_from_file_location(
        "machdoch_media_diffusers_worker",
        WORKER_PATH,
    )
    if specification is None or specification.loader is None:
        raise RuntimeError(f"Could not load Media Studio worker from {WORKER_PATH}")
    worker = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(worker)
    return worker


def _load_frames(directory: Path) -> list[Image.Image]:
    paths = sorted(directory.glob("frame-*.png"))
    if len(paths) < 2:
        raise RuntimeError(f"Expected at least two PNG frames in {directory}")
    frames = []
    expected_size = None
    for path in paths:
        with Image.open(path) as opened:
            frame = opened.convert("RGB")
            if expected_size is None:
                expected_size = frame.size
            elif frame.size != expected_size:
                raise RuntimeError(
                    f"Frame {path.name} has size {frame.size}; expected {expected_size}"
                )
            frames.append(frame.copy())
    return frames


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("frame_directory", type=Path)
    parser.add_argument("output_directory", type=Path)
    parser.add_argument("--fps", type=int, default=24)
    parser.add_argument(
        "--loop-mode",
        choices=("none", "ping-pong", "seamless"),
        default="seamless",
    )
    parser.add_argument(
        "--encoding-quality",
        choices=("preview", "production", "lossless"),
        default="lossless",
    )
    parser.add_argument(
        "--half-open-cycle",
        action="store_true",
        help="Append frame zero as terminal conditioning before seamless assembly.",
    )
    arguments = parser.parse_args()
    if arguments.fps <= 0:
        parser.error("--fps must be positive")

    frame_directory = arguments.frame_directory.resolve()
    output_directory = arguments.output_directory.resolve()
    if (output_directory / "frames").exists():
        raise RuntimeError(
            f"Application encoder output already exists in {output_directory}"
        )
    output_directory.mkdir(parents=True, exist_ok=True)
    frames = _load_frames(frame_directory)
    source_frame_count = len(frames)
    if arguments.half_open_cycle:
        if arguments.loop_mode != "seamless":
            parser.error("--half-open-cycle requires --loop-mode seamless")
        if np.array_equal(np.asarray(frames[0]), np.asarray(frames[-1])):
            raise RuntimeError(
                "Half-open input already ends on a duplicate closure frame"
            )
        frames.append(frames[0].copy())

    worker = _load_worker()
    destination, evidence, composite = worker._encode_video_webm(
        frames,
        output_directory,
        arguments.fps,
        None,
        transparent_background=False,
        loop_mode=arguments.loop_mode,
        matte_quality="production",
        encoding_quality=arguments.encoding_quality,
    )
    result = {
        "workerVersion": worker.WORKER_VERSION,
        "sourceFrameDirectory": str(frame_directory),
        "sourceFrameCount": source_frame_count,
        "halfOpenCycle": arguments.half_open_cycle,
        "destination": str(destination.resolve()),
        "evidence": evidence,
        "composite": composite,
    }
    evidence_path = output_directory / "application-encoding.json"
    evidence_path.write_text(
        json.dumps(result, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
