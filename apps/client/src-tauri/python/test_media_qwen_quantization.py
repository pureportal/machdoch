from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

import diffusers
import gguf
import numpy as np
import torch

from media_qwen_quantization import transformer_arguments


class QwenQuantizedTransformerTests(unittest.TestCase):
    def test_original_qwen_gguf_preserves_projection_and_feed_forward_outputs(self):
        torch.manual_seed(17)
        model = diffusers.QwenImageTransformer2DModel(
            in_channels=32, out_channels=32, num_layers=1,
            attention_head_dim=16, num_attention_heads=2, joint_attention_dim=32,
            axes_dims_rope=(4, 4, 8),
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            component = root / "transformer"
            component.mkdir()
            model.save_config(component)
            writer = gguf.GGUFWriter(str(component / "model.gguf"), "qwen_image")
            for key, value in model.state_dict().items():
                weights = value.detach().numpy()
                if weights.ndim == 2 and weights.shape[-1] % 32 == 0:
                    writer.add_tensor(key, gguf.quants.quantize(weights, gguf.GGMLQuantizationType.Q8_0), raw_dtype=gguf.GGMLQuantizationType.Q8_0)
                else:
                    writer.add_tensor(key, weights)
            writer.write_header_to_file()
            writer.write_kv_data_to_file()
            writer.write_tensors_to_file()
            writer.close()
            index = {
                "_class_name": "QwenImagePipeline",
                "machdoch_quantization": {"transformer": {"format": "gguf", "file": "transformer/model.gguf"}},
            }
            loaded = transformer_arguments(diffusers, root, index, torch.float32)["transformer"]
            self.assertIsInstance(loaded, diffusers.QwenImageTransformer2DModel)
            self.assertEqual(loaded.img_in.weight.quant_type, gguf.GGMLQuantizationType.Q8_0)
            latent = torch.randn(2, 32)
            torch.testing.assert_close(loaded.img_in(latent), model.img_in(latent), atol=0.02, rtol=0.02)
            torch.testing.assert_close(loaded.transformer_blocks[0].img_mlp(latent), model.transformer_blocks[0].img_mlp(latent), atol=0.02, rtol=0.02)

    def test_real_gguf_loader_preserves_fused_gate_weights_and_projection(self):
        torch.manual_seed(13)
        model = diffusers.QwenImage21Transformer2DModel(
            in_channels=32, out_channels=32, num_layers=1,
            attention_head_dim=16, num_attention_heads=2, context_in_dim=32,
            axes_dims_rope=(4, 4, 8),
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            component = root / "transformer"
            component.mkdir()
            model.save_config(component)
            checkpoint = component / "model.gguf"
            writer = gguf.GGUFWriter(str(checkpoint), "qwen_image21")
            weights = {key: value.detach().numpy() for key, value in model.state_dict().items()}
            prefix = "transformer_blocks.0.img_mlp."
            weights[prefix + "gate_up.weight"] = np.concatenate([
                weights.pop(prefix + "gate_layer.weight"), weights.pop(prefix + "proj.weight"),
            ])
            for key, value in weights.items():
                if value.ndim == 2 and value.shape[-1] % 32 == 0:
                    writer.add_tensor(key, gguf.quants.quantize(value, gguf.GGMLQuantizationType.Q8_0), raw_dtype=gguf.GGMLQuantizationType.Q8_0)
                else:
                    writer.add_tensor(key, value)
            writer.write_header_to_file()
            writer.write_kv_data_to_file()
            writer.write_tensors_to_file()
            writer.close()
            index = {
                "_class_name": "QwenImage21Pipeline",
                "machdoch_quantization": {"transformer": {"format": "gguf", "file": "transformer/model.gguf"}},
            }
            loaded = transformer_arguments(diffusers, root, index, torch.float32)["transformer"]
            self.assertEqual(loaded.img_in.weight.quant_type, gguf.GGMLQuantizationType.Q8_0)
            latent = torch.randn(2, 32)
            torch.testing.assert_close(loaded.img_in(latent), model.img_in(latent), atol=0.02, rtol=0.02)
            for name in ("gate_layer", "proj"):
                expected = getattr(model.transformer_blocks[0].img_mlp, name)(latent)
                actual = getattr(loaded.transformer_blocks[0].img_mlp, name)(latent)
                torch.testing.assert_close(actual, expected, atol=0.02, rtol=0.02)

    def test_unknown_manifests_and_traversal_are_rejected_before_loading(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for declaration in [
                {"transformer": {"format": "gguf", "file": "../model.gguf"}},
                {"transformer": {"format": "int8", "file": "transformer/model.gguf"}},
            ]:
                with self.subTest(declaration=declaration), self.assertRaisesRegex(ValueError, "manifest"):
                    transformer_arguments(diffusers, root, {"_class_name": "QwenImage21Pipeline", "machdoch_quantization": declaration}, torch.float32)
            self.assertEqual(transformer_arguments(diffusers, root, {"_class_name": "QwenImage21Pipeline"}, torch.float32), {})
            with self.assertRaisesRegex(ValueError, "manifest"):
                transformer_arguments(diffusers, root, {
                    "_class_name": "FluxPipeline",
                    "machdoch_quantization": {"transformer": {"format": "gguf", "file": "transformer/model.gguf"}},
                }, torch.float32)


if __name__ == "__main__":
    unittest.main()
