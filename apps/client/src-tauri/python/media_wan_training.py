from __future__ import annotations

import gc
import time
from pathlib import Path

import torch

from media_training_embeddings import prepare_embeddings
from media_training_exports import save_pipeline
from media_training_loop import TrainingObjective, run_training
from media_training_optimizer import finetune_memory_bytes, trainable_dtype
from media_training_options import validate_options
from media_training_state import write_json
from media_training_video_data import dataset_signature, read_dataset, validate_video_settings
from media_wan_conditioning import encode_prompts
from media_wan_training_data import cache_conditioning


ARCHITECTURES = ("wan-2.1-t2v-1.3b",)


def validate_settings(specification):
    architecture = specification["architecture"]
    if architecture not in ARCHITECTURES or specification["model"]["architecture"] != architecture:
        raise ValueError("Choose a matching Wan 2.1 T2V 1.3B model.")
    validate_options(specification, ("lora", "finetune", "embedding"))
    validate_video_settings(specification["video"])
    if specification["snr_gamma"] != 0:
        raise ValueError("Disable Min-SNR for Wan flow matching.")
    if specification["preserve_aspect_ratio"]:
        raise ValueError("Choose a fixed video canvas for Wan training.")
    if specification["video"]["image_dropout"] != 0:
        raise ValueError("Image dropout applies to image-to-video models.")
    if specification["precision"] == "fp16":
        raise ValueError("Choose BF16 or FP32 for Wan training.")


