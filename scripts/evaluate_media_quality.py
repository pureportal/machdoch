#!/usr/bin/env python3
"""Generate reproducible visual and numeric evidence for Machdoch videos.

Unlike generic video readers, this script explicitly asks libvpx-vp9 to decode
WebM into RGBA. That matters because FFmpeg's native VP9 decoder can discard the
alpha plane and make a transparent asset look like its hidden chroma-key RGB.

The evaluator intentionally keeps semantic judgements (anatomy, identity, and
whether an action reads clearly) in the accompanying human rubric. The metrics
here cover properties that can be measured reliably without a learned critic:
decode integrity, sharpness, motion-compensated temporal residual, alpha
stability, edge spill, holes/components, coverage drift, and loop closure.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import json
import math
from pathlib import Path
import re
import subprocess
import tempfile
import time
from typing import Any, Iterable

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
BUNDLED_FFMPEG = (
    ROOT
    / "src-tauri"
    / "python"
    / "runtime"
    / "Lib"
    / "site-packages"
    / "imageio_ffmpeg"
    / "binaries"
    / "ffmpeg-win-x86_64-v7.1.exe"
)
VIDEO_SUFFIXES = {".webm", ".mp4", ".mov", ".mkv", ".avi"}
IMAGE_SUFFIXES = {".png", ".webp", ".jpg", ".jpeg"}


@dataclass(frozen=True)
class ClipInfo:
    source: str
    width: int
    height: int
    frame_count: int
    fps: float
    duration_seconds: float
    decoded_alpha: bool


def _rounded(value: float | np.floating[Any], digits: int = 6) -> float:
    return round(float(value), digits)


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    return _rounded(np.percentile(np.asarray(values, dtype=np.float64), percentile))


def _ffmpeg_path(explicit: Path | None) -> Path:
    if explicit is not None:
        candidate = explicit.resolve()
    elif BUNDLED_FFMPEG.is_file():
        candidate = BUNDLED_FFMPEG
    else:
        candidate = Path("ffmpeg")
    if candidate != Path("ffmpeg") and not candidate.is_file():
        raise SystemExit(f"FFmpeg does not exist: {candidate}")
    return candidate


def _probe_video(ffmpeg: Path, source: Path) -> tuple[int, int, float]:
    completed = subprocess.run(
        [
            str(ffmpeg),
            "-hide_banner",
            "-i",
            str(source),
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        check=False,
        timeout=10 * 60,
    )
    diagnostic = completed.stderr.decode("utf-8", errors="replace")
    video_line = next(
        (line for line in diagnostic.splitlines() if "Video:" in line),
        "",
    )
    dimension_match = re.search(r"(?<![\d.])(\d{2,5})x(\d{2,5})(?![\d.])", video_line)
    fps_match = re.search(r"(\d+(?:\.\d+)?)\s+fps\b", video_line)
    if dimension_match is None:
        raise SystemExit(f"Could not read video dimensions from FFmpeg:\n{video_line}")
    return (
        int(dimension_match.group(1)),
        int(dimension_match.group(2)),
        float(fps_match.group(1)) if fps_match else 0.0,
    )


def _decode_video(ffmpeg: Path, source: Path) -> tuple[np.ndarray, ClipInfo]:
    width, height, fps = _probe_video(ffmpeg, source)
    command = [
        str(ffmpeg),
        "-hide_banner",
        "-loglevel",
        "error",
    ]
    if source.suffix.lower() == ".webm":
        # FFmpeg's native VP9 decoder commonly drops WebM alpha. libvpx does not.
        command.extend(["-c:v", "libvpx-vp9"])
    command.extend(
        [
            "-i",
            str(source),
            "-an",
            "-sn",
            "-dn",
            "-pix_fmt",
            "rgba",
            "-f",
            "rawvideo",
            "-",
        ]
    )
    completed = subprocess.run(
        command,
        capture_output=True,
        check=False,
        timeout=10 * 60,
    )
    if completed.returncode != 0:
        raise SystemExit(
            "RGBA decode failed:\n"
            + completed.stderr.decode("utf-8", errors="replace")[-4_000:]
        )
    frame_bytes = width * height * 4
    if not completed.stdout or len(completed.stdout) % frame_bytes != 0:
        raise SystemExit(
            f"RGBA decode returned {len(completed.stdout)} bytes; "
            f"expected a multiple of {frame_bytes}"
        )
    frames = np.frombuffer(completed.stdout, dtype=np.uint8).reshape(
        (-1, height, width, 4)
    )
    alpha = frames[..., 3]
    decoded_alpha = bool(int(alpha.min()) < 255 and int(alpha.max()) == 255)
    if fps <= 0:
        fps = 1.0
    return frames.copy(), ClipInfo(
        source=str(source.resolve()),
        width=width,
        height=height,
        frame_count=len(frames),
        fps=fps,
        duration_seconds=len(frames) / fps,
        decoded_alpha=decoded_alpha,
    )


def _load_frame_directory(source: Path, fps: float) -> tuple[np.ndarray, ClipInfo]:
    paths = sorted(
        path
        for path in source.iterdir()
        if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES
    )
    if not paths:
        raise SystemExit(f"No image frames found in {source}")
    loaded: list[np.ndarray] = []
    expected_size: tuple[int, int] | None = None
    for path in paths:
        with Image.open(path) as opened:
            rgba = opened.convert("RGBA")
            if expected_size is None:
                expected_size = rgba.size
            elif rgba.size != expected_size:
                raise SystemExit(
                    f"Frame dimensions changed: {path} is {rgba.size}, "
                    f"expected {expected_size}"
                )
            loaded.append(np.asarray(rgba, dtype=np.uint8))
    frames = np.stack(loaded)
    alpha = frames[..., 3]
    assert expected_size is not None
    return frames, ClipInfo(
        source=str(source.resolve()),
        width=expected_size[0],
        height=expected_size[1],
        frame_count=len(frames),
        fps=fps,
        duration_seconds=len(frames) / fps,
        decoded_alpha=bool(int(alpha.min()) < 255 and int(alpha.max()) == 255),
    )


def _load_clip(
    source: Path,
    ffmpeg: Path,
    directory_fps: float,
) -> tuple[np.ndarray, ClipInfo]:
    if source.is_dir():
        return _load_frame_directory(source, directory_fps)
    if source.suffix.lower() in VIDEO_SUFFIXES:
        return _decode_video(ffmpeg, source)
    if source.suffix.lower() in IMAGE_SUFFIXES:
        with Image.open(source) as opened:
            rgba = np.asarray(opened.convert("RGBA"), dtype=np.uint8)[None, ...]
        height, width = rgba.shape[1:3]
        alpha = rgba[..., 3]
        return rgba, ClipInfo(
            source=str(source.resolve()),
            width=width,
            height=height,
            frame_count=1,
            fps=directory_fps,
            duration_seconds=1.0 / directory_fps,
            decoded_alpha=bool(int(alpha.min()) < 255 and int(alpha.max()) == 255),
        )
    raise SystemExit(f"Unsupported input: {source}")


def _checkerboard(height: int, width: int, cell: int = 16) -> np.ndarray:
    yy, xx = np.indices((height, width))
    cells = ((xx // cell + yy // cell) % 2)[..., None]
    dark = np.asarray([66, 70, 78], dtype=np.uint8)
    light = np.asarray([174, 179, 188], dtype=np.uint8)
    return np.where(cells == 0, dark, light).astype(np.uint8)


def _backgrounds(height: int, width: int) -> dict[str, np.ndarray]:
    solid = lambda color: np.broadcast_to(  # noqa: E731
        np.asarray(color, dtype=np.uint8),
        (height, width, 3),
    ).copy()
    return {
        "checker": _checkerboard(height, width),
        "white": solid((245, 245, 245)),
        "black": solid((8, 10, 14)),
        "magenta": solid((220, 16, 160)),
        "cyan": solid((0, 190, 220)),
    }


def _composite(rgba: np.ndarray, background: np.ndarray) -> np.ndarray:
    alpha = rgba[..., 3:4].astype(np.float32) / 255.0
    output = rgba[..., :3].astype(np.float32) * alpha
    output += background.astype(np.float32) * (1.0 - alpha)
    return np.rint(np.clip(output, 0.0, 255.0)).astype(np.uint8)


def _fit_thumbnail(rgb: np.ndarray, size: tuple[int, int]) -> Image.Image:
    return Image.fromarray(rgb).resize(size, Image.Resampling.LANCZOS)


def _contact_sheet(
    frames: np.ndarray,
    background: np.ndarray,
    destination: Path,
    title: str,
    columns: int = 4,
    frame_indices: Iterable[int] | None = None,
) -> None:
    indices = (
        list(range(len(frames)))
        if frame_indices is None
        else list(frame_indices)
    )
    if not indices:
        raise ValueError("A contact sheet requires at least one frame")
    count = len(indices)
    thumb_width = min(384, frames.shape[2])
    thumb_height = max(1, round(frames.shape[1] * thumb_width / frames.shape[2]))
    label_height = 24
    header_height = 38
    rows = math.ceil(count / columns)
    canvas = Image.new(
        "RGB",
        (thumb_width * columns, header_height + rows * (thumb_height + label_height)),
        (24, 27, 34),
    )
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default()
    draw.text((10, 11), title, fill=(242, 244, 248), font=font)
    for position, frame_index in enumerate(indices):
        row, column = divmod(position, columns)
        x = column * thumb_width
        y = header_height + row * (thumb_height + label_height)
        rgb = _composite(frames[frame_index], background)
        canvas.paste(_fit_thumbnail(rgb, (thumb_width, thumb_height)), (x, y))
        draw.rectangle(
            (x, y + thumb_height, x + thumb_width, y + thumb_height + label_height),
            fill=(24, 27, 34),
        )
        draw.text(
            (x + 8, y + thumb_height + 7),
            f"frame {frame_index:03d}",
            fill=(222, 226, 234),
            font=font,
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination, format="PNG", compress_level=5)


def _contact_sheet_pages(
    frames: np.ndarray,
    background: np.ndarray,
    clip_directory: Path,
    stem: str,
    title: str,
    frames_per_page: int = 24,
) -> list[str]:
    pages: list[str] = []
    page_count = math.ceil(len(frames) / frames_per_page)
    for page_index, start in enumerate(range(0, len(frames), frames_per_page)):
        end = min(start + frames_per_page, len(frames))
        suffix = "" if page_count == 1 else f"-page-{page_index + 1:03d}"
        destination = clip_directory / f"{stem}{suffix}.png"
        _contact_sheet(
            frames,
            background,
            destination,
            (
                title
                if page_count == 1
                else f"{title} | frames {start}-{end - 1}"
            ),
            frame_indices=range(start, end),
        )
        pages.append(str(destination.resolve()))
    return pages


def _alpha_components(alpha: np.ndarray) -> tuple[int, int]:
    binary = (alpha >= 128).astype(np.uint8)
    component_count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
    meaningful = int(
        np.sum(stats[1:, cv2.CC_STAT_AREA] >= max(8, alpha.size // 100_000))
    )
    inverse = (binary == 0).astype(np.uint8)
    hole_count, hole_labels, hole_stats, _ = cv2.connectedComponentsWithStats(
        inverse, 8
    )
    border_labels = set(
        np.concatenate(
            (
                hole_labels[0, :],
                hole_labels[-1, :],
                hole_labels[:, 0],
                hole_labels[:, -1],
            )
        ).tolist()
    )
    meaningful_holes = sum(
        1
        for label in range(1, hole_count)
        if label not in border_labels
        and int(hole_stats[label, cv2.CC_STAT_AREA])
        >= max(4, alpha.size // 250_000)
    )
    return meaningful, meaningful_holes


def _flow_warp(previous_gray: np.ndarray, current_gray: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    flow = cv2.calcOpticalFlowFarneback(
        previous_gray,
        current_gray,
        None,
        0.5,
        4,
        21,
        4,
        7,
        1.5,
        0,
    )
    height, width = previous_gray.shape
    xx, yy = np.meshgrid(
        np.arange(width, dtype=np.float32),
        np.arange(height, dtype=np.float32),
    )
    # Farneback maps previous pixels toward current pixels. Backward remapping
    # with the inverse displacement is a stable approximation for diagnostics.
    map_x = xx - flow[..., 0]
    map_y = yy - flow[..., 1]
    magnitude = np.linalg.norm(flow, axis=2)
    return np.stack((map_x, map_y), axis=-1), magnitude


def _remap(array: np.ndarray, maps: np.ndarray) -> np.ndarray:
    return cv2.remap(
        array,
        maps[..., 0],
        maps[..., 1],
        cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT101,
    )


def _edge_mask(alpha: np.ndarray) -> np.ndarray:
    binary = (alpha >= 128).astype(np.uint8)
    kernel = np.ones((3, 3), dtype=np.uint8)
    return cv2.morphologyEx(binary, cv2.MORPH_GRADIENT, kernel).astype(bool) | (
        (alpha > 8) & (alpha < 247)
    )


def _evaluate(frames: np.ndarray, info: ClipInfo) -> dict[str, Any]:
    rgba = frames.astype(np.uint8)
    alpha = rgba[..., 3]
    opaque_alpha = bool(int(alpha.min()) == 255)
    background = np.full((info.height, info.width, 3), 96, dtype=np.uint8)
    composited = np.stack([_composite(frame, background) for frame in rgba])
    grays = np.stack(
        [cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY) for frame in composited]
    )

    sharpness: list[float] = []
    alpha_coverages: list[float] = []
    fractional_coverages: list[float] = []
    component_counts: list[float] = []
    hole_counts: list[float] = []
    green_spill: list[float] = []
    for frame, gray, matte in zip(rgba, grays, alpha, strict=True):
        subject = matte >= 224
        sharp_values = cv2.Laplacian(gray, cv2.CV_32F)[subject]
        sharpness.append(float(np.var(sharp_values)) if sharp_values.size else 0.0)
        alpha_coverages.append(float(np.mean(matte >= 128)))
        fractional_coverages.append(float(np.mean((matte > 8) & (matte < 247))))
        components, holes = _alpha_components(matte)
        component_counts.append(float(components))
        hole_counts.append(float(holes))
        edges = _edge_mask(matte)
        if np.any(edges):
            pixels = frame[..., :3].astype(np.float32)[edges]
            spill = pixels[:, 1] - np.maximum(pixels[:, 0], pixels[:, 2])
            green_spill.append(float(np.maximum(spill, 0.0).mean()))
        else:
            green_spill.append(0.0)

    adjacent_mae: list[float] = []
    warped_rgb_mae: list[float] = []
    warped_alpha_mae: list[float] = []
    flow_magnitudes: list[float] = []
    high_frequency_residual: list[float] = []
    for index in range(1, len(rgba)):
        previous = composited[index - 1]
        current = composited[index]
        current_subject = alpha[index] >= 64
        union = current_subject | (alpha[index - 1] >= 64)
        absolute = np.abs(current.astype(np.int16) - previous.astype(np.int16))
        adjacent_mae.append(float(absolute[union].mean()) if np.any(union) else 0.0)
        maps, magnitude = _flow_warp(grays[index - 1], grays[index])
        warped_previous = _remap(previous, maps)
        warped_matte = _remap(alpha[index - 1], maps)
        residual = np.abs(
            current.astype(np.float32) - warped_previous.astype(np.float32)
        )
        stable_region = (alpha[index] >= 224) & (warped_matte >= 224)
        measure_region = stable_region if np.any(stable_region) else union
        warped_rgb_mae.append(
            float(residual[measure_region].mean()) if np.any(measure_region) else 0.0
        )
        warped_alpha_mae.append(
            float(
                np.abs(
                    alpha[index].astype(np.float32)
                    - warped_matte.astype(np.float32)
                )[union].mean()
            )
            if np.any(union)
            else 0.0
        )
        flow_magnitudes.append(float(magnitude[union].mean()) if np.any(union) else 0.0)
        current_high = current.astype(np.float32) - cv2.GaussianBlur(
            current.astype(np.float32), (0, 0), 1.2
        )
        previous_high = warped_previous.astype(np.float32) - cv2.GaussianBlur(
            warped_previous.astype(np.float32), (0, 0), 1.2
        )
        high_residual = np.abs(current_high - previous_high)
        high_frequency_residual.append(
            float(high_residual[measure_region].mean())
            if np.any(measure_region)
            else 0.0
        )

    first = composited[0].astype(np.int16)
    last = composited[-1].astype(np.int16)
    loop_union = (alpha[0] >= 64) | (alpha[-1] >= 64)
    loop_rgb_mae = (
        float(np.abs(first - last)[loop_union].mean()) if np.any(loop_union) else 0.0
    )
    loop_alpha_mae = float(
        np.mean(np.abs(alpha[0].astype(np.int16) - alpha[-1].astype(np.int16)))
    )

    def transition_peak(values: list[float]) -> dict[str, Any] | None:
        if not values:
            return None
        index = int(np.argmax(np.asarray(values, dtype=np.float64)))
        return {
            "fromFrame": index,
            "toFrame": index + 1,
            "value": _rounded(values[index]),
        }

    per_frame = []
    for index in range(len(rgba)):
        incoming = index - 1
        per_frame.append(
            {
                "frame": index,
                "sharpness": _rounded(sharpness[index]),
                "alphaCoverage": _rounded(alpha_coverages[index]),
                "fractionalAlphaCoverage": _rounded(
                    fractional_coverages[index]
                ),
                "components": int(component_counts[index]),
                "holes": int(hole_counts[index]),
                "greenSpill": _rounded(green_spill[index]),
                "incomingTransition": (
                    {
                        "adjacentSubjectRgbMae": _rounded(
                            adjacent_mae[incoming]
                        ),
                        "opticalFlowPixels": _rounded(
                            flow_magnitudes[incoming]
                        ),
                        "motionCompensatedRgbMae": _rounded(
                            warped_rgb_mae[incoming]
                        ),
                        "motionCompensatedHighFrequencyResidual": _rounded(
                            high_frequency_residual[incoming]
                        ),
                        "motionCompensatedAlphaMae": _rounded(
                            warped_alpha_mae[incoming]
                        ),
                    }
                    if incoming >= 0
                    else None
                ),
            }
        )

    return {
        "clip": asdict(info),
        "decode": {
            "allFramesFinite": True,
            "alphaMinimum": int(alpha.min()),
            "alphaMaximum": int(alpha.max()),
            "usableAlpha": info.decoded_alpha,
            "opaqueInput": opaque_alpha,
        },
        "spatial": {
            "subjectLaplacianVarianceMean": _rounded(np.mean(sharpness)),
            "subjectLaplacianVarianceP10": _percentile(sharpness, 10),
            "subjectLaplacianVarianceP90": _percentile(sharpness, 90),
        },
        "motion": {
            "adjacentSubjectRgbMaeMean": _rounded(np.mean(adjacent_mae))
            if adjacent_mae
            else 0.0,
            "opticalFlowPixelsMean": _rounded(np.mean(flow_magnitudes))
            if flow_magnitudes
            else 0.0,
            "opticalFlowPixelsP95": _percentile(flow_magnitudes, 95),
        },
        "temporal": {
            "motionCompensatedRgbMaeMean": _rounded(np.mean(warped_rgb_mae))
            if warped_rgb_mae
            else 0.0,
            "motionCompensatedRgbMaeP95": _percentile(warped_rgb_mae, 95),
            "motionCompensatedHighFrequencyResidualMean": _rounded(
                np.mean(high_frequency_residual)
            )
            if high_frequency_residual
            else 0.0,
        },
        "alpha": {
            "coverageMean": _rounded(np.mean(alpha_coverages)),
            "coverageStd": _rounded(np.std(alpha_coverages)),
            "fractionalEdgeCoverageMean": _rounded(
                np.mean(fractional_coverages)
            ),
            "motionCompensatedMaeMean": _rounded(np.mean(warped_alpha_mae))
            if warped_alpha_mae
            else 0.0,
            "motionCompensatedMaeP95": _percentile(warped_alpha_mae, 95),
            "meaningfulComponentsMean": _rounded(np.mean(component_counts)),
            "meaningfulComponentsMax": int(max(component_counts, default=0)),
            "holesMean": _rounded(np.mean(hole_counts)),
            "holesMax": int(max(hole_counts, default=0)),
            "positiveGreenSpillAtEdgeMean": _rounded(np.mean(green_spill)),
            "positiveGreenSpillAtEdgeP95": _percentile(green_spill, 95),
        },
        "loop": {
            "compositedSubjectRgbMae": _rounded(loop_rgb_mae),
            "alphaMae": _rounded(loop_alpha_mae),
        },
        "outliers": {
            "largestMotion": transition_peak(flow_magnitudes),
            "largestTemporalResidual": transition_peak(warped_rgb_mae),
            "largestTextureResidual": transition_peak(
                high_frequency_residual
            ),
            "largestAlphaResidual": transition_peak(warped_alpha_mae),
            "softestFrame": (
                {
                    "frame": int(np.argmin(np.asarray(sharpness))),
                    "value": _rounded(min(sharpness)),
                }
                if sharpness
                else None
            ),
        },
        "perFrame": per_frame,
    }


def _safe_name(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "-", value).strip("-") or "clip"


def _write_evidence(
    name: str,
    frames: np.ndarray,
    info: ClipInfo,
    output_directory: Path,
) -> dict[str, Any]:
    clip_directory = output_directory / _safe_name(name)
    clip_directory.mkdir(parents=True, exist_ok=True)
    diagnostics = _backgrounds(info.height, info.width)
    contact_sheets: dict[str, str] = {}
    all_frame_contact_sheets: dict[str, list[str]] = {}
    for background_name, background in diagnostics.items():
        pages = _contact_sheet_pages(
            frames,
            background,
            clip_directory,
            f"contact-{background_name}",
            f"{name} | {background_name} | true decoded RGBA",
        )
        contact_sheets[background_name] = pages[0]
        all_frame_contact_sheets[background_name] = pages
    alpha_rgba = np.empty_like(frames)
    alpha_rgba[..., :3] = frames[..., 3:4]
    alpha_rgba[..., 3] = 255
    alpha_pages = _contact_sheet_pages(
        alpha_rgba,
        np.zeros((info.height, info.width, 3), dtype=np.uint8),
        clip_directory,
        "contact-alpha",
        f"{name} | decoded alpha plane",
    )
    contact_sheets["alpha"] = alpha_pages[0]
    all_frame_contact_sheets["alpha"] = alpha_pages
    metrics = _evaluate(frames, info)
    metrics["evidence"] = {
        "contactSheets": contact_sheets,
        "allFrameContactSheets": all_frame_contact_sheets,
    }
    metrics_path = clip_directory / "metrics.json"
    metrics_path.write_text(
        json.dumps(metrics, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    metrics["evidence"]["metrics"] = str(metrics_path.resolve())
    return metrics


def _parse_input(value: str) -> tuple[str, Path]:
    if "=" in value:
        name, raw_path = value.split("=", 1)
    else:
        raw_path = value
        name = Path(raw_path).stem
    path = Path(raw_path).expanduser().resolve()
    if not path.exists():
        raise argparse.ArgumentTypeError(f"Input does not exist: {path}")
    return name.strip() or path.stem, path


def _comparison(records: dict[str, dict[str, Any]]) -> dict[str, Any]:
    fields = {
        "sharpness": ("spatial", "subjectLaplacianVarianceMean"),
        "motion": ("motion", "opticalFlowPixelsMean"),
        "temporalResidual": ("temporal", "motionCompensatedRgbMaeMean"),
        "textureCrawl": (
            "temporal",
            "motionCompensatedHighFrequencyResidualMean",
        ),
        "alphaInstability": ("alpha", "motionCompensatedMaeMean"),
        "alphaCoverageDrift": ("alpha", "coverageStd"),
        "greenSpill": ("alpha", "positiveGreenSpillAtEdgeMean"),
        "holes": ("alpha", "holesMean"),
        "loopRgbSeam": ("loop", "compositedSubjectRgbMae"),
        "loopAlphaSeam": ("loop", "alphaMae"),
    }
    return {
        label: {
            name: record[section][field]
            for name, record in records.items()
        }
        for label, (section, field) in fields.items()
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        action="append",
        required=True,
        metavar="NAME=PATH",
        help="Video, still, or PNG-frame directory. Repeat to compare clips.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Evidence directory (created if needed).",
    )
    parser.add_argument(
        "--ffmpeg",
        type=Path,
        help="FFmpeg executable; defaults to Machdoch's pinned imageio-ffmpeg.",
    )
    parser.add_argument(
        "--directory-fps",
        type=float,
        default=8.0,
        help="FPS metadata for frame directories and stills (default: 8).",
    )
    args = parser.parse_args()
    if not math.isfinite(args.directory_fps) or args.directory_fps <= 0:
        parser.error("--directory-fps must be positive")
    ffmpeg = _ffmpeg_path(args.ffmpeg)
    inputs = [_parse_input(value) for value in args.input]
    output_directory = args.output.resolve()
    output_directory.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    records: dict[str, dict[str, Any]] = {}
    for name, source in inputs:
        frames, info = _load_clip(source, ffmpeg, args.directory_fps)
        records[name] = _write_evidence(name, frames, info, output_directory)
    report = {
        "schemaVersion": 1,
        "generatedAtUnixSeconds": time.time(),
        "elapsedSeconds": _rounded(time.perf_counter() - started, 3),
        "ffmpeg": str(ffmpeg.resolve()) if ffmpeg != Path("ffmpeg") else "ffmpeg",
        "clips": records,
        "comparison": _comparison(records),
        "interpretation": {
            "lowerIsBetter": [
                "temporalResidual",
                "textureCrawl",
                "alphaInstability",
                "alphaCoverageDrift",
                "greenSpill",
                "holes",
                "loopRgbSeam",
                "loopAlphaSeam",
            ],
            "contextDependent": [
                "sharpness",
                "motion",
            ],
            "semanticReviewRequired": [
                "identity",
                "anatomy",
                "costumeAndPropContinuity",
                "actionReadability",
                "composition",
            ],
        },
    }
    report_path = output_directory / "report.json"
    report_path.write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(report_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
