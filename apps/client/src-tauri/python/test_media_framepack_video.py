from __future__ import annotations

from types import MethodType, SimpleNamespace
import unittest

import torch
from diffusers import AutoencoderKLHunyuanVideo

import media_diffusers_worker as worker


class FramePackVideoTests(unittest.TestCase):
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