def train(specification: dict, directory: Path) -> None:
    import diffusers
    from peft import LoraConfig
    from peft.utils import get_peft_model_state_dict, set_peft_model_state_dict
    from safetensors.torch import save_file
    import media_diffusers_worker as worker
    import media_open_models

    validate_settings(specification)
    device, device_name, device_memory = worker._device(torch)
    worker._configure_video_conv3d_backend(torch, device)
    dtype = torch.bfloat16 if specification["precision"] == "bf16" else torch.float32
    if dtype == torch.bfloat16 and (device != "cuda" or not torch.cuda.is_bf16_supported()):
        raise ValueError("Choose FP32 precision for this device.")
    torch.manual_seed(specification["seed"])
    architecture, method = specification["architecture"], specification["method"]
    pipeline = media_open_models.load_pipeline(diffusers, specification["model"], dtype)
    if not isinstance(pipeline, diffusers.WanPipeline) or pipeline.transformer_2 is not None:
        raise ValueError("Choose the single-denoiser Wan 2.1 T2V model.")
    transformer = pipeline.transformer
    if transformer.config.in_channels != pipeline.vae.config.z_dim or transformer.config.image_dim is not None:
        raise ValueError("Choose a Wan text-to-video transformer with matching VAE channels.")
    video = specification["video"]
    if (video["height"] % (pipeline.vae_scale_factor_spatial * transformer.config.patch_size[1])
            or video["width"] % (pipeline.vae_scale_factor_spatial * transformer.config.patch_size[2])):
        raise ValueError("Video dimensions must align with the Wan transformer patches.")
    capacity = device_memory if device == "cuda" else worker._physical_memory_bytes() if device == "cpu" else None
    required = (finetune_memory_bytes(list(transformer.parameters()), specification) if method == "finetune"
                else sum(parameter.numel() * parameter.element_size() for parameter in transformer.parameters()))
    if method == "embedding":
        required += sum(parameter.numel() * parameter.element_size() for parameter in pipeline.text_encoder.parameters())
    if capacity is not None and required > capacity:
        raise ValueError(f"Training needs at least {required / 1024**3:.1f} GiB before activations. Use LoRA, BF16 Adafactor for finetuning, or a device with more memory.")
    transformer.requires_grad_(False)
    pipeline.text_encoder.requires_grad_(False)
    embeddings = (prepare_embeddings(pipeline, specification["trigger_phrase"], specification["initializer_token"], architecture)
                  if method == "embedding" else {})
    samples = read_dataset(directory / "dataset")
    signature = dataset_signature(specification, samples)
    write_json(directory / "status.json", {"state": "running", "message": "Preparing videos"})
    encoded = cache_conditioning(pipeline, samples, specification, device,
                                 directory / "conditioning.safetensors", signature)
    captions = [sample["caption"] for sample in samples]
    del samples
    pipeline.vae.to("cpu")
    pipeline.text_encoder.to(device if method == "embedding" else "cpu").eval()
    if method == "embedding" and specification["gradient_checkpointing"]:
        pipeline.text_encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    gc.collect()
    if device == "cuda":
        torch.cuda.empty_cache()
    transformer.to(device=device, dtype=dtype)
    if method == "lora":
        targets = ["to_q", "to_k", "to_v", "to_out.0"]
        if not specification["attention_only"]:
            targets.extend(["ffn.net.0.proj", "ffn.net.2"])
        transformer.add_adapter(LoraConfig(r=specification["rank"], lora_alpha=specification["rank"],
            lora_dropout=specification["lora_dropout"], init_lora_weights="gaussian", target_modules=targets))
    elif method == "finetune":
        transformer.requires_grad_(True)
    parameters = ([embedding.vector for embedding in embeddings.values()] if method == "embedding"
                  else [parameter for parameter in transformer.parameters() if parameter.requires_grad])
    for parameter in parameters:
        parameter.data = parameter.data.to(dtype=trainable_dtype(specification))
    if specification["gradient_checkpointing"]:
        transformer.enable_gradient_checkpointing()
    transformer.train()
    scheduler = diffusers.FlowMatchEulerDiscreteScheduler.from_config(pipeline.scheduler.config)
    timesteps = scheduler.timesteps.to(device)
    sigmas = scheduler.sigmas.to(device=device, dtype=dtype)

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
        clean = batch["mean"]
        noise = torch.randn(clean.shape, generator=generator, device=generator.device, dtype=dtype).to(device)
        if specification["noise_offset"]:
            offset = torch.randn((len(indices), clean.shape[1], 1, 1, 1), generator=generator,
                                 device=generator.device, dtype=dtype).to(device)
            noise = noise + specification["noise_offset"] * offset
        positions = torch.randint(len(timesteps), (len(indices),), generator=generator, device=generator.device).to(device)
        sigma = sigmas[positions].reshape(-1, 1, 1, 1, 1)
        noisy = (1 - sigma) * clean + sigma * noise
        prompt = (encode_prompts(pipeline, [captions[index] for index in indices], device,
                                  (specification["trigger_phrase"],)) if method == "embedding" else batch["prompt"])
        prediction = transformer(hidden_states=noisy, encoder_hidden_states=prompt,
                                 timestep=timesteps[positions], return_dict=False)[0]
        return torch.nn.functional.mse_loss(prediction.float(), (noise - clean).float())

    print(f"Training {method} on {device_name}; {sum(parameter.numel() for parameter in parameters)} parameters", flush=True)
    started = time.monotonic()
    step = run_training(specification, directory, signature,
                        TrainingObjective(encoded, parameters, loss, weights, restore_weights), device, dtype)
    output = directory / "output"
    write_json(directory / "status.json", {"state": "running", "message": "Saving weights"})
    if method == "lora":
        diffusers.WanPipeline.save_lora_weights(str(output), transformer_lora_layers=weights(), safe_serialization=True)
    elif method == "finetune":
        transformer.to(device="cpu", dtype=dtype)
        pipeline.register_to_config(_machdoch_training_architecture=architecture)
        save_pipeline(pipeline, output / "model")
    else:
        save_file({key: tensor.detach().cpu().contiguous() for key, tensor in weights().items()},
                  str(output / "learned_embeds.safetensors"),
                  metadata={"token": specification["trigger_phrase"], "architecture": architecture})
    write_json(output / "training.json", {"architecture": architecture, "method": method,
        "model": specification["model"], "steps": step, "datasetSignature": signature,
        "settings": {key: value for key, value in specification.items() if key not in ("model", "resume")},
        "trainableParameters": sum(parameter.numel() for parameter in parameters),
        "resumed": specification["resume"], "seconds": time.monotonic() - started})
