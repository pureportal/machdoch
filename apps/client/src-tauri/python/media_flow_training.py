from __future__ import annotations

import gc
import time
from pathlib import Path

import torch

from media_flow_training_data import cache_conditioning
from media_flux2_conditioning import encode_flux2_prompts, predict_velocity as predict_flux2_velocity
from media_sana_conditioning import encode_sana_prompts
from media_sd3_conditioning import encode_sd3_prompts
from media_z_image_conditioning import encode_z_image_prompts
from media_training_data import dataset_signature, read_dataset
from media_training_embeddings import encode_flux_captions, prepare_embeddings
from media_training_loop import TrainingObjective, run_training
from media_training_options import validate_options
from media_training_optimizer import finetune_memory_bytes, trainable_dtype
from media_training_exports import save_pipeline
from media_training_state import write_json


def validate_settings(specification: dict) -> None:
    if (specification["architecture"] not in ("stable-diffusion-3", "flux-1", "flux-1-dev", "flux-1-schnell", "flux-2", "flux-2-klein-base-4b", "flux-2-klein-9b", "flux-2-klein-base-9b", "sana", "z-image", "z-image-turbo")
            or specification["model"]["architecture"] != specification["architecture"]):
        raise ValueError("Choose a matching flow model for this trainer.")
    validate_options(specification, ("lora", "finetune", "embedding"))
    if specification["snr_gamma"] != 0:
        raise ValueError("Min-SNR weighting is unavailable for this flow-matching trainer.")


def flow_matching_loss(prediction: torch.Tensor, latents: torch.Tensor,
                       noise: torch.Tensor) -> torch.Tensor:
    return (prediction.float() - (noise.float() - latents.float())).square().mean()


def restrict_flux2_attention_adapters(transformer) -> None:
    for block in transformer.single_transformer_blocks:
        attention = block.attn
        projection = attention.to_qkv_mlp_proj.lora_B["default"].weight
        attention_rows = torch.arange(projection.shape[0], device=projection.device).unsqueeze(1) < 3 * attention.inner_dim
        output = attention.to_out.lora_A["default"].weight
        attention_columns = torch.arange(output.shape[1], device=output.device).unsqueeze(0) < attention.inner_dim
        with torch.no_grad():
            projection.mul_(attention_rows)
            output.mul_(attention_columns)
        projection.register_hook(lambda gradient, mask=attention_rows: gradient * mask)
        output.register_hook(lambda gradient, mask=attention_columns: gradient * mask)


