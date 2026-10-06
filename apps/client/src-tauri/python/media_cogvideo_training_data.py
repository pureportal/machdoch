from __future__ import annotations

import os
from pathlib import Path

import torch
from safetensors import safe_open
from safetensors.torch import load_file, save_file

from media_cogvideo_conditioning import enable_vae_tiling, encode_prompts
from media_training_video_data import decode_video


def cache_conditioning(pipeline, samples, specification, device, cache: Path, signature: str):
    embedding = specification["method"] == "embedding"
    image_conditioned = specification["architecture"].endswith("-i2v")
    keys = ["mean", "std"] + ([] if embedding else ["prompt"]) + (["image_mean", "image_std"] if image_conditioned else [])
    if cache.is_file():
        with safe_open(str(cache), framework="pt") as saved:
            if (saved.metadata() or {}).get("signature") != signature:
                raise ValueError("The training dataset or model changed. Start a new job.")
        tensors = load_file(str(cache))
        return [{key: tensors[f"{index}.{key}"] for key in keys} for index in range(len(samples))]
    pipeline.vae.requires_grad_(False).eval().to(device=device, dtype=torch.float32)
    enable_vae_tiling(pipeline)
    pipeline.text_encoder.eval().to("cpu")
    generator = torch.Generator(device=device if device == "cuda" else "cpu").manual_seed(specification["seed"])
    encoded = []
    with torch.no_grad():
        for index, sample in enumerate(samples):
            pixels = decode_video(sample["path"], specification["video"]).to(device)
            distribution = pipeline.vae.encode(pixels).latent_dist
            tensors = {"mean": distribution.mean.cpu().contiguous(), "std": distribution.std.cpu().contiguous()}
            expected_shape = (1, pipeline.vae.config.latent_channels,
                              (specification["video"]["frames"] - 1) // pipeline.vae_scale_factor_temporal + 1,
                              specification["video"]["height"] // pipeline.vae_scale_factor_spatial,
                              specification["video"]["width"] // pipeline.vae_scale_factor_spatial)
            if tuple(tensors["mean"].shape) != expected_shape:
                raise ValueError("The VAE returned a different video canvas. Check the model and video dimensions.")
            if image_conditioned:
                image = pixels[:, :, :1]
                sigma = (torch.randn((1,), generator=generator, device=generator.device) * 0.5 - 3).exp().to(device)
                noise = torch.randn(image.shape, generator=generator, device=generator.device).to(device)
                distribution = pipeline.vae.encode(image + noise * sigma.reshape(1, 1, 1, 1, 1)).latent_dist
                tensors.update(image_mean=distribution.mean.cpu().contiguous(), image_std=distribution.std.cpu().contiguous())
            if any(not torch.isfinite(tensor).all() for tensor in tensors.values()):
                raise ValueError(f"Video {index + 1} could not be encoded. Choose another video.")
            encoded.append(tensors)
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
