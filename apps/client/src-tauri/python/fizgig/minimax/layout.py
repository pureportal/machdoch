"""Packed-sequence geometry for the MiniMax H3 transformer.

H3 runs one self-attention stream over ``[text | conditions | references | audio | video]``
rows. This module owns the clock arithmetic, the latent patch packing and the rotary
coordinates of that stream. The conventions follow the MiniMax-H3 specification published
with the Hugging Face Diffusers port (Apache-2.0).
"""

import math
from dataclasses import dataclass

import torch

FRAMES_PER_LATENT = (1, 4, 4, 4, 4)
PIXEL_FRAMES_PER_GROUP = sum(FRAMES_PER_LATENT)
ROTARY_FRAME_SCALE = 5.0 / 3.0
ROTARY_SPATIAL_SCALE = 32.0
FPS = 24
AUDIO_LATENT_RATE = 40
AUDIO_CHANNELS = 2
VIDEO_SIGMA_SHIFT = 12.0
AUDIO_SIGMA_SHIFT = 3.0
CONDITION_TIMESTEP = 0.999

VIDEO_TAG = 0
TEXT_TAG = 1
AUDIO_TAG = 2
MODALITY_COUNT = 3


def pixel_frames_for_latents(latent_frames: int) -> int:
    """Pixel frames encoded by ``latent_frames`` latents on the (1, 4, 4, 4, 4) grid."""
    count = int(latent_frames)
    if count < 1:
        raise ValueError(f"latent frame count must be at least 1, got {latent_frames}")
    groups, remainder = divmod(count, len(FRAMES_PER_LATENT))
    return groups * PIXEL_FRAMES_PER_GROUP + sum(FRAMES_PER_LATENT[:remainder])


def latent_frames_for_pixels(pixel_frames: int, exact: bool = False) -> int:
    """Latent frames for ``pixel_frames``.

    By default the count snaps down onto the trained 17n+5 grid (a single frame stays a
    still). ``exact`` keeps any count that lies on the latent token grid and rejects others.
    """
    count = int(pixel_frames)
    if count < 1:
        raise ValueError(f"pixel frame count must be at least 1, got {pixel_frames}")
    if exact:
        groups, remainder = divmod(count, PIXEL_FRAMES_PER_GROUP)
        if remainder % 4 != 1 and remainder != 0:
            raise ValueError(
                f"{pixel_frames} frames are not on the latent grid (1, 5, 9, 13, 17, 18, 22, ...)")
        return groups * len(FRAMES_PER_LATENT) + (remainder + 3) // 4
    if count == 1:
        return 1
    count = max(5, count)
    aligned = count - (count - 5) % PIXEL_FRAMES_PER_GROUP
    return len(FRAMES_PER_LATENT) * (aligned - 5) // PIXEL_FRAMES_PER_GROUP + 2


def audio_latents_for_pixels(pixel_frames: int) -> int:
    """Audio latents per channel that span ``pixel_frames`` video frames."""
    return round(int(pixel_frames) * AUDIO_LATENT_RATE / FPS)


def shift_sigma(base, shift: float):
    return shift * base / (1.0 + (shift - 1.0) * base)


def unshift_sigma(sigma, shift: float):
    return sigma / (shift - (shift - 1.0) * sigma)


def audio_sigma(video_sigma, video_shift: float = VIDEO_SIGMA_SHIFT):
    """The audio noise level at the same schedule position as ``video_sigma``."""
    return shift_sigma(unshift_sigma(video_sigma, video_shift), AUDIO_SIGMA_SHIFT)


