"""MiniMax H3 sampling: joint video and soundtrack denoising.

Both streams take the same number of steps over their own shifted rectified-flow schedules
(video ``shift``, audio 3.0) at shared base positions, as the MiniMax-H3 reference pipeline
does. Updates are written in data-prediction form, ``x' = r * x + (1 - r) * x0`` with
``r = sigma' / sigma``, which is exact for a constant clean estimate. ``dpmpp_2m`` adds the
second-order multistep correction of DPM-Solver++ (Lu et al., arXiv:2211.01095) in the
flow log-SNR ``log((1 - sigma) / sigma)``.
"""

import gc
import math
import time

import torch

from .layout import (
    AUDIO_CHANNELS,
    VIDEO_SIGMA_SHIFT,
    audio_latents_for_pixels,
    audio_sigma,
    latent_frames_for_pixels,
    pixel_frames_for_latents,
    shift_sigma,
)

SAMPLERS = ("euler", "dpmpp_2m")


class PreviewAborted(RuntimeError):
    """Raised when the step callback asks sampling to stop."""


def sampling_geometry(width: int, height: int, *, spatial: int = 16) -> tuple[int, int]:
    """Validate pixel dimensions and return the latent ``(height, width)``."""
    dimensions = {"width": width, "height": height}
    if any(not isinstance(value, int) or isinstance(value, bool) or value <= 0
           for value in dimensions.values()):
        raise ValueError("sampling width and height must be positive integers")
    if not isinstance(spatial, int) or isinstance(spatial, bool) or spatial <= 0:
        raise ValueError("sampling spatial scale must be a positive integer")
    grid = spatial * 2
    undersized = [f"{name}={value}" for name, value in dimensions.items() if value < grid]
    if undersized:
        raise ValueError(f"sampling dimensions must be at least {grid}px; {', '.join(undersized)} "
                         "would produce a zero-sized latent grid")
    misaligned = [f"{name}={value}" for name, value in dimensions.items() if value % grid]
    if misaligned:
        raise ValueError(f"sampling dimensions must be multiples of {grid}px; got {', '.join(misaligned)}")
    return height // spatial, width // spatial


def sigma_schedule(steps: int, shift: float = VIDEO_SIGMA_SHIFT) -> list[float]:
    """``steps + 1`` descending sigmas from 1 to 0 on the shifted grid: ``steps`` evaluations."""
    if not isinstance(steps, int) or isinstance(steps, bool) or steps < 1:
        raise ValueError("sampling needs at least one step")
    if shift <= 0:
        raise ValueError("sigma shift must be positive")
    sigmas = []
    for index in range(steps + 1):
        sigma = shift_sigma(1.0 - index / steps, shift)
        if not sigmas or sigma < sigmas[-1]:
            sigmas.append(sigma)
    return sigmas


def _log_snr(sigma: float) -> float:
    return -math.inf if sigma >= 1.0 else math.log((1.0 - sigma) / sigma)


class FlowStream:
    """One latent stream stepped down its own sigma schedule."""

    def __init__(self, latent: torch.Tensor, sigmas: list[float], sampler: str):
        self.latent = latent
        self.sigmas = sigmas
        self.second_order = sampler == "dpmpp_2m"
        self.previous_estimate = None
        self.previous_step = None

    def estimate(self, step: int, prediction: torch.Tensor) -> torch.Tensor:
        return self.latent + self.sigmas[step] * prediction.float()

    def advance(self, step: int, estimate: torch.Tensor):
        sigma, sigma_next = self.sigmas[step], self.sigmas[step + 1]
        target = estimate
        if sigma_next == 0.0:
            self.latent = estimate
            return
        current_step = _log_snr(sigma_next) - _log_snr(sigma)
        if self.second_order and self.previous_estimate is not None:
            weight = current_step / (2.0 * self.previous_step)
            target = (1.0 + weight) * estimate - weight * self.previous_estimate
        ratio = sigma_next / sigma
        self.latent = ratio * self.latent + (1.0 - ratio) * target
        self.previous_estimate = estimate
        self.previous_step = current_step


def _resolve_keyframes(keyframes, pixel_frames: int, device):
    return [(min(int(index), pixel_frames - 1), latent.to(device=device, dtype=torch.float32))
            for index, latent in keyframes or ()]


