from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess

import numpy as np
import torch



def validate_video_settings(settings: dict) -> None:
    if not isinstance(settings, dict) or set(settings) != {"width", "height", "frames", "fps", "image_dropout"}:
        raise ValueError("Choose video dimensions, frame count, frame rate, and image dropout.")
    for name, minimum, maximum in (("width", 64, 2048), ("height", 64, 2048),
                                   ("frames", 5, 161), ("fps", 1, 60)):
        if type(settings[name]) is not int or not minimum <= settings[name] <= maximum:
            raise ValueError(f"Check video {name}.")
    if settings["width"] % 16 or settings["height"] % 16 or (settings["frames"] - 1) % 4:
        raise ValueError("Use dimensions divisible by 16 and a frame count of 4n + 1.")
    dropout = settings["image_dropout"]
    if isinstance(dropout, bool) or not isinstance(dropout, (int, float)) or not 0 <= dropout <= 1:
        raise ValueError("Image dropout must be between 0 and 1.")
    if settings["width"] * settings["height"] * settings["frames"] * 12 > 1024**3:
        raise ValueError("Reduce video dimensions or frame count to keep decoded clips below 1 GiB.")


def read_dataset(directory: Path) -> list[dict]:
    samples = []
    for line in (directory / "metadata.jsonl").read_text(encoding="utf-8").splitlines():
        record = json.loads(line)
        path = (directory / record["file_name"]).resolve()
        if path.parent != directory.resolve() or not path.is_file() or path.is_symlink():
            raise ValueError("A training video is unavailable. Add it again.")
        caption = record["text"]
        if not isinstance(caption, str) or not caption.strip() or len(caption) > 2000:
            raise ValueError("Enter a caption of at most 2000 characters for every video.")
        with path.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        samples.append({"path": path, "caption": caption, "digest": digest})
    if not 3 <= len(samples) <= 50:
        raise ValueError("Choose 3 to 50 training videos.")
    return samples


def decode_video(path: Path, settings: dict) -> torch.Tensor:
    import imageio_ffmpeg

    width, height, frames = (settings[key] for key in ("width", "height", "frames"))
    filters = (f"fps={settings['fps']},scale={width}:{height}:force_original_aspect_ratio=increase,"
               f"crop={width}:{height},setsar=1")
    result = subprocess.run([
        imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", str(path), "-map", "0:v:0", "-an", "-vf", filters,
        "-frames:v", str(frames), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ], capture_output=True, timeout=900, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        raise ValueError(f"Cannot decode {path.name}: {result.stderr.decode('utf-8', errors='replace')[-2000:]}")
    if len(result.stdout) != frames * height * width * 3:
        raise ValueError(f"{path.name} is too short. Choose a clip with at least {frames / settings['fps']:.2f} seconds.")
    pixels = np.frombuffer(result.stdout, dtype=np.uint8).reshape(frames, height, width, 3).copy()
    return torch.from_numpy(pixels).permute(3, 0, 1, 2).unsqueeze(0).float().div_(127.5).sub_(1)


def dataset_signature(specification: dict, samples: list[dict]) -> str:
    data = {"version": 2, "model": specification["model"], "architecture": specification["architecture"],
            "precision": specification["precision"], "method": specification["method"],
            "video": specification["video"], "seed": specification["seed"],
            "trigger": specification["trigger_phrase"], "initializer": specification["initializer_token"],
            "samples": [{"caption": sample["caption"], "digest": sample["digest"]} for sample in samples]}
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
