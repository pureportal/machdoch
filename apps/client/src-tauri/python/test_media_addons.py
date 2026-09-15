from __future__ import annotations

import hashlib
import json
import importlib.util
from pathlib import Path
import tempfile
import unittest

import torch
from safetensors.torch import save_file
from peft import LoraConfig
from transformers import CLIPTextConfig, CLIPTextModel, CLIPTokenizer
from diffusers import (
    AutoencoderKL,
    DDIMScheduler,
    StableDiffusionPipeline,
    UNet2DConditionModel,
)
from diffusers import (
    HunyuanVideo15Transformer3DModel,
    HunyuanVideoFramepackTransformer3DModel,
    LTXVideoTransformer3DModel,
    WanTransformer3DModel,
)


def load_module(name):
    spec = importlib.util.spec_from_file_location(
        name, Path(__file__).with_name(f"{name}.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


WORKER = load_module("media_diffusers_worker")
IMAGE_ADDONS = load_module("media_image_addons")
VIDEO_ADDONS = load_module("media_video_addons")


def image_pipeline():
    tokens = [
        "<|startoftext|>",
        "<|endoftext|>",
        *"abcdefghijklmnopqrstuvwxyz",
        *[f"{char}</w>" for char in "abcdefghijklmnopqrstuvwxyz"],
        ",</w>",
        "!</w>",
    ]
    tokenizer = CLIPTokenizer(
        vocab={token: index for index, token in enumerate(tokens)},
        merges=[],
        model_max_length=77,
    )
    encoder = CLIPTextModel(
        CLIPTextConfig(
            vocab_size=len(tokenizer),
            hidden_size=16,
            intermediate_size=32,
            num_hidden_layers=1,
            num_attention_heads=2,
            max_position_embeddings=77,
            bos_token_id=0,
            eos_token_id=1,
            pad_token_id=1,
        )
    )
    unet = UNet2DConditionModel(
        sample_size=8,
        in_channels=4,
        out_channels=4,
        layers_per_block=1,
        block_out_channels=(16, 32),
        down_block_types=("CrossAttnDownBlock2D", "DownBlock2D"),
        up_block_types=("UpBlock2D", "CrossAttnUpBlock2D"),
        cross_attention_dim=16,
        norm_num_groups=8,
    )
    return StableDiffusionPipeline(
        vae=AutoencoderKL(block_out_channels=(16,), norm_num_groups=8),
        text_encoder=encoder,
        tokenizer=tokenizer,
        unet=unet,
        scheduler=DDIMScheduler(steps_offset=1, clip_sample=False),
        safety_checker=None,
        feature_extractor=None,
        requires_safety_checker=False,
    )


class TextualInversionTests(unittest.TestCase):
    def test_mixed_case_multi_vector_tokens_survive_punctuation_and_preserve_every_vector(
        self,
    ):
        pipeline = image_pipeline()
        profile = {
            "component": "text-encoder",
            "tensorKey": "emb_params",
            "vectorCount": 8,
            "dimension": 16,
        }
        vectors = torch.arange(128, dtype=torch.float32).reshape(8, 16) / 128
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "embedding.safetensors"
            save_file({"emb_params": vectors}, path)
            loaded = WORKER._load_textual_inversion(
                pipeline, path, "EasyNegative", ["text-encoder"], [profile]
            )
        aliases = loaded[0]["registeredTokens"]
        self.assertEqual(pipeline.tokenizer.tokenize(" ".join(aliases)), aliases)
        token_ids = pipeline.tokenizer.convert_tokens_to_ids(aliases)
        torch.testing.assert_close(
            pipeline.text_encoder.get_input_embeddings().weight[token_ids], vectors
        )
        self.assertEqual(
            WORKER._append_token("EasyNegative, blurry", "EasyNegative"),
            "EasyNegative, blurry",
        )
        self.assertEqual(
            WORKER._append_token("EasyNegative_1", "EasyNegative"),
            "EasyNegative_1, EasyNegative",
        )
        applied = [
            {
                "kind": "textual-inversion",
                "token": "EasyNegative",
                "placement": "negative",
                "embeddingVectors": loaded,
            }
        ]
        WORKER._verify_embedding_prompt_tokens(
            pipeline, applied, "cat", "EasyNegative, blurry!"
        )
        self.assertEqual(loaded[0]["encodedTokenCounts"], {"negative": 8})
        WORKER._verify_embedding_prompt_tokens(
            pipeline, applied, "cat", "EasyNegative, EasyNegative!"
        )
        self.assertEqual(loaded[0]["encodedTokenCounts"], {"negative": 16})
        with self.assertRaisesRegex(WORKER.WorkerError, "Shorten the prompt"):
            WORKER._verify_embedding_prompt_tokens(
                pipeline, applied, "cat", "cat " * 80 + "EasyNegative"
            )

    def test_positive_and_negative_channels_are_checked_independently(self):
        pipeline = image_pipeline()
        profile = {
            "component": "text-encoder",
            "tensorKey": "style",
            "vectorCount": 2,
            "dimension": 16,
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "style.safetensors"
            save_file({"style": torch.ones(2, 16)}, path)
            loaded = WORKER._load_textual_inversion(
                pipeline, path, "StyleToken", ["text-encoder"], [profile]
            )
        applied = [
            {
                "kind": "textual-inversion",
                "token": "StyleToken",
                "placement": "both",
                "embeddingVectors": loaded,
            }
        ]
        WORKER._verify_embedding_prompt_tokens(
            pipeline, applied, "StyleToken", "StyleToken!"
        )
        self.assertEqual(
            loaded[0]["encodedTokenCounts"], {"positive": 2, "negative": 2}
        )
        with self.assertRaisesRegex(WORKER.WorkerError, "positive prompt"):
            WORKER._verify_embedding_prompt_tokens(
                pipeline, applied, "cat", "StyleToken"
            )

    def test_current_clip_text_encoder_lora_changes_the_target_with_its_exact_strength(
        self,
    ):
        pipeline = image_pipeline()
        target = "encoder.layers.0.self_attn.q_proj"
        value = torch.ones(1, 16)
        baseline = pipeline.text_encoder.get_submodule(target)(value).detach()
        down = torch.ones(2, 16) * 0.05
        up = torch.ones(16, 2) * 0.1
        state = {
            f"text_encoder.text_model.{target}.lora_A.weight": down,
            f"text_encoder.text_model.{target}.lora_B.weight": up,
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "text-lora.safetensors"
            save_file(state, path)
            IMAGE_ADDONS.load_text_encoder_lora(
                pipeline, path, "style", ["text-encoder"]
            )
        pipeline.set_adapters(["style"], adapter_weights=[0.6])
        result = pipeline.text_encoder.get_submodule(target)(value)
        torch.testing.assert_close(result, baseline + 0.6 * (value @ down.T @ up.T))

    def test_clip_metadata_preserves_target_patterns_ranks_and_alpha(self):
        query = "encoder.layers.0.self_attn.q_proj"
        value_projection = "encoder.layers.0.self_attn.v_proj"
        for targets in (
            [f"text_model.{query}", f"text_model.{value_projection}"],
            r"^text_model\.encoder\.layers\.0\.self_attn\.(q|v)_proj$",
        ):
            with self.subTest(
                targets=targets
            ), tempfile.TemporaryDirectory() as directory:
                pipeline = image_pipeline()
                value = torch.ones(1, 16)
                state = {}
                expected = {}
                for target, rank, alpha in ((query, 2, 8), (value_projection, 1, 6)):
                    down = torch.full((rank, 16), 0.05)
                    up = torch.full((16, rank), 0.1)
                    baseline = pipeline.text_encoder.get_submodule(target)(
                        value
                    ).detach()
                    expected[target] = baseline + 0.6 * (alpha / rank) * (
                        value @ down.T @ up.T
                    )
                    state[f"text_encoder.text_model.{target}.lora_A.weight"] = down
                    state[f"text_encoder.text_model.{target}.lora_B.weight"] = up
                config = LoraConfig(
                    r=2,
                    lora_alpha=8,
                    target_modules=targets,
                    exclude_modules=["text_model.encoder.layers.0.self_attn.k_proj"],
                    rank_pattern={f"text_model.{value_projection}": 1},
                    alpha_pattern={f"text_model.{value_projection}": 6},
                )
                metadata = {
                    f"text_encoder.{key}": setting
                    for key, setting in config.to_dict().items()
                }
                path = Path(directory) / "clip-metadata.safetensors"
                save_file(
                    state,
                    path,
                    metadata={
                        "lora_adapter_metadata": json.dumps(metadata, default=list)
                    },
                )
                IMAGE_ADDONS.load_text_encoder_lora(
                    pipeline, path, "metadata-style", ["text-encoder"]
                )
                pipeline.set_adapters(["metadata-style"], adapter_weights=[0.6])
                for target, reference in expected.items():
                    torch.testing.assert_close(
                        pipeline.text_encoder.get_submodule(target)(value), reference
                    )


def video_models():
    return [
        (
            "wan",
            lambda: WanTransformer3DModel(
                num_attention_heads=2,
                attention_head_dim=16,
                in_channels=4,
                out_channels=4,
                text_dim=16,
                freq_dim=16,
                ffn_dim=64,
                num_layers=1,
            ),
            "blocks.0.attn1.to_q",
        ),
        (
            "ltx",
            lambda: LTXVideoTransformer3DModel(
                in_channels=4,
                out_channels=4,
                num_attention_heads=2,
                attention_head_dim=16,
                cross_attention_dim=32,
                caption_channels=16,
                num_layers=1,
            ),
            "transformer_blocks.0.attn1.to_q",
        ),
        (
            "framepack",
            lambda: HunyuanVideoFramepackTransformer3DModel(
                num_attention_heads=2,
                attention_head_dim=16,
                num_layers=1,
                num_single_layers=1,
                num_refiner_layers=1,
                text_embed_dim=16,
                pooled_projection_dim=16,
                rope_axes_dim=(4, 6, 6),
            ),
            "transformer_blocks.0.attn.to_q",
        ),
        (
            "hunyuan15",
            lambda: HunyuanVideo15Transformer3DModel(
                num_attention_heads=2,
                attention_head_dim=16,
                num_layers=1,
                num_refiner_layers=1,
                text_embed_dim=16,
                text_embed_2_dim=16,
                image_embed_dim=16,
                rope_axes_dim=(4, 6, 6),
            ),
            "transformer_blocks.0.attn.to_q",
        ),
    ]


class VideoLoraTests(unittest.TestCase):
    def write_addon(self, path, target, width, value=0.05, strength=0.7):
        down = torch.full((2, width), value)
        up = torch.full((width, 2), value * 2)
        save_file(
            {
                f"transformer.{target}.lora_A.weight": down,
                f"transformer.{target}.lora_B.weight": up,
            },
            path,
        )
        profile = {
            "algorithm": "lora",
            "dialect": "diffusers-peft",
            "rankMinimum": 2,
            "rankMaximum": 2,
            "heterogeneousRanks": False,
            "targetModuleCount": 1,
            "convolutionTargetCount": 0,
            "magnitudeVectorCount": 0,
            "networkAlphaCount": 0,
        }
        addon = {
            "addonId": path.stem,
            "kind": "lora",
            "enabled": True,
            "path": str(path),
            "digest": hashlib.sha256(path.read_bytes()).hexdigest(),
            "targetComponents": ["denoiser"],
            "modelStrength": strength,
            "textEncoderStrength": None,
            "denoisingSchedule": None,
            "loraProfile": profile,
        }
        return addon, down, up

    def test_fp8_video_layers_keep_adapters_in_compute_precision(self):
        for name, create, target in video_models():
            if name not in ("ltx", "framepack"):
                continue
            with self.subTest(model=name), tempfile.TemporaryDirectory() as directory:
                transformer = create().eval()
                transformer.enable_layerwise_casting(
                    storage_dtype=torch.float8_e4m3fn,
                    compute_dtype=torch.bfloat16,
                )
                width = transformer.get_submodule(target).weight.shape[1]
                value = torch.ones(1, width, dtype=torch.bfloat16)
                with torch.inference_mode():
                    baseline = transformer.get_submodule(target)(value).clone()
                addon, down, up = self.write_addon(
                    Path(directory) / "fp8.safetensors", target, width
                )
                evidence = VIDEO_ADDONS.load_loras(
                    transformer, [addon], WORKER._lora_profile
                )
                layer = transformer.get_submodule(target)
                with torch.inference_mode():
                    actual = layer(value)
                expected = baseline + 0.7 * (
                    value @ down.to(torch.bfloat16).T @ up.to(torch.bfloat16).T
                )
                torch.testing.assert_close(actual, expected, atol=0.015, rtol=0.015)
                self.assertEqual(layer.base_layer.weight.dtype, torch.float8_e4m3fn)
                self.assertEqual(
                    layer.lora_A[evidence[0]["adapterName"]].weight.dtype,
                    torch.bfloat16,
                )

    def test_all_video_transformers_apply_stacked_strengths_to_real_peft_layers(self):
        for name, create, target in video_models():
            with self.subTest(model=name), tempfile.TemporaryDirectory() as directory:
                transformer = create()
                width = transformer.get_submodule(target).weight.shape[1]
                value = torch.ones(1, width)
                baseline = transformer.get_submodule(target)(value).detach()
                first, down, up = self.write_addon(
                    Path(directory) / "first.safetensors", target, width
                )
                second, other_down, other_up = self.write_addon(
                    Path(directory) / "second.safetensors",
                    target,
                    width,
                    value=0.1,
                    strength=-0.2,
                )
                evidence = VIDEO_ADDONS.load_loras(
                    transformer, [first, second], WORKER._lora_profile
                )
                result = transformer.get_submodule(target)(value)
                torch.testing.assert_close(
                    result,
                    baseline
                    + 0.7 * (value @ down.T @ up.T)
                    - 0.2 * (value @ other_down.T @ other_up.T),
                )
                self.assertEqual(
                    [entry["digest"] for entry in evidence],
                    [first["digest"], second["digest"]],
                )
                transformer.set_adapters(
                    [entry["adapterName"] for entry in evidence], weights=[0, 0]
                )
                torch.testing.assert_close(
                    transformer.get_submodule(target)(value), baseline
                )

    def test_wrong_digest_and_wrong_model_variant_fail_before_loading(self):
        _, create, target = video_models()[0]
        with tempfile.TemporaryDirectory() as directory:
            transformer = create()
            addon, _, _ = self.write_addon(
                Path(directory) / "wrong.safetensors", target, 16
            )
            with self.assertRaisesRegex(ValueError, "changed after import"):
                VIDEO_ADDONS.load_loras(
                    transformer, [{**addon, "digest": "0" * 64}], WORKER._lora_profile
                )
            with self.assertRaisesRegex(
                ValueError, "does not match this model variant"
            ):
                VIDEO_ADDONS.load_loras(transformer, [addon], WORKER._lora_profile)
            self.assertFalse(hasattr(transformer.get_submodule(target), "lora_A"))
            self.assertEqual(
                VIDEO_ADDONS.load_loras(
                    transformer, [{**addon, "enabled": False}], WORKER._lora_profile
                ),
                [],
            )

    def test_transformer_exports_preserve_metadata_alpha_and_unprefixed_targets(self):
        _, create, target = video_models()[3]
        transformer = create()
        value = torch.ones(1, 32)
        baseline = transformer.get_submodule(target)(value).detach()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metadata.safetensors"
            addon, down, up = self.write_addon(path, target, 32)
            metadata = LoraConfig(
                r=2, lora_alpha=6, target_modules=[target], lora_dropout=0.5
            ).to_dict()
            metadata["target_modules"] = list(metadata["target_modules"])
            save_file(
                {f"{target}.lora_A.weight": down, f"{target}.lora_B.weight": up},
                path,
                metadata={"lora_adapter_metadata": json.dumps(metadata)},
            )
            addon["digest"] = hashlib.sha256(path.read_bytes()).hexdigest()
            VIDEO_ADDONS.load_loras(transformer, [addon], WORKER._lora_profile)
        torch.testing.assert_close(
            transformer.get_submodule(target)(value),
            baseline + 0.7 * 3 * (value @ down.T @ up.T),
        )


if __name__ == "__main__":
    unittest.main()
