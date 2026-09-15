from __future__ import annotations

import importlib.util
import subprocess
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import imageio_ffmpeg
import numpy as np
from media_video_io import alpha_frame_coverage, encode_frames

spec = importlib.util.spec_from_file_location(
    "media_diffusers_worker", Path(__file__).with_name("media_diffusers_worker.py")
)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class MediaVideoDeliveryTests(unittest.TestCase):
    def test_wan_sampling_callback_runs_in_every_loop_mode(self):
        class SamplingComplete(Exception):
            pass

        class Pipeline:
            num_timesteps = 8

            def __call__(self, **arguments):
                values = {"latents": object()}
                updated = arguments["callback_on_step_end"](self, 0, 1, values)
                if updated is not values:
                    raise AssertionError("The progress callback changed sampler values")
                raise SamplingComplete

        torch = SimpleNamespace(
            device=lambda value: value,
            cuda=SimpleNamespace(current_device=lambda: 0),
            Generator=lambda **kwargs: SimpleNamespace(manual_seed=lambda seed: None),
        )
        embeddings = SimpleNamespace(to=lambda device: None)
        replacements = {
            "_runtime": (torch, object()),
            "_device": ("cuda", "test-gpu", 24 * 1024**3),
            "_absolute_existing_path": Path("source.png"),
            "_fresh_output_directory": Path("output"),
            "_prepare_video_conditioning_frame": (object(), {}),
            "_sha256_file": "same-image",
            "_start_video_memory_observation": {},
            "_configure_video_conv3d_backend": "cudnn",
            "_load_video_pipeline": (Pipeline(), embeddings, embeddings),
        }
        with ExitStack() as stack:
            for name, value in replacements.items():
                stack.enter_context(mock.patch.object(worker, name, return_value=value))
            for mode in ("none", "ping-pong", "seamless", "crossfade"):
                with self.subTest(mode=mode), self.assertRaises(SamplingComplete):
                    worker.generate_video(
                        {
                            "schemaVersion": worker.SCHEMA_VERSION,
                            "model": {"architecture": "wan-2.2-ti2v"},
                            "experimentalLowMemory": True,
                            "prompt": "Leaves move in the breeze",
                            "firstFramePath": "source.png",
                            "lastFramePath": "source.png",
                            "outputDirectory": "output",
                            "aspectRatio": "16:9",
                            "numFrames": 17,
                            "numInferenceSteps": 8,
                            "fps": 8,
                            "loopMode": mode,
                            "seed": 0,
                        }
                    )

    def test_crossfade_encodes_the_checked_sequence_and_duration(self):
        import cv2

        noise = np.random.default_rng(81).integers(0, 256, (64, 18, 3), dtype=np.uint8)
        texture = cv2.GaussianBlur(np.tile(noise, (1, 4, 1)), (5, 5), 0)
        frames = [np.roll(texture, index * 2, axis=1) for index in range(17)]
        with tempfile.TemporaryDirectory() as temporary:
            destination, evidence, _ = worker._encode_video_webm(
                frames,
                Path(temporary),
                8,
                None,
                transparent_background=False,
                loop_mode="crossfade",
                matte_quality="balanced",
                encoding_quality="lossless",
            )
            self.assertTrue(destination.is_file())
            self.assertEqual(evidence["frameCount"], 9)
            self.assertEqual(evidence["sourceFrameCount"], 17)
            self.assertEqual(evidence["durationSeconds"], 9 / 8)
            self.assertEqual(evidence["decodedExactAdjacentDuplicateCount"], 0)
            for stage in ("generated", "decoded"):
                self.assertEqual(
                    [
                        entry["frameIndices"][2]
                        for entry in evidence["loopBoundaryInspection"][stage]
                    ],
                    list(range(9)),
                )

    def test_encoder_rejects_a_bad_loop_before_creating_output(self):
        frames = [
            np.full((32, 32, 3), value, dtype=np.uint8)
            for value in (30, 31, 32, 33, 34, 35, 220, 221, 30)
        ]
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(worker.WorkerError, "visual change"):
                worker._encode_video_webm(
                    frames,
                    Path(temporary),
                    8,
                    None,
                    transparent_background=False,
                    loop_mode="seamless",
                    matte_quality="balanced",
                    encoding_quality="lossless",
                )
            self.assertEqual(list(Path(temporary).iterdir()), [])

    def test_encoder_rejects_nonfinite_generated_pixels(self):
        for invalid in (np.nan, np.inf, -np.inf):
            with (
                self.subTest(invalid=invalid),
                self.assertRaisesRegex(worker.WorkerError, "nonfinite pixels"),
            ):
                worker._frame_rgb_array(np.full((16, 16, 3), invalid))

    def test_crossfade_preserves_alpha_and_checks_the_composited_delivery(self):
        frames = []
        for index in range(17):
            angle = 2 * np.pi * index / 9
            x, y = round(18 + 5 * np.cos(angle)), round(18 + 5 * np.sin(angle))
            frame = np.full((64, 64, 3), (0, 255, 0), dtype=np.uint8)
            frame[y : y + 28, x : x + 28] = (210, 40, 80)
            frame[y + 7 : y + 21, x + 7 : x + 21] = (40, 50, 210)
            frames.append(frame)
        with tempfile.TemporaryDirectory() as temporary:
            _, evidence, composite = worker._encode_video_webm(
                frames,
                Path(temporary),
                8,
                {
                    "style": "gradient",
                    "direction": "horizontal",
                    "colorStart": "#203040",
                    "colorEnd": "#506070",
                    "cycles": 1,
                },
                transparent_background=True,
                loop_mode="crossfade",
                matte_quality="balanced",
                encoding_quality="lossless",
            )
            self.assertEqual(evidence["decodedFrameCount"], 9)
            self.assertEqual(len(evidence["matte"]["decodedFrameCoverage"]), 9)
            self.assertTrue(evidence["matte"]["losslessAlphaVerified"])
            self.assertEqual(composite[1]["decodedFrameCount"], 9)
            self.assertEqual(evidence["frameCadence"], "motion-compensated-overlap")
            self.assertEqual(composite[1]["frameCadence"], "motion-compensated-overlap")
            self.assertEqual(len(composite[1]["loopBoundaryInspection"]["decoded"]), 9)

    def test_transparent_ping_pong_and_composite_keep_every_frame(self):
        frames = []
        for index in range(5):
            frame = np.full((64, 64, 3), (0, 255, 0), dtype=np.uint8)
            frame[16:48, 20 + index : 40 + index] = (210, 40, 80)
            frames.append(frame)
        with tempfile.TemporaryDirectory() as temporary:
            destination, evidence, composite = worker._encode_video_webm(
                frames,
                Path(temporary),
                8,
                {
                    "style": "gradient",
                    "direction": "horizontal",
                    "colorStart": "#203040",
                    "colorEnd": "#506070",
                    "cycles": 1,
                },
                transparent_background=True,
                loop_mode="ping-pong",
                matte_quality="balanced",
                encoding_quality="lossless",
            )
            self.assertTrue(destination.is_file())
            self.assertEqual(evidence["frameCount"], 8)
            self.assertEqual(evidence["durationSeconds"], 1)
            self.assertEqual(len(evidence["matte"]["decodedFrameCoverage"]), 8)
            self.assertEqual(evidence["matte"]["temporalBoundaryMode"], "ping-pong")
            self.assertTrue(evidence["matte"]["losslessAlphaVerified"])
            self.assertTrue(composite[0].is_file())
            self.assertEqual(composite[1]["decodedFrameCount"], 8)
            self.assertFalse(any(path.is_dir() for path in Path(temporary).iterdir()))

    def test_alpha_validation_rejects_one_bad_frame_in_an_otherwise_valid_video(self):
        valid = np.full((16, 16, 4), 255, dtype=np.uint8)
        valid[:8, :, 3] = 0
        opaque = valid.copy()
        opaque[..., 3] = 255
        empty = valid.copy()
        empty[..., 3] = 0
        for invalid, message in (
            (opaque, "fully opaque"),
            (empty, "no visible subject"),
        ):
            with (
                self.subTest(message=message),
                self.assertRaisesRegex(ValueError, message),
            ):
                alpha_frame_coverage([valid, invalid, valid], "Encoded video")

    def test_alpha_validation_retains_soft_transparency(self):
        frame = np.zeros((8, 8, 4), dtype=np.uint8)
        frame[2:6, 2:6, 3] = 128
        self.assertEqual(
            alpha_frame_coverage([frame], "Video")[0],
            {
                "minimum": 0,
                "maximum": 128,
                "transparentPixels": 48,
                "softPixels": 16,
                "opaquePixels": 0,
            },
        )

    def test_loop_matte_stabilizes_the_seam_and_turnaround(self):
        alphas = [
            np.full((4, 4), value, dtype=np.uint8)
            for value in (116, 100, 100, 100, 116)
        ]
        original = [alpha.copy() for alpha in alphas]
        for mode in ("seamless", "ping-pong"):
            stabilized = worker._temporally_stabilize_alpha(alphas, 0.5, mode)
            self.assertEqual(int(stabilized[0][0, 0]), 108)
            self.assertEqual(int(stabilized[-1][0, 0]), 108)
            for actual, expected in zip(alphas, original, strict=True):
                np.testing.assert_array_equal(actual, expected)
        unlooped = worker._temporally_stabilize_alpha(alphas, 0.5, "none")
        self.assertEqual(int(unlooped[0][0, 0]), 116)

    def test_loop_matte_preserves_a_moving_subject_edge(self):
        alphas = [
            np.full((4, 4), value, dtype=np.uint8) for value in (255, 100, 0, 100, 255)
        ]
        stabilized = worker._temporally_stabilize_alpha(alphas, 0.5, "seamless")
        for actual, expected in zip(stabilized, alphas, strict=True):
            np.testing.assert_array_equal(actual, expected)

    def test_streamed_vp9_preserves_frame_order_and_alpha(self):
        frames = []
        for index in range(4):
            frame = np.zeros((32, 256, 4), dtype=np.uint8)
            frame[..., :3] = (150 + index * 20, 40, 60)
            frame[..., 3] = np.roll(np.arange(256, dtype=np.uint8), index)[None, :]
            frames.append(frame)
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "output.webm"
            encode_frames(
                ffmpeg,
                destination,
                frames,
                8,
                [
                    "-c:v",
                    "libvpx-vp9",
                    "-pix_fmt",
                    "yuva420p",
                    *worker._vp9_quality_arguments("lossless", alpha=True),
                ],
                alpha=True,
            )
            decoded = subprocess.run(
                [
                    ffmpeg,
                    "-v",
                    "error",
                    "-c:v",
                    "libvpx-vp9",
                    "-i",
                    str(destination),
                    "-pix_fmt",
                    "rgba",
                    "-f",
                    "rawvideo",
                    "-",
                ],
                capture_output=True,
                check=True,
                timeout=30,
            )
            pixels = np.frombuffer(decoded.stdout, dtype=np.uint8).reshape(
                4, 32, 256, 4
            )
            np.testing.assert_array_equal(pixels[..., 3], np.stack(frames)[..., 3])
            self.assertTrue(np.all(np.diff(pixels[:, 16, 16, 0].astype(int)) > 0))
            self.assertEqual(list(Path(temporary).iterdir()), [destination])

    def test_encoder_failure_reports_ffmpeg_diagnostic(self):
        with (
            tempfile.TemporaryDirectory() as temporary,
            self.assertRaisesRegex(ValueError, "VP9 encoding failed"),
        ):
            encode_frames(
                imageio_ffmpeg.get_ffmpeg_exe(),
                Path(temporary) / "bad.webm",
                [np.zeros((32, 32, 3), dtype=np.uint8)] * 8,
                8,
                ["-c:v", "nonexistent-machdoch-codec"],
                alpha=False,
            )

    def test_encoder_timeout_terminates_the_process(self):
        with (
            tempfile.TemporaryDirectory() as temporary,
            self.assertRaisesRegex(ValueError, "timed out"),
        ):
            encode_frames(
                imageio_ffmpeg.get_ffmpeg_exe(),
                Path(temporary) / "slow.webm",
                [np.zeros((512, 512, 3), dtype=np.uint8)] * 64,
                8,
                ["-c:v", "libvpx-vp9"],
                alpha=False,
                timeout_seconds=0.001,
            )

    def test_error_measurement_matches_full_array_reference(self):
        rng = np.random.default_rng(0)
        source = rng.integers(0, 256, (5, 12, 16, 4), dtype=np.uint8)
        decoded = rng.integers(0, 256, source.shape, dtype=np.uint8)
        difference = np.abs(
            decoded[..., :3].astype(np.int16) - source[..., :3].astype(np.int16)
        )
        evidence = worker._decoded_rgb_encoding_evidence(decoded, list(source))
        self.assertEqual(
            evidence,
            {"mae": float(difference.mean()), "maximumError": int(difference.max())},
        )


if __name__ == "__main__":
    unittest.main()