@torch.no_grad()
def sample_image(model, text_embeds, *, width=512, height=512, num_frames: int = 1, steps: int = 8,
                 shift: float = VIDEO_SIGMA_SHIFT, sampler: str = "dpmpp_2m", cfg_scale: float = 1.0,
                 uncond_embeds=None, seed: int = 0, device="cuda", dtype=torch.bfloat16,
                 latent_channels: int = 24, spatial: int = 16, log_steps: bool = False, ref_latents=None,
                 ref_schedule=None, text_token_tags=None, keyframes=None, exact_frames: bool = False,
                 on_denoised=None, on_slow_step=None, slow_step_s: float = 120.0, return_audio: bool = False):
    """Denoise one still or clip and return its latent ``[1, C, T, H/16, W/16]``.

    ``num_frames`` counts pixel frames and snaps down onto the 17n+5 grid unless
    ``exact_frames`` keeps a count on the latent token grid. ``steps`` counts model
    evaluations; ``cfg_scale > 1`` with ``uncond_embeds`` doubles them.

    ``ref_schedule(step, steps, sigma)`` replaces ``ref_latents`` per evaluation. Keyframes
    ``[(pixel_frame_index, latent)]`` anchor frames of the clip; indices past the end clamp
    to the last frame.

    ``on_denoised(step, steps, x0)`` receives each clean video estimate. ``on_slow_step(seconds,
    step, steps)`` fires once when a step exceeds ``slow_step_s`` (every step when it is not
    positive); returning ``True`` raises :class:`PreviewAborted`. Callback exceptions propagate.

    With ``return_audio`` the result is ``(video, audio_rows)``; stills carry no soundtrack.
    """
    if sampler not in SAMPLERS:
        raise ValueError(f"unsupported sampler {sampler!r}; expected one of {', '.join(SAMPLERS)}")
    latent_height, latent_width = sampling_geometry(width, height, spatial=spatial)
    latent_frames = latent_frames_for_pixels(int(num_frames), exact=exact_frames)
    pixel_frames = pixel_frames_for_latents(latent_frames)
    video_sigmas = sigma_schedule(steps, shift)
    audio_sigmas = [float(audio_sigma(sigma, shift)) for sigma in video_sigmas]
    generator = torch.Generator(device="cpu").manual_seed(int(seed))
    video = FlowStream(torch.randn(1, latent_channels, latent_frames, latent_height, latent_width,
                                   generator=generator).to(device), video_sigmas, sampler)
    audio = FlowStream(torch.randn(audio_latents_for_pixels(pixel_frames) * AUDIO_CHANNELS,
                                   model.config.audio_latents_dim, generator=generator).to(device),
                       audio_sigmas, sampler)

    conditioning = {}
    if text_token_tags is not None:
        conditioning["text_token_tags"] = text_token_tags
    if keyframes:
        conditioning["keyframes"] = _resolve_keyframes(keyframes, pixel_frames, device)
    if ref_latents or ref_schedule is not None:
        conditioning["ref_latents"] = ref_latents
        conditioning["seed"] = int(seed)
    guided = cfg_scale > 1.0 and uncond_embeds is not None
    evaluations = len(video_sigmas) - 1
    slow_reported = False
    previous_start = None
    for step in range(evaluations):
        started = time.monotonic()
        if log_steps:
            elapsed = f"  ({started - previous_start:.1f}s)" if previous_start is not None else ""
            print(f"[preview] step {step + 1}/{evaluations}  sigma {video_sigmas[step]:.4f} -> "
                  f"{video_sigmas[step + 1]:.4f}{elapsed}", flush=True)
            previous_start = started
        if ref_schedule is not None:
            conditioning["ref_latents"] = ref_schedule(step, evaluations, float(video_sigmas[step]))
        inputs = dict(audio_rows=audio.latent.to(dtype), audio_t=1.0 - audio_sigmas[step], return_audio=True)
        timestep = torch.tensor([1.0 - video_sigmas[step]], device=device)
        video_prediction, audio_prediction = model(video.latent.to(dtype), timestep, text_embeds,
                                                   **inputs, **conditioning)
        video_prediction, audio_prediction = video_prediction.float(), audio_prediction.float()
        if guided:
            unconditional = {key: value for key, value in conditioning.items() if key != "text_token_tags"}
            video_base, audio_base = model(video.latent.to(dtype), timestep, uncond_embeds,
                                           **inputs, **unconditional)
            video_prediction = torch.lerp(video_base.float(), video_prediction, cfg_scale)
            audio_prediction = torch.lerp(audio_base.float(), audio_prediction, cfg_scale)
        video_estimate = video.estimate(step, video_prediction)
        audio_estimate = audio.estimate(step, audio_prediction)
        if on_denoised is not None:
            on_denoised(step + 1, evaluations, video_estimate)
        video.advance(step, video_estimate)
        audio.advance(step, audio_estimate)
        if on_slow_step is not None and (slow_step_s <= 0 or not slow_reported):
            duration = time.monotonic() - started
            if duration > slow_step_s:
                slow_reported = True
                if on_slow_step(duration, step + 1, evaluations):
                    raise PreviewAborted(f"step {step + 1}/{evaluations} took {duration:.0f}s")
    if not return_audio:
        return video.latent
    return video.latent, (audio.latent if latent_frames > 1 else None)


def encode_sample_prompts(te_path, prompts, *, device="cuda", quantize=True):
    """Encode preview prompts to CPU tensors and release the text encoder before the DiT loads."""
    from .embedder import load_minimax_h3_te_planned
    encoder = load_minimax_h3_te_planned(te_path, device=device, compute_dtype=torch.bfloat16, quantize=quantize)
    encoded = [encoder.encode(prompt).cpu() for prompt in prompts]
    del encoder
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return encoded
