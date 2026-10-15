import json
import math
from pathlib import Path
from typing import Any

import torch
from safetensors import safe_open
from transformers import LlamaForCausalLM, T5EncoderModel


def configure_image_dimensions(pipeline: Any, width: int, height: int) -> None:
    sample_size = math.sqrt(width * height) / pipeline.vae_scale_factor
    pipeline.default_sample_size = math.nextafter(sample_size, math.inf)
    patch_scale = pipeline.vae_scale_factor * pipeline.transformer.config.patch_size
    pipeline.transformer.max_seq = (width // patch_scale) * (height // patch_scale)


def validate_quantization_layout(directory: Path, configuration: dict[str, Any]) -> None:
    quantization = configuration["quantization_config"]
    expected_type = quantization.get("bnb_4bit_quant_type")
    excluded_modules = quantization.get("llm_int8_skip_modules") or []
    serialized_types = set()
    for filename in sorted(directory.glob("*.safetensors")):
        with safe_open(str(filename), framework="pt", device="cpu") as tensors:
            for name in tensors.keys():
                if ".weight.quant_state.bitsandbytes__" not in name:
                    continue
                module, quantization_type = name.split(".weight.quant_state.bitsandbytes__", 1)
                serialized_types.add(quantization_type)
                if any(excluded in module for excluded in excluded_modules):
                    raise ValueError(f"HiDream quantized layer {module} is excluded by its configuration. Correct the component configuration and import the package again.")
    if serialized_types and serialized_types != {expected_type}:
        actual_types = ", ".join(sorted(serialized_types))
        raise ValueError(f"HiDream weights use {actual_types}, but the component declares {expected_type}. Correct the component configuration and import the package again.")


def load_pipeline(diffusers: Any, root: Path, dtype: Any) -> Any:
    components = {}
    for name, component_class in (
        ("transformer", diffusers.HiDreamImageTransformer2DModel),
        ("text_encoder_3", T5EncoderModel),
        ("text_encoder_4", LlamaForCausalLM),
    ):
        directory = root / name
        configuration = json.loads((directory / "config.json").read_text(encoding="utf-8"))
        quantized = configuration.get("quantization_config", {}).get("quant_method") == "bitsandbytes"
        if quantized and not torch.cuda.is_available():
            raise ValueError("HiDream quantized weights require a supported GPU")
        if quantized:
            validate_quantization_layout(directory, configuration)
        options = {"device_map": {"": torch.cuda.current_device()}} if quantized else {}
        component = component_class.from_pretrained(
            str(directory), dtype=dtype, local_files_only=True,
            use_safetensors=True, trust_remote_code=False, **options,
        )
        if quantized:
            component.to("cpu")
            torch.cuda.empty_cache()
        components[name] = component
    return diffusers.HiDreamImagePipeline.from_pretrained(
        str(root), dtype=dtype, local_files_only=True,
        use_safetensors=True, trust_remote_code=False, **components,
    )
