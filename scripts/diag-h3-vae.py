import gc
from pathlib import Path
import sys

import numpy as np
from PIL import Image
import torch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps/client/src-tauri/python"))

from fizgig.minimax.reference import reference_to_tensor, resize_reference
from fizgig.minimax.vae import MiniMaxH3VideoVAEDecoder, MiniMaxH3VideoVAEEncoder
from media_minimax_h3 import load_video_vae


REFERENCE = ROOT / "assets/media/h3-style-tests/anime-reference.png"
VAE = ROOT / "models/minimax-h3-ref2va/vae/minimax_h3_video_vae_fp16.safetensors"
OUTPUT = ROOT / "assets/media/h3-style-tests"
SIZES = [(640, 384)]


def main():
    encoder = load_video_vae(VAE, MiniMaxH3VideoVAEEncoder)
    latents = []
    with torch.no_grad(), torch.autocast("cuda", dtype=torch.float16):
        for width, height in SIZES:
            image = resize_reference(Image.open(REFERENCE), width, height)
            latent = encoder.encode(reference_to_tensor(image).to("cuda", torch.float16)).float().cpu()
            print("latent", latent.mean().item(), latent.std().item(), latent.amin().item(), latent.amax().item(), flush=True)
            latents.append(latent)
    del encoder
    gc.collect()
    torch.cuda.empty_cache()

    decoder = load_video_vae(VAE, MiniMaxH3VideoVAEDecoder)
    with torch.no_grad(), torch.autocast("cuda", dtype=torch.float16):
        for (width, height), latent in zip(SIZES, latents):
            print("decoder weight", decoder.post_quant_conv.weight.float().std().item(), flush=True)
            frame = decoder.decode(latent.to("cuda"))[0].float().cpu()
            pixels = (frame.clamp(0, 1).permute(1, 2, 0).numpy() * 255).astype(np.uint8)
            variation = np.abs(pixels[:, 16:].astype(np.int16) - pixels[:, :-16].astype(np.int16)).mean()
            path = OUTPUT / f"vae-still-{width}x{height}.png"
            Image.fromarray(pixels).save(path)
            print(width, height, round(float(variation), 2), path, flush=True)


if __name__ == "__main__":
    main()
