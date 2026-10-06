from typing import Literal

import torch
from torch import nn


class H3VideoVAE(nn.Module):
    def __init__(self, model, mean, standard_deviation, mode: Literal["encode", "decode"]):
        super().__init__()
        self.model = model
        self.mode = mode
        self.register_buffer("latent_mean", mean.reshape(1, 24, 1, 1, 1))
        self.register_buffer("latent_standard_deviation", standard_deviation.reshape(1, 24, 1, 1, 1))
        self.register_buffer("pixel_mean", torch.tensor([0.485, 0.456, 0.406]).reshape(1, 3, 1, 1, 1))
        self.register_buffer("pixel_standard_deviation", torch.tensor([0.229, 0.224, 0.225]).reshape(1, 3, 1, 1, 1))

    @torch.no_grad()
    def encode(self, pixels: torch.Tensor) -> torch.Tensor:
        if self.mode != "encode":
            raise ValueError("Load the H3 video encoder to encode pixels")
        if pixels.ndim == 4:
            pixels = pixels.unsqueeze(2)
        if pixels.ndim != 5 or pixels.shape[1] != 3 or min(pixels.shape) < 1:
            raise ValueError("H3 video encoding requires pixels shaped [B,3,T,H,W]")
        frames = pixels.shape[2]
        if frames != 1 and (frames < 5 or (frames - 5) % 17):
            raise ValueError("H3 video frames must follow the 17n+5 grid: 5, 22, 39…")
        normalized = ((pixels.float() + 1) * 0.5 - self.pixel_mean) / self.pixel_standard_deviation
        latent = self.model.encode(normalized).latent_dist.mode().float()
        return (latent - self.latent_mean) / self.latent_standard_deviation

    def _decode_latent(self, latent: torch.Tensor) -> torch.Tensor:
        if self.mode != "decode":
            raise ValueError("Load the H3 video decoder to decode latents")
        if latent.ndim != 5 or latent.shape[1] != 24 or min(latent.shape) < 1:
            raise ValueError("H3 video decoding requires latents shaped [B,24,T,H,W]")
        frames = latent.shape[2]
        if frames != 1 and (frames < 2 or (frames - 2) % 5):
            raise ValueError("H3 video latents must follow the 5n+2 grid: 2, 7, 12…")
        return latent.float() * self.latent_standard_deviation + self.latent_mean

    def _pixels(self, decoded: torch.Tensor) -> torch.Tensor:
        return (decoded.float() * self.pixel_standard_deviation + self.pixel_mean).clamp_(0, 1)

    @torch.no_grad()
    def decode(self, latent: torch.Tensor) -> torch.Tensor:
        if latent.ndim == 5 and latent.shape[2] != 1:
            return self.decode_clip(latent)
        normalized = self._decode_latent(latent)
        group = normalized.expand(-1, -1, self.model.tokens_chunk_size, -1, -1)
        start = self.model.frame_pre_padding
        decoded = self.model._decode_clip(group)[:, :, start:start + 1]
        return self._pixels(decoded).squeeze(2)

    @torch.no_grad()
    def decode_clip(self, latent: torch.Tensor) -> torch.Tensor:
        normalized = self._decode_latent(latent)
        if normalized.shape[2] == 1:
            return self.decode(latent).unsqueeze(2)
        frame_count = 17 * ((normalized.shape[2] - 2) // 5) + 5
        if normalized.shape[2] == 2:
            normalized = torch.cat([normalized, normalized[:, :, -1:].expand(-1, -1, 5, -1, -1)], dim=2)
        decoded = self.model.decode(normalized).sample[:, :, :frame_count]
        return self._pixels(decoded)

    @torch.no_grad()
    def decode_middle_frame(self, latent: torch.Tensor, frame_idx=None) -> torch.Tensor:
        normalized = self._decode_latent(latent)
        frame_count = 1 if latent.shape[2] == 1 else 17 * ((latent.shape[2] - 2) // 5) + 5
        index = frame_count // 2 if frame_idx is None else frame_idx
        if type(index) is not int or not 0 <= index < frame_count:
            raise ValueError(f"Preview frame must be an integer between 0 and {frame_count - 1}")
        if latent.shape[2] == 1:
            return self.decode(latent)
        if latent.shape[2] == 2:
            normalized = torch.cat([normalized, normalized[:, :, -1:].expand(-1, -1, 5, -1, -1)], dim=2)
        chunk = min(index // 17, (normalized.shape[2] - 2) // 5 - 1)
        first_chunk = max(0, chunk - 1)
        window = normalized[:, :, first_chunk * 5:(chunk + 1) * 5 + 2]
        local_index = index - first_chunk * 17
        decoded = self.model.decode(window).sample[:, :, local_index:local_index + 1]
        return self._pixels(decoded).squeeze(2)
