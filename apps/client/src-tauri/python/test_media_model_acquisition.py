import contextlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from media_wan_loading import load_wan_transformer, wan_model_paths
from media_svg_model import extract_svg, generate, load_model


class ModelAcquisitionTests(unittest.TestCase):
    def test_single_checkpoint_uses_offline_components_without_base_transformer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkpoint = root / "custom.safetensors"
            checkpoint.touch()
            config = root / "config"
            for name in ["model_index.json", "transformer/config.json", "text_encoder/model.safetensors.index.json", "vae/diffusion_pytorch_model.safetensors", "scheduler/scheduler_config.json"]:
                path = config / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.touch()
            model = {"packageKind": "single-file", "path": str(checkpoint), "configPath": str(config)}
            self.assertEqual(wan_model_paths(model), (config, checkpoint))
            transformer = Mock()
            load_wan_transformer(SimpleNamespace(WanTransformer3DModel=transformer), SimpleNamespace(bfloat16="bf16"), config, checkpoint)
            transformer.from_pretrained.assert_not_called()
            transformer.from_single_file.assert_called_once_with(str(checkpoint), config=str(config / "transformer"), torch_dtype="bf16", local_files_only=True, low_cpu_mem_usage=True)
            (config / "vae/diffusion_pytorch_model.safetensors").unlink()
            with self.assertRaisesRegex(ValueError, "incomplete"):
                wan_model_paths(model)

    def test_directory_uses_native_diffusers_loader(self):
        transformer = Mock()
        load_wan_transformer(SimpleNamespace(WanTransformer3DModel=transformer), SimpleNamespace(bfloat16="bf16"), Path("model"), None)
        transformer.from_single_file.assert_not_called()
        self.assertTrue(transformer.from_pretrained.call_args.kwargs["local_files_only"])

    def test_missing_checkpoint_components_and_unsupported_packages_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "model.safetensors"
            checkpoint.touch()
            with self.assertRaisesRegex(ValueError, "components are missing"):
                wan_model_paths({"path": str(checkpoint), "packageKind": "single-file"})
            with self.assertRaisesRegex(ValueError, "Unsupported"):
                wan_model_paths({"path": str(checkpoint), "packageKind": "gguf"})

    def test_svg_generation_extracts_document_and_rejects_truncated_outputs(self):
        svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>'
        self.assertEqual(extract_svg("```svg\n" + svg + "\n```"), svg)
        with self.assertRaisesRegex(ValueError, "no complete SVG"):
            extract_svg("<svg><circle")

    def test_svg_candidate_limit_is_validated_before_loading_weights(self):
        for count in (0, 7, True, "2"):
            with self.subTest(count=count), self.assertRaisesRegex(ValueError, "one and six"):
                generate({"candidateCount": count}, Mock())

    def test_text_only_svg_allocation_excludes_unused_vision_weights(self):
        transformers = SimpleNamespace(
            AutoConfig=Mock(), AutoProcessor=Mock(), Qwen2_5_VLForConditionalGeneration=Mock(spec=["from_pretrained"]),
        )
        sizing_model = transformers.Qwen2_5_VLForConditionalGeneration.return_value
        sizing_model.parameters.return_value = [SimpleNamespace(numel=lambda: 4 * 1024 ** 3)]
        transformers.AutoConfig.from_pretrained.return_value.text_config = SimpleNamespace(
            num_hidden_layers=28, num_key_value_heads=4, hidden_size=3584, num_attention_heads=28,
        )
        mapped_devices = {"model.language_model": "cpu", "lm_head": 0}
        accelerate = SimpleNamespace(
            init_empty_weights=contextlib.nullcontext,
            infer_auto_device_map=Mock(return_value=mapped_devices),
        )
        memory = {0: 1024 ** 3, "cpu": 8 * 1024 ** 3}
        torch = SimpleNamespace(
            bfloat16="bf16", nn=SimpleNamespace(Identity=Mock()),
            cuda=SimpleNamespace(
                is_available=lambda: True, is_bf16_supported=lambda: True,
                current_device=lambda: 0, mem_get_info=lambda device: (1024 ** 3, 2 * 1024 ** 3),
            ),
        )
        modules = {
            "transformers": transformers, "accelerate": accelerate,
            "accelerate.utils": SimpleNamespace(get_max_memory=lambda: memory),
        }
        with tempfile.TemporaryDirectory() as directory, patch.dict("sys.modules", modules):
            load_model({"path": directory, "packageKind": "transformers-directory"}, torch, False, 8192)
        self.assertIs(sizing_model.model.visual, torch.nn.Identity.return_value)
        self.assertEqual(memory[0], 1024 ** 3 - 9216 * 28 * 4 * 128 * 4 - 128 * 1024 ** 2)
        self.assertEqual(mapped_devices["model.visual"], "cpu")
        self.assertEqual(mapped_devices["model.language_model"], "cpu")
        self.assertIs(
            transformers.Qwen2_5_VLForConditionalGeneration.from_pretrained.call_args.kwargs["device_map"],
            mapped_devices,
        )

    def test_text_only_svg_keeps_fitting_decoder_resident_without_swap_reservation(self):
        transformers = SimpleNamespace(
            AutoConfig=Mock(), AutoProcessor=Mock(), Qwen2_5_VLForConditionalGeneration=Mock(),
        )
        transformers.AutoConfig.from_pretrained.return_value.text_config = SimpleNamespace(
            num_hidden_layers=28, num_key_value_heads=4, hidden_size=3584, num_attention_heads=28,
        )
        transformers.Qwen2_5_VLForConditionalGeneration.return_value.parameters.return_value = [
            SimpleNamespace(numel=lambda: 7_615_616_640),
        ]
        accelerate = SimpleNamespace(init_empty_weights=contextlib.nullcontext, infer_auto_device_map=Mock())
        torch = SimpleNamespace(
            bfloat16="bf16", nn=SimpleNamespace(Identity=Mock()),
            cuda=SimpleNamespace(
                is_available=lambda: True, is_bf16_supported=lambda: True,
                current_device=lambda: 0, mem_get_info=lambda device: (16_900_000_000, 17_095_983_104),
            ),
        )
        modules = {
            "transformers": transformers, "accelerate": accelerate,
            "accelerate.utils": SimpleNamespace(get_max_memory=lambda: {0: 16_900_000_000}),
        }
        with tempfile.TemporaryDirectory() as directory, patch.dict("sys.modules", modules):
            load_model({"path": directory, "packageKind": "transformers-directory"}, torch, False, 8192)
        accelerate.infer_auto_device_map.assert_not_called()
        self.assertEqual(
            transformers.Qwen2_5_VLForConditionalGeneration.from_pretrained.call_args.kwargs["device_map"],
            {"": 0, "model.visual": "cpu"},
        )

    def test_image_conditioned_svg_keeps_vision_in_automatic_allocation(self):
        transformers = SimpleNamespace(
            AutoConfig=Mock(), AutoProcessor=Mock(), Qwen2_5_VLForConditionalGeneration=Mock(spec=["from_pretrained"]),
        )
        torch = SimpleNamespace(
            bfloat16="bf16", cuda=SimpleNamespace(is_available=lambda: True, is_bf16_supported=lambda: True),
        )
        with tempfile.TemporaryDirectory() as directory, patch.dict("sys.modules", {"transformers": transformers}):
            load_model({"path": directory, "packageKind": "transformers-directory"}, torch, True, 8192)
        transformers.AutoConfig.from_pretrained.assert_not_called()
        self.assertEqual(
            transformers.Qwen2_5_VLForConditionalGeneration.from_pretrained.call_args.kwargs["device_map"], "auto",
        )

    def test_svg_inputs_use_embedding_device_when_vision_is_offloaded(self):
        svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>'
        model = Mock()
        model.device = "cpu"
        model.get_input_embeddings.return_value.weight.device = "cuda:0"
        model.generate.return_value = Mock()
        model.generate.return_value.__getitem__ = Mock(return_value=Mock())
        processor = Mock()
        inputs = Mock()
        inputs.to.return_value = {"input_ids": SimpleNamespace(shape=(1, 3))}
        processor.return_value = inputs
        processor.batch_decode.return_value = [svg]
        torch = SimpleNamespace(inference_mode=contextlib.nullcontext)
        with patch("media_svg_model.load_model", return_value=(model, processor)):
            result = generate({"candidateCount": 1, "prompt": "A circle", "model": {}, "modelPolicy": "fast"}, torch)
        self.assertEqual(result, {"candidates": [svg]})
        inputs.to.assert_called_once_with("cuda:0")
        self.assertEqual(model.generate.call_args.kwargs["max_new_tokens"], 8192)
        self.assertTrue(model.generate.call_args.kwargs["use_cache"])
        self.assertEqual(model.generate.call_args.kwargs["stop_strings"], ["</svg>"])
        self.assertIs(model.generate.call_args.kwargs["tokenizer"], processor.tokenizer)

    def test_svg_quality_is_validated_before_loading_weights(self):
        for policy in (None, True, "best"):
            with self.subTest(policy=policy), self.assertRaisesRegex(ValueError, "quality level"):
                generate({"candidateCount": 1, "prompt": "A circle", "modelPolicy": policy}, Mock())


if __name__ == "__main__":
    unittest.main()
