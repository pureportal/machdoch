from __future__ import annotations

import gc
import hashlib
import json
import math
import os
import shutil
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageOps


def read_dataset(directory: Path, resolution: int) -> list[dict[str, Any]]:
    samples = []
    for line in (directory / "metadata.jsonl").read_text(encoding="utf-8").splitlines():
        record = json.loads(line)
        path = (directory / record["file_name"]).resolve()
        if path.parent != directory.resolve():
            raise ValueError("Training images must be inside the dataset folder.")
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
            width, height = image.size
            scale = resolution / min(width, height)
            resized = image.resize(
                (round(width * scale), round(height * scale)), Image.Resampling.LANCZOS
            )
            left = (resized.width - resolution) // 2
            top = (resized.height - resolution) // 2
            cropped = resized.crop((left, top, left + resolution, top + resolution))
        samples.append(
            {
                "pixels": np.array(cropped, dtype=np.float32) / 127.5 - 1,
                "caption": record["text"],
                "time_ids": [height, width, top, left, resolution, resolution],
                "digest": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
        )
    if not 3 <= len(samples) <= 50:
        raise ValueError("Choose 3 to 50 images.")
    return samples


def dataset_signature(specification: dict, samples: list[dict[str, Any]]) -> str:
    identity = {
        "version": 2,
        "model": specification["model"],
        "precision": specification["precision"],
        "resolution": specification["resolution"],
        "samples": [
            {key: sample[key] for key in ("caption", "time_ids", "digest")}
            for sample in samples
        ],
    }
    return hashlib.sha256(
        json.dumps(identity, sort_keys=True).encode("utf-8")
    ).hexdigest()


def cache_conditioning(
    pipeline: Any, samples: list[dict], device: str, cache: Path, signature: str
) -> list[dict]:
    import torch
    from safetensors import safe_open
    from safetensors.torch import load_file, save_file

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
                for key in ("mean", "std", "prompt", "pooled", "time_ids")
            }
            for index in range(len(samples))
        ]
    for component in (pipeline.vae, pipeline.text_encoder, pipeline.text_encoder_2):
        component.requires_grad_(False)
        component.eval()
    pipeline.vae.to(device=device, dtype=torch.float32)
    pipeline.text_encoder.to(device)
    pipeline.text_encoder_2.to(device)
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
            prompt, _, pooled, _ = pipeline.encode_prompt(
                sample["caption"], device=device, do_classifier_free_guidance=False
            )
            tensors = {
                "mean": distribution.mean.detach().cpu().contiguous(),
                "std": distribution.std.detach().cpu().contiguous(),
                "prompt": prompt.detach().cpu().contiguous(),
                "pooled": pooled.detach().cpu().contiguous(),
                "time_ids": torch.tensor([sample["time_ids"]], dtype=prompt.dtype),
            }
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


def checkpoints(output: Path) -> list[Path]:
    return sorted(
        (
            path
            for path in output.glob("checkpoint-*")
            if path.is_dir()
            and path.name[11:].isdigit()
            and (path / "state.pt").is_file()
        ),
        key=lambda path: int(path.name[11:]),
    )


def save_checkpoint(
    output: Path,
    step: int,
    unet: Any,
    optimizer: Any,
    scaler: Any,
    generator: Any,
    device: str,
    signature: str,
    settings: dict,
) -> None:
    import torch
    from peft.utils import get_peft_model_state_dict
    from safetensors.torch import save_file

    temporary = output / f".checkpoint-{step}-{os.getpid()}"
    temporary.mkdir()
    weights = {
        key: value.detach().cpu().contiguous()
        for key, value in get_peft_model_state_dict(unet).items()
    }
    save_file(weights, str(temporary / "adapter.safetensors"))
    device_rng = (
        torch.cuda.get_rng_state()
        if device == "cuda"
        else torch.mps.get_rng_state() if device == "mps" else None
    )
    torch.save(
        {
            "step": step,
            "optimizer": optimizer.state_dict(),
            "scaler": scaler.state_dict(),
            "generator": generator.get_state(),
            "torch_rng": torch.get_rng_state(),
            "device_rng": device_rng,
            "signature": signature,
            "settings": settings,
        },
        temporary / "state.pt",
    )
    os.replace(temporary, output / f"checkpoint-{step}")
    for old in checkpoints(output)[:-2]:
        if old.resolve().parent != output.resolve():
            raise ValueError("The checkpoint folder is outside the training job.")
        shutil.rmtree(old)


