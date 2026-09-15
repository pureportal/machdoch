from __future__ import annotations

from pathlib import Path
import re
from typing import Any


def load_text_encoder_lora(
    pipeline: Any, path: Path, name: str, components: list[str]
) -> None:
    arguments = {
        "weight_name": path.name,
        "local_files_only": True,
        "return_lora_metadata": True,
    }
    if hasattr(pipeline, "unet"):
        state, alphas, metadata = pipeline.lora_state_dict(
            str(path.parent), unet_config=pipeline.unet.config, **arguments
        )
    else:
        state, alphas, metadata = pipeline.lora_state_dict(
            str(path.parent), return_alphas=True, **arguments
        )

    clip_prefixes = [
        prefix
        for prefix in ("text_encoder", "text_encoder_2")
        if type(getattr(pipeline, prefix, None)).__name__
        in ("CLIPTextModel", "CLIPTextModelWithProjection")
    ]

    def runtime_key(key: str) -> str:
        for prefix in clip_prefixes:
            key = key.replace(f"{prefix}.text_model.", f"{prefix}.", 1)
        return key

    def runtime_module_name(name: str) -> str:
        return re.sub(r"(?<!\w)text_model\\?\.", "", name, count=1)

    state = {runtime_key(key): tensor for key, tensor in state.items()}
    alphas = (
        {runtime_key(key): value for key, value in alphas.items()}
        if alphas is not None
        else None
    )
    metadata = (
        {runtime_key(key): value for key, value in metadata.items()}
        if metadata is not None
        else None
    )
    if metadata is not None:
        for prefix in clip_prefixes:
            for field in (
                "target_modules",
                "exclude_modules",
                "modules_to_save",
                "target_parameters",
                "layers_pattern",
            ):
                key = f"{prefix}.{field}"
                value = metadata.get(key)
                if isinstance(value, str):
                    metadata[key] = runtime_module_name(value)
                elif isinstance(value, list):
                    metadata[key] = [runtime_module_name(name) for name in value]
            for field in ("rank_pattern", "alpha_pattern"):
                key = f"{prefix}.{field}"
                value = metadata.get(key)
                if isinstance(value, dict):
                    metadata[key] = {
                        runtime_module_name(name): setting
                        for name, setting in value.items()
                    }
    if "denoiser" in components:
        if hasattr(pipeline, "unet"):
            pipeline.load_lora_into_unet(
                state,
                network_alphas=alphas,
                unet=pipeline.unet,
                adapter_name=name,
                metadata=metadata,
                _pipeline=pipeline,
                low_cpu_mem_usage=True,
            )
        else:
            pipeline.load_lora_into_transformer(
                state,
                network_alphas=alphas,
                transformer=pipeline.transformer,
                adapter_name=name,
                metadata=metadata,
                _pipeline=pipeline,
                low_cpu_mem_usage=True,
            )
    for component, prefix in (
        ("text-encoder", "text_encoder"),
        ("text-encoder-2", "text_encoder_2"),
    ):
        if component in components:
            pipeline.load_lora_into_text_encoder(
                state,
                network_alphas=alphas,
                text_encoder=getattr(pipeline, prefix),
                prefix=prefix,
                adapter_name=name,
                metadata=metadata,
                _pipeline=pipeline,
                low_cpu_mem_usage=True,
            )
