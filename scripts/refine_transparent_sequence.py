#!/usr/bin/env python3
"""Refine an existing Machdoch RGBA PNG sequence without rerunning diffusion."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from typing import Any

import imageio_ffmpeg
import numpy as np
from PIL import Image


WORKSPACE = Path(__file__).resolve().parents[1]
WORKER_PATH = WORKSPACE / "src-tauri" / "python" / "media_diffusers_worker.py"


def load_worker() -> Any:
    spec = importlib.util.spec_from_file_location("machdoch_media_worker", WORKER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load worker module from {WORKER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def encode_alpha_video(
    frame_directory: Path,
    destination: Path,
    fps: int,
    encoding_quality: str,
    worker: Any,
    width: int,
    height: int,
    frame_count: int,
) -> dict[str, Any]:
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    command = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-framerate",
        str(fps),
        "-i",
        str(frame_directory / "frame-%04d.png"),
        "-an",
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuva420p",
        *worker._vp9_quality_arguments(encoding_quality, alpha=True),  # noqa: SLF001
        str(destination),
    ]
    encoded = subprocess.run(command, capture_output=True, text=True, check=False)
    if encoded.returncode != 0:
        raise RuntimeError(f"VP9 alpha encode failed: {encoded.stderr[-2000:]}")
    verified = subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-c:v",
            "libvpx-vp9",
            "-i",
            str(destination),
            "-pix_fmt",
            "rgba",
            "-f",
            "rawvideo",
            "-",
        ],
        capture_output=True,
        check=False,
    )
    expected_bytes = width * height * 4 * frame_count
    if verified.returncode != 0 or len(verified.stdout) != expected_bytes:
        raise RuntimeError("Refined alpha WebM failed exact RGBA frame-count verification")
    decoded = np.frombuffer(verified.stdout, dtype=np.uint8).reshape(
        (frame_count, height, width, 4)
    )
    return {
        "decodedFrameCount": frame_count,
        "decodedAlphaMinimum": int(decoded[..., 3].min()),
        "decodedAlphaMaximum": int(decoded[..., 3].max()),
        "byteSize": destination.stat().st_size,
        "sha256": sha256(destination),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Apply Machdoch production transient-ground alpha suppression to an "
            "RGBA PNG sequence, then produce decode-verified VP9 alpha."
        )
    )
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--fps", type=int, default=8)
    parser.add_argument(
        "--encoding-quality",
        choices=("draft", "balanced", "production", "lossless"),
        default="lossless",
    )
    parser.add_argument(
        "--enchanted-beach",
        action="store_true",
        help="Also reproduce the verified enchanted-beach composite.",
    )
    parser.add_argument(
        "--animated-gradient",
        action="store_true",
        help="Also encode a custom animated-gradient composite.",
    )
    parser.add_argument("--background-color-start", default="#172554")
    parser.add_argument("--background-color-end", default="#7c3aed")
    parser.add_argument(
        "--background-direction",
        choices=("horizontal", "vertical", "diagonal"),
        default="vertical",
    )
    parser.add_argument("--background-cycles", type=int, default=1)
    parser.add_argument(
        "--rekey-production",
        action="store_true",
        help=(
            "Rebuild RGB-derived alpha with the complete production matte "
            "pipeline before temporal ground cleanup. Use this for legacy "
            "sequences whose original alpha contains persistent plate debris."
        ),
    )
    parser.add_argument(
        "--isolate-primary-subject",
        action="store_true",
        help=(
            "Apply production opaque-core hysteresis to the existing alpha "
            "without rebuilding its chroma key. This is the least destructive "
            "repair for a mostly clean matte with one large plate contaminant."
        ),
    )
    args = parser.parse_args()
    if args.rekey_production and args.isolate_primary_subject:
        parser.error(
            "--rekey-production already includes primary-subject isolation; "
            "do not combine it with --isolate-primary-subject"
        )
    if args.enchanted_beach and args.animated_gradient:
        parser.error(
            "--enchanted-beach and --animated-gradient are mutually exclusive"
        )
    if not 1 <= args.background_cycles <= 8:
        parser.error("--background-cycles must be between 1 and 8")
    input_directory = args.input.resolve(strict=True)
    output_directory = args.output.resolve()
    if output_directory.exists():
        if not output_directory.is_dir() or any(output_directory.iterdir()):
            raise RuntimeError("Output directory must not exist or must be empty")
    else:
        output_directory.mkdir(parents=True)
    frame_paths = sorted(input_directory.glob("frame-*.png"))
    if not frame_paths:
        raise RuntimeError("Input directory contains no frame-*.png sequence")
    rgba_frames: list[np.ndarray] = []
    for path in frame_paths:
        with Image.open(path) as opened:
            rgba_frames.append(np.asarray(opened.convert("RGBA"), dtype=np.uint8))
    shape = rgba_frames[0].shape
    if any(frame.shape != shape for frame in rgba_frames):
        raise RuntimeError("All input frames must have identical RGBA dimensions")

    worker = load_worker()
    matte = None
    primary_subject_isolation = None
    if args.rekey_production:
        # Stored Machdoch PNG sequences are straight RGBA with decontaminated
        # edge colors. Reconstruct a clean green plate through the existing
        # alpha before deriving a new matte; treating transparent under-color
        # as an opaque source can turn padded RGB into false foreground.
        green_plate = np.asarray([0.0, 255.0, 0.0], dtype=np.float32)
        rekey_frames: list[np.ndarray] = []
        for frame in rgba_frames:
            alpha = frame[..., 3:4].astype(np.float32) / 255.0
            composited = (
                frame[..., :3].astype(np.float32) * alpha
                + green_plate[None, None, :] * (1.0 - alpha)
            )
            rekey_frames.append(
                np.rint(np.clip(composited, 0.0, 255.0)).astype(np.uint8)
            )
        refined_frames, matte = worker._matte_video_frames(  # noqa: SLF001
            rekey_frames,
            "production",
        )
        suppression = matte["transientGroundSuppression"]
    else:
        source_alphas = [frame[..., 3] for frame in rgba_frames]
        if args.isolate_primary_subject:
            isolated = [
                worker._isolate_primary_alpha_subject(alpha)  # noqa: SLF001
                for alpha in source_alphas
            ]
            source_alphas = [frame[0] for frame in isolated]
            primary_subject_isolation = {
                "engine": "primary-opaque-core-hysteresis-v1",
                "appliedFrames": sum(
                    bool(frame[1].get("applied")) for frame in isolated
                ),
                "removedPixels": sum(
                    int(frame[1].get("removedPixels", 0)) for frame in isolated
                ),
                "frames": [frame[1] for frame in isolated],
            }
        cleaned_alphas, suppression = worker._suppress_transient_ground_alpha(  # noqa: SLF001
            source_alphas
        )
        refined_frames = [
            np.concatenate((frame[..., :3], alpha[..., None]), axis=2)
            for frame, alpha in zip(rgba_frames, cleaned_alphas, strict=True)
        ]
    refined_directory = output_directory / "frames"
    refined_directory.mkdir()
    for index, frame in enumerate(refined_frames):
        Image.fromarray(frame).save(
            refined_directory / f"frame-{index:04d}.png",
            format="PNG",
            compress_level=3,
        )

    height, width = shape[:2]
    transparent_path = output_directory / "output-0000.webm"
    transparent = encode_alpha_video(
        refined_directory,
        transparent_path,
        args.fps,
        args.encoding_quality,
        worker,
        width,
        height,
        len(refined_frames),
    )
    composite = None
    if args.enchanted_beach or args.animated_gradient:
        background = (
            {
                "style": "enchanted-beach",
                "direction": "diagonal",
                "colorStart": "#22d3ee",
                "colorEnd": "#a855f7",
                "cycles": 1,
            }
            if args.enchanted_beach
            else {
                "style": "gradient-wave",
                "direction": args.background_direction,
                "colorStart": args.background_color_start,
                "colorEnd": args.background_color_end,
                "cycles": args.background_cycles,
            }
        )
        composite_path, evidence = worker._encode_animated_composite(  # noqa: SLF001
            refined_frames,
            output_directory,
            args.fps,
            background,
            "none",
            args.encoding_quality,
        )
        composite = {
            **evidence,
            "byteSize": composite_path.stat().st_size,
            "sha256": sha256(composite_path),
        }
    report = {
        "schemaVersion": 1,
        "workerVersion": worker.WORKER_VERSION,
        "sourceDirectory": str(input_directory),
        "frameCount": len(refined_frames),
        "width": width,
        "height": height,
        "fps": args.fps,
        "encodingQuality": args.encoding_quality,
        "matteRebuilt": args.rekey_production,
        "matte": matte,
        "primarySubjectIsolation": primary_subject_isolation,
        "transientGroundSuppression": suppression,
        "transparentOutput": transparent,
        "compositeOutput": composite,
    }
    report_path = output_directory / "refinement-report.json"
    report_path.write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(report_path)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
