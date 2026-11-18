"""MiniMax H3 diffusion transformer for adapter training and joint audio/video sampling.

The network follows the MiniMax-H3 transformer specification of the Hugging Face Diffusers
port (Apache-2.0, The MiniMax Team and The HuggingFace Team). Module and parameter names
match the original checkpoint keys so adapters trained here load onto the released base.

The head predicts ``x0 - noise``; ``t`` is cleanness (``1 - sigma``).
"""

import logging
import math
from dataclasses import dataclass
from typing import Optional

import torch
import torch.nn as nn
import torch.nn.functional as F
import torch.utils.checkpoint

from .layout import (
    AUDIO_CHANNELS,
    AUDIO_TAG,
    CONDITION_TIMESTEP,
    MODALITY_COUNT,
    TEXT_TAG,
    VIDEO_TAG,
    AudioReference,
    VisualReference,
    audio_latents_for_pixels,
    audio_sigma,
    packed_positions,
    patchify_video,
    pixel_frames_for_latents,
    unpatchify_video,
)

logger = logging.getLogger(__name__)

FEED_FORWARD_CHUNK_ROWS = 8192


@dataclass
class MiniMaxH3Config:
    hidden_size: int = 5376
    num_layers: int = 50
    token_refiner_num_layers: int = 2
    num_attention_heads: int = 56
    attention_head_dim: int = 128
    ffn_hidden_size: int = 14336
    latents_dim: int = 24
    audio_latents_dim: int = 32
    patch_size: tuple = (1, 2, 2)
    text_dim: int = 5120
    timestep_input_dim: int = 256
    time_embed_hidden_size: int = 5376
    time_embed_dim: int = 2688
    rope_inv_freq_len: int = 16
    adaln_t_table_size: Optional[int] = None
    norm_eps: float = 1e-5
    qk_norm_eps: float = 1e-5
    final_norm_eps: float = 1e-5


def rotary_tables(positions: torch.Tensor, inverse_frequencies: torch.Tensor):
    """``[S, 3]`` positions -> cos/sin ``[S, 3 * F]`` laid out as ``[t | h | w]`` blocks."""
    angles = positions.to(torch.float32).unsqueeze(-1) * inverse_frequencies.to(torch.float32)
    angles = angles.reshape(positions.shape[0], -1)
    return angles.cos(), angles.sin()


def apply_rotary(states: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor) -> torch.Tensor:
    """Rotate channel ``i`` with ``i + R`` for the first ``2R`` channels of every head."""
    width = cos.shape[-1]
    first = states[..., :width]
    second = states[..., width:2 * width]
    cos = cos.unsqueeze(1)
    sin = sin.unsqueeze(1)
    return torch.cat((first * cos - second * sin, second * cos + first * sin, states[..., 2 * width:]),
                     dim=-1)


@dataclass(frozen=True)
class RowSegments:
    """Contiguous runs of packed rows sharing one ``(timestep, modality)`` modulation row.

    Modulating run by run broadcasts one table row over each run instead of gathering a full
    ``[S, hidden]`` tensor per shift, scale and gate.
    """

    spans: tuple

    @classmethod
    def from_rows(cls, table_rows):
        spans = []
        start = 0
        for index in range(1, len(table_rows) + 1):
            if index == len(table_rows) or table_rows[index] != table_rows[start]:
                spans.append((start, index, table_rows[start]))
                start = index
        return cls(tuple(spans))

    def truncate_last(self, rows: int) -> "RowSegments":
        start, _, table_row = self.spans[-1]
        return RowSegments(self.spans[:-1] + ((start, start + rows, table_row),))

    def modulate(self, states, shift, scale):
        shift = shift.to(states.dtype)
        scale = scale.to(states.dtype) + 1.0
        return self._combine([torch.addcmul(shift[row], states[start:stop], scale[row])
                              for start, stop, row in self.spans])

    def gate(self, residual, update, gate):
        gate = gate.to(residual.dtype)
        return self._combine([torch.addcmul(residual[start:stop], update[start:stop], gate[row])
                              for start, stop, row in self.spans])

    @staticmethod
    def _combine(parts):
        return parts[0] if len(parts) == 1 else torch.cat(parts)


