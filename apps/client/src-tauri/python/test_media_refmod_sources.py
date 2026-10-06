import base64
import io
import json
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path

import imageio_ffmpeg
import numpy as np
import torch
from PIL import Image

from media_refmod_creation import _audio_waveform, _video_frames
from media_refmod_preview import encode_audio, encode_image


class RefModSourceTests(unittest.TestCase):
    def test_video_offsets_read_a_contiguous_bounded_segment(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "source.webm"
            pixels = np.zeros((39, 32, 32, 3), dtype=np.uint8)
            for index in range(39):
                pixels[index, :, :, 0] = index * 6
            subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "32x32", "-r", "24", "-i", "pipe:0", "-c:v", "libvpx-vp9", "-lossless", "1", "-threads", "1", str(path)], input=pixels.tobytes(), capture_output=True, check=True, timeout=120)
            first = _video_frames({"path": str(path)}, (32, 32), 5)
            offset = _video_frames({"path": str(path), "startSeconds": 17 / 24}, (32, 32), 5)
            self.assertEqual(len(first), 5)
            self.assertEqual(len(offset), 5)
            self.assertLess(np.asarray(first[-1])[:, :, 0].mean(), 30)
            self.assertAlmostEqual(np.asarray(offset[0])[:, :, 0].mean(), 102, delta=3)
            self.assertAlmostEqual(np.asarray(offset[-1])[:, :, 0].mean(), 126, delta=3)

    def test_audio_offsets_preserve_stereo_and_the_32khz_clock(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "source.wav"
            samples = np.stack([np.full(6400, 8192), np.full(6400, -4096)], axis=1).astype("<i2")
            with wave.open(str(path), "wb") as output:
                output.setnchannels(2)
                output.setsampwidth(2)
                output.setframerate(32000)
                output.writeframes(samples.tobytes())
            audio = _audio_waveform({"path": str(path), "startSeconds": 0.05}, 1)
            self.assertEqual(tuple(audio.shape), (1, 2, 4800))
            self.assertTrue(torch.allclose(audio[:, 0], torch.full((1, 4800), 0.25)))
            self.assertTrue(torch.allclose(audio[:, 1], torch.full((1, 4800), -0.125)))

    def test_previews_use_bounded_portable_image_and_audio_formats(self):
        image = encode_image(torch.zeros(3, 640, 960))
        with Image.open(io.BytesIO(base64.b64decode(image.split(",", 1)[1]))) as decoded:
            self.assertEqual(decoded.format, "PNG")
            self.assertLessEqual(max(decoded.size), 500)
        audio = encode_audio(torch.zeros(2, 96000))
        with wave.open(io.BytesIO(base64.b64decode(audio.split(",", 1)[1])), "rb") as decoded:
            self.assertEqual(decoded.getnchannels(), 2)
            self.assertEqual(decoded.getframerate(), 32000)
            self.assertEqual(decoded.getnframes(), 64000)

    def test_comparison_previews_fit_the_native_worker_reply_limit(self):
        generator = torch.Generator().manual_seed(17)
        for height, width in ((500, 500), (512, 512), (768, 1024)):
            with self.subTest(height=height, width=width):
                pixels = torch.randint(0, 256, (3, height, width), generator=generator).float() / 255
                image = encode_image(pixels)
                response = json.dumps({"schemaVersion": 5, "workerVersion": "media-diffusers-worker/1.76.0",
                                       "result": {"kind": "video", "previews": [image, image]}})
                self.assertLess(len(response.encode("utf-8")), 2 * 1024 * 1024)


if __name__ == "__main__":
    unittest.main()
