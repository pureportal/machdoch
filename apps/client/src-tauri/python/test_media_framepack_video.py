from __future__ import annotations

from types import MethodType, SimpleNamespace
import unittest

import numpy as np
from PIL import Image
import torch
from diffusers import AutoencoderKLHunyuanVideo

import media_diffusers_worker as worker


class FramePackVideoTests(unittest.TestCase):
    def test_output_timing_preserves_a_uniform_trajectory_and_both_endpoints(
        self,
    ) -> None:
        frames = [Image.new("RGB", (32, 32), (index * 6,) * 3) for index in range(37)]
        selected = worker._framepack_requested_frames(frames, 25)
        self.assertEqual(len(selected), 25)
        self.assertIs(selected[0], frames[0])
        self.assertIs(selected[-1], frames[-1])
        for index, frame in enumerate(selected):
            np.testing.assert_array_equal(np.asarray(frame), index * 9)

    def test_exact_frame_count_is_preserved_and_incomplete_video_is_rejected(
        self,
    ) -> None:
        frames = [Image.new("RGB", (32, 32), (index,) * 3) for index in range(37)]
        self.assertIs(worker._framepack_requested_frames(frames, 37), frames)
        with self.assertRaisesRegex(worker.WorkerError, "fewer decoded frames"):
            worker._framepack_requested_frames(frames[:16], 17)

    def test_temporal_tiles_preserve_the_complete_timeline(self) -> None:
        latents = torch.arange(10, dtype=torch.float32).reshape(1, 1, 10, 1, 1)

        def decode_timeline(value: torch.Tensor) -> torch.Tensor:
            return torch.nn.functional.interpolate(
                value,
                size=((value.shape[2] - 1) * 4 + 1, 1, 1),
                mode="trilinear",
                align_corners=True,
            )

        expected = decode_timeline(latents)
        for memory in (None, 6 * 1024**3, 16 * 1024**3, 24 * 1024**3):
            with self.subTest(memory=memory):
                vae = SimpleNamespace(
                    **worker._framepack_vae_tile_configuration(memory),
                    temporal_compression_ratio=4,
                    spatial_compression_ratio=8,
                    use_tiling=False,
                    post_quant_conv=lambda value: value,
                    decoder=decode_timeline,
                )
                vae.blend_t = MethodType(AutoencoderKLHunyuanVideo.blend_t, vae)
                actual = AutoencoderKLHunyuanVideo._temporal_tiled_decode(
                    vae, latents, return_dict=False
                )[0]
                torch.testing.assert_close(actual, expected)


if __name__ == "__main__":
    unittest.main()
