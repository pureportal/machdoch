import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time

import imageio_ffmpeg
import numpy as np
from PIL import Image

root = Path(__file__).resolve().parents[3]
directory = root / "docs/validation/upscalers"
worker = root / "apps/client/src-tauri/python/media_workflow_worker.py"
models = json.loads((directory / "model-downloads.json").read_text())
runs = json.loads((directory / "gpu-results.json").read_text())
ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
results = []
for run in runs:
    kind, command, scale = run["model"], run["command"], run["scale"]
    reference = directory / f"gpu-{kind}-{command}-{scale}x"
    with tempfile.TemporaryDirectory(prefix="machdoch-upscale-audit-") as temporary:
        output = Path(temporary) / "result"
        if command == "upscale":
            output.mkdir()
        request = {
            "imagePath": str(directory / "source.png"),
            "inputPath": str(directory / "source.webm"),
            "outputDirectory": str(output),
            "modelPath": str(Path("D:/Models/machdoch/models/workflow") / kind / models[kind][0]["path"]),
            "scale": scale,
            "tileSize": 64,
        }
        started = time.monotonic()
        process = subprocess.run([sys.executable, "-I", "-B", "-Xutf8", str(worker), command], input=json.dumps(request), text=True, capture_output=True, timeout=600)
        assert process.returncode == 0, process.stdout + process.stderr
        result = json.loads(process.stdout)
        if command == "upscale":
            with Image.open(reference / "output.png") as expected, Image.open(output / "output.png") as actual:
                assert actual.size == expected.size
                assert np.array_equal(np.asarray(actual), np.asarray(expected)), (kind, scale)
            digest = hashlib.sha256((output / "output.png").read_bytes()).hexdigest()
        else:
            def pixels(path):
                return subprocess.run([ffmpeg, "-v", "error", "-i", str(path), "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], check=True, capture_output=True).stdout

            actual = pixels(output / "output.webm")
            assert actual == pixels(reference / "output.webm"), (kind, scale)
            assert result["output"]["numFrames"] == 8 and result["output"]["hasAudio"]
            digest = hashlib.sha256(actual).hexdigest()
        record = {"model": kind, "command": command, "scale": scale, "seconds": time.monotonic() - started, "pixelsUnchanged": True, "sha256": digest, "result": result}
        results.append(record)
        (directory / "gpu-audit-results.json").write_text(json.dumps(results, indent=2))
        print(json.dumps({key: record[key] for key in ("model", "command", "scale", "pixelsUnchanged", "seconds")}), flush=True)
assert len(results) == 10
