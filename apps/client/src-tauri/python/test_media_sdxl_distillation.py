import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import torch
from diffusers import AutoencoderKL, LCMScheduler

import media_diffusers_worker as worker
import media_open_models as models
import media_sdxl_distillation as sdxl
from media_student_checkpoints import checkpoint_path


class SDXLStudentTests(unittest.TestCase):
    def test_native_rocm_decoder_bounds_actual_vae_tiles(self):
        vae = AutoencoderKL(
            block_out_channels=(4, 4, 4, 4), norm_num_groups=4,
            down_block_types=("DownEncoderBlock2D",) * 4,
            up_block_types=("UpDecoderBlock2D",) * 4,
            layers_per_block=1, sample_size=1024,
        ).eval()
        rocm = SimpleNamespace(version=SimpleNamespace(hip="7.14"),
                               backends=SimpleNamespace(cudnn=SimpleNamespace(enabled=False)))
        evidence = worker._configure_large_image_vae_decode(
            SimpleNamespace(vae=vae), "stable-diffusion-xl-dmad-4step", rocm, 1024, 768,
        )
        tile_shapes = []
        handle = vae.decoder.register_forward_pre_hook(
            lambda module, args: tile_shapes.append(args[0].shape[-2:]),
        )
        try:
            with torch.no_grad():
                decoded = vae.decode(torch.zeros(1, 4, 128, 96)).sample
        finally:
            handle.remove()
        self.assertEqual(decoded.shape, (1, 3, 1024, 768))
        self.assertTrue(torch.isfinite(decoded).all())
        self.assertGreater(len(tile_shapes), 1)
        self.assertTrue(all(max(shape) <= 64 for shape in tile_shapes))
        self.assertEqual(evidence["mode"], "native-overlap-tiled")
        self.assertEqual(evidence["device"], "pipeline")

    def test_spectral_weights_use_the_first_forward_power_iteration_and_gain(self):
        for dtype in (torch.float32, torch.float16):
            with self.subTest(dtype=dtype):
                state = {
                    "conv.parametrizations.weight.original": torch.diag(torch.tensor([4.0, 2.0], dtype=dtype)).reshape(2, 2, 1, 1),
                    "conv.parametrizations.weight.0.u": torch.tensor([1.0, 0.0], dtype=dtype),
                    "conv.parametrizations.weight.0.v": torch.tensor([0.0, 1.0], dtype=dtype),
                    "conv.parametrizations.weight.0.gain": torch.tensor(3.0, dtype=dtype),
                    "conv.bias": torch.zeros(2, dtype=dtype),
                }
                converted = sdxl.fold_spectral_weights(state)
                expected = torch.diag(torch.tensor([3.0, 1.5], dtype=dtype)).reshape(2, 2, 1, 1)
                self.assertEqual(set(converted), {"conv.weight", "conv.bias"})
                self.assertTrue(torch.equal(converted["conv.weight"], expected))
                self.assertIs(converted["conv.bias"], state["conv.bias"])
                target = torch.nn.Conv2d(2, 2, 1, device="meta")
                target.load_state_dict({"weight": converted["conv.weight"], "bias": converted["conv.bias"]}, strict=True, assign=True)
                self.assertTrue(torch.equal(target.weight, expected))
                invalid = {**state, "conv.parametrizations.weight.0.gain": torch.tensor(float("nan"), dtype=dtype)}
                with self.assertRaisesRegex(ValueError, "Non-finite"):
                    sdxl.fold_spectral_weights(invalid)
                with self.assertRaisesRegex(ValueError, "incomplete"):
                    sdxl.fold_spectral_weights({key: value for key, value in state.items() if not key.endswith("0.gain")})
                with self.assertRaisesRegex(ValueError, "Invalid"):
                    sdxl.fold_spectral_weights({**state, "conv.weight": expected})

    def test_published_profiles_fix_actual_scheduler_timesteps(self):
        for architecture, expected in [
            ("stable-diffusion-xl-dmad-4step", [999, 749, 499, 249]),
            ("stable-diffusion-xl-dmad-1step", [399]),
        ]:
            with self.subTest(architecture=architecture):
                profile = models.PROFILES[architecture]
                arguments = models.image_arguments(architecture, {}, [], "")
                self.assertEqual(arguments, {"guidance_scale": 0, "timesteps": expected})
                scheduler = LCMScheduler()
                scheduler.set_timesteps(timesteps=arguments["timesteps"])
                self.assertEqual(scheduler.timesteps.tolist(), expected)
                self.assertEqual(worker._image_sampling({"aspectRatio": "1:1"}, architecture, "quality")[2], len(expected))
                for steps, guidance in [(8, 0), (len(expected), 1)]:
                    with self.assertRaises(ValueError):
                        models.validate_sampling(architecture, steps, guidance)

    def test_rejects_unsupported_conditioning_and_addons_before_loading(self):
        profile = models.PROFILES["stable-diffusion-xl-dmad-4step"]
        sdxl.validate_request({"negativePrompt": "", "addons": [], "referenceImages": []}, profile)
        for key, value in [
            ("negativePrompt", "blur"), ("addons", [{"kind": "lora"}]),
            ("referenceImages", [{}]), ("baseImagePath", "image.png"),
            ("editMask", {"strokes": []}), ("maskImagePath", "mask.png"),
            ("poseImagePath", "pose.png"), ("controlNet", {"kind": "depth"}),
        ]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                sdxl.validate_request({key: value}, profile)
        with self.assertRaisesRegex(ValueError, "negative prompts"):
            models.image_arguments(profile["architecture"], {}, [], "blur")
        with self.assertRaisesRegex(ValueError, "reference images"):
            models.image_arguments(profile["architecture"], {}, [object()], "")

    def test_checkpoint_identity_rejects_wrong_bytes_and_unsafe_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "student.bin"
            path.write_bytes(b"student weights")
            student = {"checkpointFile": "student.bin", "checkpointByteSize": path.stat().st_size,
                       "checkpointSha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            self.assertEqual(checkpoint_path(root, student), path)
            path.write_bytes(b"wrong weights!!")
            with self.assertRaisesRegex(ValueError, "does not match"):
                checkpoint_path(root, student)
            for relative in ("../student.bin", str(root.parent / "student.bin")):
                with self.assertRaisesRegex(ValueError, "Invalid student"):
                    checkpoint_path(root, {**student, "checkpointFile": relative})

    def test_student_replaces_unet_without_loading_teacher_weights(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "unet").mkdir()
            config = {"in_channels": 4, "out_channels": 4, "cross_attention_dim": 2048,
                      "addition_embed_type": "text_time", "block_out_channels": [320, 640, 1280]}
            (root / "unet/config.json").write_text(json.dumps(config))
            path = root / "student.bin"
            source = torch.nn.Linear(2, 3).half()
            torch.save(source.state_dict(), path)
            profile = {"distillation": {"checkpointFile": "student.bin",
                       "checkpointByteSize": path.stat().st_size,
                       "checkpointSha256": hashlib.sha256(path.read_bytes()).hexdigest()}}
            pipeline = SimpleNamespace(scheduler=LCMScheduler())
            loader = mock.Mock(return_value=pipeline)
            def construct(config):
                return torch.nn.Linear(2, 3)
            diffusers = SimpleNamespace(UNet2DConditionModel=SimpleNamespace(from_config=construct),
                                       StableDiffusionXLPipeline=SimpleNamespace(from_pretrained=loader), LCMScheduler=LCMScheduler)
            result = sdxl.load_pipeline(diffusers, root, profile, torch.float16)
            unet = loader.call_args.kwargs["unet"]
            self.assertIs(result, pipeline)
            self.assertFalse(unet.weight.is_meta)
            self.assertTrue(torch.equal(unet.weight, source.weight))
            self.assertFalse(unet.weight.requires_grad)
            self.assertTrue(loader.call_args.kwargs["local_files_only"])
            self.assertTrue(loader.call_args.kwargs["use_safetensors"])
            self.assertFalse(loader.call_args.kwargs["trust_remote_code"])
            config["cross_attention_dim"] = 768
            (root / "unet/config.json").write_text(json.dumps(config))
            with self.assertRaisesRegex(ValueError, "SDXL base"):
                sdxl.load_pipeline(diffusers, root, profile, torch.float16)


if __name__ == "__main__":
    unittest.main()
