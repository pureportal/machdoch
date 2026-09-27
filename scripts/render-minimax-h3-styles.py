import json
import os
from pathlib import Path
import re
import subprocess
import sys

from imageio_ffmpeg import get_ffmpeg_exe
import cv2
import numpy as np


ROOT = Path(__file__).resolve().parents[1]
RENDERS = ROOT / "assets/media/h3-style-tests"
MODEL = ROOT / "models/minimax-h3-ref2va"
RENDERER = ROOT / "apps/client/src-tauri/python/media_minimax_h3.py"


def verify_output(path, expected_frames):
    if not path.is_file() or path.stat().st_size == 0:
        return False
    result = subprocess.run(
        [
            get_ffmpeg_exe(), "-v", "error", "-i", str(path),
            "-map", "0:v:0", "-map", "0:a:0",
            "-progress", "pipe:1", "-nostats", "-f", "null", "-",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    frames = re.findall(r"(?m)^frame=(\d+)\s*$", result.stdout)
    if result.returncode != 0 or not frames or int(frames[-1]) != expected_frames:
        return False
    capture = cv2.VideoCapture(str(path))
    try:
        capture.set(cv2.CAP_PROP_POS_FRAMES, expected_frames // 2)
        has_frame, frame = capture.read()
    finally:
        capture.release()
    if not has_frame:
        return False
    pixels = frame.astype(np.int16)
    return np.abs(pixels[:, 16:] - pixels[:, :-16]).mean() >= 5


def main():
    manifest = json.loads((RENDERS / "renders.json").read_text(encoding="utf-8"))
    settings = manifest["settings"]
    environment = os.environ.copy()
    environment.setdefault("HIP_VISIBLE_DEVICES", "1")

    for entry in manifest["renders"]:
        style = entry["style"]
        output = RENDERS / f"{style}-h3.mp4"
        if verify_output(output, settings["frames"]):
            print(f"Skipping {style}: {output.name} is verified", flush=True)
            continue

        command = [
            sys.executable,
            str(RENDERER),
            "--image", str(RENDERS / f"{style}-reference.png"),
            "--prompt", entry["prompt"],
            "--output", str(output),
            "--models", str(MODEL),
            "--small-te", str(MODEL / "small_te"),
            "--lora", str(MODEL / "loras" / entry["lora"]),
            "--width", str(settings["width"]),
            "--height", str(settings["height"]),
            "--frames", str(settings["frames"]),
            "--steps", str(entry["evaluations"] + 1),
            "--seed", str(entry["seed"]),
            "--swap-blocks", "44",
        ]
        if style_lora := entry.get("styleLora"):
            command.extend([
                "--style-lora", str(MODEL / "loras" / style_lora),
                "--style-strength", str(entry["styleStrength"]),
            ])

        print(f"Rendering {style}", flush=True)
        with (RENDERS / f"{style}.log").open("w", encoding="utf-8") as log:
            result = subprocess.run(
                command,
                cwd=ROOT,
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
                check=False,
            )
        if result.returncode != 0:
            raise SystemExit(f"{style} failed; inspect {style}.log")
        if not verify_output(output, settings["frames"]):
            raise SystemExit(f"{style} failed video and audio verification")
        print(f"Rendered {output}", flush=True)


if __name__ == "__main__":
    main()
