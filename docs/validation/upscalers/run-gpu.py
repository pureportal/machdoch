import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import shutil
import time

import imageio_ffmpeg
import numpy as np
from PIL import Image

root = Path(__file__).resolve().parents[3]
output = root / "docs/validation/upscalers"
worker = root / "apps/client/src-tauri/python/media_workflow_worker.py"
sys.path.insert(0, str(worker.parent))
from media_video_composition import _decode

source = Image.open(output / "source.png").convert("RGBA")
source.thumbnail((192, 145))
source.save(output / "source.png")
ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=96x64:r=8:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libvpx-vp9", "-c:a", "libopus", "-shortest", "-y", str(output / "source.webm")], check=True)
subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=16:d=4", "-c:v", "libvpx-vp9", "-y", str(output / "cancel-source.webm")], check=True)
models = json.loads((output / "model-downloads.json").read_text())
temporary = tempfile.TemporaryDirectory(prefix="machdoch-upscale-validation-")
results = []
for kind, command, scale in ([(kind, command, scale) for kind in models for command, scale in [("upscale", "2"), ("upscale", "4"), ("upscale-video", "2")]] + [("upscale-span", "upscale-video", "4")]):
    destination = output / f"gpu-{kind}-{command}-{scale}x"
    destination.mkdir(exist_ok=True)
    generated = Path(temporary.name) / f"{kind}-{command}-{scale}x"
    generated.mkdir()
    request = {"imagePath": str(output / "source.png"), "inputPath": str(output / "source.webm"), "outputDirectory": str(generated), "modelPath": str(Path("D:/Models/machdoch/models/workflow") / kind / models[kind][0]["path"]), "scale": scale, "tileSize": 64}
    start = time.monotonic()
    process = subprocess.run([sys.executable, str(worker), command], input=json.dumps(request), text=True, capture_output=True, timeout=600)
    (destination / "worker.log").write_text(process.stderr)
    record = {"model": kind, "command": command, "scale": scale, "seconds": time.monotonic() - start, "code": process.returncode, "result": json.loads(process.stdout)}
    results.append(record)
    (output / "gpu-results.json").write_text(json.dumps(results, indent=2))
    print(json.dumps(record), flush=True)
    if process.returncode:
        continue
    for file in generated.iterdir():
        shutil.copy2(file, destination / file.name)
    if command == "upscale":
        image = Image.open(destination / "output.png")
        assert image.size == (source.width * int(scale), source.height * int(scale))
        assert np.array_equal(np.asarray(image.getchannel("A")), np.asarray(source.getchannel("A").resize(image.size, Image.Resampling.LANCZOS)))
        record["differenceFromLanczos"] = float(np.abs(np.asarray(image.convert("RGB"), dtype=float) - np.asarray(source.convert("RGB").resize(image.size, Image.Resampling.LANCZOS), dtype=float)).mean())
    else:
        streams = _decode(ffmpeg, destination / "output.webm")
        assert streams["video"].num_frames == 8
        assert streams["video"].fps == 8
        assert "audio" in streams
        frames = subprocess.run([ffmpeg, "-v", "error", "-i", str(destination / "output.webm"), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], check=True, capture_output=True).stdout
        pixels = np.frombuffer(frames, dtype=np.uint8).reshape(8, 64 * int(scale), 96 * int(scale), 3)
        record["frameDifferences"] = [float(np.abs(pixels[i].astype(float) - pixels[i-1]).mean()) for i in range(1, 8)]
        for index in [0, 3, 7]:
            Image.fromarray(pixels[index]).save(destination / f"frame-{index}.png")
(output / "gpu-results.json").write_text(json.dumps(results, indent=2))
temporary.cleanup()
assert all(result["code"] == 0 for result in results)
