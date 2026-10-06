from __future__ import annotations

import os
from pathlib import Path

import torch
from safetensors import safe_open
from safetensors.torch import load_file, save_file


def cache_conditioning(pipeline, samples: list[dict], device: str, cache: Path,
                       signature: str, architecture: str, method: str) -> list[dict[str, torch.Tensor]]:
    sana = architecture == "sana"
    flux = architecture.startswith("flux-1")
    flux2 = architecture.startswith("flux-2")
    z_image = architecture.startswith("z-image")
    embedding = method == "embedding"
    keys = (("mean",) if (sana or z_image or flux2) and embedding else ("mean", "std") if embedding
            else ("mean", "prompt") if flux2 else ("mean", "prompt", "mask") if sana or z_image
            else ("mean", "std", "prompt", "pooled"))
    if cache.is_file():
        with safe_open(cache, framework="pt") as saved:
            if saved.metadata().get("signature") != signature:
                raise ValueError("The training dataset or model changed. Start a new job.")
        tensors = load_file(str(cache))
        return [{key: tensors[f"{index}.{key}"] for key in keys} for index in range(len(samples))]
    encoders = [pipeline.text_encoder]
    if not sana and not z_image and not flux2:
        encoders.append(pipeline.text_encoder_2)
    if architecture == "stable-diffusion-3":
        encoders.append(pipeline.text_encoder_3)
    encoders = [encoder for encoder in encoders if encoder is not None]
    if not embedding:
        for encoder in encoders:
            encoder.requires_grad_(False)
            encoder.eval()
            encoder.to(device)
    pipeline.vae.requires_grad_(False)
    pipeline.vae.eval()
    pipeline.vae.to(device=device, dtype=torch.float32)
    encoded = []
    with torch.no_grad():
        for index, sample in enumerate(samples):
            pixels = torch.from_numpy(sample["pixels"]).permute(2, 0, 1).unsqueeze(0).to(device)
            if flux2:
                latent = pipeline._encode_vae_image(pixels, generator=None)
                tensors = {"mean": latent.detach().cpu().contiguous()}
                if not embedding:
                    from media_flux2_conditioning import encode_flux2_prompts

                    prompt = encode_flux2_prompts(pipeline, [sample["caption"]], device)
                    tensors["prompt"] = prompt.detach().cpu().contiguous()
            elif embedding and sana:
                tensors = {"mean": pipeline.vae.encode(pixels).latent.detach().cpu().contiguous()}
            elif embedding and z_image:
                tensors = {"mean": pipeline.vae.encode(pixels).latent_dist.mode().detach().cpu().contiguous()}
            elif embedding:
                distribution = pipeline.vae.encode(pixels).latent_dist
                tensors = {"mean": distribution.mean.detach().cpu().contiguous(),
                           "std": distribution.std.detach().cpu().contiguous()}
            elif sana:
                latent = pipeline.vae.encode(pixels).latent
                prompt, mask, _, _ = pipeline.encode_prompt(
                    prompt=sample["caption"], device=device, do_classifier_free_guidance=False,
                    max_sequence_length=300, complex_human_instruction=None,
                )
                tensors = {"mean": latent.detach().cpu().contiguous(),
                           "prompt": prompt.detach().cpu().contiguous(),
                           "mask": mask.detach().cpu().contiguous()}
            elif z_image:
                latent = pipeline.vae.encode(pixels).latent_dist.mode()
                prompts, _ = pipeline.encode_prompt(prompt=sample["caption"], device=device,
                                                     do_classifier_free_guidance=False, max_sequence_length=512)
                prompt = prompts[0]
                mask = torch.arange(512, device=prompt.device) < prompt.shape[0]
                padded = torch.nn.functional.pad(prompt, (0, 0, 0, 512 - prompt.shape[0]))
                tensors = {"mean": latent.detach().cpu().contiguous(),
                           "prompt": padded.unsqueeze(0).detach().cpu().contiguous(),
                           "mask": mask.unsqueeze(0).cpu().contiguous()}
            elif flux:
                distribution = pipeline.vae.encode(pixels).latent_dist
                prompt, pooled, _ = pipeline.encode_prompt(
                    prompt=sample["caption"], prompt_2=None, device=device, max_sequence_length=256,
                )
            else:
                distribution = pipeline.vae.encode(pixels).latent_dist
                prompt, _, pooled, _ = pipeline.encode_prompt(
                    prompt=sample["caption"], prompt_2=None, prompt_3=None,
                    device=device, do_classifier_free_guidance=False, max_sequence_length=256,
                )
            if not sana and not z_image and not flux2 and not embedding:
                tensors = {
                    "mean": distribution.mean.detach().cpu().contiguous(),
                    "std": distribution.std.detach().cpu().contiguous(),
                    "prompt": prompt.detach().cpu().contiguous(),
                    "pooled": pooled.detach().cpu().contiguous(),
                }
            if any(not torch.isfinite(tensor).all() for tensor in tensors.values()):
                raise ValueError(f"Image {index + 1} could not be encoded. Choose another image.")
            encoded.append(tensors)
            print(f"Preparing images: {index + 1}/{len(samples)}", flush=True)
    temporary = cache.with_suffix(".tmp")
    save_file({f"{index}.{key}": tensor for index, sample in enumerate(encoded)
               for key, tensor in sample.items()}, str(temporary), metadata={"signature": signature})
    os.replace(temporary, cache)
    return encoded
