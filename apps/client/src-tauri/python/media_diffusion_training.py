from __future__ import annotations

import gc
import time
from pathlib import Path
from typing import Any

import torch

from media_training_data import cache_conditioning, dataset_signature, read_dataset
from media_training_embeddings import encode_captions, prepare_embeddings
from media_training_loop import TrainingObjective, run_training
from media_training_options import validate_options
from media_training_optimizer import finetune_memory_bytes, trainable_dtype
from media_training_exports import save_pipeline
from media_training_state import write_json


ARCHITECTURES = frozenset({"stable-diffusion-1", "stable-diffusion-2", "stable-diffusion-xl", "pony"})


def validate_settings(specification: dict) -> None:
    architecture = specification["architecture"]
    if architecture not in ARCHITECTURES or specification["model"]["architecture"] != architecture:
        raise ValueError("Choose a Stable Diffusion or Pony model for this trainer.")
    validate_options(specification, ("lora", "finetune", "embedding"))


def noise_target(scheduler: Any, latents: Any, noise: Any, timesteps: Any) -> Any:
    if scheduler.config.prediction_type == "epsilon":
        return noise
    if scheduler.config.prediction_type == "v_prediction":
        return scheduler.get_velocity(latents, noise, timesteps)
    raise ValueError("This scheduler does not support diffusion training.")


def diffusion_loss(prediction: Any, target: Any, scheduler: Any, timesteps: Any, gamma: float):
    loss = (prediction.float() - target.float()).square().flatten(1).mean(1)
    if gamma:
        alpha = scheduler.alphas_cumprod.to(timesteps.device)[timesteps].float()
        snr = alpha / (1 - alpha).clamp_min(1e-8)
        denominator = snr + (1 if scheduler.config.prediction_type == "v_prediction" else 0)
        loss = loss * snr.clamp(max=gamma) / denominator.clamp_min(1e-8)
    return loss.mean()


