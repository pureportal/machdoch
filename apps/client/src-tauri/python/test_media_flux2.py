from __future__ import annotations

from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import diffusers
import gguf
import numpy as np
import torch
import transformers

from media_flux2 import load_pipeline


class Flux2DevTests(unittest.TestCase):
    def test_nf4_encoder_stays_quantized_on_cpu(self):
        torch.manual_seed(29)
        configuration = transformers.Mistral3Config(
            text_config={"vocab_size": 128, "hidden_size": 64, "intermediate_size": 128,
                         "num_hidden_layers": 2, "num_attention_heads": 4,
                         "num_key_value_heads": 2, "head_dim": 16},
            vision_config={"hidden_size": 32, "intermediate_size": 64,
                           "num_hidden_layers": 1, "num_attention_heads": 4,
                           "head_dim": 8, "image_size": 28, "patch_size": 14},
            image_token_index=10,
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = root / "original"
            quantized = root / "text_encoder"
            transformers.Mistral3ForConditionalGeneration(configuration).save_pretrained(original)
            encoded = transformers.Mistral3ForConditionalGeneration.from_pretrained(
                original, device_map={"": "cpu"}, dtype=torch.float32,
                quantization_config=transformers.BitsAndBytesConfig(
                    load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.float32,
                ), local_files_only=True,
            ).eval()
            encoded.save_pretrained(quantized)
            pipeline_loader = mock.Mock(return_value=mock.Mock())
            runtime = SimpleNamespace(Flux2Pipeline=SimpleNamespace(from_pretrained=pipeline_loader))
            load_pipeline(runtime, root, {}, torch.float32)
            loaded = pipeline_loader.call_args.kwargs["text_encoder"].eval()
            self.assertTrue(loaded.is_loaded_in_4bit)
            self.assertTrue(all(parameter.device.type == "cpu" for parameter in loaded.parameters()))
            query = loaded.model.language_model.layers[0].self_attn.q_proj
            self.assertEqual(query.weight.quant_type, "nf4")
            self.assertEqual(query.weight.dtype, torch.uint8)
            arguments = {"input_ids": torch.tensor([[11, 12, 13]]), "output_hidden_states": True}
            with torch.inference_mode():
                expected = encoded(**arguments).hidden_states[-1]
                actual = loaded(**arguments).hidden_states[-1]
            torch.testing.assert_close(actual, expected)
            from diffusers.hooks import apply_group_offloading

            apply_group_offloading(
                loaded, onload_device=torch.device("cpu"), offload_device=torch.device("cpu"),
                offload_type="block_level", num_blocks_per_group=1, use_stream=False,
            )
            with torch.inference_mode():
                offloaded = loaded(**arguments).hidden_states[-1]
            torch.testing.assert_close(offloaded, expected)
            self.assertEqual(query.weight.dtype, torch.uint8)
            self.assertEqual(query.weight.quant_type, "nf4")

    def test_original_gguf_fused_attention_and_modulation_preserve_denoising(self):
        torch.manual_seed(23)
        model = diffusers.Flux2Transformer2DModel(
            in_channels=32, num_layers=1, num_single_layers=1,
            attention_head_dim=16, num_attention_heads=2, joint_attention_dim=32,
            timestep_guidance_channels=32, axes_dims_rope=(4, 4, 4, 4),
        ).eval()
        weights = {key: value.detach().numpy() for key, value in model.state_dict().items()}
        for modality, names in [
            ("img", ("to_q", "to_k", "to_v")),
            ("txt", ("add_q_proj", "add_k_proj", "add_v_proj")),
        ]:
            weights[f"double_blocks.0.{modality}_attn.qkv.weight"] = np.concatenate([
                weights.pop(f"transformer_blocks.0.attn.{name}.weight") for name in names
            ])
        renames = {
            "x_embedder": "img_in", "context_embedder": "txt_in",
            "time_guidance_embed.timestep_embedder.linear_1": "time_in.in_layer",
            "time_guidance_embed.timestep_embedder.linear_2": "time_in.out_layer",
            "time_guidance_embed.guidance_embedder.linear_1": "guidance_in.in_layer",
            "time_guidance_embed.guidance_embedder.linear_2": "guidance_in.out_layer",
            "double_stream_modulation_img.linear": "double_stream_modulation_img.lin",
            "double_stream_modulation_txt.linear": "double_stream_modulation_txt.lin",
            "single_stream_modulation.linear": "single_stream_modulation.lin",
            "norm_out.linear": "final_layer.adaLN_modulation.1",
            "proj_out": "final_layer.linear",
            "transformer_blocks.0.attn.norm_q.weight": "double_blocks.0.img_attn.norm.query_norm.scale",
            "transformer_blocks.0.attn.norm_k.weight": "double_blocks.0.img_attn.norm.key_norm.scale",
            "transformer_blocks.0.attn.norm_added_q.weight": "double_blocks.0.txt_attn.norm.query_norm.scale",
            "transformer_blocks.0.attn.norm_added_k.weight": "double_blocks.0.txt_attn.norm.key_norm.scale",
            "transformer_blocks.0.attn.to_out.0": "double_blocks.0.img_attn.proj",
            "transformer_blocks.0.attn.to_add_out": "double_blocks.0.txt_attn.proj",
            "transformer_blocks.0.ff.linear_in": "double_blocks.0.img_mlp.0",
            "transformer_blocks.0.ff.linear_out": "double_blocks.0.img_mlp.2",
            "transformer_blocks.0.ff_context.linear_in": "double_blocks.0.txt_mlp.0",
            "transformer_blocks.0.ff_context.linear_out": "double_blocks.0.txt_mlp.2",
            "single_transformer_blocks.0.attn.to_qkv_mlp_proj": "single_blocks.0.linear1",
            "single_transformer_blocks.0.attn.to_out": "single_blocks.0.linear2",
            "single_transformer_blocks.0.attn.norm_q.weight": "single_blocks.0.norm.query_norm.scale",
            "single_transformer_blocks.0.attn.norm_k.weight": "single_blocks.0.norm.key_norm.scale",
        }
        weights["norm_out.linear.weight"] = np.concatenate(np.split(weights["norm_out.linear.weight"], 2)[::-1])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            component = root / "transformer"
            component.mkdir()
            model.save_config(component)
            writer = gguf.GGUFWriter(str(component / "model.gguf"), "flux")
            for key, value in weights.items():
                source = key
                for destination, original in renames.items():
                    if key == destination or key.startswith(destination + "."):
                        source = original + key[len(destination):]
                        break
                if value.ndim == 2 and value.shape[-1] % 32 == 0:
                    writer.add_tensor(source, gguf.quants.quantize(value, gguf.GGMLQuantizationType.Q8_0), raw_dtype=gguf.GGMLQuantizationType.Q8_0)
                else:
                    writer.add_tensor(source, value)
            writer.write_header_to_file()
            writer.write_kv_data_to_file()
            writer.write_tensors_to_file()
            writer.close()
            pipeline_loader = mock.Mock(return_value=mock.Mock())
            runtime = SimpleNamespace(
                Flux2Pipeline=SimpleNamespace(from_pretrained=pipeline_loader),
                Flux2Transformer2DModel=diffusers.Flux2Transformer2DModel,
                GGUFQuantizationConfig=diffusers.GGUFQuantizationConfig,
            )
            encoder_loader = mock.Mock()
            declaration = {"machdoch_quantization": {"transformer": {"format": "gguf", "file": "transformer/model.gguf"}}}
            with mock.patch("transformers.Mistral3ForConditionalGeneration.from_pretrained", encoder_loader):
                load_pipeline(runtime, root, declaration, torch.float32)
            loaded = pipeline_loader.call_args.kwargs["transformer"].eval()
            self.assertEqual(loaded.transformer_blocks[0].attn.to_q.weight.quant_type, gguf.GGMLQuantizationType.Q8_0)
            arguments = {
                "hidden_states": torch.randn(1, 4, 32),
                "encoder_hidden_states": torch.randn(1, 3, 32),
                "timestep": torch.tensor([0.5]), "guidance": torch.tensor([4.0]),
                "img_ids": torch.zeros(4, 4), "txt_ids": torch.zeros(3, 4),
            }
            with torch.inference_mode():
                expected = model(**arguments).sample
                actual = loaded(**arguments).sample
            torch.testing.assert_close(actual, expected, atol=0.025, rtol=0.025)
            self.assertEqual(encoder_loader.call_args.kwargs["device_map"], {"": "cpu"})
            self.assertTrue(encoder_loader.call_args.kwargs["local_files_only"])
            self.assertFalse(encoder_loader.call_args.kwargs["trust_remote_code"])

    def test_manifest_traversal_and_missing_gguf_fail_before_encoder_loading(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = SimpleNamespace()
            for specification, message in [
                ({"transformer": {"format": "gguf", "file": "../model.gguf"}}, "manifest"),
                ({"transformer": {"format": "nf4", "file": "transformer/model.gguf"}}, "manifest"),
                ({"transformer": {"format": "gguf", "file": "transformer/model.gguf"}}, "missing"),
            ]:
                with self.subTest(specification=specification), mock.patch("transformers.Mistral3ForConditionalGeneration.from_pretrained") as encoder:
                    with self.assertRaisesRegex(ValueError, message):
                        load_pipeline(runtime, root, {"machdoch_quantization": specification}, torch.float32)
                    encoder.assert_not_called()


if __name__ == "__main__":
    unittest.main()