class TimeEmbedder(nn.Module):
    def __init__(self, frequency_dim: int, hidden_dim: int, output_dim: int):
        super().__init__()
        self.frequency_dim = frequency_dim
        self.proj_in = nn.Linear(frequency_dim, hidden_dim, bias=True)
        self.proj_out = nn.Linear(hidden_dim, output_dim, bias=True)

    def forward(self, timesteps: torch.Tensor) -> torch.Tensor:
        half = self.frequency_dim // 2
        exponents = torch.arange(half, dtype=torch.float32, device=timesteps.device)
        frequencies = torch.exp(-math.log(10000.0) * exponents / half)
        angles = timesteps.to(torch.float32)[:, None] * frequencies[None]
        features = torch.cat((angles.cos(), angles.sin()), dim=-1)
        return self.proj_out(F.silu(self.proj_in(features.to(self.proj_in.weight.dtype))))


class Attention(nn.Module):
    def __init__(self, hidden: int, heads: int, head_dim: int, eps: float):
        super().__init__()
        self.heads = heads
        self.head_dim = head_dim
        self.qkv_proj = nn.Linear(hidden, 3 * heads * head_dim, bias=False)
        self.q_norm = nn.RMSNorm(head_dim, eps=eps)
        self.k_norm = nn.RMSNorm(head_dim, eps=eps)
        self.out_proj = nn.Linear(heads * head_dim, hidden, bias=False)

    def forward(self, states, cos=None, sin=None):
        rows = states.shape[0]
        query, key, value = self.qkv_proj(states).view(rows, 3, self.heads, self.head_dim).unbind(1)
        query = self.q_norm(query)
        key = self.k_norm(key)
        if cos is not None:
            query = apply_rotary(query, cos, sin)
            key = apply_rotary(key, cos, sin)
        attended = F.scaled_dot_product_attention(*(part.transpose(0, 1).unsqueeze(0) for part in (query, key, value)))
        return self.out_proj(attended[0].transpose(0, 1).reshape(rows, self.heads * self.head_dim))


class FeedForward(nn.Module):
    """SwiGLU; the fused ``fc1`` stores the gate half first. Inference runs in row chunks."""

    def __init__(self, hidden: int, inner: int):
        super().__init__()
        self.fc1 = nn.Linear(hidden, 2 * inner, bias=False)
        self.fc2 = nn.Linear(inner, hidden, bias=False)

    def _project(self, states):
        gate, value = self.fc1(states).chunk(2, dim=-1)
        return self.fc2(F.silu(gate) * value)

    def forward(self, states):
        if torch.is_grad_enabled() or states.shape[0] <= FEED_FORWARD_CHUNK_ROWS:
            return self._project(states)
        output = None
        for start in range(0, states.shape[0], FEED_FORWARD_CHUNK_ROWS):
            part = self._project(states[start:start + FEED_FORWARD_CHUNK_ROWS])
            if output is None:
                output = part.new_empty(states.shape[0], part.shape[-1])
            output[start:start + part.shape[0]] = part
        return output


class AdalnProj(nn.Module):
    """Timestep embedding -> ``expand`` modulation tables of ``[M * modalities, hidden]``."""

    def __init__(self, t_dim: int, hidden: int, expand: int, modalities: int, apply_silu: bool = True):
        super().__init__()
        self.expand = expand
        self.modalities = modalities
        self.hidden = hidden
        self.apply_silu = apply_silu
        self.linear = nn.Linear(t_dim, expand * hidden * modalities, bias=True)

    def forward(self, t_emb):
        projected = self.linear(F.silu(t_emb) if self.apply_silu else t_emb)
        return projected.view(-1, self.expand * self.hidden).chunk(self.expand, dim=-1)