def train(specification: dict, directory: Path) -> None:
    import diffusers
    from peft import LoraConfig
    from peft.utils import get_peft_model_state_dict, set_peft_model_state_dict
    from safetensors.torch import save_file
    import media_diffusers_worker as worker

    validate_settings(specification)
    device, device_name, device_memory = worker._device(torch)
    worker._configure_amd_convolution_backend(torch, device)
    dtype = {"bf16": torch.bfloat16, "fp16": torch.float16, "float32": torch.float32}[specification["precision"]]
    if device == "cpu" and dtype != torch.float32:
        raise ValueError("Choose FP32 precision to train on the CPU.")
    if device == "mps" and dtype == torch.bfloat16:
        raise ValueError("Choose FP16 or FP32 precision for this GPU.")
    torch.manual_seed(specification["seed"])
    method = specification["method"]
    xl = specification["architecture"] in ("stable-diffusion-xl", "pony")
    pipeline = worker._load_pipeline(diffusers, torch, specification["model"], torch_dtype=dtype)
    unet = pipeline.unet
    unet.requires_grad_(False)
    if method == "finetune":
        required = finetune_memory_bytes(list(unet.parameters()), specification)
        capacity = device_memory if device == "cuda" else worker._physical_memory_bytes() if device == "cpu" else None
        if capacity is not None and required > capacity:
            raise ValueError(f"Finetuning needs about {required / 1024**3:.1f} GiB for weights, gradients, and optimizer buffers before activations. Use BF16 Adafactor, LoRA, or a device with more memory.")
    embeddings = (prepare_embeddings(pipeline, specification["trigger_phrase"],
                                    specification["initializer_token"], specification["architecture"])
                  if method == "embedding" else {})
    samples = read_dataset(directory / "dataset", specification["resolution"], specification["preserve_aspect_ratio"])
    signature = dataset_signature(specification, samples)
    write_json(directory / "status.json", {"state": "running", "message": "Preparing images"})
    encoded = cache_conditioning(pipeline, samples, device, directory / "conditioning.safetensors", signature, method == "embedding")
    captions = [sample["caption"] for sample in samples]
    del samples
    noise_scheduler = diffusers.DDPMScheduler.from_config(pipeline.scheduler.config)
    latent_scale = pipeline.vae.config.scaling_factor
    pipeline.vae.to("cpu")
    if method == "embedding":
        pipeline.text_encoder.to(device)
        if xl:
            pipeline.text_encoder_2.to(device)
    else:
        pipeline.text_encoder.to("cpu")
        if xl:
            pipeline.text_encoder_2.to("cpu")
    gc.collect()
    if device == "cuda":
        torch.cuda.empty_cache()
    elif device == "mps":
        torch.mps.empty_cache()
    write_json(directory / "status.json", {"state": "running", "message": "Preparing model"})
    unet.to(device=device, dtype=dtype)
    if method == "lora":
        targets = ["to_q", "to_k", "to_v", "to_out.0"]
        if not specification["attention_only"]:
            targets.extend(["ff.net.0.proj", "ff.net.2"])
        unet.add_adapter(LoraConfig(r=specification["rank"], lora_alpha=specification["rank"],
                                   lora_dropout=specification["lora_dropout"],
                                   init_lora_weights="gaussian", target_modules=targets))
    elif method == "finetune":
        unet.requires_grad_(True)
    parameters = ([embedding.vector for embedding in embeddings.values()] if method == "embedding"
                  else [parameter for parameter in unet.parameters() if parameter.requires_grad])
    for parameter in parameters:
        parameter.data = parameter.data.to(dtype=trainable_dtype(specification))
    if specification["gradient_checkpointing"]:
        unet.enable_gradient_checkpointing()
    unet.train()
    output = directory / "output"
    output.mkdir(exist_ok=True)
    settings = {key: value for key, value in specification.items() if key not in ("model", "resume")}

    def weights():
        if method == "lora":
            return get_peft_model_state_dict(unet)
        if method == "finetune":
            return unet.state_dict()
        return {key: embedding.vector.unsqueeze(0) for key, embedding in embeddings.items()}

    def restore_weights(saved):
        if method == "lora":
            set_peft_model_state_dict(unet, saved)
        elif method == "finetune":
            unet.load_state_dict(saved, strict=True)
        else:
            for key, embedding in embeddings.items():
                with torch.no_grad():
                    embedding.vector.copy_(saved[key].squeeze(0))

    def loss(batch, indices, generator):
        latent_noise = torch.randn(batch["mean"].shape, generator=generator, device=generator.device, dtype=dtype).to(device)
        latents = (batch["mean"] + batch["std"] * latent_noise) * latent_scale
        noise = torch.randn(latents.shape, generator=generator, device=generator.device, dtype=dtype).to(device)
        if specification["noise_offset"]:
            offset = torch.randn((latents.shape[0], latents.shape[1], 1, 1), generator=generator, device=generator.device, dtype=dtype).to(device)
            noise = noise + specification["noise_offset"] * offset
        timesteps = torch.randint(noise_scheduler.config.num_train_timesteps, (len(indices),), generator=generator, device=generator.device).to(device)
        prompt, pooled = (encode_captions(pipeline, [captions[index] for index in indices], device, xl)
                          if method == "embedding" else (batch["prompt"], batch["pooled"]))
        arguments = {"added_cond_kwargs": {"text_embeds": pooled, "time_ids": batch["time_ids"]}} if xl else {}
        prediction = unet(noise_scheduler.add_noise(latents, noise, timesteps), timesteps,
                          prompt, return_dict=False, **arguments)[0]
        return diffusion_loss(prediction, noise_target(noise_scheduler, latents, noise, timesteps),
                              noise_scheduler, timesteps, specification["snr_gamma"])

    started = time.monotonic()
    print(f"Training {method} on {device_name}; {sum(parameter.numel() for parameter in parameters)} parameters", flush=True)
    objective = TrainingObjective(encoded, parameters, loss, weights, restore_weights)
    step = run_training(specification, directory, signature, objective, device, dtype)
    write_json(directory / "status.json", {"state": "running", "message": "Saving weights"})
    if method == "lora":
        pipeline.__class__.save_lora_weights(str(output), unet_lora_layers=weights(), safe_serialization=True)
    elif method == "finetune":
        unet.to(device="cpu", dtype=dtype)
        save_pipeline(pipeline, output / "model")
    else:
        export_weights = {key if xl else "emb_params": tensor.detach().cpu().contiguous() for key, tensor in weights().items()}
        save_file(export_weights,
                  str(output / "learned_embeds.safetensors"),
                  metadata={"token": specification["trigger_phrase"], "architecture": specification["architecture"]})
    write_json(output / "training.json", {"architecture": specification["architecture"], "method": method,
               "model": specification["model"], "steps": step, "settings": settings,
               "datasetSignature": signature, "trainableParameters": sum(parameter.numel() for parameter in parameters),
               "resumed": specification["resume"], "seconds": time.monotonic() - started})
