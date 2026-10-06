from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageOps


def read_dataset(directory: Path, resolution: int, preserve_aspect_ratio: bool = False) -> list[dict[str, Any]]:
    samples = []
    for line in (directory / "metadata.jsonl").read_text(encoding="utf-8").splitlines():
        record = json.loads(line)
        path = (directory / record["file_name"]).resolve()
        if path.parent != directory.resolve():
            raise ValueError("Training images must be inside the dataset folder.")
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
            width, height = image.size
            target_width, target_height = resolution, resolution
            if preserve_aspect_ratio:
                ratio = min(2.0, max(0.5, width / height))
                target_width = max(64, round(resolution * math.sqrt(ratio) / 64) * 64)
                target_height = max(64, round(resolution / math.sqrt(ratio) / 64) * 64)
            scale = max(target_width / width, target_height / height)
            resized = image.resize(
                (round(width * scale), round(height * scale)), Image.Resampling.LANCZOS
            )
            left = (resized.width - target_width) // 2
            top = (resized.height - target_height) // 2
            cropped = resized.crop((left, top, left + target_width, top + target_height))
        samples.append(
            {
                "pixels": np.array(cropped, dtype=np.float32) / 127.5 - 1,
                "caption": record["text"],
                "time_ids": [height, width, top, left, target_height, target_width],
                "digest": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
        )
    if not 3 <= len(samples) <= 50:
        raise ValueError("Choose 3 to 50 images.")
    return samples


def dataset_signature(specification: dict, samples: list[dict[str, Any]]) -> str:
    identity = {
        "version": 3,
        "model": specification["model"],
        "precision": specification["precision"],
        "resolution": specification["resolution"],
        "preserve_aspect_ratio": specification["preserve_aspect_ratio"],
        "method": specification["method"],
        "samples": [
            {key: sample[key] for key in ("caption", "time_ids", "digest")}
            for sample in samples
        ],
    }
    return hashlib.sha256(
        json.dumps(identity, sort_keys=True).encode("utf-8")
    ).hexdigest()


def cache_conditioning(
    pipeline: Any, samples: list[dict], device: str, cache: Path, signature: str, embedding_training: bool
) -> list[dict]:
    import torch
    from safetensors import safe_open
    from safetensors.torch import load_file, save_file
    from media_training_embeddings import encode_captions

    if cache.is_file():
        with safe_open(cache, framework="pt") as saved:
            if saved.metadata().get("signature") != signature:
                raise ValueError(
                    "The training dataset or model changed. Start a new job."
                )
        tensors = load_file(str(cache))
        return [
            {
                key: tensors[f"{index}.{key}"]
                for key in ("mean", "std", "time_ids") + (() if embedding_training else ("prompt", "pooled"))
            }
            for index in range(len(samples))
        ]
    encoders = [pipeline.text_encoder]
    if hasattr(pipeline, "text_encoder_2"):
        encoders.append(pipeline.text_encoder_2)
    for component in [pipeline.vae] + ([] if embedding_training else encoders):
        component.requires_grad_(False)
        component.eval()
    pipeline.vae.to(device=device, dtype=torch.float32)
    for encoder in encoders:
        encoder.to(device)
    encoded = []
    with torch.no_grad():
        for index, sample in enumerate(samples):
            pixels = (
                torch.from_numpy(sample["pixels"])
                .permute(2, 0, 1)
                .unsqueeze(0)
                .to(device)
            )
            distribution = pipeline.vae.encode(pixels).latent_dist
            if not embedding_training:
                prompt, pooled = encode_captions(pipeline, [sample["caption"]], device, len(encoders) == 2)
            tensors = {
                "mean": distribution.mean.detach().cpu().contiguous(),
                "std": distribution.std.detach().cpu().contiguous(),
                "time_ids": torch.tensor([sample["time_ids"]], dtype=torch.float32),
            }
            if not embedding_training:
                tensors["prompt"] = prompt.detach().cpu().contiguous()
                tensors["pooled"] = (pooled.detach().cpu().contiguous() if pooled is not None
                                     else torch.empty(0))
            if any(not torch.isfinite(tensor).all() for tensor in tensors.values()):
                raise ValueError(
                    f"Image {index + 1} could not be encoded. Choose another image."
                )
            encoded.append(tensors)
            print(f"Preparing images: {index + 1}/{len(samples)}", flush=True)
    temporary = cache.with_suffix(".tmp")
    save_file(
        {
            f"{index}.{key}": tensor
            for index, sample in enumerate(encoded)
            for key, tensor in sample.items()
        },
        str(temporary),
        metadata={"signature": signature},
    )
    os.replace(temporary, cache)
    return encoded

