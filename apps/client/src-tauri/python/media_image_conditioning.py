from __future__ import annotations

import gc
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image


KREA_PREFIX = (
    "<|im_start|>system\nDescribe the image by detailing the color, shape, size, "
    "texture, quantity, text, spatial relationships of the objects and background:"
    "<|im_end|>\n<|im_start|>user\n"
)
KREA_SUFFIX = "<|im_end|>\n<|im_start|>assistant\n"
KREA_TAP_LAYERS = (2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35)


def ip_adapter_scale(architecture: str, role: str, influence: float) -> Any:
    if role == "subject":
        return influence * 0.7
    if architecture in ("stable-diffusion-xl", "pony"):
        if role == "style":
            return {"up": {"block_0": [0.0, influence, 0.0]}}
        if role == "composition":
            return {"down": {"block_2": [0.0, influence]}}
    raise ValueError(f"{architecture} does not implement {role} reference conditioning")


def load_ip_adapter(
    pipeline: Any, root: Path, architecture: str, references: list[dict[str, Any]]
) -> None:
    weights = {
        "stable-diffusion-1": "sd15.safetensors",
        "stable-diffusion-xl": "sdxl.safetensors",
        "pony": "sdxl.safetensors",
    }[architecture]
    pipeline.remove_all_hooks()
    pipeline.load_ip_adapter(
        str(root),
        subfolder="",
        weight_name=[weights] * len(references),
        image_encoder_folder="image_encoder",
        local_files_only=True,
    )
    pipeline.set_ip_adapter_scale(
        [ip_adapter_scale(architecture, item["role"], item["influence"]) for item in references]
    )


def krea_vision_text(prompt: str, references: list[dict[str, Any]]) -> str:
    roles = {
        "subject": "subject identity and appearance",
        "style": "artistic style and texture",
        "composition": "layout and spatial arrangement",
        "palette": "color palette",
        "detail": "fine visual details",
    }
    instructions = " ".join(
        f"Use the {roles[item['role']]} from image {index + 1}."
        for index, item in enumerate(references)
    )
    images = "<|vision_start|><|image_pad|><|vision_end|>" * len(references)
    return KREA_PREFIX + images + "\n" + instructions + "\n" + prompt + KREA_SUFFIX


def encode_krea_prompt(
    torch: Any, text_root: Path, prompt: str, references: list[dict[str, Any]]
) -> tuple[Any, Any]:
    from transformers import AutoProcessor, AutoTokenizer, Qwen3VLForConditionalGeneration

    device = torch.device(f"cuda:{torch.cuda.current_device()}")
    tokenizer = AutoTokenizer.from_pretrained(
        str(text_root), local_files_only=True, trust_remote_code=False
    )
    prefix_tokens = 34
    if references:
        processor = AutoProcessor.from_pretrained(
            str(text_root), local_files_only=True, trust_remote_code=False
        )
        images = []
        for reference in references:
            image = reference["image"].copy()
            image.thumbnail((384, 384), Image.Resampling.LANCZOS)
            images.append(image)
        inputs = processor(
            text=[krea_vision_text(prompt, references)], images=images, return_tensors="pt"
        ).to(device)
        if inputs.input_ids.shape[1] > 2048:
            raise ValueError("Shorten the prompt or remove a reference image")
        del processor, images
    else:
        text_tokens = tokenizer(
            [KREA_PREFIX + prompt], truncation=True, padding="max_length",
            max_length=512 + prefix_tokens - 5, return_tensors="pt",
        ).to(device)
        suffix_tokens = tokenizer([KREA_SUFFIX], return_tensors="pt").to(device)
        attention_mask = torch.cat(
            (text_tokens.attention_mask, suffix_tokens.attention_mask), dim=1
        ).bool()
        position_ids = (attention_mask.long().cumsum(dim=-1) - 1).clamp(min=0)
        inputs = {
            "input_ids": torch.cat((text_tokens.input_ids, suffix_tokens.input_ids), dim=1),
            "attention_mask": attention_mask,
            "position_ids": position_ids.unsqueeze(0).expand(3, -1, -1),
        }
        del text_tokens, suffix_tokens, attention_mask, position_ids
    encoder = Qwen3VLForConditionalGeneration.from_pretrained(
        str(text_root), torch_dtype=torch.bfloat16, local_files_only=True,
        use_safetensors=True, trust_remote_code=False, low_cpu_mem_usage=True,
    )
    encoder.to(device).eval().requires_grad_(False)
    with torch.inference_mode():
        states = encoder(**inputs, output_hidden_states=True)
        selected = [
            states.hidden_states[index][:, prefix_tokens:].to(device="cpu", dtype=torch.bfloat16)
            for index in KREA_TAP_LAYERS
        ]
    hidden = torch.stack(selected, dim=2)
    mask = inputs["attention_mask"][:, prefix_tokens:].to(device="cpu", dtype=torch.bool)
    del states, encoder, tokenizer, inputs, selected
    gc.collect()
    torch.cuda.empty_cache()
    return hidden, mask


