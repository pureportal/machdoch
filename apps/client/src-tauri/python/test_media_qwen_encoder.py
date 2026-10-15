from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest

from diffusers.hooks import apply_group_offloading
import torch
from transformers import Qwen2_5_VLConfig, Qwen2_5_VLForConditionalGeneration

from media_qwen_quantization import load_text_encoder


def tiny_qwen_configuration() -> Qwen2_5_VLConfig:
    return Qwen2_5_VLConfig(
            text_config={
                "vocab_size": 128, "hidden_size": 64, "intermediate_size": 128,
                "num_hidden_layers": 2, "num_attention_heads": 4, "num_key_value_heads": 2,
                "rope_parameters": {"rope_type": "default", "mrope_section": [2, 3, 3]},
                "bos_token_id": 0, "eos_token_id": 1, "pad_token_id": 2,
            },
            vision_config={
                "depth": 1, "hidden_size": 32, "intermediate_size": 64,
                "num_heads": 4, "out_hidden_size": 64, "patch_size": 2,
                "spatial_merge_size": 1, "temporal_patch_size": 1,
                "window_size": 4, "fullatt_block_indexes": [0],
            },
            image_token_id=127, video_token_id=126, vision_start_token_id=125,
            vision_end_token_id=124,
        )


class QwenEncoderTests(unittest.TestCase):
    def test_nf4_encoder_reduces_residency_and_preserves_embeddings_after_reload_and_offload(self):
        torch.manual_seed(37)
        configuration = tiny_qwen_configuration()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "text_encoder"
            saved = root / "encoded"
            original = Qwen2_5_VLForConditionalGeneration(configuration)
            original_bytes = original.get_memory_footprint()
            original.save_pretrained(source)
            encoded = load_text_encoder(root, torch.float32).eval()
            self.assertTrue(encoded.is_loaded_in_4bit)
            self.assertLess(encoded.get_memory_footprint(), original_bytes * 0.6)
            query = encoded.model.language_model.layers[0].self_attn.q_proj
            self.assertEqual(query.weight.dtype, torch.uint8)
            self.assertEqual(query.weight.quant_type, "nf4")
            arguments = {"input_ids": torch.tensor([[11, 12, 13]]), "output_hidden_states": True}
            with torch.inference_mode():
                expected = encoded(**arguments).hidden_states[-1]
            self.assertTrue(torch.isfinite(expected).all())
            encoded.save_pretrained(saved)
            loaded = Qwen2_5_VLForConditionalGeneration.from_pretrained(
                saved, device_map={"": "cpu"}, dtype=torch.float32,
                local_files_only=True, trust_remote_code=False,
            ).eval()
            apply_group_offloading(
                loaded, onload_device=torch.device("cpu"), offload_device=torch.device("cpu"),
                offload_type="block_level", num_blocks_per_group=1, use_stream=False,
            )
            with torch.inference_mode():
                actual = loaded(**arguments).hidden_states[-1]
            torch.testing.assert_close(actual, expected)
            self.assertTrue(all(parameter.device.type == "cpu" for parameter in loaded.parameters()))
            self.assertEqual(loaded.model.language_model.layers[0].self_attn.q_proj.weight.dtype, torch.uint8)

    @unittest.skipUnless(os.environ.get("MACHDOCH_IMAGE_GPU_TEST") == "1", "Requires an explicitly selected image GPU")
    def test_cpu_quantized_encoder_stages_on_gpu_with_matching_prompt_embeddings(self):
        self.assertTrue(torch.cuda.is_available())
        device = torch.device("cuda", torch.cuda.current_device())
        torch.manual_seed(47)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            Qwen2_5_VLForConditionalGeneration(tiny_qwen_configuration()).save_pretrained(root / "text_encoder")
            encoded = load_text_encoder(root, torch.bfloat16).eval()
            self.assertTrue(all(parameter.device.type == "cpu" for parameter in encoded.parameters()))
            encoded.save_pretrained(root / "reference")
            reference = Qwen2_5_VLForConditionalGeneration.from_pretrained(root / "reference", device_map={"": "cpu"}, dtype=torch.bfloat16, local_files_only=True, trust_remote_code=False).eval()
            arguments = {"input_ids": torch.tensor([[11, 12, 13]]), "output_hidden_states": True}
            with torch.inference_mode():
                expected = reference(**arguments).hidden_states[-1]
            apply_group_offloading(encoded, onload_device=device, offload_device=torch.device("cpu"), offload_type="block_level", num_blocks_per_group=1, use_stream=False)
            with torch.inference_mode():
                for _ in range(2):
                    actual = encoded(input_ids=arguments["input_ids"].to(device), output_hidden_states=True).hidden_states[-1].cpu()
                    torch.cuda.synchronize()
                    torch.testing.assert_close(actual, expected, rtol=0.04, atol=0.04)
            query = encoded.model.language_model.layers[0].self_attn.q_proj
            self.assertEqual(query.weight.dtype, torch.uint8)
            self.assertEqual(query.weight.quant_type, "nf4")


if __name__ == "__main__":
    unittest.main()
