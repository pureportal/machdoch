from __future__ import annotations

import copy
import os
import unittest
from unittest import mock

import diffusers
import torch

import media_diffusers_worker as worker


@unittest.skipUnless(os.environ.get("MACHDOCH_IMAGE_GPU_TEST") == "1", "Requires an explicitly selected image GPU")
class ImageVAEDecodeDeviceTests(unittest.TestCase):
    def test_group_offloaded_qwen_pipeline_decodes_repeated_full_frames_and_tiles(self):
        self.assertTrue(torch.cuda.is_available())
        device = torch.device("cuda", torch.cuda.current_device())
        torch.manual_seed(43)
        if torch.version.hip:
            torch.backends.cudnn.enabled = False
        vae = diffusers.AutoencoderKLQwenImage(
            base_dim=8, z_dim=4, dim_mult=[1, 1], num_res_blocks=1,
            temperal_downsample=[False], latents_mean=[0.0] * 4, latents_std=[1.0] * 4,
        ).eval()
        reference = copy.deepcopy(vae).to(device)
        transformer = diffusers.QwenImageTransformer2DModel(
            in_channels=16, out_channels=4, num_layers=1, attention_head_dim=8,
            num_attention_heads=2, joint_attention_dim=64, axes_dims_rope=(2, 2, 4),
        )
        pipeline = diffusers.QwenImagePipeline(
            vae=vae, transformer=transformer, scheduler=diffusers.FlowMatchEulerDiscreteScheduler(),
            text_encoder=None, tokenizer=None,
        )
        with mock.patch.object(worker, "_physical_memory_bytes", return_value=32 * 1024**3):
            worker._configure_image_group_offload(pipeline, torch)
        latents = torch.randn((1, 4, 1, 8, 12), device=device)
        for tiled in (False, True):
            with self.subTest(tiled=tiled):
                for decoder in (reference, pipeline.vae):
                    if tiled:
                        decoder.enable_tiling(tile_sample_min_height=12, tile_sample_min_width=12, tile_sample_stride_height=8, tile_sample_stride_width=8)
                    else:
                        decoder.disable_tiling()
                with torch.inference_mode():
                    expected = reference.decode(latents).sample
                    for _ in range(2):
                        actual = pipeline.vae.decode(latents).sample
                        torch.testing.assert_close(actual, expected)
                        self.assertEqual(actual.shape, (1, 3, 1, 16, 24))
                        self.assertTrue(torch.isfinite(actual).all())
        self.assertTrue(all(parameter.device == device for parameter in pipeline.vae.parameters()))
        self.assertTrue(all(parameter.device.type == "cpu" for parameter in pipeline.transformer.parameters()))


if __name__ == "__main__":
    unittest.main()
