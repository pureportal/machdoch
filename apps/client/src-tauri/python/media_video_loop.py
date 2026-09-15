from __future__ import annotations

import itertools
from typing import Any

import numpy as np

MAX_APPEARANCE_RATIO = 1.25
MAX_APPEARANCE_EXCESS = 1.0
MIN_SPEED_RATIO = 0.4
MAX_SPEED_RATIO = 2.0
MAX_VELOCITY_CHANGE_RATIO = 1.5
MAX_TURN_ALIGNMENT = -0.5


def overlap_frame_count(source_frame_count: int) -> int:
    if source_frame_count < 8:
        raise ValueError("Crossfade requires at least eight frames")
    return min(24, (source_frame_count - 1) // 2)


def inspection_indices(source_frame_count: int, loop_mode: str) -> list[int]:
    if loop_mode == "crossfade":
        overlap = overlap_frame_count(source_frame_count)
        return [
            0,
            *range(source_frame_count - 2 * overlap, source_frame_count - overlap),
        ]
    if loop_mode == "ping-pong":
        return [0, source_frame_count - 1]
    if loop_mode == "seamless":
        return [0]
    raise ValueError("Loop inspection requires a loop mode")


def _validate_frames(frames: list[Any]) -> None:
    if len(frames) < 4:
        raise ValueError("Video loop inspection requires at least four frames")
    shape = np.asarray(frames[0]).shape
    if any(
        np.asarray(frame).dtype != np.uint8
        or np.asarray(frame).shape != shape
        or np.asarray(frame).ndim != 3
        or np.asarray(frame).shape[2] not in (3, 4)
        for frame in frames
    ):
        raise ValueError(
            "Video loop frames must have matching RGB or RGBA uint8 pixels"
        )


def _visible_rgb(frame: Any) -> Any:
    if frame.shape[2] == 3:
        return frame
    alpha = frame[..., 3:4].astype(np.float32) / 255
    return np.rint(frame[..., :3] * alpha + 127 * (1 - alpha)).astype(np.uint8)


def _gray(frame: Any, maximum_size: int) -> tuple[Any, float]:
    import cv2

    scale = min(1.0, maximum_size / max(frame.shape[:2]))
    return cv2.cvtColor(
        cv2.resize(
            _visible_rgb(frame), None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA
        ),
        cv2.COLOR_RGB2GRAY,
    ), scale


def _flow(left: Any, right: Any) -> Any:
    import cv2

    return cv2.calcOpticalFlowFarneback(left, right, None, 0.5, 4, 25, 5, 7, 1.5, 0)


def crossfade_frames(frames: list[Any]) -> list[Any]:
    import cv2

    _validate_frames(frames)
    overlap = overlap_frame_count(len(frames))
    height, width = frames[0].shape[:2]
    grid = np.stack(
        np.meshgrid(
            np.arange(width, dtype=np.float32),
            np.arange(height, dtype=np.float32),
        ),
        axis=-1,
    )
    output = list(frames[overlap:-overlap])
    for index in range(overlap):
        left, right = frames[len(frames) - overlap + index], frames[index]
        if index in (0, overlap - 1):
            output.append((left if index == 0 else right).copy())
            continue
        phase = index / (overlap - 1)
        weight = phase**3 * (10 + phase * (-15 + 6 * phase))
        left_gray, scale = _gray(left, 512)
        right_gray, _ = _gray(right, 512)
        forward = cv2.resize(_flow(left_gray, right_gray), (width, height)) / scale
        backward = cv2.resize(_flow(right_gray, left_gray), (width, height)) / scale
        left_pixels, right_pixels = left.astype(np.float32), right.astype(np.float32)
        if left.shape[2] == 4:
            left_pixels[..., :3] *= left_pixels[..., 3:4] / 255
            right_pixels[..., :3] *= right_pixels[..., 3:4] / 255
        warped_left = cv2.remap(
            left_pixels,
            grid - weight * forward,
            None,
            cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REFLECT_101,
        )
        warped_right = cv2.remap(
            right_pixels,
            grid - (1 - weight) * backward,
            None,
            cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REFLECT_101,
        )
        blended = (1 - weight) * warped_left + weight * warped_right
        if left.shape[2] == 4:
            blended[..., :3] = np.divide(
                blended[..., :3] * 255,
                blended[..., 3:4],
                out=np.zeros_like(blended[..., :3]),
                where=blended[..., 3:4] > 0,
            )
        output.append(np.rint(blended).clip(0, 255).astype(np.uint8))
    return output


def boundary_evidence(frames: list[Any], index: int = 0) -> dict[str, Any]:
    import cv2

    _validate_frames(frames)
    indices = [(index + offset) % len(frames) for offset in (-2, -1, 0, 1)]
    pixels = [np.asarray(frames[index]) for index in indices]
    images = [_visible_rgb(frame) for frame in pixels]
    changes = [
        float(np.abs(right.astype(np.float32) - left.astype(np.float32)).mean())
        for left, right in itertools.pairwise(images)
    ]
    first_gray, scale = _gray(pixels[0], 256)
    grays = [first_gray, *[_gray(frame, 256)[0] for frame in pixels[1:]]]
    flows = [_flow(left, right) / scale for left, right in itertools.pairwise(grays)]
    alpha_changes = [
        float(
            np.abs(
                right[..., 3].astype(np.float32) - left[..., 3].astype(np.float32)
            ).mean()
        )
        if left.shape[2] == 4
        else 0.0
        for left, right in itertools.pairwise(pixels)
    ]
    speeds = [float(np.linalg.norm(flow, axis=2).mean()) for flow in flows]
    speed_reference = (speeds[0] + speeds[2]) / 2
    grid = np.stack(
        np.meshgrid(
            np.arange(first_gray.shape[1], dtype=np.float32),
            np.arange(first_gray.shape[0], dtype=np.float32),
        ),
        axis=-1,
    )
    transported = [flows[0]]
    position = grid + flows[0] * scale
    for flow in flows[1:]:
        transported.append(
            cv2.remap(
                flow,
                position,
                None,
                cv2.INTER_LINEAR,
                borderMode=cv2.BORDER_REFLECT_101,
            )
        )
        position = position + transported[-1] * scale
    velocity_changes = [
        float(np.linalg.norm(right - left, axis=2).mean())
        for left, right in itertools.pairwise(transported)
    ]
    alignment = float(np.sum(transported[0] * transported[2])) / max(
        float(np.sqrt(np.sum(transported[0] ** 2) * np.sum(transported[2] ** 2))),
        1e-6,
    )
    return {
        "frameIndices": indices,
        "transitionMae": changes,
        "appearanceRatio": changes[1] / max((changes[0] + changes[2]) / 2, 1.0),
        "alphaTransitionMae": alpha_changes,
        "alphaAppearanceRatio": alpha_changes[1]
        / max((alpha_changes[0] + alpha_changes[2]) / 2, 1.0),
        "motionMeanPixels": speeds,
        "speedRatio": speeds[1] / max(speed_reference, 0.1),
        "velocityChangeMeanPixels": velocity_changes,
        "velocityChangeRatio": max(velocity_changes) / max(float(np.mean(speeds)), 0.1),
        "neighborMotionAlignment": float(np.clip(alignment, -1, 1)),
        "motionMeasurable": max(speed_reference, speeds[1]) >= 0.25,
    }


def require_boundary_continuity(
    evidence: dict[str, Any], label: str, *, allow_reversal: bool = False
) -> None:
    if any(
        ratio > MAX_APPEARANCE_RATIO
        and changes[1] - (changes[0] + changes[2]) / 2 > MAX_APPEARANCE_EXCESS
        for ratio, changes in (
            (evidence["appearanceRatio"], evidence["transitionMae"]),
            (evidence["alphaAppearanceRatio"], evidence["alphaTransitionMae"]),
        )
    ):
        raise ValueError(
            f"{label} video loop has an abrupt visual change near frame {evidence['frameIndices'][2] + 1}; "
            "try more frames or another loop mode"
        )
    smooth_turn = (
        evidence["neighborMotionAlignment"] <= MAX_TURN_ALIGNMENT
        and evidence["velocityChangeRatio"] <= MAX_VELOCITY_CHANGE_RATIO
    )
    if evidence["motionMeasurable"] and (
        evidence["speedRatio"] > MAX_SPEED_RATIO
        or (evidence["speedRatio"] < MIN_SPEED_RATIO and not smooth_turn)
        or (
            not allow_reversal
            and evidence["velocityChangeRatio"] > MAX_VELOCITY_CHANGE_RATIO
        )
    ):
        raise ValueError(
            f"{label} video loop has a motion discontinuity near frame {evidence['frameIndices'][2] + 1}; "
            "try more frames or another loop mode"
        )


def inspect_loop(
    frames: list[Any], source_frame_count: int, loop_mode: str, label: str
) -> list[dict[str, Any]]:
    measurements = [
        boundary_evidence(frames, index)
        for index in inspection_indices(source_frame_count, loop_mode)
    ]
    for evidence in measurements:
        require_boundary_continuity(
            evidence, label, allow_reversal=loop_mode == "ping-pong"
        )
    return measurements
