#!/usr/bin/env python3
"""Build a forward-only, source-anchored articulated loop from a JSON manifest.

This builder is intended for identity-critical loops where whole-frame video
diffusion redraws the subject or scene. Clean plates and pose keyframes are used
only inside declared masks. Visible articulated layers retain the source pixels
and can move as rigid parts or as attachment-anchored, forward-travelling fabric
waves; declared light and particle effects are composited in image space. No
whole-frame warp, optical-flow retiming, duplicated closure frame, or ping-pong
assembly is performed.

The output is a half-open PNG cycle. Encode it with
``scripts/encode_media_frames_with_worker.py --half-open-cycle`` so the worker
receives its expected terminal condition while publishing each loop instant once.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

import cv2
import numpy as np


SCHEMA_VERSION = 1


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be numeric")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{label} must be finite")
    return result


def _positive_odd(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{label} must be a positive odd integer")
    if value % 2 == 0:
        raise ValueError(f"{label} must be odd")
    return value


def _positive_integer(value: Any, label: str, maximum: int = 1_000_000) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value <= 0
        or value > maximum
    ):
        raise ValueError(f"{label} must be an integer from 1 through {maximum}")
    return value


def _color_bgr(value: Any, label: str) -> np.ndarray:
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError(f"{label} must be an RGB array with three values")
    rgb = [_number(channel, f"{label}[{index}]") for index, channel in enumerate(value)]
    if any(channel < 0.0 or channel > 255.0 for channel in rgb):
        raise ValueError(f"{label} values must be from 0 through 255")
    return np.asarray(rgb[::-1], dtype=np.float32)


def _resolve_path(root: Path, value: Any, label: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty path")
    candidate = Path(value)
    resolved = candidate.resolve() if candidate.is_absolute() else (root / candidate).resolve()
    if not resolved.is_file():
        raise ValueError(f"{label} does not exist: {resolved}")
    return resolved


def _load_color(path: Path, size: tuple[int, int] | None = None) -> np.ndarray:
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"Could not decode image: {path}")
    if size is not None and image.shape[:2] != size:
        raise ValueError(
            f"Image {path} has dimensions {image.shape[1]}x{image.shape[0]}; "
            f"expected {size[1]}x{size[0]}"
        )
    return image


def _load_mask(path: Path, size: tuple[int, int]) -> np.ndarray:
    mask = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if mask is None:
        raise ValueError(f"Could not decode mask: {path}")
    if mask.shape != size:
        raise ValueError(
            f"Mask {path} has dimensions {mask.shape[1]}x{mask.shape[0]}; "
            f"expected {size[1]}x{size[0]}"
        )
    return mask


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def _smoothstep(value: float) -> float:
    clamped = min(1.0, max(0.0, value))
    return clamped * clamped * (3.0 - 2.0 * clamped)


def _keyframe_value(
    phase: float,
    points_value: Any,
    label: str,
    interpolation: str,
) -> float:
    if not isinstance(points_value, list) or len(points_value) < 2:
        raise ValueError(f"{label}.points must contain at least two keyframes")
    points: list[tuple[float, float]] = []
    for index, item in enumerate(points_value):
        if not isinstance(item, list) or len(item) != 2:
            raise ValueError(f"{label}.points[{index}] must be [phase, value]")
        points.append(
            (
                _number(item[0], f"{label}.points[{index}][0]"),
                _number(item[1], f"{label}.points[{index}][1]"),
            )
        )
    if points[0][0] != 0.0 or points[-1][0] != 1.0:
        raise ValueError(f"{label}.points must span phase 0 through 1")
    if any(right[0] <= left[0] for left, right in zip(points, points[1:])):
        raise ValueError(f"{label}.points phases must increase strictly")
    for left, right in zip(points, points[1:]):
        if phase <= right[0]:
            fraction = (phase - left[0]) / (right[0] - left[0])
            if interpolation == "smoothstep":
                fraction = _smoothstep(fraction)
            elif interpolation != "linear":
                raise ValueError(
                    f"{label}.interpolation must be linear or smoothstep"
                )
            return left[1] + (right[1] - left[1]) * fraction
    return points[-1][1]


def _curve_value(specification: Any, phase: float, label: str) -> float:
    if isinstance(specification, (int, float)) and not isinstance(specification, bool):
        return _number(specification, label)
    spec = _object(specification, label)
    kind = spec.get("kind")
    offset = _number(spec.get("offset", 0.0), f"{label}.offset")
    if kind == "keyframes":
        return offset + _keyframe_value(
            phase,
            spec.get("points"),
            label,
            str(spec.get("interpolation", "smoothstep")),
        )
    if kind == "sine":
        amplitude = _number(spec.get("amplitude"), f"{label}.amplitude")
        cycles = _number(spec.get("cycles", 1.0), f"{label}.cycles")
        phase_offset = _number(spec.get("phaseOffset", 0.0), f"{label}.phaseOffset")
        return offset + amplitude * math.sin(
            2.0 * math.pi * (cycles * phase + phase_offset)
        )
    if kind == "raised-cosine":
        peak = _number(spec.get("peak"), f"{label}.peak")
        cycles = _number(spec.get("cycles", 1.0), f"{label}.cycles")
        phase_offset = _number(spec.get("phaseOffset", 0.0), f"{label}.phaseOffset")
        angle = 2.0 * math.pi * (cycles * phase + phase_offset)
        return offset + peak * (1.0 - math.cos(angle)) / 2.0
    if kind == "gaussian":
        amplitude = _number(spec.get("amplitude"), f"{label}.amplitude")
        center = _number(spec.get("center"), f"{label}.center")
        width = _number(spec.get("width"), f"{label}.width")
        if width <= 0.0:
            raise ValueError(f"{label}.width must be positive")
        return offset + amplitude * math.exp(-((phase - center) / width) ** 2)
    if kind == "sum":
        terms = spec.get("terms")
        if not isinstance(terms, list) or not terms:
            raise ValueError(f"{label}.terms must be a non-empty array")
        return offset + sum(
            _curve_value(term, phase, f"{label}.terms[{index}]")
            for index, term in enumerate(terms)
        )
    raise ValueError(
        f"{label}.kind must be keyframes, sine, raised-cosine, gaussian, or sum"
    )


def _align_to_source(source: np.ndarray, generated: np.ndarray) -> np.ndarray:
    source_gray = cv2.cvtColor(source, cv2.COLOR_BGR2GRAY)
    generated_gray = cv2.cvtColor(generated, cv2.COLOR_BGR2GRAY)
    matrix = np.eye(2, 3, dtype=np.float32)
    try:
        _, matrix = cv2.findTransformECC(
            source_gray,
            generated_gray,
            matrix,
            cv2.MOTION_AFFINE,
            (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-7),
            None,
            5,
        )
    except cv2.error as error:
        raise ValueError("Generated image could not be aligned to the source") from error
    return cv2.warpAffine(
        generated,
        matrix,
        (source.shape[1], source.shape[0]),
        flags=cv2.INTER_LANCZOS4 | cv2.WARP_INVERSE_MAP,
        borderMode=cv2.BORDER_REFLECT,
    )


def _feather(mask: np.ndarray, sigma: float) -> np.ndarray:
    if sigma < 0.0:
        raise ValueError("Mask feather sigma cannot be negative")
    normalized = mask.astype(np.float32) / 255.0
    if sigma == 0.0:
        return normalized
    return np.clip(cv2.GaussianBlur(normalized, (0, 0), sigma), 0.0, 1.0)


def _composite(base: np.ndarray, overlay: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    mixed = (
        overlay.astype(np.float32) * alpha[..., None]
        + base.astype(np.float32) * (1.0 - alpha[..., None])
    )
    return np.clip(np.rint(mixed), 0, 255).astype(np.uint8)


def _screen_color(
    base: np.ndarray,
    color_bgr: np.ndarray,
    alpha: np.ndarray,
) -> np.ndarray:
    normalized = base.astype(np.float32) / 255.0
    color = color_bgr.reshape((1, 1, 3)) / 255.0
    amount = np.clip(alpha, 0.0, 1.0)[..., None]
    screened = 1.0 - (1.0 - normalized) * (1.0 - color * amount)
    return np.clip(np.rint(screened * 255.0), 0, 255).astype(np.uint8)


def _ellipse_mask(
    size: tuple[int, int],
    ellipses: list[Any],
    label: str,
) -> np.ndarray:
    mask = np.zeros(size, dtype=np.uint8)
    for index, ellipse_value in enumerate(ellipses):
        ellipse = _object(ellipse_value, f"{label}[{index}]")
        center = ellipse.get("center")
        axes = ellipse.get("axes")
        if not isinstance(center, list) or len(center) != 2:
            raise ValueError(f"{label}[{index}].center must have two values")
        if not isinstance(axes, list) or len(axes) != 2:
            raise ValueError(f"{label}[{index}].axes must have two values")
        center_values = (
            round(_number(center[0], f"{label}[{index}].center[0]")),
            round(_number(center[1], f"{label}[{index}].center[1]")),
        )
        axes_values = (
            round(_number(axes[0], f"{label}[{index}].axes[0]")),
            round(_number(axes[1], f"{label}[{index}].axes[1]")),
        )
        if axes_values[0] <= 0 or axes_values[1] <= 0:
            raise ValueError(f"{label}[{index}].axes must be positive")
        cv2.ellipse(
            mask,
            center_values,
            axes_values,
            _number(ellipse.get("angle", 0.0), f"{label}[{index}].angle"),
            0,
            360,
            255,
            -1,
        )
    return mask


def _procedural_blink_images(
    source: np.ndarray,
    ellipses: list[Any],
    feather_sigma: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    eye_mask = _ellipse_mask(source.shape[:2], ellipses, "blink.maskEllipses")
    eye_alpha = _feather(eye_mask, feather_sigma)
    closed = source.copy()
    for index, ellipse_value in enumerate(ellipses):
        ellipse = _object(ellipse_value, f"blink.maskEllipses[{index}]")
        local_mask = _ellipse_mask(
            source.shape[:2], [ellipse], f"blink.maskEllipses[{index}:]"
        )
        center = ellipse["center"]
        axes = ellipse["axes"]
        center_y = round(_number(center[1], f"blink.maskEllipses[{index}].center[1]"))
        axis_y = round(_number(axes[1], f"blink.maskEllipses[{index}].axes[1]"))
        fill_offset = round(
            _number(
                ellipse.get("fillSourceOffsetY", 7.0),
                f"blink.maskEllipses[{index}].fillSourceOffsetY",
            )
        )
        skin = cv2.GaussianBlur(source, (0, 0), 1.1)
        shifted = source.copy()
        top = max(0, center_y - axis_y - 3)
        bottom = min(source.shape[0], center_y + axis_y + 4)
        for destination_y in range(top, bottom):
            source_y = round(
                center_y
                + axis_y
                + fill_offset
                + 0.12 * (destination_y - center_y)
            )
            source_y = min(source.shape[0] - 1, max(0, source_y))
            shifted[destination_y] = skin[source_y]
        local_alpha = _feather(local_mask, max(0.8, feather_sigma * 0.55))
        closed = _composite(closed, shifted, local_alpha)
        lash_points = ellipse.get("lashPoints")
        if not isinstance(lash_points, list) or len(lash_points) < 2:
            raise ValueError(
                f"blink.maskEllipses[{index}].lashPoints must contain at least two points"
            )
        points: list[tuple[int, int]] = []
        for point_index, point in enumerate(lash_points):
            if not isinstance(point, list) or len(point) != 2:
                raise ValueError(
                    f"blink.maskEllipses[{index}].lashPoints[{point_index}] "
                    "must have two values"
                )
            points.append(
                (
                    round(
                        _number(
                            point[0],
                            f"blink.maskEllipses[{index}].lashPoints[{point_index}][0]",
                        )
                    ),
                    round(
                        _number(
                            point[1],
                            f"blink.maskEllipses[{index}].lashPoints[{point_index}][1]",
                        )
                    ),
                )
            )
        color = _color_bgr(
            ellipse.get("lashColorRgb", [29, 19, 24]),
            f"blink.maskEllipses[{index}].lashColorRgb",
        )
        thickness = _positive_integer(
            ellipse.get("lashThickness", 3),
            f"blink.maskEllipses[{index}].lashThickness",
            32,
        )
        cv2.polylines(
            closed,
            [np.asarray(points, dtype=np.int32)],
            False,
            tuple(float(channel) for channel in color),
            thickness,
            cv2.LINE_AA,
        )
    halfway = cv2.addWeighted(source, 0.46, closed, 0.54, 0.0)
    half = _composite(source, halfway, eye_alpha)
    closed = _composite(source, closed, eye_alpha)
    return half, closed, eye_alpha


def _transform_layer(
    layer: np.ndarray,
    alpha: np.ndarray,
    pivot: tuple[float, float],
    angle: float,
    dx: float,
    dy: float,
) -> tuple[np.ndarray, np.ndarray]:
    if abs(angle) < 1e-12 and abs(dx) < 1e-12 and abs(dy) < 1e-12:
        return layer, alpha
    matrix = cv2.getRotationMatrix2D(pivot, angle, 1.0)
    matrix[0, 2] += dx
    matrix[1, 2] += dy
    size = (layer.shape[1], layer.shape[0])
    moved_layer = cv2.warpAffine(
        layer,
        matrix,
        size,
        flags=cv2.INTER_LANCZOS4,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0),
    )
    moved_alpha = cv2.warpAffine(
        alpha,
        matrix,
        size,
        flags=cv2.INTER_LANCZOS4,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    return moved_layer, np.clip(moved_alpha, 0.0, 1.0)


def _point(
    value: Any,
    label: str,
) -> tuple[float, float]:
    if not isinstance(value, list) or len(value) != 2:
        raise ValueError(f"{label} must have two values")
    return (
        _number(value[0], f"{label}[0]"),
        _number(value[1], f"{label}[1]"),
    )


def _prepare_wind_fabric(
    value: Any,
    xx: np.ndarray,
    yy: np.ndarray,
    label: str,
) -> dict[str, Any] | None:
    if value is None:
        return None
    config = _object(value, label)
    kind = str(config.get("type"))
    if kind != "wind-fabric":
        raise ValueError(f"{label}.type must be wind-fabric")
    anchor = _point(config.get("anchor"), f"{label}.anchor")
    tip = _point(config.get("tip"), f"{label}.tip")
    axis_x = tip[0] - anchor[0]
    axis_y = tip[1] - anchor[1]
    length = math.hypot(axis_x, axis_y)
    if length < 1.0:
        raise ValueError(f"{label}.anchor and {label}.tip must be distinct")
    axis_x /= length
    axis_y /= length
    normal_x = -axis_y
    normal_y = axis_x
    attachment = _number(
        config.get("attachmentFraction", 0.08),
        f"{label}.attachmentFraction",
    )
    falloff_power = _number(
        config.get("falloffPower", 1.35), f"{label}.falloffPower"
    )
    if not 0.0 <= attachment < 0.9:
        raise ValueError(f"{label}.attachmentFraction must be from 0 through 0.9")
    if not 0.25 <= falloff_power <= 8.0:
        raise ValueError(f"{label}.falloffPower must be from 0.25 through 8")
    longitudinal = (
        (xx - anchor[0]) * axis_x + (yy - anchor[1]) * axis_y
    ) / length
    normalized = np.clip(
        (longitudinal - attachment) / (1.0 - attachment), 0.0, 1.0
    ).astype(np.float32)
    weight = (normalized * normalized * (3.0 - 2.0 * normalized)) ** falloff_power
    waves_value = config.get("waves")
    if not isinstance(waves_value, list) or not waves_value or len(waves_value) > 8:
        raise ValueError(f"{label}.waves must contain from one through eight waves")
    waves: list[dict[str, float]] = []
    for wave_index, wave_value in enumerate(waves_value):
        wave_label = f"{label}.waves[{wave_index}]"
        wave = _object(wave_value, wave_label)
        normal_amplitude = _number(
            wave.get("normalAmplitude", 0.0), f"{wave_label}.normalAmplitude"
        )
        tangent_amplitude = _number(
            wave.get("tangentAmplitude", 0.0), f"{wave_label}.tangentAmplitude"
        )
        spatial_cycles = _number(
            wave.get("spatialCycles", 1.0), f"{wave_label}.spatialCycles"
        )
        temporal_cycles = _number(
            wave.get("temporalCycles", 1), f"{wave_label}.temporalCycles"
        )
        phase_offset = _number(
            wave.get("phaseOffset", 0.0), f"{wave_label}.phaseOffset"
        )
        if abs(normal_amplitude) > 256.0 or abs(tangent_amplitude) > 256.0:
            raise ValueError(f"{wave_label} amplitudes must be from -256 through 256")
        if not 0.0 <= spatial_cycles <= 16.0:
            raise ValueError(f"{wave_label}.spatialCycles must be from 0 through 16")
        if (
            not temporal_cycles.is_integer()
            or not 1 <= int(temporal_cycles) <= 16
        ):
            raise ValueError(
                f"{wave_label}.temporalCycles must be an integer from 1 through 16"
            )
        waves.append(
            {
                "normalAmplitude": normal_amplitude,
                "tangentAmplitude": tangent_amplitude,
                "spatialCycles": spatial_cycles,
                "temporalCycles": temporal_cycles,
                "phaseOffset": phase_offset,
            }
        )
    shade_strength = _number(
        config.get("foldShadeStrength", 0.0), f"{label}.foldShadeStrength"
    )
    if not 0.0 <= shade_strength <= 0.4:
        raise ValueError(f"{label}.foldShadeStrength must be from 0 through 0.4")
    return {
        "kind": kind,
        "axisX": axis_x,
        "axisY": axis_y,
        "normalX": normal_x,
        "normalY": normal_y,
        "longitudinal": longitudinal.astype(np.float32),
        "weight": weight.astype(np.float32),
        "waves": waves,
        "normalBias": config.get("normalBias", 0.0),
        "tangentBias": config.get("tangentBias", 0.0),
        "foldShadeStrength": shade_strength,
        "xx": xx,
        "yy": yy,
    }


def _deform_wind_fabric_layer(
    layer: np.ndarray,
    alpha: np.ndarray,
    deformation: dict[str, Any],
    phase: float,
    label: str,
) -> tuple[np.ndarray, np.ndarray, dict[str, float]]:
    weight = deformation["weight"]
    longitudinal = deformation["longitudinal"]
    normal = weight * _curve_value(
        deformation["normalBias"], phase, f"{label}.normalBias"
    )
    tangent = weight * _curve_value(
        deformation["tangentBias"], phase, f"{label}.tangentBias"
    )
    shade_signal = np.zeros_like(weight)
    normal_scale = max(
        1.0,
        sum(abs(wave["normalAmplitude"]) for wave in deformation["waves"]),
    )
    for wave in deformation["waves"]:
        angle = 2.0 * math.pi * (
            wave["spatialCycles"] * longitudinal
            - wave["temporalCycles"] * phase
            + wave["phaseOffset"]
        )
        wave_sine = np.sin(angle).astype(np.float32)
        normal += weight * wave["normalAmplitude"] * wave_sine
        tangent += weight * wave["tangentAmplitude"] * wave_sine
        shade_signal += (
            weight
            * (wave["normalAmplitude"] / normal_scale)
            * np.cos(angle).astype(np.float32)
        )
    displacement_x = (
        tangent * deformation["axisX"] + normal * deformation["normalX"]
    )
    displacement_y = (
        tangent * deformation["axisY"] + normal * deformation["normalY"]
    )
    map_x = (deformation["xx"] - displacement_x).astype(np.float32)
    map_y = (deformation["yy"] - displacement_y).astype(np.float32)
    moved_layer = cv2.remap(
        layer,
        map_x,
        map_y,
        cv2.INTER_LANCZOS4,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0),
    )
    moved_alpha = cv2.remap(
        alpha,
        map_x,
        map_y,
        cv2.INTER_LANCZOS4,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    shade_strength = deformation["foldShadeStrength"]
    if shade_strength > 0.0:
        shade = np.clip(1.0 + shade_strength * shade_signal, 0.68, 1.32)
        moved_layer = np.clip(
            np.rint(moved_layer.astype(np.float32) * shade[..., None]), 0, 255
        ).astype(np.uint8)
    return moved_layer, np.clip(moved_alpha, 0.0, 1.0), {
        "normalDisplacementMinimum": round(float(normal.min()), 6),
        "normalDisplacementMaximum": round(float(normal.max()), 6),
        "tangentDisplacementMinimum": round(float(tangent.min()), 6),
        "tangentDisplacementMaximum": round(float(tangent.max()), 6),
    }


def _blink_amount(config: dict[str, Any], frame: int) -> float:
    values = _object(config.get("amountByFrame"), "blink.amountByFrame")
    raw = values.get(str(frame), 0.0)
    amount = _number(raw, f"blink.amountByFrame.{frame}")
    if not 0.0 <= amount <= 1.0:
        raise ValueError(f"blink amount for frame {frame} must be from 0 through 1")
    return amount


def _blink_pose(
    source: np.ndarray,
    half: np.ndarray,
    closed: np.ndarray,
    eye_alpha: np.ndarray,
    amount: float,
) -> np.ndarray:
    if amount <= 0.0:
        return source
    if amount <= 0.5:
        fraction = _smoothstep(amount / 0.5)
        pose = cv2.addWeighted(source, 1.0 - fraction, half, fraction, 0.0)
    else:
        fraction = _smoothstep((amount - 0.5) / 0.5)
        pose = cv2.addWeighted(half, 1.0 - fraction, closed, fraction, 0.0)
    return _composite(source, pose, eye_alpha)


def _apply_effect(
    frame: np.ndarray,
    effect: dict[str, Any],
    phase: float,
    label: str,
) -> tuple[np.ndarray, dict[str, Any]]:
    opacity = float(
        np.clip(_curve_value(effect["opacity"], phase, f"{label}.opacity"), 0.0, 1.0)
    )
    kind = effect["kind"]
    if kind == "masked-glow":
        alpha = effect["alpha"] * opacity
        return _screen_color(frame, effect["color"], alpha), {
            "opacity": round(opacity, 6)
        }
    if kind == "radial-glow":
        center_x = _curve_value(effect["x"], phase, f"{label}.x")
        center_y = _curve_value(effect["y"], phase, f"{label}.y")
        distance = (
            ((effect["xx"] - center_x) / effect["radiusX"]) ** 2
            + ((effect["yy"] - center_y) / effect["radiusY"]) ** 2
        )
        alpha = np.exp(-2.0 * distance).astype(np.float32) * opacity
        if effect["mask"] is not None:
            alpha *= effect["mask"]
        if effect["occlusion"] is not None:
            alpha *= 1.0 - effect["occlusion"]
        return _screen_color(frame, effect["color"], alpha), {
            "opacity": round(opacity, 6),
            "center": [round(center_x, 4), round(center_y, 4)],
        }
    if kind == "orbit-particles":
        particle_alpha = np.zeros(frame.shape[:2], dtype=np.float32)
        positions: list[list[float]] = []
        for particle in effect["particles"]:
            angle = 2.0 * math.pi * (
                particle["cycles"] * phase + particle["phaseOffset"]
            )
            x = particle["centerX"] + particle["amplitudeX"] * math.sin(angle)
            y = particle["centerY"] + particle["amplitudeY"] * math.cos(angle)
            twinkle_angle = 2.0 * math.pi * (
                particle["twinkleCycles"] * phase + particle["twinkleOffset"]
            )
            twinkle = 0.32 + 0.68 * (0.5 + 0.5 * math.sin(twinkle_angle))
            cv2.circle(
                particle_alpha,
                (round(x), round(y)),
                particle["radius"],
                float(opacity * twinkle),
                -1,
                cv2.LINE_AA,
            )
            if len(positions) < 4:
                positions.append([round(x, 3), round(y, 3)])
        sigma = effect["glowSigma"]
        if sigma > 0.0:
            particle_alpha = cv2.GaussianBlur(particle_alpha, (0, 0), sigma)
        particle_alpha = np.clip(particle_alpha, 0.0, 1.0)
        if effect["mask"] is not None:
            particle_alpha *= effect["mask"]
        if effect["occlusion"] is not None:
            particle_alpha *= 1.0 - effect["occlusion"]
        return _screen_color(frame, effect["color"], particle_alpha), {
            "opacity": round(opacity, 6),
            "samplePositions": positions,
        }
    if kind == "wind-streaks":
        streak_alpha = np.zeros(frame.shape[:2], dtype=np.float32)
        positions: list[list[float]] = []
        for streak in effect["streaks"]:
            progress = (
                streak["start"] + effect["speedCycles"] * phase
            ) % 1.0
            edge_distance = min(progress, 1.0 - progress)
            fade = _smoothstep(edge_distance / effect["edgeFadeFraction"])
            drift_angle = 2.0 * math.pi * (
                effect["driftCycles"] * phase + streak["driftOffset"]
            )
            x = effect["left"] + progress * effect["width"]
            y = (
                effect["top"]
                + streak["cross"] * effect["height"]
                + effect["driftAmplitude"] * math.sin(drift_angle)
            )
            half_length = streak["length"] * 0.5
            dx = effect["directionX"] * half_length
            dy = effect["directionY"] * half_length
            cv2.line(
                streak_alpha,
                (round(x - dx), round(y - dy)),
                (round(x + dx), round(y + dy)),
                float(opacity * streak["strength"] * fade),
                streak["thickness"],
                cv2.LINE_AA,
            )
            if len(positions) < 4:
                positions.append([round(x, 3), round(y, 3)])
        sigma = effect["glowSigma"]
        if sigma > 0.0:
            streak_alpha = cv2.GaussianBlur(streak_alpha, (0, 0), sigma)
        streak_alpha = np.clip(streak_alpha, 0.0, 1.0)
        if effect["mask"] is not None:
            streak_alpha *= effect["mask"]
        if effect["occlusion"] is not None:
            streak_alpha *= 1.0 - effect["occlusion"]
        return _screen_color(frame, effect["color"], streak_alpha), {
            "opacity": round(opacity, 6),
            "samplePositions": positions,
        }
    raise ValueError(f"Unsupported prepared effect kind: {kind}")


def build(manifest_path: Path, output_directory: Path) -> dict[str, Any]:
    manifest_path = manifest_path.resolve()
    manifest = _object(json.loads(manifest_path.read_text(encoding="utf-8")), "manifest")
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError(f"schemaVersion must be {SCHEMA_VERSION}")
    frame_count = manifest.get("frameCount")
    fps = manifest.get("fps")
    if isinstance(frame_count, bool) or not isinstance(frame_count, int) or frame_count < 3:
        raise ValueError("frameCount must be an integer of at least 3")
    if isinstance(fps, bool) or not isinstance(fps, int) or not 1 <= fps <= 60:
        raise ValueError("fps must be an integer from 1 through 60")

    output_directory = output_directory.resolve()
    if output_directory.exists() and any(output_directory.iterdir()):
        raise ValueError(f"Output directory is not empty: {output_directory}")
    output_directory.mkdir(parents=True, exist_ok=True)
    frames_directory = output_directory / "frames"
    diagnostics_directory = output_directory / "diagnostics"
    frames_directory.mkdir()
    diagnostics_directory.mkdir()

    manifest_root = manifest_path.parent
    source_path = _resolve_path(manifest_root, manifest.get("source"), "source")
    source = _load_color(source_path)
    size = source.shape[:2]
    mask_cache: dict[Path, np.ndarray] = {}
    input_paths: set[Path] = {source_path, manifest_path}

    def load_mask(value: Any, label: str) -> tuple[Path, np.ndarray]:
        path = _resolve_path(manifest_root, value, label)
        input_paths.add(path)
        if path not in mask_cache:
            mask_cache[path] = _load_mask(path, size)
        return path, mask_cache[path]

    plate = source.copy()
    clean_passes = manifest.get("cleanPlatePasses")
    if not isinstance(clean_passes, list) or not clean_passes:
        raise ValueError("cleanPlatePasses must be a non-empty array")
    for pass_index, pass_value in enumerate(clean_passes):
        config = _object(pass_value, f"cleanPlatePasses[{pass_index}]")
        mask_values = config.get("masks")
        if not isinstance(mask_values, list) or not mask_values:
            raise ValueError(f"cleanPlatePasses[{pass_index}].masks cannot be empty")
        masks = [
            load_mask(value, f"cleanPlatePasses[{pass_index}].masks[{index}]")[1]
            for index, value in enumerate(mask_values)
        ]
        combined = np.maximum.reduce(masks)
        dilation = _positive_odd(
            config.get("dilationSize", 9),
            f"cleanPlatePasses[{pass_index}].dilationSize",
        )
        removal = cv2.dilate(
            combined,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilation, dilation)),
            iterations=1,
        )
        mode = str(config.get("mode", "image"))
        if mode == "image":
            underlay_path = _resolve_path(
                manifest_root,
                config.get("underlay"),
                f"cleanPlatePasses[{pass_index}].underlay",
            )
            input_paths.add(underlay_path)
            underlay = _load_color(underlay_path, size)
            if config.get("alignToSource", True) is not True:
                raise ValueError("clean-plate underlays must be aligned to the source")
            underlay = _align_to_source(source, underlay)
        elif mode == "inpaint":
            radius = _number(
                config.get("inpaintRadius", 5.0),
                f"cleanPlatePasses[{pass_index}].inpaintRadius",
            )
            if not 0.5 <= radius <= 64.0:
                raise ValueError(
                    f"cleanPlatePasses[{pass_index}].inpaintRadius must be from 0.5 through 64"
                )
            algorithm = str(config.get("inpaintAlgorithm", "telea"))
            if algorithm not in ("telea", "navier-stokes"):
                raise ValueError(
                    f"cleanPlatePasses[{pass_index}].inpaintAlgorithm must be telea or navier-stokes"
                )
            method = cv2.INPAINT_TELEA if algorithm == "telea" else cv2.INPAINT_NS
            scale = _number(
                config.get("inpaintScale", 1.0),
                f"cleanPlatePasses[{pass_index}].inpaintScale",
            )
            if not 0.1 <= scale <= 1.0:
                raise ValueError(
                    f"cleanPlatePasses[{pass_index}].inpaintScale must be from 0.1 through 1"
                )
            if scale < 1.0:
                scaled_size = (
                    max(1, round(plate.shape[1] * scale)),
                    max(1, round(plate.shape[0] * scale)),
                )
                scaled_plate = cv2.resize(
                    plate, scaled_size, interpolation=cv2.INTER_AREA
                )
                scaled_removal = cv2.resize(
                    removal, scaled_size, interpolation=cv2.INTER_NEAREST
                )
                scaled_underlay = cv2.inpaint(
                    scaled_plate,
                    scaled_removal,
                    max(1.0, radius * scale),
                    method,
                )
                underlay = cv2.resize(
                    scaled_underlay,
                    (plate.shape[1], plate.shape[0]),
                    interpolation=cv2.INTER_CUBIC,
                )
            else:
                underlay = cv2.inpaint(plate, removal, radius, method)
        elif mode == "shadow-blur":
            blur_sigma = _number(
                config.get("blurSigma", 18.0),
                f"cleanPlatePasses[{pass_index}].blurSigma",
            )
            brightness = _number(
                config.get("brightness", 0.62),
                f"cleanPlatePasses[{pass_index}].brightness",
            )
            if not 0.5 <= blur_sigma <= 256.0:
                raise ValueError(
                    f"cleanPlatePasses[{pass_index}].blurSigma must be from 0.5 through 256"
                )
            if not 0.0 <= brightness <= 1.5:
                raise ValueError(
                    f"cleanPlatePasses[{pass_index}].brightness must be from 0 through 1.5"
                )
            underlay = cv2.GaussianBlur(plate, (0, 0), blur_sigma)
            underlay = np.clip(
                np.rint(underlay.astype(np.float32) * brightness), 0, 255
            ).astype(np.uint8)
        else:
            raise ValueError(
                f"cleanPlatePasses[{pass_index}].mode must be image, inpaint, or shadow-blur"
            )
        sigma = _number(
            config.get("featherSigma", 2.0),
            f"cleanPlatePasses[{pass_index}].featherSigma",
        )
        plate = _composite(plate, underlay, _feather(removal, sigma))

    blink_config = _object(manifest.get("blink"), "blink")
    ellipses = blink_config.get("maskEllipses")
    if not isinstance(ellipses, list) or not ellipses:
        raise ValueError("blink.maskEllipses must be a non-empty array")
    blink_feather = _number(
        blink_config.get("featherSigma", 8.0), "blink.featherSigma"
    )
    blink_mode = str(blink_config.get("mode", "images"))
    if blink_mode == "images":
        half_path = _resolve_path(
            manifest_root, blink_config.get("half"), "blink.half"
        )
        closed_path = _resolve_path(
            manifest_root, blink_config.get("closed"), "blink.closed"
        )
        input_paths.update((half_path, closed_path))
        half = _align_to_source(source, _load_color(half_path, size))
        closed = _align_to_source(source, _load_color(closed_path, size))
        eye_mask = _ellipse_mask(size, ellipses, "blink.maskEllipses")
        eye_alpha = _feather(eye_mask, blink_feather)
    elif blink_mode == "procedural":
        half, closed, eye_alpha = _procedural_blink_images(
            source, ellipses, blink_feather
        )
    else:
        raise ValueError("blink.mode must be images or procedural")

    yy, xx = np.indices(size, dtype=np.float32)
    layer_values = manifest.get("layers")
    if not isinstance(layer_values, list) or not layer_values:
        raise ValueError("layers must be a non-empty array")
    layers: list[dict[str, Any]] = []
    names: set[str] = set()
    for layer_index, layer_value in enumerate(layer_values):
        config = _object(layer_value, f"layers[{layer_index}]")
        name = config.get("name")
        if not isinstance(name, str) or not name or name in names:
            raise ValueError(f"layers[{layer_index}].name must be unique and non-empty")
        names.add(name)
        mask_path, mask = load_mask(config.get("mask"), f"layers[{layer_index}].mask")
        dilation = _positive_odd(
            config.get("maskDilationSize", 9),
            f"layers[{layer_index}].maskDilationSize",
        )
        layer_mask = cv2.dilate(
            mask,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilation, dilation)),
            iterations=1,
        )
        alpha = _feather(
            layer_mask,
            _number(
                config.get("maskFeatherSigma", 0.8),
                f"layers[{layer_index}].maskFeatherSigma",
            ),
        )
        pivot = config.get("pivot")
        if not isinstance(pivot, list) or len(pivot) != 2:
            raise ValueError(f"layers[{layer_index}].pivot must have two values")
        appearance = str(config.get("appearance", "source"))
        if appearance not in ("source", "blink"):
            raise ValueError(f"layers[{layer_index}].appearance must be source or blink")
        motion = _object(config.get("motion"), f"layers[{layer_index}].motion")
        layers.append(
            {
                "name": name,
                "maskPath": mask_path,
                "alpha": alpha,
                "pivot": (
                    _number(pivot[0], f"layers[{layer_index}].pivot[0]"),
                    _number(pivot[1], f"layers[{layer_index}].pivot[1]"),
                ),
                "appearance": appearance,
                "motion": motion,
                "deformation": _prepare_wind_fabric(
                    config.get("deformation"),
                    xx,
                    yy,
                    f"layers[{layer_index}].deformation",
                ),
            }
        )
        cv2.imwrite(str(diagnostics_directory / f"{name}-mask.png"), mask)

    effect_values = manifest.get("effects", [])
    if not isinstance(effect_values, list):
        raise ValueError("effects must be an array")
    effects: list[dict[str, Any]] = []
    effect_names: set[str] = set()
    for effect_index, effect_value in enumerate(effect_values):
        config = _object(effect_value, f"effects[{effect_index}]")
        name = config.get("name")
        if (
            not isinstance(name, str)
            or not name
            or name in effect_names
            or any(not (character.isalnum() or character in "-_") for character in name)
        ):
            raise ValueError(
                f"effects[{effect_index}].name must be unique and use letters, numbers, dashes, or underscores"
            )
        effect_names.add(name)
        kind = str(config.get("type"))
        if kind not in (
            "masked-glow",
            "radial-glow",
            "orbit-particles",
            "wind-streaks",
        ):
            raise ValueError(
                f"effects[{effect_index}].type must be masked-glow, radial-glow, orbit-particles, or wind-streaks"
            )
        stage = str(config.get("stage", "after-layers"))
        if stage not in ("before-layers", "after-layers"):
            raise ValueError(
                f"effects[{effect_index}].stage must be before-layers or after-layers"
            )
        prepared: dict[str, Any] = {
            "name": name,
            "kind": kind,
            "stage": stage,
            "color": _color_bgr(
                config.get("colorRgb"), f"effects[{effect_index}].colorRgb"
            ),
            "opacity": config.get("opacity", 1.0),
        }
        mask_alpha: np.ndarray | None = None
        if config.get("mask") is not None:
            _, effect_mask = load_mask(
                config.get("mask"), f"effects[{effect_index}].mask"
            )
            dilation = _positive_odd(
                config.get("maskDilationSize", 1),
                f"effects[{effect_index}].maskDilationSize",
            )
            if dilation > 1:
                effect_mask = cv2.dilate(
                    effect_mask,
                    cv2.getStructuringElement(
                        cv2.MORPH_ELLIPSE, (dilation, dilation)
                    ),
                    iterations=1,
                )
            mask_alpha = _feather(
                effect_mask,
                _number(
                    config.get("maskFeatherSigma", 0.0),
                    f"effects[{effect_index}].maskFeatherSigma",
                ),
            )
            cv2.imwrite(
                str(diagnostics_directory / f"effect-{name}-mask.png"), effect_mask
            )
        occlusion_alpha: np.ndarray | None = None
        if config.get("occlusionMask") is not None:
            _, occlusion_mask = load_mask(
                config.get("occlusionMask"),
                f"effects[{effect_index}].occlusionMask",
            )
            occlusion_alpha = _feather(
                occlusion_mask,
                _number(
                    config.get("occlusionFeatherSigma", 1.0),
                    f"effects[{effect_index}].occlusionFeatherSigma",
                ),
            )
        if kind == "masked-glow":
            if mask_alpha is None:
                raise ValueError(f"effects[{effect_index}].mask is required")
            blur_sigma = _number(
                config.get("glowSigma", 8.0),
                f"effects[{effect_index}].glowSigma",
            )
            if blur_sigma < 0.0 or blur_sigma > 256.0:
                raise ValueError(
                    f"effects[{effect_index}].glowSigma must be from 0 through 256"
                )
            prepared["alpha"] = (
                cv2.GaussianBlur(mask_alpha, (0, 0), blur_sigma)
                if blur_sigma > 0.0
                else mask_alpha
            )
        elif kind == "radial-glow":
            radius_x = _number(
                config.get("radiusX"), f"effects[{effect_index}].radiusX"
            )
            radius_y = _number(
                config.get("radiusY"), f"effects[{effect_index}].radiusY"
            )
            if radius_x <= 0.0 or radius_y <= 0.0:
                raise ValueError(f"effects[{effect_index}] radii must be positive")
            prepared.update(
                {
                    "x": config.get("x"),
                    "y": config.get("y"),
                    "radiusX": radius_x,
                    "radiusY": radius_y,
                    "xx": xx,
                    "yy": yy,
                    "mask": mask_alpha,
                    "occlusion": occlusion_alpha,
                }
            )
        elif kind == "orbit-particles":
            region = config.get("region")
            if not isinstance(region, list) or len(region) != 4:
                raise ValueError(
                    f"effects[{effect_index}].region must be [left, top, right, bottom]"
                )
            left, top, right, bottom = [
                _number(value, f"effects[{effect_index}].region[{index}]")
                for index, value in enumerate(region)
            ]
            if right <= left or bottom <= top:
                raise ValueError(f"effects[{effect_index}].region must have positive area")
            count = _positive_integer(
                config.get("count", 12), f"effects[{effect_index}].count", 256
            )
            seed = config.get("seed", 0)
            if isinstance(seed, bool) or not isinstance(seed, int):
                raise ValueError(f"effects[{effect_index}].seed must be an integer")
            amplitude_x = _number(
                config.get("amplitudeX", 18.0),
                f"effects[{effect_index}].amplitudeX",
            )
            amplitude_y = _number(
                config.get("amplitudeY", 10.0),
                f"effects[{effect_index}].amplitudeY",
            )
            radius_min = _positive_integer(
                config.get("radiusMin", 1),
                f"effects[{effect_index}].radiusMin",
                64,
            )
            radius_max = _positive_integer(
                config.get("radiusMax", 3),
                f"effects[{effect_index}].radiusMax",
                64,
            )
            if radius_max < radius_min:
                raise ValueError(
                    f"effects[{effect_index}].radiusMax cannot be below radiusMin"
                )
            cycles = _positive_integer(
                config.get("cycles", 1), f"effects[{effect_index}].cycles", 16
            )
            twinkle_cycles = _positive_integer(
                config.get("twinkleCycles", 2),
                f"effects[{effect_index}].twinkleCycles",
                32,
            )
            rng = np.random.default_rng(seed)
            particles = []
            for _ in range(count):
                particles.append(
                    {
                        "centerX": float(rng.uniform(left, right)),
                        "centerY": float(rng.uniform(top, bottom)),
                        "amplitudeX": float(
                            rng.uniform(0.45 * amplitude_x, amplitude_x)
                        ),
                        "amplitudeY": float(
                            rng.uniform(0.45 * amplitude_y, amplitude_y)
                        ),
                        "phaseOffset": float(rng.uniform(0.0, 1.0)),
                        "twinkleOffset": float(rng.uniform(0.0, 1.0)),
                        "cycles": cycles,
                        "twinkleCycles": twinkle_cycles,
                        "radius": int(rng.integers(radius_min, radius_max + 1)),
                    }
                )
            glow_sigma = _number(
                config.get("glowSigma", 3.0),
                f"effects[{effect_index}].glowSigma",
            )
            if glow_sigma < 0.0 or glow_sigma > 64.0:
                raise ValueError(
                    f"effects[{effect_index}].glowSigma must be from 0 through 64"
                )
            prepared.update(
                {
                    "particles": particles,
                    "glowSigma": glow_sigma,
                    "mask": mask_alpha,
                    "occlusion": occlusion_alpha,
                }
            )
        else:
            region = config.get("region")
            if not isinstance(region, list) or len(region) != 4:
                raise ValueError(
                    f"effects[{effect_index}].region must be [left, top, right, bottom]"
                )
            left, top, right, bottom = [
                _number(value, f"effects[{effect_index}].region[{index}]")
                for index, value in enumerate(region)
            ]
            if right <= left or bottom <= top:
                raise ValueError(f"effects[{effect_index}].region must have positive area")
            direction = _point(
                config.get("direction", [1.0, 0.0]),
                f"effects[{effect_index}].direction",
            )
            direction_length = math.hypot(direction[0], direction[1])
            if direction_length < 1e-6:
                raise ValueError(f"effects[{effect_index}].direction cannot be zero")
            count = _positive_integer(
                config.get("count", 24), f"effects[{effect_index}].count", 256
            )
            seed = config.get("seed", 0)
            if isinstance(seed, bool) or not isinstance(seed, int):
                raise ValueError(f"effects[{effect_index}].seed must be an integer")
            speed_cycles = _positive_integer(
                config.get("speedCycles", 1),
                f"effects[{effect_index}].speedCycles",
                16,
            )
            drift_cycles = _positive_integer(
                config.get("driftCycles", 1),
                f"effects[{effect_index}].driftCycles",
                16,
            )
            drift_amplitude = _number(
                config.get("driftAmplitude", 8.0),
                f"effects[{effect_index}].driftAmplitude",
            )
            if not 0.0 <= drift_amplitude <= 256.0:
                raise ValueError(
                    f"effects[{effect_index}].driftAmplitude must be from 0 through 256"
                )
            length_min = _positive_integer(
                config.get("lengthMin", 18),
                f"effects[{effect_index}].lengthMin",
                512,
            )
            length_max = _positive_integer(
                config.get("lengthMax", 64),
                f"effects[{effect_index}].lengthMax",
                512,
            )
            thickness_min = _positive_integer(
                config.get("thicknessMin", 1),
                f"effects[{effect_index}].thicknessMin",
                16,
            )
            thickness_max = _positive_integer(
                config.get("thicknessMax", 2),
                f"effects[{effect_index}].thicknessMax",
                16,
            )
            if length_max < length_min or thickness_max < thickness_min:
                raise ValueError(
                    f"effects[{effect_index}] maximum streak dimensions cannot be below their minima"
                )
            edge_fade = _number(
                config.get("edgeFadeFraction", 0.12),
                f"effects[{effect_index}].edgeFadeFraction",
            )
            if not 0.01 <= edge_fade <= 0.45:
                raise ValueError(
                    f"effects[{effect_index}].edgeFadeFraction must be from 0.01 through 0.45"
                )
            glow_sigma = _number(
                config.get("glowSigma", 1.2),
                f"effects[{effect_index}].glowSigma",
            )
            if not 0.0 <= glow_sigma <= 64.0:
                raise ValueError(
                    f"effects[{effect_index}].glowSigma must be from 0 through 64"
                )
            rng = np.random.default_rng(seed)
            streaks = [
                {
                    "start": float(rng.uniform(0.0, 1.0)),
                    "cross": float(rng.uniform(0.02, 0.98)),
                    "driftOffset": float(rng.uniform(0.0, 1.0)),
                    "length": int(rng.integers(length_min, length_max + 1)),
                    "thickness": int(
                        rng.integers(thickness_min, thickness_max + 1)
                    ),
                    "strength": float(rng.uniform(0.55, 1.0)),
                }
                for _ in range(count)
            ]
            prepared.update(
                {
                    "left": left,
                    "top": top,
                    "width": right - left,
                    "height": bottom - top,
                    "directionX": direction[0] / direction_length,
                    "directionY": direction[1] / direction_length,
                    "speedCycles": speed_cycles,
                    "driftCycles": drift_cycles,
                    "driftAmplitude": drift_amplitude,
                    "edgeFadeFraction": edge_fade,
                    "glowSigma": glow_sigma,
                    "streaks": streaks,
                    "mask": mask_alpha,
                    "occlusion": occlusion_alpha,
                }
            )
        effects.append(prepared)

    cv2.imwrite(str(diagnostics_directory / "clean-plate.png"), plate)
    cv2.imwrite(str(diagnostics_directory / "blink-half.png"), half)
    cv2.imwrite(str(diagnostics_directory / "blink-closed.png"), closed)
    per_frame: list[dict[str, Any]] = []
    rendered_frames: list[np.ndarray] = []
    for frame_index in range(frame_count):
        phase = frame_index / frame_count
        amount = _blink_amount(blink_config, frame_index)
        blink_pose = _blink_pose(source, half, closed, eye_alpha, amount)
        frame = plate.copy()
        effect_motion: dict[str, dict[str, Any]] = {}
        for effect_index, effect in enumerate(effects):
            if effect["stage"] != "before-layers":
                continue
            frame, evidence = _apply_effect(
                frame, effect, phase, f"effects[{effect_index}]"
            )
            effect_motion[effect["name"]] = evidence
        layer_motion: dict[str, dict[str, Any]] = {}
        for layer_index, layer in enumerate(layers):
            motion = layer["motion"]
            rotation = _curve_value(
                motion.get("rotationDegrees", 0.0),
                phase,
                f"layers[{layer_index}].motion.rotationDegrees",
            )
            x = _curve_value(
                motion.get("x", 0.0), phase, f"layers[{layer_index}].motion.x"
            )
            y = _curve_value(
                motion.get("y", 0.0), phase, f"layers[{layer_index}].motion.y"
            )
            appearance = blink_pose if layer["appearance"] == "blink" else source
            alpha = layer["alpha"]
            visible_layer = np.where(alpha[..., None] > 0.0, appearance, 0)
            deformation_evidence: dict[str, float] | None = None
            if layer["deformation"] is not None:
                visible_layer, alpha, deformation_evidence = (
                    _deform_wind_fabric_layer(
                        visible_layer,
                        alpha,
                        layer["deformation"],
                        phase,
                        f"layers[{layer_index}].deformation",
                    )
                )
            moved, moved_alpha = _transform_layer(
                visible_layer, alpha, layer["pivot"], rotation, x, y
            )
            frame = _composite(frame, moved, moved_alpha)
            layer_motion[layer["name"]] = {
                "rotationDegrees": round(rotation, 6),
                "x": round(x, 6),
                "y": round(y, 6),
                **(
                    {"deformation": deformation_evidence}
                    if deformation_evidence is not None
                    else {}
                ),
            }
        for effect_index, effect in enumerate(effects):
            if effect["stage"] != "after-layers":
                continue
            frame, evidence = _apply_effect(
                frame, effect, phase, f"effects[{effect_index}]"
            )
            effect_motion[effect["name"]] = evidence
        destination = frames_directory / f"frame-{frame_index:04d}.png"
        if not cv2.imwrite(str(destination), frame):
            raise RuntimeError(f"Could not write frame: {destination}")
        rendered_frames.append(frame)
        per_frame.append(
            {
                "frame": frame_index,
                "phase": round(phase, 6),
                "blinkAmount": round(amount, 6),
                "layers": layer_motion,
                "effects": effect_motion,
            }
        )

    rest = rendered_frames[0]
    cv2.imwrite(str(diagnostics_directory / "rest-reconstruction.png"), rest)
    difference = cv2.absdiff(source, rest).astype(np.int16)
    cv2.imwrite(
        str(diagnostics_directory / "rest-difference-x4.png"),
        np.clip(difference * 4, 0, 255).astype(np.uint8),
    )
    metadata = {
        "schemaVersion": SCHEMA_VERSION,
        "manifest": str(manifest_path),
        "source": str(source_path),
        "width": source.shape[1],
        "height": source.shape[0],
        "frameCount": frame_count,
        "fps": fps,
        "durationSeconds": frame_count / fps,
        "closedIntervalTerminalFrameOmitted": True,
        "playbackDirection": "forward",
        "inputSha256": {
            str(path): _sha256(path) for path in sorted(input_paths, key=str)
        },
        "motion": per_frame,
    }
    metadata_path = output_directory / "motion.json"
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return {
        "frames": str(frames_directory),
        "motion": str(metadata_path),
        "frameCount": frame_count,
        "fps": fps,
        "width": source.shape[1],
        "height": source.shape[0],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output_directory", type=Path)
    arguments = parser.parse_args()
    result = build(arguments.manifest, arguments.output_directory)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