def krea_edit_sigmas(steps: int, strength: float) -> list[float]:
    count = int(steps * strength)
    if count < 1:
        raise ValueError("Increase edit strength or sampling steps")
    return np.linspace(1.0, 1.0 / steps, steps)[steps - count:].tolist()


def preserve_krea_mask(source: Any, noise: Any, mask: Any) -> Any:
    def callback(pipeline: Any, step: int, _timestep: Any, values: dict[str, Any]) -> dict[str, Any]:
        sigma = pipeline.scheduler.sigmas[step + 1].to(source.device, source.dtype)
        preserved = (1.0 - sigma) * source + sigma * noise
        values["latents"] = mask * values["latents"] + (1.0 - mask) * preserved
        return values

    return callback


def prepare_krea_edit(
    pipeline: Any, torch: Any, image: Image.Image, mask: Image.Image | None,
    width: int, height: int, steps: int, strength: float, generator: Any,
) -> tuple[dict[str, Any], Any]:
    sigmas = krea_edit_sigmas(steps, strength)
    device = pipeline.vae.device
    dtype = pipeline.vae.dtype
    pixels = pipeline.image_processor.preprocess(image, height=height, width=width)
    with torch.inference_mode():
        source = pipeline.vae.encode(pixels.unsqueeze(2).to(device=device, dtype=dtype)).latent_dist.mode()
    mean = torch.tensor(pipeline.vae.config.latents_mean, device=device, dtype=dtype).view(1, -1, 1, 1, 1)
    std = torch.tensor(pipeline.vae.config.latents_std, device=device, dtype=dtype).view(1, -1, 1, 1, 1)
    source = ((source - mean) / std)[:, :, 0]
    latent_height, latent_width = source.shape[-2:]
    channels = source.shape[1]
    source = pipeline._pack_latents(source, 1, channels, latent_height, latent_width)
    noise = pipeline.prepare_latents(1, channels, height, width, dtype, device, generator)
    scheduler = type(pipeline.scheduler).from_config(pipeline.scheduler.config)
    scheduler.set_timesteps(sigmas=sigmas, device=device, mu=1.15)
    sigma = scheduler.sigmas[0].to(device=device, dtype=dtype)
    initial = (1.0 - sigma) * source + sigma * noise
    callback = None
    if mask is not None:
        mask_pixels = np.asarray(mask.resize((latent_width, latent_height), Image.Resampling.BILINEAR), dtype=np.float32) / 255.0
        latent_mask = torch.from_numpy(mask_pixels.copy()).to(device=device, dtype=dtype)
        latent_mask = latent_mask[None, None].expand(1, channels, -1, -1).contiguous()
        packed_mask = pipeline._pack_latents(latent_mask, 1, channels, latent_height, latent_width)
        callback = preserve_krea_mask(source, noise, packed_mask)
    return {"latents": initial, "sigmas": sigmas}, callback
