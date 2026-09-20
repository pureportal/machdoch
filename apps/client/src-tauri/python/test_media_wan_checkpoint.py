import tempfile
import unittest
from pathlib import Path

import diffusers
import torch
from safetensors.torch import save_file

from media_wan_loading import load_wan_transformer


class WanCheckpointTests(unittest.TestCase):
    def test_publisher_checkpoint_loads_offline_with_all_weights_preserved(self):
        model = diffusers.WanTransformer3DModel(
            num_attention_heads=1, attention_head_dim=8, in_channels=48,
            out_channels=48, text_dim=16, freq_dim=8, ffn_dim=16,
            num_layers=1, cross_attn_norm=True,
        )
        renames = [
            ("condition_embedder.time_embedder.linear_1", "time_embedding.0"),
            ("condition_embedder.time_embedder.linear_2", "time_embedding.2"),
            ("condition_embedder.text_embedder.linear_1", "text_embedding.0"),
            ("condition_embedder.text_embedder.linear_2", "text_embedding.2"),
            ("condition_embedder.time_proj", "time_projection.1"),
            ("attn1", "self_attn"), ("attn2", "cross_attn"),
            (".to_out.0.", ".o."), (".to_q.", ".q."),
            (".to_k.", ".k."), (".to_v.", ".v."),
            ("ffn.net.0.proj", "ffn.0"), ("ffn.net.2", "ffn.2"),
            ("norm2", "norm_placeholder"), ("norm3", "norm2"),
            ("norm_placeholder", "norm3"),
        ]
        checkpoint = {}
        for name, value in model.state_dict().items():
            original = name
            for source, destination in renames:
                original = original.replace(source, destination)
            if original == "scale_shift_table":
                original = "head.modulation"
            elif original.startswith("proj_out."):
                original = original.replace("proj_out.", "head.head.")
            else:
                original = original.replace("scale_shift_table", "modulation")
            checkpoint["model.diffusion_model." + original] = value.contiguous()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model.save_config(root / "transformer")
            path = root / "checkpoint.safetensors"
            save_file(checkpoint, path)
            loaded = load_wan_transformer(diffusers, torch, root, path)
            self.assertEqual(set(loaded.state_dict()), set(model.state_dict()))
            for name, value in model.state_dict().items():
                torch.testing.assert_close(loaded.state_dict()[name], value.to(torch.bfloat16), rtol=0, atol=0)


if __name__ == "__main__":
    unittest.main()
