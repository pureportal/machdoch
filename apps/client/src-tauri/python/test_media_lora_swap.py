from __future__ import annotations

import copy
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import torch
from safetensors.torch import save_file

import media_lora_state
from test_media_addons import WORKER, image_pipeline, video_models

PROFILE = {
    "algorithm": "lora", "dialect": "diffusers-peft", "rankMinimum": 2, "rankMaximum": 2,
    "heterogeneousRanks": False, "targetModuleCount": 1, "convolutionTargetCount": 0,
    "magnitudeVectorCount": 0, "networkAlphaCount": 0,
}
IMAGE_TARGET = "down_blocks.0.attentions.0.transformer_blocks.0.attn1.to_q"


def lora_addon(path: Path, prefix: str, target: str, width: int, seed: int, strength: float) -> dict:
    generator = torch.Generator().manual_seed(seed)
    save_file({
        f"{prefix}.{target}.lora_A.weight": torch.randn(2, width, generator=generator) * 0.3,
        f"{prefix}.{target}.lora_B.weight": torch.randn(width, 2, generator=generator) * 0.3,
    }, path)
    return {
        "addonId": path.stem, "kind": "lora", "enabled": True, "path": str(path.resolve()),
        "digest": hashlib.sha256(path.read_bytes()).hexdigest(), "targetComponents": ["denoiser"],
        "modelStrength": strength, "textEncoderStrength": None, "denoisingSchedule": None,
        "loraProfile": PROFILE,
    }


def weights(module: torch.nn.Module) -> dict[str, torch.Tensor]:
    return {name.replace(".base_layer", ""): value.detach().clone() for name, value in module.state_dict().items()
            if "lora_" not in name}


def assert_identical(test: unittest.TestCase, actual: dict, expected: dict) -> None:
    test.assertEqual(actual.keys(), expected.keys())
    for name, value in expected.items():
        test.assertTrue(torch.equal(actual[name], value), name)


class ImageLoraSwapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        torch.manual_seed(0)
        cls.template = image_pipeline().to(torch.float16)

    def fused(self, addons: list[dict]) -> tuple:
        pipeline = copy.deepcopy(self.template)
        _, _, applied, names, strengths, schedules = WORKER._apply_addons(pipeline, addons, "a", "")
        snapshot = WORKER._activate_loras(pipeline, names, strengths, schedules)
        cached = {"addons": applied, "loraRequest": addons, "loraNames": names, "loraWeights": strengths,
                  "loraSchedules": schedules, "loraSnapshot": snapshot}
        return pipeline, cached

    def test_swapping_restores_the_exact_base_and_matches_a_fresh_load(self):
        with tempfile.TemporaryDirectory() as directory:
            first = lora_addon(Path(directory) / "first.safetensors", "unet", IMAGE_TARGET, 16, 1, 0.8)
            second = lora_addon(Path(directory) / "second.safetensors", "unet", IMAGE_TARGET, 16, 2, -0.6)
            pristine = weights(self.template.unet)
            pipeline, cached = self.fused([first])
            self.assertTrue(pipeline.unet.get_submodule(IMAGE_TARGET).merged)
            self.assertFalse(torch.equal(weights(pipeline.unet)[f"{IMAGE_TARGET}.weight"], pristine[f"{IMAGE_TARGET}.weight"]))

            WORKER._release_loras(pipeline, cached["loraNames"], cached["loraSnapshot"])
            assert_identical(self, weights(pipeline.unet), pristine)

            WORKER._swap_cached_loras(pipeline, cached, [second], [second])
            fresh, _ = self.fused([second])
            assert_identical(self, weights(pipeline.unet), weights(fresh.unet))
            self.assertEqual([item["digest"] for item in cached["addons"]], [second["digest"]])
            self.assertEqual(cached["loraWeights"], [-0.6])

            WORKER._swap_cached_loras(pipeline, cached, [{**second, "modelStrength": 0.4}], [{**second, "modelStrength": 0.4}])
            fresh, _ = self.fused([{**second, "modelStrength": 0.4}])
            assert_identical(self, weights(pipeline.unet), weights(fresh.unet))

            WORKER._swap_cached_loras(pipeline, cached, [], [])
            assert_identical(self, weights(pipeline.unet), pristine)
            self.assertEqual(cached["addons"], [])

    def test_layerwise_fusion_is_at_least_as_exact_as_diffusers_fusion(self):
        def diffusers_fused(dtype):
            pipeline = copy.deepcopy(self.template).to(dtype)
            _, _, _, names, strengths, _ = WORKER._apply_addons(pipeline, [first], "a", "")
            pipeline.set_adapters(names, adapter_weights=strengths)
            pipeline.fuse_lora(adapter_names=names, lora_scale=1.0)
            return pipeline.unet.get_submodule(IMAGE_TARGET).base_layer.weight.detach()

        with tempfile.TemporaryDirectory() as directory:
            first = lora_addon(Path(directory) / "first.safetensors", "unet", IMAGE_TARGET, 16, 1, 0.8)
            pipeline, _ = self.fused([first])
            layerwise = pipeline.unet.get_submodule(IMAGE_TARGET).base_layer.weight.detach()
            exact = diffusers_fused(torch.float64)
            self.assertEqual(layerwise.device.type, "cpu")
            self.assertLessEqual(
                float((layerwise.double() - exact).abs().sum()),
                float((diffusers_fused(torch.float16).double() - exact).abs().sum()),
            )

    def test_a_lora_round_trip_keeps_a_frozen_pipeline_frozen(self):
        with tempfile.TemporaryDirectory() as directory:
            first = lora_addon(Path(directory) / "first.safetensors", "unet", IMAGE_TARGET, 16, 1, 0.8)
            pipeline = copy.deepcopy(self.template)
            media_lora_state.freeze_pipeline(pipeline)
            flags = {name: parameter.requires_grad for name, parameter in pipeline.unet.named_parameters()}
            self.assertFalse(any(flags.values()))
            _, _, _, names, strengths, schedules = WORKER._apply_addons(pipeline, [first], "a", "")
            snapshot = WORKER._activate_loras(pipeline, names, strengths, schedules)
            WORKER._release_loras(pipeline, names, snapshot)
            self.assertEqual({name: parameter.requires_grad for name, parameter in pipeline.unet.named_parameters()}, flags)

    def test_accelerator_resident_weights_keep_loras_unfused(self):
        with tempfile.TemporaryDirectory() as directory:
            first = lora_addon(Path(directory) / "first.safetensors", "unet", IMAGE_TARGET, 16, 1, 0.8)
            pristine = weights(self.template.unet)
            with mock.patch.object(media_lora_state, "tuner_bases_on_cpu", return_value=False):
                pipeline, cached = self.fused([first])
            self.assertEqual(cached["loraSnapshot"], [])
            self.assertFalse(pipeline.unet.get_submodule(IMAGE_TARGET).merged)
            assert_identical(self, weights(pipeline.unet), pristine)

    def test_swaps_keep_textual_inversion_evidence_in_request_order(self):
        embedding = {"kind": "textual-inversion", "addonId": "negative", "digest": "e" * 64}
        with tempfile.TemporaryDirectory() as directory:
            first = lora_addon(Path(directory) / "first.safetensors", "unet", IMAGE_TARGET, 16, 1, 0.8)
            pipeline, cached = self.fused([first])
            cached["addons"] = [cached["addons"][0], embedding]
            requested = [{"kind": "textual-inversion", "enabled": True}, first]
            WORKER._swap_cached_loras(pipeline, cached, requested, [first])
            self.assertEqual([item["addonId"] for item in cached["addons"]], ["negative", "first"])

    def test_swap_support_follows_the_pipeline_placement(self):
        text_lora = [{"kind": "lora", "loadedComponents": ["text-encoder"]}]
        denoiser_request = [{"targetComponents": ["denoiser"]}]
        self.assertTrue(WORKER._lora_swap_supported("model-offload", text_lora, [{"targetComponents": ["text-encoder"]}]))
        self.assertFalse(WORKER._lora_swap_supported("device", [], denoiser_request))
        self.assertTrue(WORKER._lora_swap_supported("resident", [], denoiser_request))
        self.assertFalse(WORKER._lora_swap_supported("resident", text_lora, denoiser_request))
        self.assertFalse(WORKER._lora_swap_supported("resident", [], [{"targetComponents": ["denoiser", "text-encoder"]}]))
        self.assertFalse(WORKER._lora_swap_supported("custom", [], denoiser_request))


class VideoLoraSwapTests(unittest.TestCase):
    def test_video_swaps_restore_the_exact_base_and_match_a_fresh_load(self):
        name, create, target = next(model for model in video_models() if model[0] == "wan")
        torch.manual_seed(0)
        template = create().to(torch.bfloat16).state_dict()

        def transformer():
            model = create().to(torch.bfloat16)
            model.load_state_dict(template)
            return model.eval()

        width = transformer().get_submodule(target).weight.shape[1]
        with tempfile.TemporaryDirectory() as directory:
            first = lora_addon(Path(directory) / "first.safetensors", "transformer", target, width, 1, 0.7)
            second = lora_addon(Path(directory) / "second.safetensors", "transformer", target, width, 2, 1.2)
            pristine = weights(transformer())
            model = transformer()
            applied, snapshot = WORKER._load_swappable_video_addons(model, [first])
            self.assertTrue(model.get_submodule(target).merged)
            WORKER._release_video_loras(model, applied, snapshot)
            assert_identical(self, weights(model), pristine)
            WORKER._load_swappable_video_addons(model, [second])
            fresh = transformer()
            WORKER._load_video_addons(fresh, [second])
            assert_identical(self, weights(model), weights(fresh))


if __name__ == "__main__":
    unittest.main()
