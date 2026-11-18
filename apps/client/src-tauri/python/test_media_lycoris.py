from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from diffusers import UNet2DConditionModel
from peft.tuners.tuners_utils import BaseTunerLayer
from safetensors.torch import save_file
import torch
import torch.nn.functional as F

import media_lycoris as lycoris


class Denoiser(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.proj = torch.nn.Linear(8, 12, bias=False)
        self.conv = torch.nn.Conv2d(4, 6, 3, padding=1)


def _activate(model, name, weight):
    for module in model.modules():
        if isinstance(module, BaseTunerLayer):
            module.set_adapter([name])
            module.set_scale(name, weight)


def _load(model, tensors):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "adapter.safetensors"
        save_file(tensors, path)
        lycoris.load_lycoris(SimpleNamespace(unet=model), path, "style", ["denoiser"])


class LycorisTests(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(3)
        self.model = Denoiser().eval()
        self.linear_input = torch.randn(2, 8)
        self.conv_input = torch.randn(1, 4, 5, 5)

    def assert_delta(self, linear_delta, conv_delta, strength=0.5):
        weight = self.model.proj.get_base_layer().weight.detach().clone()
        conv = self.model.conv.get_base_layer()
        _activate(self.model, "style", strength)
        with torch.no_grad():
            torch.testing.assert_close(self.model.proj(self.linear_input), F.linear(self.linear_input, weight + strength * linear_delta))
            expected = F.conv2d(self.conv_input, conv.weight + strength * conv_delta, conv.bias, padding=1)
            torch.testing.assert_close(self.model.conv(self.conv_input), expected)
            for module in self.model.modules():
                if isinstance(module, BaseTunerLayer):
                    module.merge()
            torch.testing.assert_close(self.model.conv(self.conv_input), expected)

    def test_lokr_matches_kronecker_delta_with_alpha_only_for_decomposed_factors(self):
        w1, w2 = torch.randn(3, 2), torch.randn(4, 4)
        conv_w1, conv_w2_a, conv_w2_b = torch.randn(2, 2), torch.randn(3, 2), torch.randn(2, 18)
        tensors = {
            "lora_unet_proj.lokr_w1": w1, "lora_unet_proj.lokr_w2": w2, "lora_unet_proj.alpha": torch.tensor(99.0),
            "lora_unet_conv.lokr_w1": conv_w1, "lora_unet_conv.lokr_w2_a": conv_w2_a,
            "lora_unet_conv.lokr_w2_b": conv_w2_b, "lora_unet_conv.alpha": torch.tensor(1.0),
        }
        _load(self.model, tensors)
        conv_delta = torch.kron(conv_w1, conv_w2_a @ conv_w2_b).reshape(6, 4, 3, 3) * 0.5
        self.assert_delta(torch.kron(w1, w2), conv_delta)

    def test_loha_matches_hadamard_delta(self):
        factors = {name: torch.randn(*shape) for name, shape in {
            "lora_unet_proj.hada_w1_a": (12, 2), "lora_unet_proj.hada_w1_b": (2, 8),
            "lora_unet_proj.hada_w2_a": (12, 2), "lora_unet_proj.hada_w2_b": (2, 8),
            "lora_unet_conv.hada_w1_a": (6, 2), "lora_unet_conv.hada_w1_b": (2, 36),
            "lora_unet_conv.hada_w2_a": (6, 2), "lora_unet_conv.hada_w2_b": (2, 36),
        }.items()}
        _load(self.model, {**factors, "lora_unet_proj.alpha": torch.tensor(1.0)})

        def delta(stem):
            return (factors[f"{stem}.hada_w1_a"] @ factors[f"{stem}.hada_w1_b"]) * (factors[f"{stem}.hada_w2_a"] @ factors[f"{stem}.hada_w2_b"])

        self.assert_delta(delta("lora_unet_proj") * 0.5, delta("lora_unet_conv").reshape(6, 4, 3, 3))

    def test_unknown_or_misfit_modules_are_rejected(self):
        with self.assertRaisesRegex(lycoris.LycorisError, "does not match"):
            _load(self.model, {"lora_unet_missing.lokr_w1": torch.randn(2, 2), "lora_unet_missing.lokr_w2": torch.randn(2, 2)})
        with self.assertRaisesRegex(lycoris.LycorisError, "does not fit"):
            _load(Denoiser(), {"lora_unet_proj.lokr_w1": torch.randn(2, 2), "lora_unet_proj.lokr_w2": torch.randn(2, 2)})

    def test_profile_reports_ranks_alpha_and_convolutions(self):
        shapes = {
            "lycoris_a.lokr_w1": (16, 16), "lycoris_a.lokr_w2": (40, 40), "lycoris_a.alpha": (),
            "lycoris_b.lokr_w1": (4, 4), "lycoris_b.lokr_w2_a": (8, 6), "lycoris_b.lokr_w2_b": (6, 72),
            "lycoris_c.lokr_w1": (2, 2), "lycoris_c.lokr_w2": (3, 3, 3, 3),
        }
        self.assertEqual(lycoris.lycoris_profile(shapes), {
            "algorithm": "lokr", "dialect": "generic", "rankMinimum": 3, "rankMaximum": 40,
            "heterogeneousRanks": True, "targetModuleCount": 3, "convolutionTargetCount": 1,
            "magnitudeVectorCount": 0, "networkAlphaCount": 1,
        })
        with self.assertRaisesRegex(lycoris.LycorisError, "Mixed"):
            lycoris.lycoris_profile({**shapes, "lycoris_d.hada_w1_a": (2, 2)})
        with self.assertRaisesRegex(lycoris.LycorisError, "unsupported tensor"):
            lycoris.lycoris_profile({**shapes, "lycoris_a.lora_down.weight": (2, 2)})

    def test_tucker_locon_folds_into_an_equivalent_plain_locon(self):
        down, middle, up = torch.randn(3, 4, 1, 1), torch.randn(3, 3, 3, 3), torch.randn(6, 3, 1, 1)
        folded = lycoris.fold_tucker_locon({"m.lora_down.weight": down, "m.lora_mid.weight": middle, "m.lora_up.weight": up})
        self.assertNotIn("m.lora_mid.weight", folded)
        states = torch.randn(1, 4, 7, 7)
        expected = F.conv2d(F.conv2d(F.conv2d(states, down), middle, padding=1), up)
        torch.testing.assert_close(F.conv2d(F.conv2d(states, folded["m.lora_down.weight"], padding=1), up), expected, rtol=1e-4, atol=1e-4)

    def test_sgm_names_resolve_to_diffusers_unet_modules(self):
        unet = UNet2DConditionModel(
            block_out_channels=(32, 64), down_block_types=("DownBlock2D", "CrossAttnDownBlock2D"),
            up_block_types=("CrossAttnUpBlock2D", "UpBlock2D"), layers_per_block=2, cross_attention_dim=32,
            norm_num_groups=8, sample_size=8,
        )
        index = lycoris.module_index(unet, "denoiser")
        for flat, name in {
            "input_blocks_0_0": "conv_in",
            "input_blocks_1_0_in_layers_2": "down_blocks.0.resnets.0.conv1",
            "input_blocks_3_0_op": "down_blocks.0.downsamplers.0.conv",
            "input_blocks_4_1_proj_in": "down_blocks.1.attentions.0.proj_in",
            "input_blocks_4_0_skip_connection": "down_blocks.1.resnets.0.conv_shortcut",
            "middle_block_1_transformer_blocks_0_attn2_to_k": "mid_block.attentions.0.transformer_blocks.0.attn2.to_k",
            "middle_block_2_emb_layers_1": "mid_block.resnets.1.time_emb_proj",
            "output_blocks_1_1_proj_out": "up_blocks.0.attentions.1.proj_out",
            "output_blocks_2_2_conv": "up_blocks.0.upsamplers.0.conv",
            "output_blocks_5_0_out_layers_3": "up_blocks.1.resnets.2.conv2",
            "time_embed_0": "time_embedding.linear_1",
            "out_2": "conv_out",
            "down_blocks_1_attentions_0_transformer_blocks_0_attn1_to_q": "down_blocks.1.attentions.0.transformer_blocks.0.attn1.to_q",
        }.items():
            with self.subTest(flat=flat):
                self.assertEqual(index[flat], name)


if __name__ == "__main__":
    unittest.main()
