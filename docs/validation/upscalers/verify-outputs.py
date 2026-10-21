import hashlib
import json
from pathlib import Path
import subprocess
import sys

import imageio_ffmpeg
import numpy as np
from PIL import Image

root = Path(__file__).resolve().parents[3]
directory = root / "docs/validation/upscalers"
sys.path.insert(0, str(root / "apps/client/src-tauri/python"))
from media_video_composition import _decode

ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
playwright = json.loads((directory / "playwright-results.json").read_text())
exports = []
for row in playwright["results"]:
    asset = row["asset"]
    extension = "webm" if asset["kind"] == "video" else "png"
    path = directory / f'native-export-{asset["kind"]}-{asset["runId"]}.{extension}'
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    assert digest == asset["digest"]
    record = {"kind": asset["kind"], "path": str(path.relative_to(root)), "sha256": digest, "verifiedOriginal": True}
    if asset["kind"] == "image":
        with Image.open(path) as image:
            assert image.size == (388, 580)
            record["dimensions"] = list(image.size)
    else:
        streams = _decode(ffmpeg, path)
        video = streams["video"]
        assert video.num_frames == 8 and video.fps == 8 and "audio" in streams
        record.update({"dimensions": [video.width, video.height], "frames": video.num_frames, "fps": float(video.fps), "hasAudio": True, "durationSeconds": float(video.duration)})
    exports.append(record)
(directory / "export-verification.json").write_text(json.dumps(exports, indent=2))

chains = json.loads((directory / "generation-chains.json").read_text())
for chain in chains:
    extension = "png" if chain["kind"] == "image" else "webm"
    for name, asset in (("source", chain["input"]), ("output", chain["output"])):
        path = directory / f'generation-chain-{chain["kind"]}-{chain["runId"]}-{name}.{extension}'
        assert hashlib.sha256(path.read_bytes()).hexdigest() == asset["digest"]
video_chain = next(chain for chain in chains if chain["kind"] == "video")
paths = {name: directory / f'generation-chain-video-{video_chain["runId"]}-{name}.webm' for name in ("source", "output")}
decoded = {name: _decode(ffmpeg, path) for name, path in paths.items()}
source, output = decoded["source"]["video"], decoded["output"]["video"]
assert (source.num_frames, source.fps, source.duration) == (output.num_frames, output.fps, output.duration)
assert (output.width, output.height) == (source.width * 2, source.height * 2)
assert ("audio" in decoded["source"]) == ("audio" in decoded["output"])
frames = {}
for name, path in paths.items():
    process = subprocess.run([ffmpeg, "-v", "error", "-i", str(path), "-vf", "scale=64:64", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], check=True, capture_output=True)
    frames[name] = np.frombuffer(process.stdout, dtype=np.uint8).reshape(source.num_frames, 64, 64, 3)
    for index in (0, source.num_frames // 2, source.num_frames - 1):
        Image.fromarray(frames[name][index]).resize((256, 256)).save(directory / f"generation-chain-video-{name}-frame-{index}.png")
    if name == "output":
        for index in (0, source.num_frames // 2, source.num_frames - 1):
            subprocess.run([ffmpeg, "-v", "error", "-i", str(path), "-vf", f"select=eq(n\\,{index})", "-frames:v", "1", "-update", "1", "-y", str(directory / f"generation-chain-video-full-frame-{index}.png")], check=True, capture_output=True)
record = {
    "runId": video_chain["runId"], "frames": output.num_frames, "fps": float(output.fps), "durationSeconds": float(output.duration),
    "sourceDimensions": [source.width, source.height], "outputDimensions": [output.width, output.height],
    "motionObservation": "Very little visible subject motion in the generated source; motion preservation is checked separately on the moving test-chart clips.",
    "sourceAdjacentFrameDifferences": np.abs(np.diff(frames["source"].astype(float), axis=0)).mean(axis=(1, 2, 3)).tolist(),
    "outputAdjacentFrameDifferences": np.abs(np.diff(frames["output"].astype(float), axis=0)).mean(axis=(1, 2, 3)).tolist(),
}
def small_frames(path):
    process = subprocess.run([ffmpeg, "-v", "error", "-i", str(path), "-vf", "scale=64:64", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], check=True, capture_output=True)
    return np.frombuffer(process.stdout, dtype=np.uint8).reshape(-1, 64, 64, 3).astype(float)

reference = small_frames(directory / "source.webm")
motion_checks = []
for model in ("upscale-span", "upscale", "upscale-swinir"):
    actual = small_frames(directory / f"gpu-{model}-upscale-video-2x/output.webm")
    assert len(actual) == len(reference) == 8
    distances = np.abs(actual[:, None] - reference[None, :]).mean(axis=(2, 3, 4))
    order = distances.argmin(axis=1).tolist()
    assert order == list(range(8)), (model, order)
    motion_checks.append({"model": model, "matchingSourceFrames": order, "adjacentFrameDifferences": np.abs(np.diff(actual, axis=0)).mean(axis=(1, 2, 3)).tolist()})
record["movingClipOrderChecks"] = motion_checks
(directory / "generation-video-verification.json").write_text(json.dumps(record, indent=2))
print(json.dumps({"exports": len(exports), "generationVideo": record}, indent=2))
