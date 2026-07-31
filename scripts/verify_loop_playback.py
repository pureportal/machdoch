"""Decode a repeated loop and verify its frame cadence across every boundary."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FFMPEG = (
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("--frames-per-cycle", type=int, required=True)
    parser.add_argument("--cycles", type=int, default=3)
    parser.add_argument("--fps", type=float, required=True)
    parser.add_argument("--ffmpeg", type=Path, default=DEFAULT_FFMPEG)
    parser.add_argument("--output", type=Path)
    arguments = parser.parse_args()
    if arguments.frames_per_cycle < 2:
        parser.error("--frames-per-cycle must be at least 2")
    if arguments.cycles < 2:
        parser.error("--cycles must be at least 2")
    if arguments.fps <= 0:
        parser.error("--fps must be positive")

    video = arguments.video.resolve()
    completed = subprocess.run(
        [
            str(arguments.ffmpeg.resolve()),
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(video),
            "-map",
            "0:v:0",
            "-f",
            "framemd5",
            "-",
        ],
        capture_output=True,
        text=True,
        timeout=15 * 60,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip())
    time_base_match = re.search(r"^#tb 0:\s*(\d+)/(\d+)$", completed.stdout, re.M)
    if time_base_match is None:
        raise RuntimeError("FFmpeg framemd5 output did not report a time base")
    time_base = int(time_base_match.group(1)) / int(time_base_match.group(2))
    records = []
    for line in completed.stdout.splitlines():
        if not line or line.startswith("#"):
            continue
        fields = [field.strip() for field in line.split(",")]
        if len(fields) != 6:
            raise RuntimeError(f"Unexpected framemd5 record: {line}")
        records.append(
            {
                "dts": int(fields[1]),
                "pts": int(fields[2]),
                "duration": int(fields[3]),
                "size": int(fields[4]),
                "hash": fields[5],
            }
        )

    expected_frame_count = arguments.frames_per_cycle * arguments.cycles
    if len(records) != expected_frame_count:
        raise RuntimeError(
            f"Decoded {len(records)} frames; expected {expected_frame_count}"
        )
    pts = [record["pts"] for record in records]
    if any(current <= previous for previous, current in zip(pts, pts[1:])):
        raise RuntimeError("Decoded presentation timestamps are not strictly increasing")
    hashes = [record["hash"] for record in records]
    reference_hashes = hashes[: arguments.frames_per_cycle]
    cycles_match = all(
        hashes[
            cycle * arguments.frames_per_cycle :
            (cycle + 1) * arguments.frames_per_cycle
        ]
        == reference_hashes
        for cycle in range(1, arguments.cycles)
    )
    adjacent_duplicate_transitions = [
        index
        for index in range(1, len(hashes))
        if hashes[index] == hashes[index - 1]
    ]
    boundary_indices = [
        cycle * arguments.frames_per_cycle
        for cycle in range(1, arguments.cycles)
    ]
    boundary_intervals = [pts[index] - pts[index - 1] for index in boundary_indices]
    all_intervals = [
        current - previous for previous, current in zip(pts, pts[1:])
    ]
    duration_ticks = records[-1]["pts"] + records[-1]["duration"] - records[0]["pts"]
    decoded_duration_seconds = duration_ticks * time_base
    expected_duration_seconds = expected_frame_count / arguments.fps
    duration_error_seconds = abs(
        decoded_duration_seconds - expected_duration_seconds
    )
    if not cycles_match:
        raise RuntimeError("Decoded frame hashes differ between playback cycles")
    if adjacent_duplicate_transitions:
        raise RuntimeError(
            "Repeated playback contains adjacent duplicate frames at "
            + ", ".join(map(str, adjacent_duplicate_transitions))
        )
    if duration_error_seconds > max(time_base, 1e-6):
        raise RuntimeError(
            f"Decoded duration differs by {duration_error_seconds:.6f} seconds"
        )

    result = {
        "video": str(video),
        "decodedFrameCount": len(records),
        "framesPerCycle": arguments.frames_per_cycle,
        "cycles": arguments.cycles,
        "fps": arguments.fps,
        "timeBaseSeconds": time_base,
        "presentationTimestampsStrictlyIncreasing": True,
        "intervalTicks": {
            "minimum": min(all_intervals),
            "maximum": max(all_intervals),
            "boundary": boundary_intervals,
        },
        "decodedDurationSeconds": decoded_duration_seconds,
        "expectedDurationSeconds": expected_duration_seconds,
        "durationErrorSeconds": duration_error_seconds,
        "identicalDecodedCycles": True,
        "adjacentDuplicateTransitionCount": 0,
        "boundaryFramePairs": [
            {
                "fromFrame": index - 1,
                "toFrame": index,
                "sameHash": hashes[index - 1] == hashes[index],
            }
            for index in boundary_indices
        ],
    }
    output = (
        arguments.output.resolve()
        if arguments.output is not None
        else video.with_suffix(".playback-verification.json")
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
