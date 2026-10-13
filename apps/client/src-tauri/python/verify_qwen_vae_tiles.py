import argparse
import hashlib
import json
import os
from pathlib import Path
import time

import numpy as np
from PIL import Image


def verify(model: Path, vae_class_name: str, image_path: Path | None, latents_path: Path | None, output: Path) -> None:
    os.environ.update({"HIP_VISIBLE_DEVICES": "1", "HF_HUB_OFFLINE": "1", "MIOPEN_FIND_MODE": "2"})
    import torch
    import diffusers
    from diffusers.image_processor import VaeImageProcessor
    import media_diffusers_worker as worker

    output.mkdir(parents=True, exist_ok=False)
    worker._configure_amd_convolution_backend(torch, "cuda")
    vae_class = getattr(diffusers, vae_class_name)
    vae = vae_class.from_pretrained(
        str(model), subfolder="vae", dtype=torch.bfloat16, local_files_only=True,
    ).to("cuda")
    scale = vae.spatial_compression_ratio
    processor = VaeImageProcessor(vae_scale_factor=scale, vae_latent_channels=vae.config.z_dim)
    with torch.inference_mode():
        if latents_path is not None:
            from safetensors.torch import load_file

            latents = load_file(str(latents_path))["latents"].to("cuda", torch.bfloat16)
            source_path = latents_path
        else:
            with Image.open(image_path) as source:
                source = source.convert("RGBA" if vae_class_name == "AutoencoderKLQwenImage21" else "RGB").resize((896, 1120), Image.Resampling.LANCZOS)
                inputs = processor.preprocess(source, height=1120, width=896).unsqueeze(2).to("cuda", torch.bfloat16)
            vae.disable_tiling()
            latents = vae.encode(inputs).latent_dist.mode()
            del inputs
            source_path = image_path
        torch.cuda.empty_cache()
        records = []
        baseline = None
        for tile in (0, 256, 512, 1024, 1536):
            if tile:
                vae.enable_tiling(
                    tile_sample_min_height=tile, tile_sample_min_width=tile,
                    tile_sample_stride_height=tile * 3 // 4, tile_sample_stride_width=tile * 3 // 4,
                )
            else:
                vae.disable_tiling()
            torch.cuda.reset_peak_memory_stats()
            started = time.monotonic()
            decoded = vae.decode(latents, return_dict=False)[0][:, :, 0]
            if not torch.isfinite(decoded).all():
                raise ValueError(f"Non-finite decoded pixels with tile {tile}")
            pixels = processor.postprocess(decoded, output_type="pil")[0].convert("RGB")
            pixels.save(output / f"tile-{tile}.png")
            values = decoded.float().cpu().numpy()
            if baseline is None:
                baseline = values.copy()
            record = {
                "tile": tile, "stride": tile * 3 // 4 if tile else None,
                "seconds": time.monotonic() - started,
                "peakAllocatedBytes": torch.cuda.max_memory_allocated(),
                "meanAbsoluteErrorAgainstFullFrame": float(np.abs(values - baseline).mean()),
                "maxAbsoluteErrorAgainstFullFrame": float(np.abs(values - baseline).max()),
                "image": str(output / f"tile-{tile}.png"),
            }
            records.append(record)
            print(json.dumps(record), flush=True)
            del decoded, values, pixels
            torch.cuda.empty_cache()
        result = {
            "model": str(model), "source": str(source_path),
            "sourceSha256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
            "sourceKind": "generated-latents" if latents_path else "encoded-reference",
            "vaeClass": vae_class_name, "spatialCompressionRatio": scale,
            "dtype": "bfloat16", "canvas": [latents.shape[-1] * scale, latents.shape[-2] * scale], "sameLatents": True,
            "convolutionBackend": "native", "device": torch.cuda.get_device_name(),
            "records": records,
        }
        (output / "results.json").write_text(json.dumps(result, indent=2), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--vae-class", choices=("AutoencoderKLQwenImage", "AutoencoderKLQwenImage21"), required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--image", type=Path)
    source.add_argument("--latents", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    verify(arguments.model, arguments.vae_class, arguments.image, arguments.latents, arguments.output)