class RefinerBlock(nn.Module):
    def __init__(self, hidden, heads, head_dim, ffn, eps, qk_eps):
        super().__init__()
        self.norm1 = nn.RMSNorm(hidden, eps=eps)
        self.attn = Attention(hidden, heads, head_dim, qk_eps)
        self.norm2 = nn.RMSNorm(hidden, eps=eps)
        self.mlp = FeedForward(hidden, ffn)

    def forward(self, states):
        states = states + self.attn(self.norm1(states))
        return states + self.mlp(self.norm2(states))


class TokenRefiner(nn.Module):
    def __init__(self, layers, hidden, heads, head_dim, ffn, eps, qk_eps, final_eps):
        super().__init__()
        self.blocks = nn.ModuleList(RefinerBlock(hidden, heads, head_dim, ffn, eps, qk_eps)
                                    for _ in range(layers))
        self.final_norm = nn.RMSNorm(hidden, eps=final_eps)

    def forward(self, states):
        for block in self.blocks:
            states = block(states)
        return self.final_norm(states)


class DiTBlock(nn.Module):
    def __init__(self, hidden, heads, head_dim, ffn, t_dim, eps, qk_eps, apply_silu=True):
        super().__init__()
        self.norm1 = nn.RMSNorm(hidden, eps=eps)
        self.attn = Attention(hidden, heads, head_dim, qk_eps)
        self.norm2 = nn.RMSNorm(hidden, eps=eps)
        self.mlp = FeedForward(hidden, ffn)
        self.adaln_proj = AdalnProj(t_dim, hidden, 6, MODALITY_COUNT, apply_silu=apply_silu)

    def forward(self, states, t_emb, segments: RowSegments, cos, sin):
        shift_attn, scale_attn, gate_attn, shift_mlp, scale_mlp, gate_mlp = self.adaln_proj(t_emb)
        attended = self.attn(segments.modulate(self.norm1(states), shift_attn, scale_attn), cos, sin)
        states = segments.gate(states, attended, gate_attn)
        projected = self.mlp(segments.modulate(self.norm2(states), shift_mlp, scale_mlp))
        return segments.gate(states, projected, gate_mlp)


class FinalLayer(nn.Module):
    def __init__(self, hidden, t_dim, video_dim, audio_dim, eps, apply_silu=True):
        super().__init__()
        self.norm = nn.RMSNorm(hidden, eps=eps)
        self.adaln_proj = AdalnProj(t_dim, hidden, 2, 1, apply_silu=apply_silu)
        self.video_out = nn.Linear(hidden, video_dim, bias=True)
        self.audio_out = nn.Linear(hidden, audio_dim, bias=True)

    def forward(self, states, t_emb, t_index: int, head: nn.Linear):
        shift, scale = self.adaln_proj(t_emb)
        modulated = self.norm(states) * (1.0 + scale[t_index]) + shift[t_index]
        return head(modulated.to(head.weight.dtype))


def _run_block(blocks, index, swap_from, states, t_emb, segments, cos, sin):
    """Run one block, streaming or parking it when it lies in the swapped tail.

    Parking the successor on entry keeps backward recomputation, which stops early, from
    leaving every swapped block resident.
    """
    block = blocks[index]
    if index < swap_from:
        return block(states, t_emb, segments, cos, sin)
    offloader = getattr(block, "_h2d_offloader", None)
    if offloader is not None:
        offloader.wait_for_block(index)
        return block(states, t_emb, segments, cos, sin)
    block.to(states.device)
    if index + 1 < len(blocks):
        blocks[index + 1].to("cpu")
    output = block(states, t_emb, segments, cos, sin)
    block.to("cpu")
    return output


@dataclass
class _PackedRows:
    states: list
    table_rows: list
    timesteps: list
    references: list


