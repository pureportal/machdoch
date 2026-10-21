import hashlib
import json
from pathlib import Path
import subprocess
import sys

import imageio_ffmpeg
import numpy as np
from PIL import Image

root = Path(__file__).resolve().parents[4]
directory = Path(__file__).resolve().parent
sys.path.insert(0, str(root / "apps/client/src-tauri/python"))
from media_video_composition import _decode

report = json.loads((directory / "playwright-results.json").read_text())
assert report["completed"]
records = []
ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
source_video = directory.parent / "source.webm"


def video_frames(path):
    result = subprocess.run([ffmpeg, "-v", "error", "-i", str(path), "-vf", "scale=64:64", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], check=True, capture_output=True)
    return np.frombuffer(result.stdout, dtype=np.uint8).reshape(-1, 64, 64, 3).astype(float)


def audio_hash(path):
    return subprocess.run([ffmpeg, "-v", "error", "-i", str(path), "-map", "0:a:0", "-c:a", "pcm_s16le", "-f", "hash", "pipe:1"], check=True, capture_output=True).stdout


for run in report["runs"]:
    output = Path(run["exportPath"])
    assert hashlib.sha256(output.read_bytes()).hexdigest() == run["digest"]
    record = {"name": run["name"], "dimensions": [run["width"], run["height"]], "digestVerified": True}
    if run["kind"] == "image":
        source_path = directory / ("portrait.png" if run["name"] in ("swinir-portrait-minimum-edges", "advanced-minimum-edges") else "source.png")
        with Image.open(source_path) as source, Image.open(output) as image:
            assert image.size == (run["width"], run["height"])
            pixels = np.asarray(image.convert("RGB"))
            assert pixels.std() > 10
            if "A" in source.getbands():
                np.testing.assert_array_equal(np.asarray(image.getchannel("A")), np.asarray(source.getchannel("A").resize(image.size, Image.Resampling.LANCZOS)))
            if run["name"] == "already-meets-minimum":
                np.testing.assert_array_equal(np.asarray(source.convert("RGBA")), np.asarray(image.convert("RGBA")))
                record["unchangedPixels"] = True
            else:
                difference = np.abs(pixels.astype(float) - np.asarray(source.convert("RGB").resize(image.size, Image.Resampling.LANCZOS), dtype=float)).mean()
                assert difference > 0.01
                record["differenceFromLanczos"] = float(difference)
            record["alphaVerified"] = True
    else:
        source = _decode(ffmpeg, source_video)["video"]
        streams = _decode(ffmpeg, output)
        video = streams["video"]
        assert (video.width, video.height) == (run["width"], run["height"])
        assert (video.num_frames, video.fps, video.duration) == (source.num_frames, source.fps, source.duration)
        assert "audio" in streams
        assert audio_hash(source_video) == audio_hash(output)
        reference, actual = video_frames(source_video), video_frames(output)
        distances = np.abs(actual[:, None] - reference[None, :]).mean(axis=(2, 3, 4))
        order = distances.argmin(axis=1).tolist()
        assert order == list(range(video.num_frames)), order
        record.update({"frames": video.num_frames, "fps": float(video.fps), "audioVerified": True, "matchingSourceFrames": order})
    records.append(record)
(directory / "output-verification.json").write_text(json.dumps(records, indent=2))
print(json.dumps({"verifiedOutputs": len(records), "checks": records}, indent=2))