def predict_velocity(pipeline, noisy: torch.Tensor, timesteps: torch.Tensor,
                     batch: dict[str, torch.Tensor], guidance_scale: float,
                      architecture: str) -> torch.Tensor:
    if architecture.startswith("flux-2"):
        return predict_flux2_velocity(pipeline, noisy, timesteps, batch["prompt"], guidance_scale)
    if architecture == "sana":
        return pipeline.transformer(hidden_states=noisy, timestep=timesteps,
                                    encoder_hidden_states=batch["prompt"], encoder_attention_mask=batch["mask"],
                                    return_dict=False)[0]
    if architecture == "stable-diffusion-3":
        return pipeline.transformer(hidden_states=noisy, timestep=timesteps,
                                    encoder_hidden_states=batch["prompt"], pooled_projections=batch["pooled"],
                                    return_dict=False)[0]
    if architecture.startswith("z-image"):
        captions = [prompt[mask.bool()] for prompt, mask in zip(batch["prompt"], batch["mask"])]
        prediction = pipeline.transformer(list(noisy.unsqueeze(2).unbind(0)),
                                          (1000 - timesteps) / 1000, captions, return_dict=False)[0]
        return -torch.stack(prediction).squeeze(2)
    count, channels, height, width = noisy.shape
    packed = pipeline._pack_latents(noisy, count, channels, height, width)
    image_ids = pipeline._prepare_latent_image_ids(count, height // 2, width // 2, noisy.device, noisy.dtype)
    text_ids = torch.zeros((batch["prompt"].shape[1], 3), device=noisy.device, dtype=noisy.dtype)
    guidance = torch.full((count,), guidance_scale, device=noisy.device, dtype=noisy.dtype) if pipeline.transformer.config.guidance_embeds else None
    prediction = pipeline.transformer(
        hidden_states=packed, timestep=timesteps / 1000, guidance=guidance,
        encoder_hidden_states=batch["prompt"], pooled_projections=batch["pooled"],
        txt_ids=text_ids, img_ids=image_ids, return_dict=False,
    )[0]
    return pipeline._unpack_latents(prediction, height * pipeline.vae_scale_factor,
                                   width * pipeline.vae_scale_factor, pipeline.vae_scale_factor)


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
    pipeline = worker._load_pipeline(diffusers, torch, specification["model"], torch_dtype=dtype)
    architecture = specification["architecture"]
    sana = architecture == "sana"
    flux = architecture.startswith("flux-1")
    flux2 = architecture.startswith("flux-2")
    z_image = architecture.startswith("z-image")
    pipeline_class = (diffusers.SanaPipeline if sana else diffusers.FluxPipeline if flux
                      else diffusers.Flux2KleinPipeline if flux2
                      else diffusers.ZImagePipeline if z_image else diffusers.StableDiffusion3Pipeline)
    if not isinstance(pipeline, pipeline_class):
        raise ValueError("The base model pipeline does not match the training architecture.")
    if flux2:
        expected_distilled = architecture in ("flux-2", "flux-2-klein-9b")
        if pipeline.config.is_distilled != expected_distilled or pipeline.transformer.config.guidance_embeds:
            raise ValueError("Choose a matching FLUX.2 Klein Base or distilled model.")
    if flux and specification["architecture"] != "flux-1":
        expected_guidance = specification["architecture"] == "flux-1-dev"
        if pipeline.transformer.config.guidance_embeds != expected_guidance:
            raise ValueError("The FLUX.1 transformer does not match the selected dev or Schnell architecture.")
    transformer = pipeline.transformer
    transformer.requires_grad_(False)
    encoders = [pipeline.text_encoder]
    if not sana and not z_image and not flux2:
        encoders.append(pipeline.text_encoder_2)
    if architecture == "stable-diffusion-3":
        encoders.append(pipeline.text_encoder_3)
    capacity = device_memory if device == "cuda" else worker._physical_memory_bytes() if device == "cpu" else None
    if method == "finetune":
        required = finetune_memory_bytes(list(transformer.parameters()), specification)
        if capacity is not None and required > capacity:
            raise ValueError(f"Finetuning needs about {required / 1024**3:.1f} GiB for weights, gradients, and optimizer buffers before activations. Use BF16 Adafactor, LoRA, or a device with more memory.")
    elif method == "embedding":
        required = sum(parameter.numel() * parameter.element_size()
                       for component in [transformer, *encoders] if component is not None
                       for parameter in component.parameters())
        if capacity is not None and required > capacity:
            raise ValueError(f"Embedding training needs at least {required / 1024**3:.1f} GiB for the frozen transformer and text encoders before activations. Use a device with more memory.")
    else:
        required = sum(parameter.numel() * parameter.element_size() for parameter in transformer.parameters())
        if capacity is not None and required > capacity:
            raise ValueError(f"The base transformer needs at least {required / 1024**3:.1f} GiB before trainable weights and activations. Use a device with more memory.")
    if not sana and not flux2 and pipeline.vae.config.shift_factor is None:
        raise ValueError("The VAE configuration is missing its latent shift.")
    embeddings = (prepare_embeddings(pipeline, specification["trigger_phrase"],
                                     specification["initializer_token"], architecture)
                  if method == "embedding" else {})
    samples = read_dataset(directory / "dataset", specification["resolution"], specification["preserve_aspect_ratio"])
    signature = dataset_signature(specification, samples)
    write_json(directory / "status.json", {"state": "running", "message": "Preparing images"})
    encoded = cache_conditioning(pipeline, samples, device, directory / "conditioning.safetensors", signature, architecture, method)
    captions = [sample["caption"] for sample in samples]
    del samples
    noise_scheduler = diffusers.FlowMatchEulerDiscreteScheduler.from_config(pipeline.scheduler.config)
    shift = 0 if sana or flux2 else pipeline.vae.config.shift_factor
    scale = 1 if flux2 else pipeline.vae.config.scaling_factor
    pipeline.vae.to("cpu")
    for encoder in encoders:
        if encoder is not None:
            encoder.to(device if method == "embedding" else "cpu")
            encoder.train(method == "embedding")
            if method == "embedding" and specification["gradient_checkpointing"]:
                encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    gc.collect()
    if device == "cuda":
        torch.cuda.empty_cache()
    elif device == "mps":
        torch.mps.empty_cache()
    write_json(directory / "status.json", {"state": "running", "message": "Preparing model"})
    transformer.to(device=device, dtype=dtype)
    if method == "lora":
        targets = ["to_q", "to_k", "to_v", "to_out.0"]
        if not sana and not z_image:
            targets.extend(["add_q_proj", "add_k_proj", "add_v_proj", "to_add_out"])
        if flux2:
            targets.extend(["to_qkv_mlp_proj", *[f"single_transformer_blocks.{index}.attn.to_out"
                            for index in range(len(transformer.single_transformer_blocks))]])
        if not specification["attention_only"]:
            if sana:
                targets.extend(["ff.conv_inverted", "ff.conv_point"])
            elif z_image:
                targets.extend(["feed_forward.w1", "feed_forward.w2", "feed_forward.w3"])
            elif flux2:
                targets.extend(["ff.linear_in", "ff.linear_out", "ff_context.linear_in", "ff_context.linear_out"])
            else:
                targets.extend(["ff.net.0.proj", "ff.net.2", "ff_context.net.0.proj", "ff_context.net.2"])
            if flux:
                targets.extend(["proj_mlp", "proj_out"])
        transformer.add_adapter(LoraConfig(
            r=specification["rank"], lora_alpha=specification["rank"],
            lora_dropout=specification["lora_dropout"], init_lora_weights="gaussian", target_modules=targets,
        ))
        if flux2 and specification["attention_only"]:
            restrict_flux2_attention_adapters(transformer)
    elif method == "finetune":
        transformer.requires_grad_(True)
    parameters = ([embedding.vector for embedding in embeddings.values()] if method == "embedding"
                  else [parameter for parameter in transformer.parameters() if parameter.requires_grad])
    for parameter in parameters:
        parameter.data = parameter.data.to(dtype=trainable_dtype(specification))
    if specification["gradient_checkpointing"]:
        transformer.enable_gradient_checkpointing()
    transformer.train()

    def weights():
        if method == "lora":
            return get_peft_model_state_dict(transformer)
        if method == "finetune":
            return transformer.state_dict()
        return {key: embedding.vector.unsqueeze(0) for key, embedding in embeddings.items()}

    def restore_weights(saved):
        if method == "lora":
            set_peft_model_state_dict(transformer, saved)
        elif method == "finetune":
            transformer.load_state_dict(saved, strict=True)
        else:
            for key, embedding in embeddings.items():
                with torch.no_grad():
                    embedding.vector.copy_(saved[key].squeeze(0))

    def loss(batch, indices, generator):
        if sana or flux2:
            latents = batch["mean"] * scale
        elif z_image:
            latents = (batch["mean"] - shift) * scale
        else:
            latent_noise = torch.randn(batch["mean"].shape, generator=generator, device=generator.device, dtype=dtype).to(device)
            latents = (batch["mean"] + batch["std"] * latent_noise - shift) * scale
        noise = torch.randn(latents.shape, generator=generator, device=generator.device, dtype=dtype).to(device)
        if specification["noise_offset"]:
            offset = torch.randn((latents.shape[0], latents.shape[1], 1, 1), generator=generator, device=generator.device, dtype=dtype).to(device)
            noise = noise + specification["noise_offset"] * offset
        positions = torch.randint(noise_scheduler.config.num_train_timesteps, (len(indices),), generator=generator, device=generator.device).cpu()
        timesteps = noise_scheduler.timesteps[positions].to(device)
        sigmas = noise_scheduler.sigmas[positions].to(device=device, dtype=dtype).reshape(-1, 1, 1, 1)
        noisy = (1 - sigmas) * latents + sigmas * noise
        if method == "embedding":
            batch_captions = [captions[index] for index in indices]
            if sana:
                prompt, mask = encode_sana_prompts(pipeline, batch_captions, device, (specification["trigger_phrase"],))
                batch = {**batch, "prompt": prompt, "mask": mask}
            elif z_image:
                prompt, mask = encode_z_image_prompts(pipeline, batch_captions, device, (specification["trigger_phrase"],))
                batch = {**batch, "prompt": prompt, "mask": mask}
            elif flux2:
                prompt = encode_flux2_prompts(pipeline, batch_captions, device, (specification["trigger_phrase"],))
                batch = {**batch, "prompt": prompt}
            elif architecture == "stable-diffusion-3":
                prompt, pooled = encode_sd3_prompts(pipeline, batch_captions, device, (specification["trigger_phrase"],))
                batch = {**batch, "prompt": prompt, "pooled": pooled}
            else:
                prompt, pooled = encode_flux_captions(pipeline, batch_captions, device)
                batch = {**batch, "prompt": prompt, "pooled": pooled}
        prediction = predict_velocity(pipeline, noisy, timesteps, batch, specification["guidance_scale"], architecture)
        return flow_matching_loss(prediction, latents, noise)

    print(f"Training {method} on {device_name}; {sum(parameter.numel() for parameter in parameters)} parameters", flush=True)
    started = time.monotonic()
    step = run_training(specification, directory, signature,
                        TrainingObjective(encoded, parameters, loss, weights, restore_weights), device, dtype)
    output = directory / "output"
    write_json(directory / "status.json", {"state": "running", "message": "Saving weights"})
    if method == "lora":
        pipeline.__class__.save_lora_weights(str(output), transformer_lora_layers=weights(), safe_serialization=True)
    elif method == "finetune":
        transformer.to(device="cpu", dtype=dtype)
        if z_image or flux2:
            pipeline.register_to_config(_machdoch_training_architecture=architecture)
        save_pipeline(pipeline, output / "model")
    else:
        save_file({key: tensor.detach().cpu().contiguous() for key, tensor in weights().items()},
                  str(output / "learned_embeds.safetensors"),
                  metadata={"token": specification["trigger_phrase"], "architecture": architecture})
    write_json(output / "training.json", {
        "architecture": specification["architecture"], "method": method, "model": specification["model"],
        "steps": step, "settings": {key: value for key, value in specification.items() if key not in ("model", "resume")},
        "datasetSignature": signature, "trainableParameters": sum(parameter.numel() for parameter in parameters),
        "resumed": specification["resume"], "seconds": time.monotonic() - started,
    })
