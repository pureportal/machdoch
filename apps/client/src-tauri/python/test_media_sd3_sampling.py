from __future__ import annotations

from types import SimpleNamespace
import math
import unittest

import diffusers
import torch

import media_image_sampling as sampling
from media_diffusers_worker import _scheduled_lora_callback


class SD3FlowHeunTests(unittest.TestCase):
    def test_flow_heun_integrates_a_known_velocity_field_and_restores_euler(self):
        original = diffusers.FlowMatchEulerDiscreteScheduler(shift=3)
        pipeline = SimpleNamespace(scheduler=original)
        sampling.configure_sampler(pipeline, diffusers, "stable-diffusion-3", "flow-heun")
        scheduler = pipeline.scheduler
        self.assertIsInstance(scheduler, diffusers.FlowMatchHeunDiscreteScheduler)
        self.assertEqual(scheduler.config.shift, 3)
        scheduler.set_timesteps(4, device="cpu")
        sample = torch.zeros(1, 1)
        initial_sigma = float(scheduler.sigmas[0])
        for timestep in scheduler.timesteps:
            sigma = float(scheduler.sigmas[scheduler.step_index or 0])
            sample = scheduler.step(torch.full_like(sample, sigma), timestep, sample).prev_sample
        self.assertAlmostEqual(float(sample), -initial_sigma**2 / 2, delta=1e-4)
        sampling.configure_sampler(pipeline, diffusers, "stable-diffusion-3", None)
        self.assertIs(pipeline.scheduler, original)
        for architecture in ("stable-diffusion-3.5-large-turbo", "qwen-image", "flux-1-dev", "stable-diffusion-xl"):
            with self.subTest(architecture=architecture), self.assertRaisesRegex(ValueError, "compatible sampler"):
                sampling.validate_sampler(architecture, "flow-heun")

    def test_actual_sd35_pipeline_uses_both_heun_evaluations_with_guidance(self):
        transformer = diffusers.SD3Transformer2DModel(
            sample_size=16,
            patch_size=2,
            in_channels=4,
            out_channels=4,
            num_layers=2,
            attention_head_dim=16,
            num_attention_heads=2,
            joint_attention_dim=32,
            caption_projection_dim=32,
            pooled_projection_dim=32,
            pos_embed_max_size=32,
            dual_attention_layers=(0,),
            qk_norm="rms_norm",
        )
        vae = diffusers.AutoencoderKL(
            block_out_channels=(16, 32, 32),
            down_block_types=("DownEncoderBlock2D",) * 3,
            up_block_types=("UpDecoderBlock2D",) * 3,
            latent_channels=4,
            norm_num_groups=8,
        )
        pipeline = diffusers.StableDiffusion3Pipeline(
            transformer=transformer,
            vae=vae,
            scheduler=diffusers.FlowMatchEulerDiscreteScheduler(shift=3),
            text_encoder=None,
            tokenizer=None,
            text_encoder_2=None,
            tokenizer_2=None,
            text_encoder_3=None,
            tokenizer_3=None,
        )
        pipeline.set_progress_bar_config(disable=True)
        arguments = {
            "prompt_embeds": torch.randn(1, 8, 32),
            "negative_prompt_embeds": torch.randn(1, 8, 32),
            "pooled_prompt_embeds": torch.randn(1, 32),
            "negative_pooled_prompt_embeds": torch.randn(1, 32),
            "width": 64,
            "height": 64,
            "num_inference_steps": 4,
            "guidance_scale": 5,
            "output_type": "latent",
        }
        for sampler, evaluations in (("flow-heun", 7), ("flow-euler", 4)):
            with self.subTest(sampler=sampler):
                callbacks = []
                adapter_updates = []
                pipeline.set_adapters = lambda names, adapter_weights: adapter_updates.append((len(callbacks), adapter_weights))
                schedule = _scheduled_lora_callback(["style"], [1.0], [{"start": 0, "end": 0.75}])

                def step_end(pipe, step, timestep, values):
                    callbacks.append(float(timestep))
                    return schedule(pipe, step, timestep, values)

                sampling.configure_sampler(pipeline, diffusers, "stable-diffusion-3", sampler)
                with torch.inference_mode():
                    output = pipeline(
                        **arguments,
                        generator=torch.Generator(device="cpu").manual_seed(42),
                        callback_on_step_end=step_end,
                    ).images
                self.assertEqual(output.shape, (1, 4, 16, 16))
                self.assertTrue(torch.isfinite(output).all())
                self.assertEqual(len(callbacks), evaluations)
                self.assertEqual(adapter_updates, [(math.ceil(0.75 * evaluations), [0.0])])
                self.assertEqual(pipeline.scheduler.config.shift, 3)


if __name__ == "__main__":
    torch.set_num_threads(2)
    unittest.main()
