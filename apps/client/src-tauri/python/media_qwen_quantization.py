from __future__ import annotations

from pathlib import Path
from typing import Any


def load_text_encoder(root: Path, dtype: Any) -> Any:
    from transformers import BitsAndBytesConfig, Qwen2_5_VLForConditionalGeneration

    return Qwen2_5_VLForConditionalGeneration.from_pretrained(
        str(root / "text_encoder"), dtype=dtype, device_map={"": "cpu"},
        quantization_config=BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=dtype,
        ), local_files_only=True, use_safetensors=True, trust_remote_code=False,
    )


def transformer_arguments(diffusers: Any, root: Path, index: dict[str, Any], dtype: Any) -> dict[str, Any]:
    specification = index.get("machdoch_quantization")
    if specification is None:
        return {}
    expected = {"transformer": {"format": "gguf", "file": "transformer/model.gguf"}}
    transformer_classes = {
        "QwenImagePipeline": "QwenImageTransformer2DModel",
        "QwenImage21Pipeline": "QwenImage21Transformer2DModel",
    }
    transformer_class = transformer_classes.get(index.get("_class_name"))
    if transformer_class is None or specification != expected:
        raise ValueError("The Qwen quantization manifest is invalid")
    checkpoint = root / "transformer" / "model.gguf"
    if not checkpoint.is_file() or checkpoint.is_symlink():
        raise ValueError("The Qwen GGUF transformer is missing")
    transformer = getattr(diffusers, transformer_class).from_single_file(
        str(checkpoint), config=str(root), subfolder="transformer",
        quantization_config=diffusers.GGUFQuantizationConfig(compute_dtype=dtype),
        dtype=dtype, local_files_only=True,
    )
    return {"transformer": transformer}
