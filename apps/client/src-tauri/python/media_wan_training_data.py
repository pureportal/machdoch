from __future__ import annotations

import os
from pathlib import Path

import torch
from safetensors import safe_open
from safetensors.torch import load_file, save_file

from media_training_video_data import decode_video
from media_wan_conditioning import encode_prompts, normalize_latents


def cache_conditioning(pipeline, samples, specification, device, cache: Path, signature: str):
    embedding = specification["method"] == "embedding"
    keys = ["mean"] + ([] if embedding else ["prompt"])
    if cache.is_file():
        with safe_open(str(cache), framework="pt") as saved:
            if (saved.metadata() or {}).get("signature") != signature:
                raise ValueError("The training dataset or model changed. Start a new job.")
        tensors = load_file(str(cache))
        return [{key: tensors[f"{index}.{key}"] for key in keys} for index in range(len(samples))]
    pipeline.vae.requires_grad_(False).eval().to(device=device, dtype=torch.float32)
    pipeline.vae.enable_tiling()
    pipeline.text_encoder.eval().to("cpu")
    encoded = []
    video = specification["video"]
    expected_shape = (1, pipeline.vae.config.z_dim, (video["frames"] - 1) // pipeline.vae_scale_factor_temporal + 1,
                      video["height"] // pipeline.vae_scale_factor_spatial,
                      video["width"] // pipeline.vae_scale_factor_spatial)
    with torch.no_grad():
        for index, sample in enumerate(samples):
            pixels = decode_video(sample["path"], video).to(device)
            latents = normalize_latents(pipeline, pipeline.vae.encode(pixels).latent_dist.mode())
            if tuple(latents.shape) != expected_shape:
                raise ValueError("The VAE returned a different video canvas. Check the model and video dimensions.")
            if not torch.isfinite(latents).all():
                raise ValueError(f"Video {index + 1} could not be encoded. Choose another video.")
            encoded.append({"mean": latents.cpu().contiguous()})
            print(f"Preparing videos: {index + 1}/{len(samples)}", flush=True)
    pipeline.vae.to("cpu")
    if device == "cuda":
        torch.cuda.empty_cache()
    if not embedding:
        pipeline.text_encoder.requires_grad_(False).eval().to(device)
        with torch.no_grad():
            for sample, tensors in zip(samples, encoded):
                tensors["prompt"] = encode_prompts(pipeline, [sample["caption"]], device).cpu().contiguous()
    pipeline.text_encoder.to("cpu")
    temporary = cache.with_suffix(".tmp")
    save_file({f"{index}.{key}": tensor for index, sample in enumerate(encoded) for key, tensor in sample.items()},
              str(temporary), metadata={"signature": signature})
    os.replace(temporary, cache)
    return encoded
