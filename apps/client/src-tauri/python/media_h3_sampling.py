"""MiniMax-H3 student sampling adapted from DMAD (Apache-2.0).

Copyright 2026 the DMAD authors. Machdoch modifications: explicit sampling
contracts, step progress, finite-output checks, and video-worker integration.
See LICENSE-DMAD.txt and NOTICE-DMAD.txt.
"""

import torch

from media_h3_geometry import row_timesteps


def sigma_grid(steps, shift):
    sigma = torch.linspace(1, 0, steps + 1, dtype=torch.float32)
    return shift * sigma / (1 + (shift - 1) * sigma)


@torch.inference_mode()
def rollout(transformer, embeddings, layout, shape, geometry, settings, seed, device, progress):
    generator = torch.Generator(device="cpu").manual_seed(seed)
    noise = torch.randn(
        (1, geometry.video_latent_channels, shape["latent_frames"], shape["latent_height"], shape["latent_width"]),
        generator=generator, dtype=torch.float32,
    )
    _, patch_height, patch_width = geometry.patch_size
    video = noise.reshape(1, geometry.video_latent_channels, shape["latent_frames"], shape["latent_height"] // patch_height, patch_height, shape["latent_width"] // patch_width, patch_width)
    video = video.permute(0, 2, 3, 5, 1, 4, 6).reshape(shape["video_tokens"]).to(device)
    audio = torch.randn(shape["audio_tokens"], generator=generator, dtype=torch.float32).to(device)
    video_sigmas = sigma_grid(settings["steps"], settings["videoShift"])
    audio_sigmas = sigma_grid(settings["steps"], settings["audioShift"])
    for step in range(settings["steps"]):
        video_sigma, audio_sigma = video_sigmas[step].to(device), audio_sigmas[step].to(device)
        times, indices = row_timesteps(layout, video_sigma, audio_sigma)
        velocity = transformer(
            hidden_states=video, audio_hidden_states=audio, encoder_hidden_states=embeddings,
            timestep=times, timestep_indices=indices, token_tags=layout.token_tags,
            position_ids=layout.position_ids, video_indices=layout.video_indices,
            audio_indices=layout.audio_indices, text_indices=layout.text_indices, return_dict=False,
        )
        clean_video = video + video_sigma * velocity[0].float()
        clean_audio = audio + audio_sigma * velocity[1].float()
        if not torch.isfinite(clean_video).all() or not torch.isfinite(clean_audio).all():
            raise ValueError("MiniMax-H3 returned non-finite latents. Check the model and runtime precision.")
        next_video, next_audio = video_sigmas[step + 1].to(device), audio_sigmas[step + 1].to(device)
        if settings["sampler"] == "renoise":
            video_noise = torch.randn(clean_video.shape, generator=generator, dtype=torch.float32).to(device)
            audio_noise = torch.randn(clean_audio.shape, generator=generator, dtype=torch.float32).to(device)
            video = (1 - next_video) * clean_video + next_video * video_noise
            audio = (1 - next_audio) * clean_audio + next_audio * audio_noise
        elif settings["sampler"] == "euler":
            video_ratio, audio_ratio = next_video / video_sigma, next_audio / audio_sigma
            video = video_ratio * video + (1 - video_ratio) * clean_video
            audio = audio_ratio * audio + (1 - audio_ratio) * clean_audio
        else:
            raise ValueError("Unknown MiniMax-H3 student sampler")
        progress(step + 1, settings["steps"])
    return clean_video.cpu().to(torch.bfloat16), clean_audio.cpu().to(torch.bfloat16)


@torch.inference_mode()
def decode(vae, audio_vae, video, audio, shape, geometry, device):
    video_mean = torch.tensor(vae.config.latents_mean, device=device).view(1, -1, 1, 1, 1)
    video_std = torch.tensor(vae.config.latents_std, device=device).view(1, -1, 1, 1, 1)
    _, patch_height, patch_width = geometry.patch_size
    height, width = shape["latent_height"], shape["latent_width"]
    latents = video.float().to(device).reshape(shape["latent_frames"], height // patch_height, width // patch_width, geometry.video_latent_channels, patch_height, patch_width)
    latents = latents.permute(3, 0, 1, 4, 2, 5).reshape(1, geometry.video_latent_channels, shape["latent_frames"], height, width)
    pixels = vae.decode((latents * video_std + video_mean).to(next(vae.parameters()).dtype)).sample[0].float()
    if not torch.isfinite(pixels).all():
        raise ValueError("MiniMax-H3 returned non-finite pixels. Check the video VAE and runtime precision.")
    pixel_mean = torch.tensor((0.485, 0.456, 0.406), device=device).view(3, 1, 1, 1)
    pixel_std = torch.tensor((0.229, 0.224, 0.225), device=device).view(3, 1, 1, 1)
    frames = ((pixels * pixel_std + pixel_mean).clamp(0, 1) * 255).round().byte().cpu().permute(1, 2, 3, 0).numpy()
    audio_mean = torch.tensor(audio_vae.config.latents_mean, device=device).view(1, -1, 1)
    audio_std = torch.tensor(audio_vae.config.latents_std, device=device).view(1, -1, 1)
    latents = audio.float().to(device).reshape(2, -1, geometry.audio_latent_channels).permute(0, 2, 1)
    waveform = audio_vae.decode((latents * audio_std + audio_mean).to(next(audio_vae.parameters()).dtype)).sample[:, 0].float()
    if not torch.isfinite(waveform).all():
        raise ValueError("MiniMax-H3 returned non-finite audio. Check the audio VAE and runtime precision.")
    waveform = waveform.clamp(-1, 1).cpu().unsqueeze(0)
    return frames, waveform, 32000