def restore_checkpoint(
    output: Path,
    unet: Any,
    optimizer: Any,
    scaler: Any,
    generator: Any,
    device: str,
    signature: str,
    settings: dict,
) -> int:
    import torch
    from peft.utils import set_peft_model_state_dict
    from safetensors.torch import load_file

    available = checkpoints(output)
    if not available:
        raise ValueError("No saved checkpoint is available to resume.")
    latest = available[-1]
    state = torch.load(latest / "state.pt", map_location="cpu", weights_only=True)
    if state["signature"] != signature or state["settings"] != settings:
        raise ValueError(
            "The training dataset, model, or settings changed. Start a new job."
        )
    set_peft_model_state_dict(unet, load_file(str(latest / "adapter.safetensors")))
    optimizer.load_state_dict(state["optimizer"])
    scaler.load_state_dict(state["scaler"])
    generator.set_state(state["generator"])
    torch.set_rng_state(state["torch_rng"])
    if device == "cuda":
        torch.cuda.set_rng_state(state["device_rng"])
    elif device == "mps":
        torch.mps.set_rng_state(state["device_rng"])
    return state["step"]


def noise_target(scheduler: Any, latents: Any, noise: Any, timesteps: Any) -> Any:
    if scheduler.config.prediction_type == "epsilon":
        return noise
    if scheduler.config.prediction_type == "v_prediction":
        return scheduler.get_velocity(latents, noise, timesteps)
    raise ValueError("This SDXL scheduler does not support LoRA training.")


def validate_settings(specification: dict) -> None:
    if (
        specification["architecture"] != "stable-diffusion-xl"
        or specification["model"]["architecture"] != "stable-diffusion-xl"
    ):
        raise ValueError("Choose an SDXL model for this trainer.")
    if specification["four_bit"] or not specification["attention_only"]:
        raise ValueError(
            "SDXL LoRA trains attention layers with unquantized base weights."
        )
    if specification["precision"] not in ("bf16", "fp16"):
        raise ValueError("Choose BF16 or FP16 training precision.")
    if (
        type(specification["steps"]) is not int
        or not 1 <= specification["steps"] <= 10000
    ):
        raise ValueError("Choose 1 to 10000 training steps.")
    if specification["resolution"] not in (512, 768, 1024) or specification[
        "rank"
    ] not in (4, 8, 16, 32, 64):
        raise ValueError("Check the training resolution and rank.")
    if (
        not math.isfinite(specification["learning_rate"])
        or not 0.00001 <= specification["learning_rate"] <= 0.001
    ):
        raise ValueError("Choose a learning rate from 0.00001 to 0.001.")
    if (
        type(specification["seed"]) is not int
        or not 0 <= specification["seed"] <= 4294967295
    ):
        raise ValueError("Choose a seed from 0 to 4294967295.")
    if (
        type(specification["checkpoint_interval"]) is not int
        or not 1 <= specification["checkpoint_interval"] <= specification["steps"]
    ):
        raise ValueError("Check the checkpoint interval.")


