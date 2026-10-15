from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import imageio_ffmpeg
import numpy as np
from PIL import Image
import torch

import media_upscale as upscale
from media_upscale_settings import output_size, resolve_tile_size, validate_settings


SETTINGS = {"sizeMode": "scale", "scale": 2, "minWidth": 1920, "minHeight": 1024,
            "minLongEdge": 1920, "minShortEdge": 1024, "tileMode": "manual", "tileSize": 64, "tileFactor": 4}


class FixtureModel:
    scale = 4
    architecture = type("Architecture", (), {"id": "fixture"})()

    def __call__(self, image):
        return torch.nn.functional.interpolate(image, scale_factor=4, mode="nearest")


class UpscaleTests(unittest.TestCase):
    def test_transparent_odd_image_scales_and_preserves_alpha(self):
        pixels = np.random.default_rng(9).integers(0, 256, (71, 97, 4), dtype=np.uint8)
        source = Image.fromarray(pixels)
        for scale in (1.25, 2, 2.75, 4, 8):
            settings = {**SETTINGS, "scale": scale}
            result = upscale.upscale_frame(source, FixtureModel(), torch, "cpu", settings)
            self.assertEqual(result.size, output_size(97, 71, settings))
            np.testing.assert_array_equal(np.asarray(result.getchannel("A")), np.asarray(source.getchannel("A").resize(result.size, Image.Resampling.LANCZOS)))

    def test_invalid_settings_fail_before_model_loading(self):
        for settings in ({"scale": 9}, {"scale": float("nan")}, {"tileSize": 0}, {"tileSize": True}, {"tileFactor": 1}, {"sizeMode": "edges", "minLongEdge": 0, "minShortEdge": 0}):
            with self.assertRaises(ValueError):
                upscale.load_upscaler({**SETTINGS, **settings}, "cpu")

    def test_minimum_targets_preserve_orientation_and_never_downscale(self):
        for mode, width, height, expected in [
                ("dimensions", 640, 480, (1920, 1440)),
                ("dimensions", 480, 640, (1920, 2560)),
                ("edges", 480, 640, (1440, 1920)),
                ("edges", 640, 480, (1920, 1440)),
                ("short-edge", 640, 480, (1366, 1024)),
                ("short-edge", 480, 640, (1024, 1366)),
                ("dimensions", 2560, 1440, (2560, 1440))]:
            with self.subTest(mode=mode, width=width):
                self.assertEqual(output_size(width, height, {**SETTINGS, "sizeMode": mode}), expected)

    def test_already_large_enough_image_is_preserved(self):
        source = Image.new("RGBA", (100, 80), (50, 100, 200, 90))
        request = {**SETTINGS, "sizeMode": "short-edge", "minShortEdge": 64}
        result = upscale.upscale_frame(source, FixtureModel(), torch, "cpu", request)
        np.testing.assert_array_equal(np.asarray(source), np.asarray(result))

    def test_automatic_tiles_follow_actual_free_memory_and_selected_device(self):
        from unittest.mock import Mock
        mocked_torch = Mock()
        mocked_torch.cuda.memory_reserved.return_value = 0
        mocked_torch.cuda.memory_allocated.return_value = 0
        mocked_torch.cuda.mem_get_info.return_value = (1024 ** 3, 16 * 1024 ** 3)
        small = resolve_tile_size({**SETTINGS, "tileMode": "automatic"}, 1920, 1080, FixtureModel(), mocked_torch, "cuda:1")
        mocked_torch.cuda.mem_get_info.assert_called_with("cuda:1")
        mocked_torch.cuda.mem_get_info.return_value = (16 * 1024 ** 3, 16 * 1024 ** 3)
        large = resolve_tile_size({**SETTINGS, "tileMode": "automatic"}, 1920, 1080, FixtureModel(), mocked_torch, "cuda:1")
        self.assertLess(small, large)
        self.assertLessEqual(large, 512)
        mocked_torch.cuda.mem_get_info.return_value = (1024 ** 3, 16 * 1024 ** 3)
        mocked_torch.cuda.memory_reserved.return_value = 15 * 1024 ** 3
        cached = resolve_tile_size({**SETTINGS, "tileMode": "automatic"}, 1920, 1080, FixtureModel(), mocked_torch, "cuda:1")
        self.assertEqual(cached, large)

    def test_factor_and_full_frame_tiles(self):
        for mode, expected in [("factor", 480), ("full", 1920)]:
            self.assertEqual(resolve_tile_size({**SETTINGS, "tileMode": mode}, 1920, 1080, FixtureModel(), torch, "cpu"), expected)

    def test_invalid_model_pixels_are_rejected(self):
        class BrokenModel:
            scale = 4

            def __init__(self, value):
                self.value = value

            def __call__(self, image):
                return torch.full((1, 3, image.shape[2] * 4, image.shape[3] * 4), self.value)

        for value in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "invalid pixels"):
                upscale.tiled_upscale(Image.new("RGB", (7, 9)), BrokenModel(value), torch, "cpu", 64)

    def test_finite_pixels_outside_the_color_range_are_clamped(self):
        class OutOfRangeModel:
            scale = 4

            def __call__(self, image):
                return torch.tensor([-0.5, 0.5, 1.5]).reshape(1, 3, 1, 1).expand(1, 3, image.shape[2] * 4, image.shape[3] * 4)

        result = upscale.tiled_upscale(Image.new("RGB", (7, 9)), OutOfRangeModel(), torch, "cpu", 64)
        np.testing.assert_array_equal(np.asarray(result), np.broadcast_to([0, 128, 255], (36, 28, 3)))

    def test_streaming_video_preserves_fractional_rate_motion_audio_and_transparency(self):
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.webm"
            frames = []
            for index in range(6):
                frame = np.zeros((24, 32, 4), dtype=np.uint8)
                frame[:, :, 0] = 180
                frame[4:16, index*2:index*2+8, 3] = 255
                frames.append(frame)
            encoded = subprocess.run([ffmpeg, "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "32x24", "-r", "30000/1001", "-i", "pipe:0", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.21", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-c:a", "libopus", "-frames:v", "6", str(source)], input=b"".join(frame.tobytes() for frame in frames), capture_output=True)
            self.assertEqual(encoded.returncode, 0, encoded.stderr)
            request = {**SETTINGS, "inputPath": str(source), "outputDirectory": str(root / "result"), "scale": 1.5}
            with patch.object(upscale, "load_upscaler", return_value=FixtureModel()):
                result = upscale.upscale_video(request, torch, "cpu", lambda *_: None)
            self.assertEqual(result["output"]["numFrames"], 6)
            self.assertAlmostEqual(result["output"]["fps"], 30000/1001)
            self.assertTrue(result["output"]["hasAudio"])
            self.assertTrue(result["output"]["hasAlpha"])
            destination = root / "result/output.webm"
            decoded = subprocess.run([ffmpeg, "-v", "error", "-c:v", "libvpx-vp9", "-i", str(destination), "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], check=True, capture_output=True)
            pixels = np.frombuffer(decoded.stdout, dtype=np.uint8).reshape(6, 36, 48, 4)
            self.assertLess(int(pixels[0, 0, 0, 3]), 5)
            self.assertGreater(int(pixels[0, 16, 8, 3]), 240)
            self.assertTrue(all(np.any(pixels[index, :, :, 3] != pixels[index - 1, :, :, 3]) for index in range(1, 6)))
            def audio_digest(path):
                return subprocess.run([ffmpeg, "-v", "error", "-i", str(path), "-map", "0:a:0", "-c:a", "pcm_s16le", "-f", "hash", "pipe:1"], check=True, capture_output=True).stdout
            self.assertEqual(audio_digest(source), audio_digest(destination))


if __name__ == "__main__":
    unittest.main()
