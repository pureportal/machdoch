import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
from safetensors.torch import save_file

from fizgig.krea2.safetensors_utils import MemoryEfficientSafeOpen
from fizgig.minimax.video_vae_checkpoint import load_video_vae


class H3VideoAdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from diffusers import AutoencoderKLMiniMaxH3

        torch.set_num_threads(2)
        torch.manual_seed(37128)
        cls.factory = AutoencoderKLMiniMaxH3
        cls.configuration = {
            "block_out_channels": (32, 64), "layers_per_block": 1,
            "spatial_downsample_factors": (2, 2), "temporal_downsample_factors": (2, 2),
            "decoder_num_layers": 2, "decoder_num_attention_heads": 4, "decoder_attention_head_dim": 32,
        }
        cls.native = cls.factory(**cls.configuration).eval().requires_grad_(False)
        for block in cls.native.decoder.transformer_blocks:
            block.scale1.data.fill_(0.1)
            block.scale2.data.fill_(0.2)
        cls.weights = {}
        state = cls.native.state_dict()
        for name, weight in state.items():
            weight = weight.half()
            if ".attn.to_k." in name or ".attn.to_v." in name:
                continue
            if ".attn.to_q." in name:
                projections = [state[name.replace(".to_q.", f".to_{projection}.")].half()
                               .reshape(4, 32, *weight.shape[1:]) for projection in "qkv"]
                cls.weights[name.replace(".to_q.", ".to_qkv.")] = torch.stack(projections, dim=1).flatten(0, 2)
                continue
            source = re.sub(r"encoder\.down_blocks\.(\d+)\.resnets\.(\d+)\.", r"encoder.down.\1.block.\2.", name)
            source = re.sub(r"encoder\.down_blocks\.(\d+)\.downsamplers\.0\.", r"encoder.down.\1.downsample.", source)
            source = source.replace(".conv_shortcut.", ".nin_shortcut.").replace("decoder.proj_in.", "decoder.x_embedder.")
            source = source.replace(".attn.to_out.0.", ".attn.to_out.").replace(".ff.net.2.", ".ff.w2.")
            if ".ff.net.0.proj." in source:
                value, gate = weight.chunk(2)
                weight = torch.cat([gate, value])
                source = source.replace(".ff.net.0.proj.", ".ff.w1.")
            cls.weights[source] = weight.contiguous()
        cls.mean = torch.linspace(-0.4, 0.6, 24)
        cls.deviation = torch.linspace(0.5, 1.5, 24)
        cls.weights["latents_mean"], cls.weights["latents_std"] = cls.mean, cls.deviation
        cls.native.load_state_dict({name: weight.half().float() for name, weight in state.items()})
        cls.directory = tempfile.TemporaryDirectory()
        cls.path = Path(cls.directory.name) / "video.safetensors"
        save_file(cls.weights, cls.path)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def load(self, mode, path=None):
        with patch("diffusers.AutoencoderKLMiniMaxH3", side_effect=lambda: self.factory(**self.configuration)):
            return load_video_vae(path or self.path, mode, device="cpu")

    def changed_checkpoint(self, changes, removed=()):
        weights = {name: value for name, value in self.weights.items() if name not in removed}
        weights.update(changes)
        path = Path(self.directory.name) / "changed.safetensors"
        save_file(weights, path)
        return path

    def test_checkpoint_conversion_matches_native_parameters_and_materializes_rope(self):
        for mode, prefixes in (("encode", ("encoder.", "quant_conv.")), ("decode", ("decoder.", "post_quant_conv."))):
            adapter = self.load(mode)
            expected = {name: weight for name, weight in self.native.state_dict().items() if name.startswith(prefixes)}
            self.assertEqual(set(adapter.model.state_dict()), set(expected))
            for name, weight in adapter.model.state_dict().items():
                torch.testing.assert_close(weight, expected[name], rtol=0, atol=0)
                self.assertEqual(weight.dtype, torch.float32)
            self.assertFalse(any(value.is_meta for value in adapter.buffers()))
            self.assertFalse(any(value.requires_grad for value in adapter.parameters()))

    def test_only_the_selected_component_weights_are_read(self):
        decoder_bad = torch.full_like(self.weights["decoder.x_embedder.weight"], float("nan"))
        encoder = self.load("encode", self.changed_checkpoint({"decoder.x_embedder.weight": decoder_bad}))
        self.assertFalse(hasattr(encoder.model, "decoder"))
        encoder_bad = torch.full_like(self.weights["encoder.conv_in.weight"], float("nan"))
        decoder = self.load("decode", self.changed_checkpoint({"encoder.conv_in.weight": encoder_bad}))
        self.assertFalse(hasattr(decoder.model, "encoder"))

    def test_bad_normalization_fails_before_native_model_initialization(self):
        for value in (torch.zeros(24), torch.full((24,), float("nan")), torch.ones(23), torch.ones(24, dtype=torch.int32)):
            path = self.changed_checkpoint({"latents_std": value})
            with patch("diffusers.AutoencoderKLMiniMaxH3") as factory:
                with self.assertRaisesRegex(ValueError, "normalization|floating-point"):
                    load_video_vae(path, "decode", device="cpu")
                factory.assert_not_called()

    def test_fp16_checkpoint_statistics_keep_their_values_in_float32(self):
        mean, deviation = self.mean.half(), self.deviation.half()
        adapter = self.load("encode", self.changed_checkpoint({"latents_mean": mean, "latents_std": deviation}))
        torch.testing.assert_close(adapter.latent_mean.flatten(), mean.float(), rtol=0, atol=0)
        torch.testing.assert_close(adapter.latent_standard_deviation.flatten(), deviation.float(), rtol=0, atol=0)
        self.assertEqual(adapter.latent_mean.dtype, torch.float32)

    def test_missing_and_wrong_shape_weights_fail_before_loading_model_weights(self):
        name = "quant_conv.weight"
        original_read = MemoryEfficientSafeOpen.get_tensor
        for changes, removed in (({}, (name,)), ({name: torch.ones(4)}, ())):
            reads = []

            def read(checkpoint, key):
                reads.append(key)
                return original_read(checkpoint, key)

            path = self.changed_checkpoint(changes, removed)
            with patch.object(MemoryEfficientSafeOpen, "get_tensor", autospec=True, side_effect=read):
                with self.assertRaisesRegex(ValueError, "quant_conv.weight.*missing or incompatible"):
                    self.load("encode", path)
            self.assertEqual(reads, ["latents_mean", "latents_std"])

    def test_nonfinite_selected_weight_is_rejected(self):
        name = "decoder.transformer_blocks.0.attn.to_qkv.bias"
        value = self.weights[name].clone()
        value[0] = float("nan")
        with self.assertRaisesRegex(ValueError, "to_qkv.bias.*damaged"):
            self.load("decode", self.changed_checkpoint({name: value}))

    def test_insufficient_gpu_memory_fails_before_loading_model_weights(self):
        original_read = MemoryEfficientSafeOpen.get_tensor
        for mode, component in (("encode", "encoder"), ("decode", "decoder")):
            reads = []

            def read(checkpoint, key):
                reads.append(key)
                return original_read(checkpoint, key)

            with patch("diffusers.AutoencoderKLMiniMaxH3", side_effect=lambda: self.factory(**self.configuration)), \
                    patch("torch.cuda.mem_get_info", return_value=(0, 0)) as memory, \
                    patch.object(MemoryEfficientSafeOpen, "get_tensor", autospec=True, side_effect=read):
                with self.assertRaisesRegex(ValueError, f"{component}.*free GPU memory.*Close GPU applications"):
                    load_video_vae(self.path, mode, device="cuda:1")
            memory.assert_called_once_with("cuda:1")
            self.assertEqual(reads, ["latents_mean", "latents_std"])

    def test_image_and_video_encoding_keep_normalization_and_native_clock(self):
        encoder = self.load("encode")
        for frames, expected_frames in ((1, 1), (5, 2), (22, 7), (39, 12)):
            pixels = torch.rand(1, 3, frames, 16, 16) * 2 - 1
            actual = encoder.encode(pixels)
            normalized = ((pixels + 1) * 0.5 - encoder.pixel_mean) / encoder.pixel_standard_deviation
            expected = self.native.encode(normalized).latent_dist.mode()
            expected = (expected - encoder.latent_mean) / encoder.latent_standard_deviation
            self.assertEqual(actual.shape, (1, 24, expected_frames, 4, 4))
            torch.testing.assert_close(actual, expected, rtol=0, atol=0)

    def test_still_and_short_video_decode_use_explicit_current_geometry(self):
        decoder = self.load("decode")
        latent = torch.randn(1, 24, 1, 4, 4)
        group = (latent * decoder.latent_standard_deviation + decoder.latent_mean).expand(-1, -1, 5, -1, -1)
        expected = self.native._decode_clip(group)[:, :, 3:4]
        expected = (expected * decoder.pixel_standard_deviation + decoder.pixel_mean).clamp(0, 1).squeeze(2)
        torch.testing.assert_close(decoder.decode(latent), expected, rtol=0, atol=0)
        torch.testing.assert_close(decoder.decode_middle_frame(latent, 0), expected, rtol=0, atol=0)
        short = torch.randn(1, 24, 2, 4, 4)
        decoded = decoder.decode_clip(short)
        self.assertEqual(decoded.shape, (1, 3, 5, 16, 16))
        for frame in range(5):
            torch.testing.assert_close(decoder.decode_middle_frame(short, frame), decoded[:, :, frame], rtol=0, atol=0)

    def test_selected_frames_equal_full_decode_and_use_at_most_two_chunks(self):
        decoder = self.load("decode")
        for frames in (7, 12, 17):
            latent = torch.randn(1, 24, frames, 4, 4)
            original = latent.clone()
            full = decoder.decode_clip(latent)
            for index in sorted({0, 4, 16, 17, 21, full.shape[2] // 2, full.shape[2] - 1}):
                with patch.object(decoder.model, "decode", wraps=decoder.model.decode) as native_decode:
                    selected = decoder.decode_middle_frame(latent, index)
                torch.testing.assert_close(selected, full[:, :, index], rtol=0, atol=0)
                self.assertLessEqual(native_decode.call_args.args[0].shape[2], 12)
            torch.testing.assert_close(latent, original, rtol=0, atol=0)

    def test_invalid_frames_and_modes_fail_before_native_execution(self):
        encoder, decoder = self.load("encode"), self.load("decode")
        with patch.object(encoder.model, "encode") as native_encode:
            with self.assertRaisesRegex(ValueError, "17n"):
                encoder.encode(torch.zeros(1, 3, 2, 16, 16))
            native_encode.assert_not_called()
        for index in (-1, True, 1.0, 22):
            with self.assertRaisesRegex(ValueError, "Preview frame"):
                decoder.decode_middle_frame(torch.zeros(1, 24, 7, 4, 4), index)
        with self.assertRaisesRegex(ValueError, "5n"):
            decoder.decode_clip(torch.zeros(1, 24, 3, 4, 4))
        with self.assertRaisesRegex(ValueError, "encoder"):
            decoder.encode(torch.zeros(1, 3, 1, 16, 16))
        with self.assertRaisesRegex(ValueError, "decoder"):
            encoder.decode(torch.zeros(1, 24, 1, 4, 4))


if __name__ == "__main__":
    unittest.main()
