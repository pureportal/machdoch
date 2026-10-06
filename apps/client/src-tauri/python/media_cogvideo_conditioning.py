from __future__ import annotations

import torch

from media_embedding_prompts import expand_embedding_prompt


ARCHITECTURES = ("cogvideox-2b", "cogvideox-1.5-5b", "cogvideox-1.5-5b-i2v")


def enable_vae_tiling(pipeline):
    alignment = pipeline.vae_scale_factor_spatial * 4
    tile_height = max(alignment, pipeline.vae.tile_sample_min_height // alignment * alignment)
    tile_width = max(alignment, pipeline.vae.tile_sample_min_width // alignment * alignment)
    pipeline.vae.enable_tiling(tile_sample_min_height=tile_height, tile_sample_min_width=tile_width,
                               tile_overlap_factor_height=0.25, tile_overlap_factor_width=0.25)


def encode_prompts(pipeline, captions: list[str], device, required_tokens: tuple[str, ...] = ()):
    tokenizer = pipeline.tokenizer
    maximum = pipeline.transformer.config.max_text_seq_length
    prompts = [expand_embedding_prompt(caption, tokenizer) for caption in captions]
    inputs = tokenizer(prompts, padding="max_length", max_length=maximum,
                       truncation=True, add_special_tokens=True, return_tensors="pt").input_ids.to(device)
    for token in required_tokens:
        token_id = tokenizer.convert_tokens_to_ids(token)
        if not (inputs == token_id).any(dim=1).all():
            raise ValueError("A caption truncates the embedding token. Shorten the caption or put the token first.")
    return pipeline.text_encoder(inputs)[0].to(dtype=pipeline.transformer.dtype)


def pad_latent_frames(latents, patch_size_t):
    if patch_size_t is None:
        return latents
    padding = (-latents.shape[1]) % patch_size_t
    return torch.cat((latents[:, :1].expand(-1, padding, -1, -1, -1), latents), dim=1)


def training_loss(scheduler, prediction, noisy, clean, timesteps):
    predicted_clean = scheduler.get_velocity(prediction.float(), noisy.float(), timesteps)
    alpha = scheduler.alphas_cumprod.to(device=clean.device)[timesteps]
    weights = 1 / (1 - alpha)
    error = (predicted_clean - clean.float()).square()
    return (error * weights.reshape(-1, 1, 1, 1, 1)).flatten(1).mean(1).mean()


@torch.no_grad()
def embedding_arguments(pipeline, prompt, negative_prompt, device, guidance):
    arguments = {"prompt": None, "prompt_embeds": encode_prompts(pipeline, [prompt], device)}
    if guidance > 1:
        arguments.update(negative_prompt=None,
                         negative_prompt_embeds=encode_prompts(pipeline, [negative_prompt], device))
    return arguments
