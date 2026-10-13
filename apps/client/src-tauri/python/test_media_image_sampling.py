from __future__ import annotations

from types import SimpleNamespace
import unittest

import torch
import diffusers

import media_image_sampling as sampling
import media_open_models as models


class ImageSamplerTests(unittest.TestCase):
    def test_hidream_samplers_preserve_the_published_flow_shift(self):
        for sampler in (None, "unipc", "flow-euler"):
            with self.subTest(sampler=sampler):
                original = diffusers.UniPCMultistepScheduler(use_flow_sigmas=True, prediction_type="flow_prediction", flow_shift=3.0)
                pipeline = SimpleNamespace(scheduler=original)
                sampling.configure_sampler(pipeline, diffusers, "hidream-i1-full", sampler)
                scheduler = pipeline.scheduler
                if sampler == "flow-euler":
                    self.assertEqual(scheduler.config.shift, 3.0)
                else:
                    self.assertEqual(scheduler.config.flow_shift, 3.0)
                    self.assertTrue(scheduler.config.use_flow_sigmas)
                    self.assertEqual(scheduler.config.prediction_type, "flow_prediction")
                scheduler.set_timesteps(50)
                self.assertTrue(torch.isfinite(scheduler.sigmas).all())
                self.assertTrue(torch.all(scheduler.sigmas[:-1] >= scheduler.sigmas[1:]))

    def test_turbo_automatic_and_manual_samplers_keep_trailing_timesteps(self):
        for architecture in ("sd-turbo", "sdxl-turbo"):
            for sampler in (None, "euler", "euler-ancestral", "dpmpp-2m-karras"):
                with self.subTest(architecture=architecture, sampler=sampler):
                    pipeline = SimpleNamespace(scheduler=diffusers.EulerDiscreteScheduler(timestep_spacing="leading"))
                    sampling.configure_sampler(pipeline, diffusers, architecture, sampler)
                    self.assertEqual(pipeline.scheduler.config.timestep_spacing, "trailing")
                    pipeline.scheduler.set_timesteps(4)
                    self.assertEqual(int(pipeline.scheduler.timesteps[0]), 999)
                    latent = torch.randn(1, 4, 8, 8)
                    for timestep in pipeline.scheduler.timesteps:
                        pipeline.scheduler.scale_model_input(latent, timestep)
                        latent = pipeline.scheduler.step(torch.zeros_like(latent), timestep, latent).prev_sample
                    self.assertTrue(torch.isfinite(latent).all())

    def test_deis_uses_second_order_for_guided_latent_diffusion(self):
        original = diffusers.PNDMScheduler(
            beta_start=0.00085, beta_end=0.012, beta_schedule="scaled_linear",
            prediction_type="epsilon",
        )
        pipeline = SimpleNamespace(scheduler=original)
        sampling.configure_sampler(pipeline, diffusers, "stable-diffusion-1", "deis")
        self.assertIsInstance(pipeline.scheduler, diffusers.DEISMultistepScheduler)
        self.assertEqual(pipeline.scheduler.config.solver_order, 2)
        self.assertEqual(pipeline.scheduler.config.beta_start, original.config.beta_start)
        self.assertEqual(pipeline.scheduler.config.beta_end, original.config.beta_end)
        self.assertEqual(pipeline.scheduler.config.prediction_type, "epsilon")

    def test_sana_solvers_preserve_the_publishers_flow_and_trigflow_parameters(self):
        cases = [
            ("sana", "dpmpp-2m", diffusers.DPMSolverMultistepScheduler(prediction_type="flow_prediction", use_flow_sigmas=True, flow_shift=3.0, algorithm_type="dpmsolver++")),
            ("sana-sprint", "scm", diffusers.SCMScheduler(prediction_type="trigflow", sigma_data=0.5)),
        ]
        for architecture, sampler, original in cases:
            with self.subTest(architecture=architecture):
                pipeline = SimpleNamespace(scheduler=original)
                sampling.configure_sampler(pipeline, diffusers, architecture, sampler)
                scheduler = pipeline.scheduler
                self.assertEqual(scheduler.config.prediction_type, original.config.prediction_type)
                for steps in ([1, 2, 3, 4] if architecture == "sana-sprint" else [4]):
                    arguments = models.image_arguments(architecture, {"numInferenceSteps": steps}, [], "")
                    timestep_options = {"intermediate_timesteps": arguments["intermediate_timesteps"]} if "intermediate_timesteps" in arguments else {}
                    scheduler.set_timesteps(steps, device="cpu", **timestep_options)
                    latent = torch.randn(1, 4, 8, 8)
                    timesteps = scheduler.timesteps[:-1] if architecture == "sana-sprint" else scheduler.timesteps
                    self.assertEqual(len(timesteps), steps)
                    for timestep in timesteps:
                        latent = scheduler.step(torch.zeros_like(latent), timestep, latent).prev_sample
                    self.assertTrue(torch.isfinite(latent).all())
                if architecture == "sana":
                    self.assertTrue(scheduler.config.use_flow_sigmas)
                    self.assertEqual(scheduler.config.flow_shift, 3.0)
                else:
                    self.assertEqual(scheduler.config.sigma_data, 0.5)

    def test_diffusion_samplers_preserve_velocity_prediction_and_produce_finite_steps(self):
        original = diffusers.EulerDiscreteScheduler(prediction_type="v_prediction")
        pipeline = SimpleNamespace(scheduler=original)
        for name in sampling.SAMPLING_PROFILES["stable-diffusion-xl"]["samplers"]:
            with self.subTest(sampler=name):
                sampling.configure_sampler(pipeline, diffusers, "stable-diffusion-xl", name)
                scheduler = pipeline.scheduler
                self.assertEqual(scheduler.config.prediction_type, "v_prediction")
                class_name, options = sampling.SAMPLERS[name]
                self.assertEqual(type(scheduler).__name__, class_name)
                for option, value in options.items():
                    self.assertEqual(getattr(scheduler.config, option), value)
                scheduler.set_timesteps(4, device="cpu")
                latent = torch.randn(1, 4, 8, 8)
                for timestep in scheduler.timesteps:
                    scheduler.scale_model_input(latent, timestep)
                    latent = scheduler.step(torch.zeros_like(latent), timestep, latent).prev_sample
                self.assertTrue(torch.isfinite(latent).all())
        sampling.configure_sampler(pipeline, diffusers, "stable-diffusion-xl", None)
        self.assertIs(pipeline.scheduler, original)

    def test_flow_scheduler_retains_shift_and_custom_turbo_trajectory(self):
        original = diffusers.FlowMatchEulerDiscreteScheduler(shift=3.0)
        pipeline = SimpleNamespace(scheduler=original)
        sampling.configure_sampler(pipeline, diffusers, "qwen-image-2.1-turbo", "flow-euler")
        self.assertEqual(pipeline.scheduler.config.shift, 3.0)
        arguments = models.image_arguments("qwen-image-2.1-turbo", {}, [], "")
        self.assertEqual(len(arguments["sigmas"]), 8)
        self.assertEqual(arguments["true_cfg_scale"], 1)
        self.assertTrue(arguments["use_kv_cache"])
        pipeline.scheduler.set_timesteps(sigmas=arguments["sigmas"], device="cpu")
        self.assertEqual(len(pipeline.scheduler.timesteps), 8)
        self.assertTrue(torch.all(pipeline.scheduler.timesteps[:-1] > pipeline.scheduler.timesteps[1:]))

    def test_invalid_samplers_and_cross_family_schedulers_are_rejected(self):
        for architecture, sampler in [("krea-2", "dpmpp-2m-karras"), ("qwen-image-2.1-turbo", "euler"), ("stable-diffusion-xl", "flow-euler"), ("unknown", "euler"), ("pony", 10)]:
            with self.subTest(architecture=architecture, sampler=sampler), self.assertRaisesRegex(ValueError, "compatible sampler"):
                sampling.validate_sampler(architecture, sampler)

    def test_every_image_engine_has_a_valid_researched_sampling_profile(self):
        for profile in models.PROFILES.values():
            if not any(capability in profile["capabilities"] for capability in ["text-to-image", "image-to-image"]):
                continue
            with self.subTest(architecture=profile["architecture"]):
                recommendation = sampling.SAMPLING_PROFILES[profile["architecture"]]
                self.assertLessEqual(recommendation["steps"][0], profile["steps"])
                self.assertGreaterEqual(recommendation["steps"][1], profile["steps"])
                self.assertTrue(recommendation["sources"])


if __name__ == "__main__":
    unittest.main()
