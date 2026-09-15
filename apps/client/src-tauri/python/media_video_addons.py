from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Any, Callable


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
            shapes = {
                key: tuple(source.get_slice(key).get_shape()) for key in source.keys()
            }
            metadata = source.metadata() or {}
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
        profile = inspect_profile(addon, shapes)
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
                target = key.removeprefix("transformer.").removesuffix(".lora_A.weight")
                module = modules.get(target)
                weight = getattr(module, "weight", None)
                output_shape = shapes[key.replace(".lora_A.weight", ".lora_B.weight")]
                if weight is None or tuple(weight.shape) != (output_shape[0], shape[1]):
                    raise ValueError(
                        f"Video LoRA does not match this model variant: {target}"
                    )
                target_names.append(target)
        state = {
            key.removeprefix("transformer."): value
            for key, value in load_file(str(path), device="cpu").items()
        }
        if len(state) != len(shapes):
            raise ValueError("Video LoRA contains duplicate transformer targets")
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
