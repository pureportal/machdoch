import argparse
import hashlib
import json
import os
from pathlib import Path
import time

import numpy as np
from PIL import Image


def verify(request_path: Path, latents_path: Path, original_image: Path, output: Path) -> None:
    os.environ.update({"HIP_VISIBLE_DEVICES": "1", "HF_HUB_OFFLINE": "1", "MIOPEN_FIND_MODE": "2"})
    import torch
    from diffusers import AutoencoderKL
    from diffusers.image_processor import VaeImageProcessor
    from safetensors.torch import load_file
    import media_diffusers_worker as worker

    output.mkdir(parents=True, exist_ok=False)
    request = json.loads(request_path.read_text(encoding="utf-8"))
    worker._configure_amd_convolution_backend(torch, "cuda")
    vae = AutoencoderKL.from_single_file(
        request["model"]["path"], config=request["model"]["configPath"],
        subfolder="vae", torch_dtype=torch.float16, local_files_only=True,
    ).to("cuda")
    vae.disable_tiling()
    scale = 2 ** (len(vae.config.block_out_channels) - 1)
    processor = VaeImageProcessor(vae_scale_factor=scale)
    latents = load_file(str(latents_path))["latents"]
    with Image.open(original_image) as source:
        original_pixels = np.asarray(source.convert("RGB"), dtype=np.int16)
    records = []
    with torch.inference_mode():
        for device, dtype in (("cuda", torch.float16), ("cuda", torch.float32), ("cpu", torch.float32)):
            vae.to(device=device, dtype=dtype)
            torch.cuda.empty_cache()
            torch.cuda.reset_peak_memory_stats()
            started = time.monotonic()
            decoded = vae.decode(latents.to(device, dtype), return_dict=False)[0]
            if not torch.isfinite(decoded).all():
                raise ValueError(f"Non-finite decoded pixels with {dtype}")
            image = processor.postprocess(decoded, output_type="pil")[0]
            image_path = output / f"{device}-{str(dtype).removeprefix('torch.')}.png"
            image.save(image_path)
            difference = np.abs(np.asarray(image.convert("RGB"), dtype=np.int16) - original_pixels)
            record = {
                "device": device, "dtype": str(dtype), "image": str(image_path),
                "sha256": hashlib.sha256(image_path.read_bytes()).hexdigest(),
                "seconds": time.monotonic() - started,
                "peakAllocatedBytes": torch.cuda.max_memory_allocated(),
                "meanAbsolutePixelErrorAgainstOriginal": float(difference.mean()),
                "maxAbsolutePixelErrorAgainstOriginal": int(difference.max()),
            }
            records.append(record)
            print(json.dumps(record), flush=True)
            del decoded, image, difference
    result = {
        "request": str(request_path), "latents": str(latents_path),
        "latentsSha256": hashlib.sha256(latents_path.read_bytes()).hexdigest(),
        "originalImage": str(original_image), "sameLatents": True,
        "device": torch.cuda.get_device_name(), "convolutionBackend": "native",
        "records": records,
    }
    (output / "results.json").write_text(json.dumps(result, indent=2), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--latents", type=Path, required=True)
    parser.add_argument("--original-image", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    verify(arguments.request, arguments.latents, arguments.original_image, arguments.output)