def patchify_video(latent: torch.Tensor, patch_size) -> torch.Tensor:
    """``[B, C, T, H, W]`` -> ``[B*t*h*w, C*pt*ph*pw]`` rows, frame-major then row-major."""
    batch, channels, frames, height, width = latent.shape
    patch_t, patch_h, patch_w = patch_size
    if frames % patch_t or height % patch_h or width % patch_w:
        raise ValueError(f"latent {tuple(latent.shape)} is not divisible by the patch {tuple(patch_size)}")
    grid = latent.reshape(batch, channels, frames // patch_t, patch_t, height // patch_h, patch_h,
                          width // patch_w, patch_w)
    return grid.permute(0, 2, 4, 6, 1, 3, 5, 7).reshape(-1, channels * patch_t * patch_h * patch_w)


def unpatchify_video(rows: torch.Tensor, frames: int, height: int, width: int, channels: int,
                     patch_size) -> torch.Tensor:
    """Inverse of :func:`patchify_video` for one item; ``frames/height/width`` count patches."""
    patch_t, patch_h, patch_w = patch_size
    grid = rows.reshape(-1, frames, height, width, channels, patch_t, patch_h, patch_w)
    return grid.permute(0, 4, 1, 5, 2, 6, 3, 7).reshape(
        -1, channels, frames * patch_t, height * patch_h, width * patch_w)


def _spatial_axis(size: int, patch: int, normalizer: float) -> torch.Tensor:
    extent = size / normalizer
    steps = size // patch
    return (torch.arange(steps, dtype=torch.float64) * (extent / steps)
            + (1.0 - extent) / 2.0) * ROTARY_SPATIAL_SCALE


@dataclass(frozen=True)
class FrameGrid:
    """Rotary ``(h, w)`` coordinates of one latent frame and its width axis."""

    coordinates: torch.Tensor
    width_axis: torch.Tensor

    @classmethod
    def build(cls, latent_height: int, latent_width: int, patch_h: int = 2, patch_w: int = 2):
        normalizer = math.sqrt(latent_height * latent_width)
        height_axis = _spatial_axis(latent_height, patch_h, normalizer)
        width_axis = _spatial_axis(latent_width, patch_w, normalizer)
        rows, columns = torch.meshgrid(height_axis, width_axis, indexing="ij")
        return cls(torch.stack((rows.reshape(-1), columns.reshape(-1)), dim=-1), width_axis)


def latent_frame_times(latent_frames: int, origin: float) -> torch.Tensor:
    """Rotary time of each latent frame starting at ``origin``."""
    spans = torch.tensor([ROTARY_FRAME_SCALE * FRAMES_PER_LATENT[index % len(FRAMES_PER_LATENT)]
                          for index in range(latent_frames - 1)], dtype=torch.float64)
    return origin + torch.cat((torch.zeros(1, dtype=torch.float64), spans.cumsum(0)))


def latent_frames_span(latent_frames: int) -> float:
    return ROTARY_FRAME_SCALE * pixel_frames_for_latents(latent_frames)


def video_positions(grid: FrameGrid, latent_frames: int, origin: float) -> torch.Tensor:
    rows_per_frame = grid.coordinates.shape[0]
    positions = torch.empty(latent_frames * rows_per_frame, 3, dtype=torch.float64)
    positions[:, 0] = latent_frame_times(latent_frames, origin).repeat_interleave(rows_per_frame)
    positions[:, 1:] = grid.coordinates.repeat(latent_frames, 1)
    return positions


def audio_positions(width_axis: torch.Tensor, audio_latents: int, origin: float) -> torch.Tensor:
    """Channel-major stereo rows pinned to the outer columns of ``width_axis``."""
    positions = torch.zeros(audio_latents * AUDIO_CHANNELS, 3, dtype=torch.float64)
    positions[:, 0] = (origin + torch.arange(audio_latents, dtype=torch.float64)).repeat(AUDIO_CHANNELS)
    positions[:audio_latents, 2] = float(width_axis[0])
    positions[audio_latents:, 2] = float(width_axis[-1])
    return positions


@dataclass(frozen=True)
class VisualReference:
    latent_height: int
    latent_width: int
    latent_frames: int = 1


@dataclass(frozen=True)
class AudioReference:
    audio_latents: int


def packed_positions(text_length: int, latent_height: int, latent_width: int, *,
                     audio_latents: int = 0, latent_frames: int = 1, references=(),
                     keyframe_indices=()) -> torch.Tensor:
    """``[S, 3]`` float64 ``(t, h, w)`` rotary coordinates of a packed sequence.

    Row order is text, keyframe conditions, references, audio, then video. Text rows advance
    the clock by one unit each; every reference advances it by the time it occupies, so the
    generated rows start where the last reference ends. Keyframe conditions sit on the target
    timeline at the pixel frame they anchor.
    """
    target = FrameGrid.build(latent_height, latent_width)
    text = torch.zeros(text_length, 3, dtype=torch.float64)
    text[:, 0] = torch.arange(text_length, dtype=torch.float64)
    clock = float(text_length)
    reference_blocks = []
    for reference in references:
        if isinstance(reference, AudioReference):
            reference_blocks.append(audio_positions(target.width_axis, reference.audio_latents, clock))
            clock += reference.audio_latents
        elif reference.latent_frames == 1:
            grid = FrameGrid.build(reference.latent_height, reference.latent_width)
            block = torch.empty(grid.coordinates.shape[0], 3, dtype=torch.float64)
            block[:, 0] = clock
            block[:, 1:] = grid.coordinates
            reference_blocks.append(block)
            clock += 1.0
        else:
            grid = FrameGrid.build(reference.latent_height, reference.latent_width)
            reference_blocks.append(video_positions(grid, reference.latent_frames, clock))
            clock += latent_frames_span(reference.latent_frames)
    keyframe_blocks = []
    for frame_index in keyframe_indices:
        block = torch.empty(target.coordinates.shape[0], 3, dtype=torch.float64)
        block[:, 0] = clock + ROTARY_FRAME_SCALE * frame_index
        block[:, 1:] = target.coordinates
        keyframe_blocks.append(block)
    blocks = [text, *keyframe_blocks, *reference_blocks]
    if audio_latents:
        blocks.append(audio_positions(target.width_axis, audio_latents, clock))
    blocks.append(video_positions(target, latent_frames, clock))
    return torch.cat(blocks)
