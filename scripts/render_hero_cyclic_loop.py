import argparse
import bisect
import json
import subprocess
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FORWARD = (
    REPOSITORY_ROOT
    / "tmp"
    / "loop-forward-2026-07-30"
    / "hero-forward-half"
)
DEFAULT_RETURN = (
    REPOSITORY_ROOT
    / "tmp"
    / "loop-forward-2026-07-30"
    / "framepack-bridge-back-v3-25f-12step-seed72526043"
    / "output"
    / "frames"
)
DEFAULT_DETAIL_RETURN = (
    REPOSITORY_ROOT
    / "tmp"
    / "hero-character-animation-2026-07-31"
    / "return-hunyuan-a"
    / "output"
    / "frames"
)
FFMPEG = (
    REPOSITORY_ROOT
    / "src-tauri"
    / "python"
    / "runtime"
    / "Lib"
    / "site-packages"
    / "imageio_ffmpeg"
    / "binaries"
    / "ffmpeg-win-x86_64-v7.1.exe"
)
SIZE = 768
FLOW_SIZE = 384
FORWARD_FRAME_COUNT = 37
RETURN_FRAME_COUNT = 25
DETAIL_RETURN_FRAME_COUNT = 37
PHASE_FRAME_COUNT = 25
FRAME_COUNT = 48
FPS = 16
REPAIRED_RETURN_INDICES = tuple(range(5, 22, 2))


GRID_X, GRID_Y = np.meshgrid(
    np.arange(SIZE, dtype=np.float32),
    np.arange(SIZE, dtype=np.float32),
)


def load_frames(
    directory: Path,
    label: str,
    expected_count: int,
) -> list[np.ndarray]:
    paths = sorted(directory.glob("frame-*.png"))
    if len(paths) != expected_count:
        raise RuntimeError(
            f"Expected {expected_count} {label} frames, found {len(paths)}"
        )
    frames = []
    for path in paths:
        with Image.open(path) as opened:
            frame = np.asarray(opened.convert("RGB"), dtype=np.uint8)
        if frame.shape[0] != frame.shape[1] or frame.shape[2] != 3:
            raise RuntimeError(
                f"{label} frame {path.name} is not square RGB"
            )
        frames.append(frame)
    return frames


def frame_mae(first: np.ndarray, second: np.ndarray) -> float:
    return float(
        np.mean(
            np.abs(first.astype(np.float32) - second.astype(np.float32))
        )
    )


