from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any, Callable

WAN_ORIGINAL_BLOCK_MODULES = {
    "self_attn.q": "attn1.to_q", "self_attn.k": "attn1.to_k", "self_attn.v": "attn1.to_v", "self_attn.o": "attn1.to_out.0",
    "cross_attn.q": "attn2.to_q", "cross_attn.k": "attn2.to_k", "cross_attn.v": "attn2.to_v", "cross_attn.o": "attn2.to_out.0",
    "cross_attn.k_img": "attn2.add_k_proj", "cross_attn.v_img": "attn2.add_v_proj",
    "ffn.0": "ffn.net.0.proj", "ffn.2": "ffn.net.2",
}
WAN_ORIGINAL_MODULES = {
    "head.head": "proj_out",
    "time_projection.1": "condition_embedder.time_proj",
    "time_embedding.0": "condition_embedder.time_embedder.linear_1",
    "time_embedding.2": "condition_embedder.time_embedder.linear_2",
    "text_embedding.0": "condition_embedder.text_embedder.linear_1",
    "text_embedding.2": "condition_embedder.text_embedder.linear_2",
}


def _uses_original_wan_names(transformer: Any, keys: list[str]) -> bool:
    return type(transformer).__name__ == "WanTransformer3DModel" and any(
        key.startswith("diffusion_model.") or re.search(r"\.(self_attn|cross_attn)\.|\.ffn\.[02]\.lora_", key)
        for key in keys
    )


def _runtime_key(key: str, original_wan: bool) -> str:
    key = key.removeprefix("transformer.")
    for side in ("A", "B"):
        key = key.replace(f".lora_{side}.default.weight", f".lora_{side}.weight")
    if not original_wan:
        return key
    module, separator, tensor = key.removeprefix("diffusion_model.").rpartition(".lora_")
    if module.startswith("blocks."):
        index, _, rest = module.removeprefix("blocks.").partition(".")
        module = f"blocks.{index}.{WAN_ORIGINAL_BLOCK_MODULES.get(rest, rest)}"
    else:
        module = WAN_ORIGINAL_MODULES.get(module, module)
    return f"{module}{separator}{tensor}"


def load_loras(
    transformer: Any,
    addons: list[dict[str, Any]],
    inspect_profile: Callable[
        [dict[str, Any], dict[str, tuple[int, ...]]], dict[str, Any]
    ],
) -> list[dict[str, Any]]:
    import torch
    from safetensors import safe_open
    from safetensors.torch import load_file

    if not isinstance(addons, list) or len(addons) > 8:
        raise ValueError("Video generation accepts up to eight LoRAs")
    applied = []
    adapter_names = []
    strengths = []
    for addon in addons:
        if not isinstance(addon, dict):
            raise ValueError("A video LoRA selection must be an object")
        if not addon.get("enabled", True):
            continue
        if addon.get("kind") != "lora" or addon.get("targetComponents") != ["denoiser"]:
            raise ValueError("Video add-ons must be denoiser LoRAs")
        if (
            addon.get("denoisingSchedule") is not None
            or addon.get("textEncoderStrength") is not None
        ):
            raise ValueError("Video LoRAs use one strength for the entire clip")
        strength = addon.get("modelStrength", 1.0)
        if (
            isinstance(strength, bool)
            or not isinstance(strength, (int, float))
            or not math.isfinite(strength)
            or not -100 <= strength <= 100
        ):
            raise ValueError("Video LoRA strength must be between -100 and 100")
        path = Path(addon["path"])
        if not path.is_absolute() or not path.is_file() or path.is_symlink():
            raise ValueError("Video LoRA file is unavailable")
        with path.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        if digest != addon.get("digest"):
            raise ValueError("Video LoRA changed after import. Import the file again.")
        name = f"machdoch_{digest[:16]}"
        if name in adapter_names:
            raise ValueError("Select each video LoRA only once")
        with safe_open(str(path), framework="pt", device="cpu") as source:
            file_shapes = {
                key: tuple(source.get_slice(key).get_shape()) for key in source.keys()
            }
            metadata = source.metadata() or {}
        original_wan = _uses_original_wan_names(transformer, list(file_shapes))
        shapes = {_runtime_key(key, original_wan): shape for key, shape in file_shapes.items()}
        if len(shapes) != len(file_shapes):
            raise ValueError("Video LoRA contains duplicate transformer targets")
        adapter_metadata = (
            json.loads(metadata["lora_adapter_metadata"])
            if "lora_adapter_metadata" in metadata
            else None
        )
        if adapter_metadata is not None:
            if not isinstance(adapter_metadata, dict):
                raise ValueError("Video LoRA metadata must be an object")
            adapter_metadata = {
                key.removeprefix("transformer."): value
                for key, value in adapter_metadata.items()
            }
        profile = inspect_profile(addon, file_shapes)
        if (
            profile["dialect"] != "diffusers-peft"
            or profile["algorithm"] != "lora"
            or profile["networkAlphaCount"]
        ):
            raise ValueError("Choose a video LoRA in Diffusers PEFT Safetensors format")
        modules = dict(transformer.named_modules())
        target_names = []
        for key, shape in shapes.items():
            if not key.endswith((".lora_A.weight", ".lora_B.weight")):
                raise ValueError(f"Unsupported video LoRA tensor: {key}")
            if key.endswith(".lora_A.weight"):
                target = key.removesuffix(".lora_A.weight")
                module = modules.get(target)
                weight = getattr(module, "weight", None)
                output_shape = shapes[key.replace(".lora_A.weight", ".lora_B.weight")]
                if weight is None or tuple(weight.shape) != (output_shape[0], shape[1]):
                    raise ValueError(
                        f"Video LoRA does not match this model variant: {target}"
                    )
                target_names.append(target)
        state = {
            _runtime_key(key, original_wan): value
            for key, value in load_file(str(path), device="cpu").items()
        }
        transformer.load_lora_adapter(
            state,
            adapter_name=name,
            prefix=None,
            metadata=adapter_metadata,
            low_cpu_mem_usage=True,
        )
        loaded_targets = []
        for module_name, module in transformer.named_modules():
            if name in getattr(module, "lora_A", {}) and name in getattr(
                module, "lora_B", {}
            ):
                dtype = module.base_layer.weight.dtype
                if dtype in (torch.float8_e4m3fn, torch.float8_e5m2):
                    dtype = torch.bfloat16
                module.lora_A[name].to(dtype=dtype)
                module.lora_B[name].to(dtype=dtype)
                loaded_targets.append(module_name)
        if set(loaded_targets) != set(target_names):
            raise ValueError("The video model did not load every LoRA target")
        adapter_names.append(name)
        strengths.append(float(strength))
        applied.append(
            {
                "kind": "lora",
                "addonId": addon["addonId"],
                "digest": digest,
                "modelStrength": float(strength),
                "textEncoderStrength": None,
                "denoisingSchedule": None,
                "scheduleApplied": False,
                "adapterName": name,
                "loadedComponents": ["denoiser"],
                "loraProfile": profile,
            }
        )
    if adapter_names:
        transformer.set_adapters(adapter_names, weights=strengths)
        transformer.eval()
    return applied
