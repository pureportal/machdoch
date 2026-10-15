import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, PropertyMock, patch

from safetensors.torch import save_file

import media_hidream


class HiDreamTests(unittest.TestCase):
    def test_requested_dimensions_survive_the_real_pipeline_area_normalization(self):
        from diffusers import FlowMatchEulerDiscreteScheduler, HiDreamImagePipeline

        pipeline = HiDreamImagePipeline(
            scheduler=FlowMatchEulerDiscreteScheduler(), vae=None,
            text_encoder=None, tokenizer=None, text_encoder_2=None, tokenizer_2=None,
            text_encoder_3=None, tokenizer_3=None, text_encoder_4=None, tokenizer_4=None,
            transformer=SimpleNamespace(__module__=__name__, config=SimpleNamespace(in_channels=16, patch_size=2)),
        )
        pooled = media_hidream.torch.zeros(1, 16)
        encoded = (pooled, None, pooled, None, pooled, None)
        with patch.object(HiDreamImagePipeline, "_execution_device", new_callable=PropertyMock, return_value=media_hidream.torch.device("cpu")), patch.object(pipeline, "check_inputs"), patch.object(pipeline, "encode_prompt", return_value=encoded), patch.object(pipeline, "prepare_latents", side_effect=RuntimeError("Dimensions captured")) as prepare:
            with self.assertRaisesRegex(RuntimeError, "Dimensions captured"):
                pipeline(prompt="Test", width=256, height=256, guidance_scale=0)
            self.assertEqual(prepare.call_args.args[2:4], (1024, 1024))
            for width, height in ((256, 256), (832, 1216), (1376, 768), (832, 1248), (1024, 1024), (736, 1440)):
                media_hidream.configure_image_dimensions(pipeline, width, height)
                with self.assertRaisesRegex(RuntimeError, "Dimensions captured"):
                    pipeline(prompt="Test", width=width, height=height, guidance_scale=0)
                self.assertEqual(prepare.call_args.args[2:4], (height, width))

    def test_rectangular_patch_tokens_survive_above_the_original_sequence_capacity(self):
        from diffusers import HiDreamImageTransformer2DModel

        transformer = HiDreamImageTransformer2DModel(
            patch_size=2, in_channels=4, out_channels=4, num_layers=0, num_single_layers=0,
            attention_head_dim=8, num_attention_heads=2, caption_channels=[8, 8],
            text_emb_dim=8, axes_dims_rope=(4, 4),
        ).eval()
        pipeline = SimpleNamespace(vae_scale_factor=8, transformer=transformer)
        latents = media_hidream.torch.randn(1, 4, 96, 172)
        with self.assertRaises(RuntimeError):
            transformer.patchify(latents)
        for width, height in ((1376, 768), (256, 256), (832, 1216), (1664, 2432)):
            media_hidream.configure_image_dimensions(pipeline, width, height)
            latents = media_hidream.torch.randn(1, 4, height // 8, width // 8)
            patches, mask, image_sizes, image_ids = transformer.patchify(latents)
            self.assertEqual(patches.shape[1], (width // 16) * (height // 16))
            self.assertEqual(image_ids.shape[1], patches.shape[1])
            if mask is not None:
                self.assertTrue(media_hidream.torch.all(mask == 1))
            reconstructed = transformer.unpatchify(patches, image_sizes, is_training=False)
            self.assertTrue(media_hidream.torch.equal(reconstructed, latents))

    def test_excluded_quantized_layers_fail_before_loading_weights(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            save_file({"caption_projection.0.linear.weight.quant_state.bitsandbytes__fp4": media_hidream.torch.zeros(2, dtype=media_hidream.torch.uint8)}, str(directory / "diffusion_pytorch_model.safetensors"))
            configuration = {"quantization_config": {"bnb_4bit_quant_type": "fp4", "llm_int8_skip_modules": ["caption_projection"]}}
            with self.assertRaisesRegex(ValueError, "caption_projection.0.linear is excluded"):
                media_hidream.validate_quantization_layout(directory, configuration)

    def test_serialized_quantization_must_match_component_configuration(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            save_file({"caption_projection.0.linear.weight.quant_state.bitsandbytes__fp4": media_hidream.torch.zeros(2, dtype=media_hidream.torch.uint8)}, str(directory / "diffusion_pytorch_model.safetensors"))
            configuration = {"quantization_config": {"bnb_4bit_quant_type": "nf4", "llm_int8_skip_modules": ["gate"]}}
            with self.assertRaisesRegex(ValueError, "weights use fp4.*declares nf4"):
                media_hidream.validate_quantization_layout(directory, configuration)
            configuration["quantization_config"]["bnb_4bit_quant_type"] = "fp4"
            media_hidream.validate_quantization_layout(directory, configuration)

    def test_quantized_components_are_staged_on_cpu_before_loading_the_next(self):
        events = []
        classes = {}
        for name in ("transformer", "text_encoder_3", "text_encoder_4"):
            component = SimpleNamespace(to=lambda device, name=name: events.append((name, device)))

            def load_component(*args, name=name, component=component, **kwargs):
                events.append((name, "load"))
                return component

            classes[name] = SimpleNamespace(from_pretrained=Mock(side_effect=load_component))
        pipeline_class = SimpleNamespace(from_pretrained=Mock(return_value="pipeline"))
        diffusers = SimpleNamespace(HiDreamImageTransformer2DModel=classes["transformer"], HiDreamImagePipeline=pipeline_class)
        with tempfile.TemporaryDirectory() as temporary, patch.object(media_hidream, "T5EncoderModel", classes["text_encoder_3"]), patch.object(media_hidream, "LlamaForCausalLM", classes["text_encoder_4"]), patch.object(media_hidream.torch.cuda, "is_available", return_value=True), patch.object(media_hidream.torch.cuda, "current_device", return_value=0), patch.object(media_hidream.torch.cuda, "empty_cache") as release:
            root = Path(temporary)
            for name in classes:
                (root / name).mkdir()
                (root / name / "config.json").write_text(json.dumps({"quantization_config": {"quant_method": "bitsandbytes"}}))
            result = media_hidream.load_pipeline(diffusers, root, "bf16")
            self.assertEqual(result, "pipeline")
            self.assertEqual(events, [(name, operation) for name in classes for operation in ("load", "cpu")])
            self.assertEqual(release.call_count, 3)
            for name, factory in classes.items():
                factory.from_pretrained.assert_called_once_with(str(root / name), dtype="bf16", local_files_only=True, use_safetensors=True, trust_remote_code=False, device_map={"": 0})
            self.assertEqual(set(pipeline_class.from_pretrained.call_args.kwargs) & set(classes), set(classes))

    def test_quantized_packages_fail_before_loading_without_a_gpu(self):
        factory = Mock()
        diffusers = SimpleNamespace(HiDreamImageTransformer2DModel=factory)
        with tempfile.TemporaryDirectory() as temporary, patch.object(media_hidream.torch.cuda, "is_available", return_value=False):
            root = Path(temporary)
            (root / "transformer").mkdir()
            (root / "transformer/config.json").write_text(json.dumps({"quantization_config": {"quant_method": "bitsandbytes"}}))
            with self.assertRaisesRegex(ValueError, "supported GPU"):
                media_hidream.load_pipeline(diffusers, root, "bf16")
            factory.from_pretrained.assert_not_called()


if __name__ == "__main__":
    unittest.main()
