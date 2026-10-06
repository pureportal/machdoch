from typing import Literal

import torch
from torch import nn

from fizgig.krea2.safetensors_utils import MemoryEfficientSafeOpen


class H3AudioVAE(nn.Module):
    def __init__(self, model, mean, standard_deviation, mode: Literal["encode", "decode"]):
        super().__init__()
        self.model = model
        self.mode = mode
        self.sample_rate = 32000
        self.register_buffer("latent_mean", mean.reshape(1, 32, 1))
        self.register_buffer("latent_standard_deviation", standard_deviation.reshape(1, 32, 1))

    @torch.no_grad()
    def encode(self, waveform: torch.Tensor) -> torch.Tensor:
        if self.mode != "encode":
            raise ValueError("Load the H3 audio encoder to encode a waveform")
        if waveform.ndim != 3 or waveform.shape[1] != 2 or min(waveform.shape) < 1:
            raise ValueError("H3 audio encoding requires stereo samples shaped [B,2,L]")
        batch, channels, samples = waveform.shape
        latent = self.model.encode(waveform.reshape(batch * channels, 1, samples)).latent_dist.mode()
        normalized = (latent - self.latent_mean) / self.latent_standard_deviation
        return normalized.reshape(batch, channels, 32, -1).permute(0, 2, 1, 3)

    @torch.no_grad()
    def decode(self, latent: torch.Tensor) -> torch.Tensor:
        if self.mode != "decode":
            raise ValueError("Load the H3 audio decoder to decode latents")
        if latent.ndim != 4 or tuple(latent.shape[1:3]) != (32, 2) or min(latent.shape) < 1:
            raise ValueError("H3 audio decoding requires latents shaped [B,32,2,T]")
        batch, channels, stereo, frames = latent.shape
        flattened = latent.permute(0, 2, 1, 3).reshape(batch * stereo, channels, frames)
        denormalized = flattened * self.latent_standard_deviation + self.latent_mean
        return self.model.decode(denormalized).sample.reshape(batch, stereo, -1)


def load_audio_vae(path, mode: Literal["encode", "decode"], device="cuda") -> H3AudioVAE:
    if mode not in ("encode", "decode"):
        raise ValueError("H3 audio VAE mode must be encode or decode")
    with MemoryEfficientSafeOpen(str(path)) as checkpoint:
        for name in ("latents_mean", "latents_std"):
            specification = checkpoint.header.get(name)
            if not specification or specification["shape"] != [32] or specification["dtype"] != "F32":
                raise ValueError(f"H3 audio VAE needs an fp32 [32] {name} tensor. Install the complete audio checkpoint.")
        mean = checkpoint.get_tensor("latents_mean")
        standard_deviation = checkpoint.get_tensor("latents_std")
        if not torch.isfinite(mean).all() or not torch.isfinite(standard_deviation).all() or (standard_deviation <= 0).any():
            raise ValueError("H3 audio VAE normalization is damaged. Replace the audio checkpoint.")

        from diffusers import AutoencoderKLMiniMaxH3Audio

        with torch.device("meta"):
            model = AutoencoderKLMiniMaxH3Audio()
            for module in model.modules():
                if hasattr(module, "weight_g") and hasattr(module, "weight_v"):
                    nn.utils.remove_weight_norm(module)
        unused = ("decoder", "dec_in_proj") if mode == "encode" else ("encoder", "pre_block", "mean_proj", "logs_proj")
        for name in unused:
            delattr(model, name)
        expected = model.state_dict()
        for name, tensor in expected.items():
            specification = checkpoint.header.get(name)
            if not specification or tuple(specification["shape"]) != tuple(tensor.shape) or specification["dtype"] != "F32":
                raise ValueError(f"H3 audio VAE weight {name} is missing or incompatible. Install the complete audio checkpoint.")
        state = {}
        for name in expected:
            tensor = checkpoint.get_tensor(name)
            if not torch.isfinite(tensor).all():
                raise ValueError(f"H3 audio VAE weight {name} is damaged. Replace the audio checkpoint.")
            state[name] = tensor
        model.load_state_dict(state, strict=True, assign=True)
    return H3AudioVAE(model, mean, standard_deviation, mode).eval().requires_grad_(False).to(device=device, dtype=torch.float32)


def audio_latents_from_rows(rows: torch.Tensor) -> torch.Tensor:
    if rows.ndim != 2 or rows.shape[1] != 32 or rows.shape[0] == 0 or rows.shape[0] % 2:
        raise ValueError("H3 audio rows need an even row count and 32 channels")
    return rows.T.reshape(1, 32, 2, rows.shape[0] // 2)