def bidirectional_flow(
    first: np.ndarray,
    second: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    first_small = cv2.resize(
        first,
        (FLOW_SIZE, FLOW_SIZE),
        interpolation=cv2.INTER_AREA,
    )
    second_small = cv2.resize(
        second,
        (FLOW_SIZE, FLOW_SIZE),
        interpolation=cv2.INTER_AREA,
    )
    first_gray = cv2.cvtColor(first_small, cv2.COLOR_RGB2GRAY)
    second_gray = cv2.cvtColor(second_small, cv2.COLOR_RGB2GRAY)
    arguments = (0.5, 5, 21, 5, 7, 1.5, 0)
    forward = cv2.calcOpticalFlowFarneback(
        first_gray,
        second_gray,
        None,
        *arguments,
    )
    backward = cv2.calcOpticalFlowFarneback(
        second_gray,
        first_gray,
        None,
        *arguments,
    )
    scale = SIZE / FLOW_SIZE
    forward = cv2.resize(
        forward,
        (SIZE, SIZE),
        interpolation=cv2.INTER_LINEAR,
    )
    backward = cv2.resize(
        backward,
        (SIZE, SIZE),
        interpolation=cv2.INTER_LINEAR,
    )
    forward *= scale
    backward *= scale
    return forward, backward


def warp(
    frame: np.ndarray,
    flow: np.ndarray,
    strength: float,
) -> np.ndarray:
    return cv2.remap(
        frame,
        GRID_X - flow[..., 0] * strength,
        GRID_Y - flow[..., 1] * strength,
        cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REFLECT101,
    )


def one_sided_intermediate(
    first: np.ndarray,
    second: np.ndarray,
    fraction: float,
) -> np.ndarray:
    forward, backward = bidirectional_flow(first, second)
    if fraction <= 0.5:
        return warp(first, forward, fraction)
    return warp(second, backward, 1.0 - fraction)


def blended_intermediate(
    first: np.ndarray,
    second: np.ndarray,
    fraction: float,
) -> np.ndarray:
    forward, backward = bidirectional_flow(first, second)
    first_warped = warp(first, forward, fraction).astype(np.float32)
    second_warped = warp(second, backward, 1.0 - fraction).astype(np.float32)
    blended = np.clip(
        first_warped * (1.0 - fraction) + second_warped * fraction,
        0,
        255,
    )
    blurred = cv2.GaussianBlur(blended, (0, 0), 0.8)
    return np.clip(
        blended + 0.6 * (blended - blurred),
        0,
        255,
    ).round().astype(np.uint8)


def retime_forward(frames: list[np.ndarray]) -> tuple[list[np.ndarray], list[float]]:
    positions = np.linspace(
        0,
        len(frames) - 1,
        PHASE_FRAME_COUNT,
    )
    output = []
    for position in positions:
        left = int(np.floor(position))
        fraction = float(position - left)
        if fraction < 1e-6:
            output.append(frames[left])
        else:
            output.append(
                one_sided_intermediate(
                    frames[left],
                    frames[left + 1],
                    fraction,
                )
            )
    return output, [round(float(position), 6) for position in positions]


def soft_face_mask() -> np.ndarray:
    yy, xx = np.mgrid[:SIZE, :SIZE].astype(np.float32)
    distance = np.sqrt(
        ((xx - 382.0) / 132.0) ** 2
        + ((yy - 252.0) / 82.0) ** 2
    )
    return np.clip((1.22 - distance) / 0.22, 0.0, 1.0)


def restore_opening_face(
    returning: list[np.ndarray],
    detail_return: list[np.ndarray],
) -> tuple[list[np.ndarray], list[int]]:
    output = list(returning)
    mask = soft_face_mask()[..., None]
    source_indices = []
    weights = (1.0, 1.0, 1.0, 1.0)
    for return_index, weight in zip(range(1, 5), weights, strict=True):
        source_index = round(return_index * 1.5)
        source_indices.append(source_index)
        blend = mask * weight
        output[return_index] = np.clip(
            output[return_index].astype(np.float32) * (1.0 - blend)
            + detail_return[source_index].astype(np.float32) * blend,
            0,
            255,
        ).round().astype(np.uint8)
    return output, source_indices


def repair_soft_return_frames(
    frames: list[np.ndarray],
) -> list[np.ndarray]:
    output = list(frames)
    for index in REPAIRED_RETURN_INDICES:
        output[index] = one_sided_intermediate(
            frames[index - 1],
            frames[index + 1],
            0.5,
        )
    return output


def character_motion_distance(
    first: np.ndarray,
    second: np.ndarray,
) -> float:
    forward, _ = bidirectional_flow(first, second)
    magnitude = np.linalg.norm(forward, axis=2)
    return float(np.mean(magnitude[60:700, 0:600]))


def retime_return_path(
    anchors: list[np.ndarray],
) -> tuple[list[np.ndarray], list[float], list[float]]:
    distances = [
        character_motion_distance(first, second)
        for first, second in zip(anchors, anchors[1:])
    ]
    cumulative = [0.0]
    for distance in distances:
        cumulative.append(cumulative[-1] + distance)

    positions = []
    output = []
    target_step = cumulative[-1] / (PHASE_FRAME_COUNT - 1)
    for sample_index in range(PHASE_FRAME_COUNT):
        target = min(sample_index * target_step, cumulative[-1])
        segment = min(
            bisect.bisect_right(cumulative, target) - 1,
            len(anchors) - 2,
        )
        segment_distance = distances[segment]
        fraction = (
            0.0
            if segment_distance == 0.0
            else (target - cumulative[segment]) / segment_distance
        )
        source_position = segment + fraction
        positions.append(round(source_position, 6))
        if fraction < 1e-6:
            output.append(anchors[segment])
        elif fraction > 1.0 - 1e-6:
            output.append(anchors[segment + 1])
        else:
            if segment == len(anchors) - 2:
                output.append(
                    blended_intermediate(
                        anchors[segment],
                        anchors[segment + 1],
                        fraction,
                    )
                )
            else:
                output.append(
                    one_sided_intermediate(
                        anchors[segment],
                        anchors[segment + 1],
                        fraction,
                    )
                )
    return output, positions, [round(distance, 6) for distance in distances]


def assemble_cycle(
    forward: list[np.ndarray],
    returning: list[np.ndarray],
    detail_return: list[np.ndarray],
) -> tuple[list[np.ndarray], dict[str, object]]:
    retimed_forward, forward_positions = retime_forward(forward)

    resized_return = []
    for frame in returning:
        resized = cv2.resize(
            frame,
            (SIZE, SIZE),
            interpolation=cv2.INTER_LANCZOS4,
        )
        blurred = cv2.GaussianBlur(resized, (0, 0), 0.8)
        resized_return.append(
            np.clip(
                resized.astype(np.float32)
                + 0.4
                * (
                    resized.astype(np.float32)
                    - blurred.astype(np.float32)
                ),
                0,
                255,
            )
            .round()
            .astype(np.uint8)
        )
    face_restored_return, face_source_indices = restore_opening_face(
        resized_return,
        detail_return,
    )
    repaired_return = repair_soft_return_frames(face_restored_return)
    return_path, return_positions, return_source_distances = retime_return_path(
        [
            retimed_forward[-1],
            *repaired_return[1:24],
            retimed_forward[0],
        ]
    )

    # Both shots include their conditioning endpoints. Keep the forward A-to-B
    # shot, then omit B and the repeated closing A from the B-to-A shot. The
    # resulting [A, A) cycle contains only chronological semantic frames.
    frames = [*retimed_forward, *return_path[1:-1]]
    if len(frames) != FRAME_COUNT:
        raise RuntimeError(f"Expected {FRAME_COUNT} assembled frames")

    circular_mae = [
        frame_mae(frames[index], frames[(index + 1) % len(frames)])
        for index in range(len(frames))
    ]
    return frames, {
        "forwardFramePositions": forward_positions,
        "openingFaceDetailFrameIndices": face_source_indices,
        "repairedReturnFrameIndices": list(REPAIRED_RETURN_INDICES),
        "returnFramePositions": return_positions,
        "returnSourceMotionDistances": return_source_distances,
        "sourceHandoffMae": frame_mae(
            retimed_forward[-1],
            return_path[0],
        ),
        "renderedHandoffMae": circular_mae[len(retimed_forward) - 1],
        "loopBoundaryMae": circular_mae[-1],
        "internalTransitionMaeMedian": float(np.median(circular_mae[:-1])),
        "internalTransitionMaeP95": float(
            np.percentile(circular_mae[:-1], 95.0)
        ),
    }


def encode_frames(
    frame_directory: Path,
    destination: Path,
    repeat: int = 1,
) -> None:
    input_pattern = frame_directory / "frame-%04d.png"
    command = [
        str(FFMPEG),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-framerate",
        str(FPS),
    ]
    if repeat == 1:
        command.extend(["-i", str(input_pattern)])
    else:
        command.extend(
            [
                "-stream_loop",
                str(repeat - 1),
                "-i",
                str(input_pattern),
                "-frames:v",
                str(FRAME_COUNT * repeat),
            ]
        )
    command.extend(
        [
            "-an",
            "-c:v",
            "libvpx-vp9",
            "-pix_fmt",
            "yuv444p",
            "-color_range",
            "pc",
            "-lossless",
            "1",
            "-b:v",
            "0",
            "-deadline",
            "good",
            "-cpu-used",
            "1",
            "-row-mt",
            "1",
            "-fps_mode",
            "passthrough",
            str(destination),
        ]
    )
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=30 * 60,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--forward-dir", type=Path, default=DEFAULT_FORWARD)
    parser.add_argument("--return-dir", type=Path, default=DEFAULT_RETURN)
    parser.add_argument(
        "--detail-return-dir",
        type=Path,
        default=DEFAULT_DETAIL_RETURN,
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=(
            REPOSITORY_ROOT
            / "tmp"
            / "hero-character-animation-2026-07-31"
        ),
    )
    parser.add_argument("--name", default="hero-semantic-character-cycle")
    arguments = parser.parse_args()

    forward_directory = arguments.forward_dir.resolve()
    return_directory = arguments.return_dir.resolve()
    detail_return_directory = arguments.detail_return_dir.resolve()
    forward = load_frames(
        forward_directory,
        "forward",
        FORWARD_FRAME_COUNT,
    )
    returning = load_frames(
        return_directory,
        "return",
        RETURN_FRAME_COUNT,
    )
    detail_return = load_frames(
        detail_return_directory,
        "detail return",
        DETAIL_RETURN_FRAME_COUNT,
    )
    frames, transition_evidence = assemble_cycle(
        forward,
        returning,
        detail_return,
    )

    output_directory = arguments.output_dir.resolve()
    output_directory.mkdir(parents=True, exist_ok=True)
    destination_directory = output_directory / arguments.name
    destination_directory.mkdir(parents=True, exist_ok=True)
    for index, frame in enumerate(frames):
        Image.fromarray(frame).save(
            destination_directory / f"frame-{index:04d}.png",
            format="PNG",
            compress_level=3,
        )

    master = output_directory / f"{arguments.name}.webm"
    proof = output_directory / f"{arguments.name}-3x.webm"
    encode_frames(destination_directory, master)
    encode_frames(destination_directory, proof, repeat=3)
    evidence = {
        "engine": "semantic-two-shot-cycle-v8",
        "forwardSource": str(forward_directory),
        "returnSource": str(return_directory),
        "openingFaceDetailSource": str(detail_return_directory),
        "forwardSourceFrameCount": FORWARD_FRAME_COUNT,
        "returnSourceFrameCount": RETURN_FRAME_COUNT,
        "frameCount": FRAME_COUNT,
        "fps": FPS,
        "durationSeconds": FRAME_COUNT / FPS,
        "motionSource": "native-generated-character-frames",
        "globalPixelWarping": False,
        "temporalInterpolation": (
            "one-sided-semantic-with-blended-closing-transition"
        ),
        "forwardRetime": "uniform-time-one-sided-semantic",
        "returnRetime": "character-motion-equalized-semantic-path",
        "generatedChronologicalReturn": True,
        "pingPong": False,
        "duplicateHandoffFrame": False,
        "duplicateClosureFrame": False,
        "closedPhaseInterval": "[0, T)",
        "master": str(master.resolve()),
        "threeCycleProof": str(proof.resolve()),
        **transition_evidence,
    }
    (destination_directory / "assembly.json").write_text(
        json.dumps(evidence, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(evidence))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