def train(specification: dict, directory: Path) -> None:
    import torch
    import diffusers
    from peft import LoraConfig
    from peft.utils import get_peft_model_state_dict
    import media_diffusers_worker as worker

    validate_settings(specification)
    device, device_name, _ = worker._device(torch)
    if device not in ("cuda", "mps"):
        raise ValueError("SDXL training requires a supported GPU.")
    worker._configure_amd_convolution_backend(torch, device)
    dtype = torch.bfloat16 if specification["precision"] == "bf16" else torch.float16
    torch.manual_seed(specification["seed"])
    pipeline = worker._load_pipeline(
        diffusers, torch, specification["model"], torch_dtype=dtype
    )
    unet = pipeline.unet
    unet.requires_grad_(False)
    samples = read_dataset(directory / "dataset", specification["resolution"])
    signature = dataset_signature(specification, samples)
    encoded = cache_conditioning(
        pipeline, samples, device, directory / "conditioning.safetensors", signature
    )
    scheduler = diffusers.DDPMScheduler.from_config(pipeline.scheduler.config)
    latent_scale = pipeline.vae.config.scaling_factor
    del pipeline, samples
    gc.collect()
    if device == "cuda":
        torch.cuda.empty_cache()
    else:
        torch.mps.empty_cache()
    unet.to(device=device, dtype=dtype)
    adapter = LoraConfig(
        r=specification["rank"],
        lora_alpha=specification["rank"],
        init_lora_weights="gaussian",
        target_modules=["to_q", "to_k", "to_v", "to_out.0"],
    )
    unet.add_adapter(adapter)
    parameters = [
        parameter for parameter in unet.parameters() if parameter.requires_grad
    ]
    for parameter in parameters:
        parameter.data = parameter.data.float()
    unet.enable_gradient_checkpointing()
    unet.train()
    optimizer = torch.optim.AdamW(
        parameters, lr=specification["learning_rate"], weight_decay=0.01
    )
    scaler = torch.amp.GradScaler(
        device, enabled=device == "cuda" and dtype == torch.float16
    )
    generator = torch.Generator(
        device=device if device == "cuda" else "cpu"
    ).manual_seed(specification["seed"])
    output = directory / "output"
    output.mkdir(exist_ok=True)
    settings = {
        key: specification[key]
        for key in ("rank", "precision", "learning_rate", "seed")
    }
    step = (
        restore_checkpoint(
            output, unet, optimizer, scaler, generator, device, signature, settings
        )
        if specification["resume"]
        else 0
    )
    losses = []
    print(
        f"Training on {device_name}; {sum(parameter.numel() for parameter in parameters)} adapter parameters",
        flush=True,
    )
    while step < specification["steps"]:
        sample_index = int(
            torch.randint(
                len(encoded), (1,), generator=generator, device=generator.device
            ).item()
        )
        sample = encoded[sample_index]
        mean = sample["mean"].to(device=device, dtype=dtype)
        std = sample["std"].to(device=device, dtype=dtype)
        latent_noise = torch.randn(
            mean.shape, generator=generator, device=generator.device, dtype=dtype
        ).to(device)
        latents = (mean + std * latent_noise) * latent_scale
        noise = torch.randn(
            latents.shape, generator=generator, device=generator.device, dtype=dtype
        ).to(device)
        timesteps = torch.randint(
            scheduler.config.num_train_timesteps,
            (1,),
            generator=generator,
            device=generator.device,
        ).to(device)
        noisy = scheduler.add_noise(latents, noise, timesteps)
        optimizer.zero_grad(set_to_none=True)
        with torch.autocast(device_type=device, dtype=dtype):
            prediction = unet(
                noisy,
                timesteps,
                sample["prompt"].to(device=device, dtype=dtype),
                added_cond_kwargs={
                    "text_embeds": sample["pooled"].to(device=device, dtype=dtype),
                    "time_ids": sample["time_ids"].to(device=device, dtype=dtype),
                },
                return_dict=False,
            )[0]
            loss = torch.nn.functional.mse_loss(
                prediction.float(),
                noise_target(scheduler, latents, noise, timesteps).float(),
            )
        if not torch.isfinite(loss):
            raise ValueError(
                "Training produced a non-finite loss. Lower the learning rate and try again."
            )
        scaler.scale(loss).backward()
        scaler.unscale_(optimizer)
        gradient_norm = torch.nn.utils.clip_grad_norm_(parameters, 1.0)
        if not torch.isfinite(gradient_norm):
            raise ValueError(
                "Training produced non-finite gradients. Lower the learning rate and try again."
            )
        scaler.step(optimizer)
        scaler.update()
        step += 1
        losses.append(float(loss.detach().cpu()))
        print(
            f"Steps: {step}/{specification['steps']} loss={losses[-1]:.6f}", flush=True
        )
        if (
            step % specification["checkpoint_interval"] == 0
            or step == specification["steps"]
        ):
            save_checkpoint(
                output,
                step,
                unet,
                optimizer,
                scaler,
                generator,
                device,
                signature,
                settings,
            )
    adapter_weights = get_peft_model_state_dict(unet)
    diffusers.StableDiffusionXLPipeline.save_lora_weights(
        str(output), unet_lora_layers=adapter_weights, safe_serialization=True
    )
    summary = {
        "architecture": specification["architecture"],
        "model": specification["model"],
        "steps": step,
        "rank": specification["rank"],
        "seed": specification["seed"],
        "datasetSignature": signature,
        "trainableParameters": sum(parameter.numel() for parameter in parameters),
        "losses": losses,
        "resumed": specification["resume"],
    }
    (output / "training.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )
