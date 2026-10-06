import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import torch
from safetensors.torch import save_file

import media_h3_adapters as adapters
import media_student_checkpoints as checkpoints
import media_h3_distillation as runtime
from media_h3_geometry import H3Geometry, latent_shape, packed_sequence, row_timesteps
from media_h3_sampling import rollout, sigma_grid
import media_open_models as models


STUDENTS = [profile for profile in models.PROFILES.values() if profile.get("distillation") and profile["pipeline"] == "MiniMaxH3ModularPipeline"]
GEOMETRY = H3Geometry((1, 2, 2), 24, 32, 16)


class StudentContracts(unittest.TestCase):
    def create_package(self, root):
        for name in ("transformer", "text_encoder", "tokenizer", "processor", "vae", "audio_vae", "scheduler", "audio_scheduler"):
            (root / name).mkdir()
        configs = {
            "model_index.json": {"_class_name": "MiniMaxH3ModularPipeline"},
            "text_encoder/config.json": {
                "model_type": "qwen3_vl",
                "text_config": {"model_type": "qwen3_vl_text", "num_hidden_layers": 64, "hidden_size": 5120},
            },
            "transformer/config.json": {"_class_name": "MiniMaxH3Transformer3DModel", "patch_size": [1, 2, 2], "in_channels": 24, "audio_in_channels": 32},
            "vae/config.json": {"spatial_downsample_factors": [2, 2, 2, 2]},
        }
        for filename, config in configs.items():
            (root / filename).write_text(json.dumps(config), encoding="utf-8")
        (root / "LICENSE").write_text("Synthetic package fixture", encoding="utf-8")
        checkpoint = root / "student.safetensors"
        checkpoint.write_bytes(b"synthetic checkpoint")
        profile = {**STUDENTS[0], "distillation": {
            **STUDENTS[0]["distillation"], "checkpointFile": checkpoint.name,
            "checkpointByteSize": checkpoint.stat().st_size,
            "checkpointSha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
        }}
        return dict(packageKind="diffusers-directory", path=str(root)), profile

    def test_original_conditioner_configuration_passes_before_weight_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model, profile = self.create_package(root)
            package, geometry, checkpoint = runtime.validate_package(model, profile)
            self.assertEqual(package, root.resolve())
            self.assertEqual(geometry, GEOMETRY)
            self.assertEqual(checkpoint, root / "student.safetensors")

    def test_incompatible_conditioner_is_rejected_before_weight_loading_or_hashing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model, profile = self.create_package(root)
            path = root / "text_encoder/config.json"
            original = json.loads(path.read_text(encoding="utf-8"))
            invalid = [{}, [], {"text_config": None}, {"text_config": []}, {**original, "model_type": "qwen3"}]
            for field, value in [("model_type", "qwen3_text"), ("num_hidden_layers", 32), ("num_hidden_layers", 51), ("num_hidden_layers", "64"), ("num_hidden_layers", 64.0), ("hidden_size", 2560), ("hidden_size", "5120"), ("hidden_size", 5120.0)]:
                invalid.append({**original, "text_config": {**original["text_config"], field: value}})
            diffusers = SimpleNamespace(**{name: object() for name in ("MiniMaxH3Transformer3DModel", "AutoencoderKLMiniMaxH3", "AutoencoderKLMiniMaxH3Audio")})
            for config in invalid:
                with self.subTest(config=config), mock.patch.object(runtime, "checkpoint_path") as checkpoint, mock.patch.object(runtime, "_encode_prompt") as encode:
                    path.write_text(json.dumps(config), encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, "original MiniMax-H3 Qwen3-VL"):
                        runtime.render(model, profile, {}, 640, 384, "cuda", diffusers, mock.Mock())
                    checkpoint.assert_not_called()
                    encode.assert_not_called()

    def test_every_published_adapter_has_fixed_sampling_and_restricted_model_terms(self):
        self.assertEqual(len(STUDENTS), 4)
        for profile in STUDENTS:
            with self.subTest(model=profile["id"]):
                self.assertEqual(profile["capabilities"], ["text-to-video"])
                self.assertTrue(profile["fixedSteps"] and profile["fixedGuidance"] and profile["audio"])
                self.assertEqual(profile["license"]["commercialUse"], "review-required")
                self.assertIsNone(profile["license"]["spdxId"])
                self.assertRegex(profile["revision"], r"^[a-f0-9]{40}$")
                self.assertRegex(profile["distillation"]["checkpointSha256"], r"^[a-f0-9]{64}$")
                request = dict(numFrames=124, numInferenceSteps=profile["steps"], guidanceScale=1, fps=24, prompt="A bird flies")
                arguments = models.video_arguments(profile, request, None, None, 640, 384, None)
                self.assertNotIn("negative_prompt", arguments)
                for field, value, message in [("numInferenceSteps", 8, "sampling"), ("guidanceScale", 5, "guidance"), ("fps", 30, "24 fps"), ("numFrames", 125, "frames"), ("numFrames", 362, "frames")]:
                    with self.assertRaisesRegex(ValueError, message):
                        models.video_arguments(profile, {**request, field: value}, None, None, 640, 384, None)
                with self.assertRaisesRegex(ValueError, "from a prompt"):
                    models.video_arguments(profile, request, object(), None, 640, 384, None)

    def test_cpu_runtime_is_rejected_before_checkpoint_or_model_loading(self):
        with mock.patch.object(runtime, "validate_package") as validate:
            with self.assertRaisesRegex(ValueError, "accelerated worker"):
                runtime.render({}, STUDENTS[0], {}, 640, 384, "cpu", SimpleNamespace(), mock.Mock())
            validate.assert_not_called()

    def test_runtime_without_current_h3_classes_fails_before_loading_weights(self):
        with mock.patch.object(runtime, "validate_package") as validate:
            with self.assertRaisesRegex(ValueError, "does not expose MiniMaxH3Transformer3DModel"):
                runtime.render({}, STUDENTS[0], {}, 640, 384, "cuda", SimpleNamespace(), mock.Mock())
            validate.assert_not_called()

    def test_checkpoint_identity_includes_size_and_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "student.safetensors"
            path.write_bytes(b"test checkpoint")
            student = dict(checkpointFile=path.name, checkpointByteSize=path.stat().st_size, checkpointSha256=hashlib.sha256(path.read_bytes()).hexdigest())
            self.assertEqual(checkpoints.checkpoint_path(root, student), path)
            with self.assertRaisesRegex(ValueError, "incomplete"):
                checkpoints.checkpoint_path(root, {**student, "checkpointByteSize": 1})
            with self.assertRaisesRegex(ValueError, "does not match"):
                checkpoints.checkpoint_path(root, {**student, "checkpointSha256": "0" * 64})
            with self.assertRaisesRegex(ValueError, "Invalid"):
                checkpoints.checkpoint_path(root, {**student, "checkpointFile": "../student.safetensors"})

    def test_current_adapter_dialects_are_read_without_ignoring_extra_weights(self):
        for method, left_key, right_key in [("dmad", "projection.lora.down.weight", "projection.lora.up.weight"), ("pdmd", "transformer.projection.lora_A.weight", "transformer.projection.lora_B.weight")]:
            with self.subTest(method=method), tempfile.TemporaryDirectory() as directory:
                path = Path(directory, "student.safetensors")
                left, right = torch.ones(128, 2), torch.ones(3, 128)
                save_file({left_key: left, right_key: right}, str(path))
                pairs = adapters.read_pairs(path, method)
                self.assertEqual(list(pairs), ["projection"])
                self.assertTrue(torch.equal(pairs["projection"]["A"], left))
                del pairs
                incomplete = Path(directory, "incomplete.safetensors")
                save_file({left_key: left}, str(incomplete))
                with self.assertRaisesRegex(ValueError, "missing"):
                    adapters.read_pairs(incomplete, method)
                extra = Path(directory, "extra.safetensors")
                save_file({left_key: left, right_key: right, "unsupported": torch.ones(1)}, str(extra))
                with self.assertRaisesRegex(ValueError, "Unexpected"):
                    adapters.read_pairs(extra, method)

    def test_adapter_fusion_matches_fp32_matrix_update(self):
        transformer = torch.nn.Sequential(torch.nn.Linear(2, 3, bias=False))
        transformer[0].weight.data.fill_(2)
        adapters.fuse_pairs(transformer, {"0": {"A": torch.full((128, 2), 0.5), "B": torch.full((3, 128), 0.25)}})
        self.assertTrue(torch.equal(transformer[0].weight, torch.full((3, 2), 18.0)))

    def test_all_adapter_shapes_are_checked_before_fusion(self):
        transformer = torch.nn.Sequential(torch.nn.Linear(2, 3, bias=False))
        original = transformer[0].weight.detach().clone()
        pairs = {"0": {"A": torch.ones(128, 2), "B": torch.ones(3, 128)}, "unknown": {"A": torch.ones(128, 2), "B": torch.ones(3, 128)}}
        with self.assertRaisesRegex(ValueError, "does not match"):
            adapters.fuse_pairs(transformer, pairs)
        self.assertTrue(torch.equal(transformer[0].weight, original))

    def test_fusion_rounds_once_after_the_fp32_base_update(self):
        transformer = torch.nn.Sequential(torch.nn.Linear(2, 3, bias=False)).to(torch.bfloat16)
        original = transformer[0].weight.detach().clone()
        left = torch.linspace(0.0001, 0.02, 256).reshape(128, 2)
        right = torch.linspace(-0.01, 0.012, 384).reshape(3, 128)
        expected = (original.float() + right @ left).to(torch.bfloat16)
        adapters.fuse_pairs(transformer, {"0": {"A": left, "B": right}})
        self.assertTrue(torch.equal(transformer[0].weight, expected))

    def test_dmad_preserves_base_weights_and_matches_unfused_adapter_arithmetic(self):
        for dtype in (torch.float32, torch.bfloat16):
            with self.subTest(dtype=dtype):
                transformer = torch.nn.Sequential(torch.nn.Linear(4, 3, bias=False)).to(dtype)
                original = transformer[0].weight.detach().clone()
                left = torch.linspace(-0.02, 0.03, 512).reshape(128, 4).to(dtype)
                right = torch.linspace(-0.015, 0.012, 384).reshape(3, 128).to(dtype)
                transformer = adapters.load_dmad_adapter(transformer, {"0": {"A": left, "B": right}})
                layer = transformer[0]
                hidden = torch.linspace(-1, 1, 8).reshape(2, 4).to(dtype)
                adapter_dtype = layer.lora_A["default"].weight.dtype
                base = torch.nn.functional.linear(hidden, original)
                update = torch.nn.functional.linear(
                    torch.nn.functional.linear(hidden.to(adapter_dtype), left.to(adapter_dtype)),
                    right.to(adapter_dtype),
                )
                self.assertTrue(torch.equal(layer.base_layer.weight, original))
                self.assertTrue(torch.equal(transformer(hidden), (base + update).to(dtype)))
                self.assertEqual(layer.scaling["default"], 1)
                self.assertFalse(any(parameter.requires_grad for parameter in transformer.parameters()))

    def test_dmad_checks_all_targets_before_adapter_injection(self):
        transformer = torch.nn.Sequential(torch.nn.Linear(2, 3, bias=False))
        original = transformer[0].weight.detach().clone()
        pairs = {"0": {"A": torch.ones(128, 2), "B": torch.ones(3, 128)}, "unknown": {"A": torch.ones(128, 2), "B": torch.ones(3, 128)}}
        with self.assertRaisesRegex(ValueError, "does not match"):
            adapters.load_dmad_adapter(transformer, pairs)
        self.assertTrue(torch.equal(transformer[0].weight, original))
        self.assertFalse(hasattr(transformer[0], "lora_A"))


class StudentSampling(unittest.TestCase):
    def test_shifted_grids_have_exact_evaluation_count_and_terminal_zero(self):
        for profile in STUDENTS:
            for modality in ("videoShift", "audioShift"):
                steps, shift = profile["steps"], profile["distillation"][modality]
                sigmas = sigma_grid(steps, shift)
                self.assertEqual(len(sigmas), steps + 1)
                for index, sigma in enumerate(sigmas):
                    position = (steps - index) / steps
                    self.assertAlmostEqual(sigma.item(), shift * position / (1 + (shift - 1) * position), places=6)

    def test_packed_rows_preserve_temporal_grid_and_stereo_channels(self):
        shape = latent_shape(64, 64, 124, GEOMETRY)
        self.assertEqual(shape["latent_frames"], 37)
        self.assertEqual(shape["audio_latents"], 207)
        self.assertEqual(shape["audio_tokens"], (1, 414, 32))
        layout = packed_sequence(3, shape, GEOMETRY)
        self.assertEqual(layout.sequence_length, 3 + 414 + 37 * 4)
        self.assertEqual(layout.token_tags[layout.text_indices].tolist(), [1, 1, 1])
        self.assertTrue((layout.token_tags[layout.audio_indices] == 2).all())
        self.assertTrue((layout.token_tags[layout.video_indices] == 0).all())
        self.assertEqual(layout.position_ids[3:210, 0].tolist(), layout.position_ids[210:417, 0].tolist())
        times, indices = row_timesteps(layout, 0.75, 0.25)
        rows = times[indices]
        self.assertTrue((rows[layout.video_indices] == 0.25).all())
        self.assertTrue((rows[layout.audio_indices] == 0.75).all())

    def test_every_student_performs_exactly_its_published_number_of_evaluations(self):
        shape = latent_shape(32, 32, 5, GEOMETRY)
        layout = packed_sequence(2, shape, GEOMETRY)
        for profile in STUDENTS:
            calls, progress = [], []
            def transformer(**arguments):
                calls.append(arguments)
                return torch.zeros_like(arguments["hidden_states"]), torch.zeros_like(arguments["audio_hidden_states"])
            settings = {**profile["distillation"], "steps": profile["steps"]}
            video, audio = rollout(transformer, torch.zeros(1, 2, 5120), layout, shape, GEOMETRY, settings, 42, "cpu", lambda step, total: progress.append((step, total)))
            self.assertEqual(len(calls), profile["steps"])
            self.assertEqual(progress, [(step, profile["steps"]) for step in range(1, profile["steps"] + 1)])
            self.assertEqual(tuple(video.shape), shape["video_tokens"])
            self.assertEqual(tuple(audio.shape), shape["audio_tokens"])
            self.assertEqual(video.dtype, torch.bfloat16)

    def test_seed_reproduction_and_distinct_stochastic_and_euler_updates(self):
        shape = latent_shape(32, 32, 5, GEOMETRY)
        layout = packed_sequence(2, shape, GEOMETRY)
        def transformer(**arguments):
            return torch.zeros_like(arguments["hidden_states"]), torch.zeros_like(arguments["audio_hidden_states"])
        def sample(seed, sampler):
            return rollout(transformer, torch.zeros(1, 2, 5120), layout, shape, GEOMETRY, dict(steps=4, videoShift=12, audioShift=2, sampler=sampler), seed, "cpu", lambda *_: None)
        first, repeated, other_seed, euler = sample(42, "renoise"), sample(42, "renoise"), sample(43, "renoise"), sample(42, "euler")
        for index in (0, 1):
            self.assertTrue(torch.equal(first[index], repeated[index]))
            self.assertFalse(torch.equal(first[index], other_seed[index]))
            self.assertFalse(torch.equal(first[index], euler[index]))

    def test_clean_endpoint_uses_the_h3_velocity_sign(self):
        shape = latent_shape(32, 32, 5, GEOMETRY)
        layout = packed_sequence(2, shape, GEOMETRY)
        def transformer(**arguments):
            rows = arguments["timestep"][arguments["timestep_indices"]]
            video_sigma = 1 - rows[layout.video_indices[0]]
            audio_sigma = 1 - rows[layout.audio_indices[0]]
            return (3 - arguments["hidden_states"]) / video_sigma, (-2 - arguments["audio_hidden_states"]) / audio_sigma
        video, audio = rollout(transformer, torch.zeros(1, 2, 5120), layout, shape, GEOMETRY, dict(steps=4, videoShift=12, audioShift=2, sampler="renoise"), 42, "cpu", lambda *_: None)
        self.assertTrue(torch.equal(video, torch.full_like(video, 3)))
        self.assertTrue(torch.equal(audio, torch.full_like(audio, -2)))

    def test_non_finite_model_output_stops_sampling(self):
        shape = latent_shape(32, 32, 5, GEOMETRY)
        layout = packed_sequence(2, shape, GEOMETRY)
        def transformer(**arguments):
            return torch.full_like(arguments["hidden_states"], float("nan")), arguments["audio_hidden_states"]
        with self.assertRaisesRegex(ValueError, "non-finite"):
            rollout(transformer, torch.zeros(1, 2, 5120), layout, shape, GEOMETRY, dict(steps=2, videoShift=12, audioShift=6, sampler="euler"), 42, "cpu", lambda *_: None)


if __name__ == "__main__":
    unittest.main()