class MiniMaxH3DiT(nn.Module):
    def __init__(self, config: Optional[MiniMaxH3Config] = None):
        super().__init__()
        c = config or MiniMaxH3Config()
        self.config = c
        self.hidden_size = c.hidden_size
        self.patch_size = tuple(c.patch_size)
        self.latents_dim = c.latents_dim
        video_patch_dim = c.latents_dim * math.prod(self.patch_size)
        self.video_patch_proj = nn.Linear(video_patch_dim, c.hidden_size, bias=True)
        self.audio_patch_proj = nn.Linear(c.audio_latents_dim, c.hidden_size, bias=True)
        self.condition_proj = nn.Linear(c.text_dim, c.hidden_size, bias=True)
        self.pruned_adaln = c.adaln_t_table_size is not None
        self.adaln_fp32 = False
        if self.pruned_adaln:
            self.time_embedder = None
            self.register_buffer("adaln_t_table", torch.zeros(c.adaln_t_table_size, c.time_embed_dim))
        else:
            self.time_embedder = TimeEmbedder(c.timestep_input_dim, c.time_embed_hidden_size, c.time_embed_dim)
        self.rope = nn.Module()
        self.rope.register_buffer(
            "inv_freq",
            1.0 / 10000.0 ** (torch.arange(c.rope_inv_freq_len, dtype=torch.float32) / c.rope_inv_freq_len))
        self.token_refiner = TokenRefiner(c.token_refiner_num_layers, c.hidden_size, c.num_attention_heads,
                                          c.attention_head_dim, c.ffn_hidden_size, c.norm_eps,
                                          c.qk_norm_eps, c.final_norm_eps)
        self.blocks = nn.ModuleList(
            DiTBlock(c.hidden_size, c.num_attention_heads, c.attention_head_dim, c.ffn_hidden_size,
                     c.time_embed_dim, c.norm_eps, c.qk_norm_eps, apply_silu=not self.pruned_adaln)
            for _ in range(c.num_layers))
        self.final_layer = FinalLayer(c.hidden_size, c.time_embed_dim, video_patch_dim, c.audio_latents_dim,
                                      c.final_norm_eps, apply_silu=not self.pruned_adaln)
        self._gradient_checkpointing = False
        self._swap_from = len(self.blocks)
        self._h2d_requested = False
        self._h2d_offloader = None
        self._tread = None

    def _time_embedding(self, timesteps: torch.Tensor) -> torch.Tensor:
        """Cleanness values ``[M]`` -> ``[M, time_embed_dim]``; pruned bases interpolate their table."""
        if not self.pruned_adaln:
            return self.time_embedder(timesteps)
        table = self.adaln_t_table.float()
        position = timesteps.to(device=table.device, dtype=torch.float32).clamp(0.0, 1.0) * (table.shape[0] - 1)
        lower = position.floor().long()
        upper = (lower + 1).clamp(max=table.shape[0] - 1)
        fraction = (position - lower.float()).unsqueeze(1)
        return torch.lerp(table[lower], table[upper], fraction).to(timesteps.device)

    def enable_gradient_checkpointing(self, enabled: bool = True):
        self._gradient_checkpointing = enabled

    def enable_block_swap(self, blocks_to_swap: int, h2d_only=None, ring_size: int = 2):
        """Keep the last ``blocks_to_swap`` blocks off the GPU between uses.

        ``h2d_only`` streams int8 ConvRot blocks through a pinned ring on a copy stream; any
        other tail is parked on the CPU and moved per use. ``None`` keeps the previous mode.
        Returns the number of swapped blocks.
        """
        if h2d_only is not None:
            self._h2d_requested = bool(h2d_only)
        self._release_offloader()
        swapped = max(0, min(int(blocks_to_swap), len(self.blocks) - 2))
        self._swap_from = len(self.blocks) - swapped
        if self._h2d_requested and swapped:
            try:
                self._attach_int8_ring(ring_size)
                return swapped
            except Exception as error:
                logger.warning("[vram] H2D ring unavailable (%s: %s); parking swapped blocks on the CPU "
                               "instead, which is several times slower.", type(error).__name__, error)
                self._release_offloader()
                self._h2d_requested = False
        for block in self.blocks[self._swap_from:]:
            block.to("cpu")
        return swapped

    def _attach_int8_ring(self, ring_size: int):
        quantized = [module for block in self.blocks[self._swap_from:] for module in block.modules()
                     if type(module).__name__ == "ConvRotInt8Linear"]
        if not quantized:
            raise RuntimeError("the swapped blocks hold no int8 ConvRot weights")
        from .block_stream import Int8BlockStream
        device = next((module.qdata.device for block in self.blocks for module in block.modules()
                       if type(module).__name__ == "ConvRotInt8Linear" and module.qdata.is_cuda),
                      torch.device("cuda"))
        offloader = Int8BlockStream(self.blocks, self._swap_from, device=device, ring_size=ring_size)
        self._h2d_offloader = offloader
        for block in self.blocks:
            block._h2d_offloader = offloader
        offloader.move_static_weights_to_gpu()
        offloader.prepare()

    def _release_offloader(self):
        offloader = self._h2d_offloader
        self._h2d_offloader = None
        for block in self.blocks:
            block._h2d_offloader = None
        if offloader is not None:
            offloader.release()

    def forward(self, video_latent: torch.Tensor, t, text_embeds: torch.Tensor,
                audio_noise: Optional[torch.Tensor] = None, *, audio_rows: Optional[torch.Tensor] = None,
                audio_t=None, return_audio: bool = False, ref_latents=None,
                text_token_tags: Optional[torch.Tensor] = None, seed: int = 0, keyframes=None):
        """Predict ``x0 - noise`` for one packed sequence.

        video_latent    ``[1, C, T, H, W]`` target latent (``T`` on the latent grid).
        t               cleanness of the target video rows.
        text_embeds     ``[1, L, text_dim]`` encoder states.
        audio_noise     unit noise for the soundtrack rows, scaled to the audio noise level.
        audio_rows      ``[A * 2, audio_dim]`` soundtrack rows used verbatim.
        audio_t         cleanness of the soundtrack rows; derived from ``t`` on the default
                        video/audio schedules when omitted.
        ref_latents     visual ``[1, C, T, h, w]`` or stereo audio ``[1, audio_dim, 2, T]``
                        references, packed as clean conditioning.
        text_token_tags per-row modality tags of the text rows.
        seed            noise seed of the visual reference augmentation.
        keyframes       ``[(pixel_frame_index, latent [1, C, 1, H, W])]`` frame conditions.

        Returns the video prediction, or ``(video, audio)`` with ``return_audio``.
        """
        if video_latent.shape[0] != 1:
            raise ValueError("MiniMax H3 packs one item per forward")
        device = video_latent.device
        dtype = text_embeds.dtype
        _, _, latent_frames, latent_height, latent_width = video_latent.shape
        text_length = text_embeds.shape[1]
        video_t = (t.detach().reshape(-1)[:1] if torch.is_tensor(t) else torch.tensor([float(t)]))
        video_t = video_t.to(device="cpu", dtype=torch.float32)
        if audio_t is None:
            audio_noise_level = audio_sigma((1.0 - video_t).clamp(0.0, 1.0))
            audio_t = 1.0 - audio_noise_level
        else:
            audio_t = (audio_t.detach().reshape(-1)[:1] if torch.is_tensor(audio_t)
                       else torch.tensor([float(audio_t)])).to(device="cpu", dtype=torch.float32)
            audio_noise_level = 1.0 - audio_t
        condition_t = torch.clamp(video_t, min=CONDITION_TIMESTEP)
        clean_t = torch.ones(1)
        timesteps, inverse = torch.unique(torch.cat((video_t, audio_t, condition_t, clean_t)),
                                          sorted=True, return_inverse=True)
        video_row, audio_row, condition_row, clean_row = (int(index) * MODALITY_COUNT for index in inverse)

        packed = _PackedRows([], [], [], [])
        self._pack_text(packed, text_embeds[0], text_token_tags, video_row, dtype)
        keyframe_indices = self._pack_keyframes(packed, keyframes, latent_frames, latent_height, latent_width,
                                                condition_row, device, dtype)
        self._pack_references(packed, ref_latents, seed, condition_row, clean_row, device, dtype)
        audio_start = len(packed.table_rows)
        audio_latents = audio_latents_for_pixels(pixel_frames_for_latents(latent_frames))
        self._pack_audio(packed, audio_rows, audio_noise, audio_latents, float(audio_noise_level), audio_row,
                         device, dtype)
        video_start = len(packed.table_rows)
        video_rows = patchify_video(video_latent.to(torch.float32), self.patch_size)
        packed.states.append(self._project(self.video_patch_proj, video_rows, dtype))
        packed.table_rows.extend([video_row + VIDEO_TAG] * video_rows.shape[0])

        states = torch.cat(packed.states)
        t_emb = self._time_embedding(timesteps.to(device))
        if not self.adaln_fp32:
            t_emb = t_emb.to(dtype)
        positions = packed_positions(text_length, latent_height, latent_width, audio_latents=audio_latents,
                                     latent_frames=latent_frames, references=packed.references,
                                     keyframe_indices=keyframe_indices)
        cos, sin = rotary_tables(positions.to(device), self.rope.inv_freq.to(device))
        states = self._run_blocks(states, t_emb, RowSegments.from_rows(packed.table_rows),
                                  cos.to(dtype), sin.to(dtype), video_start, latent_frames)

        patch_t, patch_h, patch_w = self.patch_size
        video = self.final_layer(states[video_start:], t_emb, video_row // MODALITY_COUNT,
                                 self.final_layer.video_out)
        video = unpatchify_video(video, latent_frames // patch_t, latent_height // patch_h,
                                 latent_width // patch_w, self.latents_dim, self.patch_size).to(video_latent.dtype)
        if not return_audio:
            return video
        audio = self.final_layer(states[audio_start:video_start], t_emb, audio_row // MODALITY_COUNT,
                                 self.final_layer.audio_out)
        return video, audio

    @staticmethod
    def _project(layer: nn.Linear, rows: torch.Tensor, dtype) -> torch.Tensor:
        return layer(rows.to(layer.weight.dtype)).to(dtype)

    def _pack_text(self, packed, text_states, text_token_tags, video_row, dtype):
        if text_states.shape[-1] != self.hidden_size:
            text_states = self.token_refiner(self.condition_proj(text_states))
        packed.states.append(text_states.to(dtype))
        if text_token_tags is None:
            packed.table_rows.extend([video_row + TEXT_TAG] * text_states.shape[0])
            return
        tags = text_token_tags.reshape(-1).tolist()
        if len(tags) != text_states.shape[0]:
            raise ValueError(f"text_token_tags has {len(tags)} rows for {text_states.shape[0]} text rows")
        packed.table_rows.extend(video_row + int(tag) for tag in tags)

    def _augmented_rows(self, latent, noise_seed: int, device, dtype):
        rows = patchify_video(latent.to(device=device, dtype=torch.float32), self.patch_size)
        generator = torch.Generator("cpu").manual_seed(int(noise_seed))
        noise = torch.randn(rows.shape, generator=generator, dtype=torch.float32).to(device)
        return self._project(self.video_patch_proj, torch.lerp(noise, rows, CONDITION_TIMESTEP), dtype)

    def _pack_keyframes(self, packed, keyframes, latent_frames, latent_height, latent_width, condition_row,
                        device, dtype):
        if not keyframes:
            return ()
        pixel_frames = pixel_frames_for_latents(latent_frames)
        indices = []
        for frame_index, latent in keyframes:
            frame_index = int(frame_index)
            if tuple(latent.shape[-2:]) != (latent_height, latent_width):
                raise ValueError(f"keyframe latent {tuple(latent.shape[-2:])} does not match the target grid "
                                 f"{(latent_height, latent_width)}")
            if not 0 <= frame_index < pixel_frames:
                raise ValueError(f"keyframe {frame_index} is outside the clip's {pixel_frames} frames")
            noise_seed = 1 if frame_index == 0 else 0 if frame_index == pixel_frames - 1 else 100 + frame_index
            rows = self._augmented_rows(latent, noise_seed, device, dtype)
            packed.states.append(rows)
            packed.table_rows.extend([condition_row + VIDEO_TAG] * rows.shape[0])
            indices.append(frame_index)
        return tuple(indices)

    def _pack_references(self, packed, ref_latents, seed, condition_row, clean_row, device, dtype):
        audio_dim = self.config.audio_latents_dim
        for latent in ref_latents or ():
            if latent.ndim == 4:
                if tuple(latent.shape[:3]) != (1, audio_dim, AUDIO_CHANNELS) or latent.shape[-1] < 1:
                    raise ValueError(f"audio reference must have shape [1, {audio_dim}, {AUDIO_CHANNELS}, T]")
                rows = latent[0].permute(1, 2, 0).reshape(-1, audio_dim).to(device)
                packed.states.append(self._project(self.audio_patch_proj, rows, dtype))
                packed.table_rows.extend([clean_row + AUDIO_TAG] * rows.shape[0])
                packed.references.append(AudioReference(int(latent.shape[-1])))
                continue
            rows = self._augmented_rows(latent, seed, device, dtype)
            packed.states.append(rows)
            packed.table_rows.extend([condition_row + VIDEO_TAG] * rows.shape[0])
            packed.references.append(VisualReference(int(latent.shape[-2]), int(latent.shape[-1]),
                                                     int(latent.shape[2])))

    def _pack_audio(self, packed, audio_rows, audio_noise, audio_latents, noise_level, audio_row, device, dtype):
        expected = audio_latents * AUDIO_CHANNELS
        if audio_rows is None:
            noise = audio_noise if audio_noise is not None else torch.randn(
                expected, self.config.audio_latents_dim, device=device)
            rows = noise_level * noise.to(device=device, dtype=torch.float32)
        else:
            rows = audio_rows.to(device=device, dtype=torch.float32)
        if rows.shape[0] != expected:
            raise ValueError(f"soundtrack has {rows.shape[0]} rows; this clip packs {expected} "
                             f"({audio_latents} latents x {AUDIO_CHANNELS} channels)")
        packed.states.append(self._project(self.audio_patch_proj, rows, dtype))
        packed.table_rows.extend([audio_row + AUDIO_TAG] * expected)

    def _token_route(self, rows: int, video_start: int, latent_frames: int, latent_device):
        """TREAD (arXiv 2501.04765): a training forward skips a random share of clip rows
        between two blocks; those rows rejoin unchanged. Stills and inference never route."""
        if self._tread is None or latent_frames == 1 or not torch.is_grad_enabled():
            return None
        ratio, start, end = float(self._tread[0]), int(self._tread[1]), min(int(self._tread[2]), len(self.blocks))
        video_rows = rows - video_start
        if not (0.0 < ratio < 1.0 and 0 <= start < end) or video_rows <= 1:
            return None
        kept = max(1, round(video_rows * (1.0 - ratio)))
        chosen = torch.randperm(video_rows, device=latent_device)[:kept].sort().values + video_start
        return start, end, torch.cat((torch.arange(video_start, device=latent_device), chosen)), kept

    def _run_blocks(self, states, t_emb, segments, cos, sin, video_start, latent_frames):
        route = self._token_route(states.shape[0], video_start, latent_frames, states.device)
        checkpointed = self._gradient_checkpointing and torch.is_grad_enabled()
        full = None
        for index in range(len(self.blocks)):
            if route is not None and index == route[0]:
                full = (states, segments, cos, sin)
                kept = route[2]
                states, cos, sin = states[kept], cos[kept], sin[kept]
                segments = segments.truncate_last(route[3])
            if checkpointed:
                states = torch.utils.checkpoint.checkpoint(_run_block, self.blocks, index, self._swap_from,
                                                           states, t_emb, segments, cos, sin,
                                                           use_reentrant=False)
            else:
                states = _run_block(self.blocks, index, self._swap_from, states, t_emb, segments, cos, sin)
            if route is not None and index + 1 == route[1]:
                routed = states
                states, segments, cos, sin = full
                states = states.index_copy(0, route[2], routed)
                full = None
            if self._h2d_offloader is not None and index >= self._swap_from:
                self._h2d_offloader.submit_move_blocks_forward(index)
        return states
