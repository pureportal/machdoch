import json
from pathlib import Path
from typing import Any

import torch
from transformers import LlamaForCausalLM, T5EncoderModel


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
            raise ValueError("HiDream NF4 requires a supported GPU")
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
