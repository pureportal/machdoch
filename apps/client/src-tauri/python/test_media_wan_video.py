from __future__ import annotations

import unittest
from types import MethodType, SimpleNamespace

import numpy as np
import torch
from diffusers import WanImageToVideoPipeline
from PIL import Image

import media_diffusers_worker as worker


class WanVideoTests(unittest.TestCase):
    def test_first_frame_conditioning_leaves_the_remaining_timeline_free(self) -> None:
        encoded_lengths = []

        def encode(video):
            encoded_lengths.append(video.shape[2])
            return SimpleNamespace(latents=torch.zeros(1, 48, 1, 2, 2))

        pipeline = SimpleNamespace(
            vae_scale_factor_temporal=4,
            vae_scale_factor_spatial=16,
            config=SimpleNamespace(expand_timesteps=True),
            vae=SimpleNamespace(
                dtype=torch.float32,
                encode=encode,
                config=SimpleNamespace(
                    z_dim=48,
                    latents_mean=[0.0] * 48,
                    latents_std=[1.0] * 48,
                ),
            ),
        )
        pipeline.prepare_latents = MethodType(
            WanImageToVideoPipeline.prepare_latents, pipeline
        )
        worker._enable_wan_last_frame_conditioning(pipeline, torch)
        latents, condition, mask = pipeline.prepare_latents(
            torch.zeros(1, 3, 32, 32),
            batch_size=1,
            num_channels_latents=48,
            height=32,
            width=32,
            num_frames=17,
            dtype=torch.float32,
            device=torch.device("cpu"),
            generator=torch.Generator().manual_seed(9152026),
            last_image=None,
        )
        self.assertEqual(encoded_lengths, [1])
        self.assertEqual(tuple(latents.shape), (1, 48, 5, 2, 2))
        self.assertEqual(tuple(condition.shape), (1, 48, 1, 2, 2))
        torch.testing.assert_close(mask[:, :, 0], torch.zeros(1, 1, 2, 2))
        torch.testing.assert_close(mask[:, :, 1:], torch.ones(1, 1, 4, 2, 2))

    def test_preview_canvases_sample_at_the_model_pixel_budget(self) -> None:
        for resolution in ("preview-512", "quality-640", "quality-768"):
            for aspect in ("1:1", "16:9", "9:16", "21:9"):
                with self.subTest(resolution=resolution, aspect=aspect):
                    width, height = worker._video_dimensions(aspect, resolution)
                    native_width, native_height = worker._wan_generation_dimensions(
                        width, height
                    )
                    self.assertGreaterEqual(native_width * native_height, 704 * 1280)
                    self.assertEqual(native_width % 32, 0)
                    self.assertEqual(native_height % 32, 0)
                    self.assertGreaterEqual(native_width, width)
                    self.assertGreaterEqual(native_height, height)
                    self.assertLess(
                        abs((native_width / native_height) / (width / height) - 1),
                        0.05,
                    )

    def test_native_sizes_and_custom_square_outputs(self) -> None:
        self.assertEqual(worker._wan_generation_dimensions(1280, 704), (1280, 704))
        self.assertEqual(worker._wan_generation_dimensions(704, 1280), (704, 1280))
        self.assertEqual(worker._wan_generation_dimensions(384, 384), (960, 960))
        self.assertEqual(worker._wan_generation_dimensions(1536, 1024), (1536, 1024))

    def test_delivery_preserves_geometry_after_sampling_grid_rounding(self) -> None:
        pixels = np.zeros((736, 1280, 3), dtype=np.uint8)
        pixels[288:448, 560:720] = 255
        for frame, size in (
            (pixels, (512, 288)),
            (pixels.transpose(1, 0, 2), (288, 512)),
        ):
            with self.subTest(size=size):
                delivered = worker._wan_delivery_frames([frame], *size)[0]
                self.assertEqual(delivered.size, size)
                y, x = np.where(np.asarray(delivered)[:, :, 0] >= 128)
                self.assertEqual(int(x.max() - x.min() + 1), 64)
                self.assertEqual(int(y.max() - y.min() + 1), 64)

    def test_square_delivery_retains_existing_resampling(self) -> None:
        pixels = np.random.default_rng(9152026).integers(
            0, 256, (128, 128, 3), dtype=np.uint8
        )
        image = Image.fromarray(pixels)
        delivered = worker._wan_delivery_frames([image], 64, 64)[0]
        np.testing.assert_array_equal(
            np.asarray(delivered),
            np.asarray(image.resize((64, 64), Image.Resampling.LANCZOS)),
        )

    def test_vae_tiles_fit_the_reviewed_sixteen_gib_profile(self) -> None:
        for memory, size in ((None, 128), (16 * 1024**3, 128), (24 * 1024**3, 256)):
            with self.subTest(memory=memory):
                tiles = worker._wan_vae_tile_configuration(memory)
                self.assertEqual(tiles["tile_sample_min_width"], size)
                self.assertEqual(tiles["tile_sample_min_height"], size)
                self.assertEqual(tiles["tile_sample_stride_width"], size * 3 // 4)
                self.assertEqual(tiles["tile_sample_stride_height"], size * 3 // 4)


if __name__ == "__main__":
    unittest.main()
