import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import torch
from safetensors.torch import save_file
from torch import nn
from torch.nn import functional

from fizgig.minimax.audio_vae import audio_latents_from_rows, load_audio_vae


class SmallNativeAudioVAE(nn.Module):
    def __init__(self):
        super().__init__()
        self.encoder = nn.utils.weight_norm(nn.Conv1d(1, 32, 4, stride=4, bias=False))
        self.pre_block = nn.Identity()
        self.mean_proj = nn.Identity()
        self.logs_proj = nn.Identity()
        self.dec_in_proj = nn.Identity()
        self.decoder = nn.utils.weight_norm(nn.ConvTranspose1d(32, 1, 4, stride=4, bias=False))

    def encode(self, waveform):
        padded = functional.pad(waveform, (0, (-waveform.shape[-1]) % 4))
        mean = self.encoder(padded)
        return SimpleNamespace(latent_dist=SimpleNamespace(mode=lambda: mean))

    def decode(self, latent):
        return SimpleNamespace(sample=self.decoder(latent).clamp(-1, 1))


class H3NativeAudioTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "audio.safetensors"
        encoder = torch.zeros(32, 1, 4)
        decoder = torch.zeros(32, 1, 4)
        for sample in range(4):
            encoder[sample, 0, sample] = 1
            decoder[sample, 0, sample] = 1
        self.state = {"encoder.weight": encoder, "decoder.weight": decoder,
                      "latents_mean": torch.linspace(-.3, .4, 32),
                      "latents_std": torch.linspace(.5, 1.5, 32)}
        self.native = patch("diffusers.AutoencoderKLMiniMaxH3Audio", SmallNativeAudioVAE, create=True)
        self.native.start()

    def tearDown(self):
        self.native.stop()
        self.temporary.cleanup()

    def save(self, state=None):
        save_file(self.state if state is None else state, str(self.path))

    def test_folded_weights_stereo_normalization_padding_and_zero_channels_roundtrip(self):
        self.save()
        encoder = load_audio_vae(self.path, "encode", device="cpu")
        decoder = load_audio_vae(self.path, "decode", device="cpu")
        waveform = torch.linspace(-.8, .8, 44).reshape(2, 2, 11)
        latent = encoder.encode(waveform)
        self.assertEqual(tuple(latent.shape), (2, 32, 2, 3))
        restored = decoder.decode(latent)
        self.assertEqual(tuple(restored.shape), (2, 2, 12))
        torch.testing.assert_close(restored[..., :11], waveform, atol=2e-7, rtol=2e-7)
        torch.testing.assert_close(restored[..., 11], torch.zeros(2, 2), atol=2e-7, rtol=0)
        self.assertTrue(torch.isfinite(latent).all())
        self.assertTrue(torch.isfinite(restored).all())
        self.assertFalse(hasattr(encoder.model, "decoder"))
        self.assertFalse(hasattr(decoder.model, "encoder"))
        self.assertFalse(hasattr(encoder.model.encoder, "weight_g"))
        self.assertEqual(encoder.sample_rate, 32000)
        self.assertTrue(all(parameter.dtype == torch.float32 and not parameter.requires_grad
                            for parameter in encoder.parameters()))
        with self.assertRaisesRegex(ValueError, "Load the H3 audio decoder"):
            encoder.decode(latent)
        with self.assertRaisesRegex(ValueError, "Load the H3 audio encoder"):
            decoder.encode(waveform)

    def test_missing_or_invalid_normalization_fails_before_native_model_construction(self):
        for damage in ("missing", "shape", "precision", "zero", "negative", "nonfinite"):
            state = dict(self.state)
            if damage == "missing":
                del state["latents_std"]
            else:
                state["latents_std"] = {
                    "shape": torch.ones(31), "precision": torch.ones(32).half(),
                    "zero": torch.zeros(32), "negative": -torch.ones(32),
                    "nonfinite": torch.full((32,), float("nan")),
                }[damage]
            self.save(state)
            with self.subTest(damage=damage), patch("diffusers.AutoencoderKLMiniMaxH3Audio") as factory:
                with self.assertRaisesRegex(ValueError, "H3 audio VAE"):
                    load_audio_vae(self.path, "encode", device="cpu")
                factory.assert_not_called()

    def test_required_weight_shapes_precision_and_finiteness_are_enforced(self):
        for damage in ("missing", "shape", "precision", "nonfinite"):
            state = dict(self.state)
            if damage == "missing":
                del state["encoder.weight"]
            else:
                state["encoder.weight"] = {
                    "shape": torch.zeros(31, 1, 4), "precision": self.state["encoder.weight"].half(),
                    "nonfinite": torch.full((32, 1, 4), float("nan")),
                }[damage]
            self.save(state)
            with self.subTest(damage=damage):
                with self.assertRaisesRegex(ValueError, "H3 audio VAE weight encoder.weight"):
                    load_audio_vae(self.path, "encode", device="cpu")

    def test_encoder_does_not_load_decoder_weights(self):
        state = dict(self.state)
        state["decoder.weight"] = torch.full((31, 1, 4), float("nan"))
        self.save(state)
        encoder = load_audio_vae(self.path, "encode", device="cpu")
        self.assertTrue(torch.isfinite(encoder.encode(torch.ones(1, 2, 8))).all())
        with self.assertRaisesRegex(ValueError, "decoder.weight"):
            load_audio_vae(self.path, "decode", device="cpu")

    def test_channel_major_audio_rows_preserve_the_stereo_clock(self):
        latent = audio_latents_from_rows(torch.arange(6 * 32).reshape(6, 32))
        self.assertEqual(tuple(latent.shape), (1, 32, 2, 3))
        torch.testing.assert_close(latent[0, 5, 0], torch.tensor([5, 37, 69]))
        torch.testing.assert_close(latent[0, 5, 1], torch.tensor([101, 133, 165]))
        for invalid in (torch.zeros(5, 32), torch.zeros(6, 31), torch.zeros(0, 32), torch.zeros(1, 6, 32)):
            with self.subTest(shape=invalid.shape), self.assertRaisesRegex(ValueError, "even row count and 32 channels"):
                audio_latents_from_rows(invalid)


if __name__ == "__main__":
    unittest.main()
