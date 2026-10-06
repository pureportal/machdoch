"""MiniMax-H3 T2AV geometry adapted from DMAD (Apache-2.0).

Copyright 2026 the DMAD authors. Machdoch modifications: offline component
validation, explicit geometry checks, and removal of unrelated loading paths.
See LICENSE-DMAD.txt and NOTICE-DMAD.txt.
"""

from dataclasses import dataclass
import json
import math
from pathlib import Path

import torch
import numpy as np


@dataclass(frozen=True)
class H3Geometry:
    patch_size: tuple[int, int, int]
    video_latent_channels: int
    audio_latent_channels: int
    vae_spatial_scale_factor: int

    @classmethod
    def from_model_dir(cls, root: Path):
        transformer = json.loads((root / "transformer/config.json").read_text(encoding="utf-8"))
        vae = json.loads((root / "vae/config.json").read_text(encoding="utf-8"))
        if transformer.get("_class_name") != "MiniMaxH3Transformer3DModel":
            raise ValueError("Choose the full MiniMax-H3 text-to-audio-video transformer")
        geometry = cls(
            tuple(transformer["patch_size"]), transformer["in_channels"],
            transformer["audio_in_channels"], math.prod(vae["spatial_downsample_factors"]),
        )
        if geometry.patch_size != (1, 2, 2) or geometry.video_latent_channels != 24 or geometry.audio_latent_channels != 32 or geometry.vae_spatial_scale_factor != 16:
            raise ValueError("The model has incompatible MiniMax-H3 latent geometry")
        return geometry


@dataclass(frozen=True)
class H3PackedSequence:
    sequence_length: int
    position_ids: torch.Tensor
    token_tags: torch.Tensor
    video_indices: torch.Tensor
    audio_indices: torch.Tensor
    text_indices: torch.Tensor

    def to(self, device):
        return H3PackedSequence(
            self.sequence_length, self.position_ids.to(device), self.token_tags.to(device),
            self.video_indices.to(device), self.audio_indices.to(device), self.text_indices.to(device),
        )


def latent_shape(height, width, frames, geometry):
    latent_frames = (frames - 5) // 17 * 5 + 2
    latent_height = height // geometry.vae_spatial_scale_factor
    latent_width = width // geometry.vae_spatial_scale_factor
    _, patch_height, patch_width = geometry.patch_size
    audio_frames = round(frames / 24 * 40)
    return {
        "latent_frames": latent_frames, "latent_height": latent_height,
        "latent_width": latent_width, "audio_latents": audio_frames,
        "video_tokens": (1, latent_frames * (latent_height // patch_height) * (latent_width // patch_width), geometry.video_latent_channels * patch_height * patch_width),
        "audio_tokens": (1, audio_frames * 2, geometry.audio_latent_channels),
    }


def packed_sequence(text_count, shape, geometry):
    audio_count = shape["audio_latents"] * 2
    latent_frames = shape["latent_frames"]
    height, width = shape["latent_height"], shape["latent_width"]
    _, patch_height, patch_width = geometry.patch_size
    rows_per_frame = (height // patch_height) * (width // patch_width)
    video_start = text_count + audio_count
    sequence_length = video_start + latent_frames * rows_per_frame
    positions = torch.zeros(sequence_length, 3, dtype=torch.float64)
    positions[:text_count, 0] = torch.arange(text_count, dtype=torch.float64)
    sqrt_area = float(np.sqrt(height * width))
    height_grid = _spatial_grid(height, patch_height, sqrt_area)
    width_grid = _spatial_grid(width, patch_width, sqrt_area)
    grid = torch.stack([axis.flatten() for axis in torch.meshgrid(height_grid, width_grid, indexing="ij")], dim=-1)
    spans = torch.tensor([5 / 3 * (1, 4, 4, 4, 4)[index % 5] for index in range(latent_frames)], dtype=torch.float64)
    times = text_count + torch.cat((torch.zeros(1, dtype=torch.float64), spans[:-1].cumsum(0)))
    video_positions = torch.empty(latent_frames, rows_per_frame, 3, dtype=torch.float64)
    video_positions[:, :, 0] = times[:, None]
    video_positions[:, :, 1:] = grid[None]
    positions[video_start:] = video_positions.reshape(-1, 3)
    positions[text_count:video_start, 0] = (text_count + torch.arange(shape["audio_latents"], dtype=torch.float64)).repeat(2)
    positions[text_count:video_start, 2] = torch.cat((
        width_grid[0].expand(shape["audio_latents"]), width_grid[-1].expand(shape["audio_latents"]),
    ))
    text_indices = torch.arange(text_count)
    audio_indices = torch.arange(text_count, video_start)
    video_indices = torch.arange(video_start, sequence_length)
    tags = torch.zeros(sequence_length, dtype=torch.long)
    tags[text_indices] = 1
    tags[audio_indices] = 2
    return H3PackedSequence(sequence_length, positions, tags, video_indices, audio_indices, text_indices)


def _spatial_grid(dimension, patch, sqrt_area):
    ratio = dimension / sqrt_area
    left = (1 - ratio) / 2
    return torch.from_numpy(np.linspace(left, left + ratio, dimension // patch, endpoint=False) * 32)


def row_timesteps(layout, video_sigma, audio_sigma):
    video_time = float((1 - torch.as_tensor(video_sigma, dtype=torch.float32)).item())
    audio_time = float((1 - torch.as_tensor(audio_sigma, dtype=torch.float32)).item())
    rows = torch.full((layout.sequence_length,), video_time, dtype=torch.float32, device=layout.audio_indices.device)
    rows[layout.audio_indices] = audio_time
    return torch.unique(rows, sorted=True, return_inverse=True)
