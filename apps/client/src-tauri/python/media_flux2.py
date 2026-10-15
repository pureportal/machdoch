from __future__ import annotations

from pathlib import Path
from typing import Any


def load_pipeline(diffusers: Any, root: Path, index: dict[str, Any], dtype: Any) -> Any:
    from transformers import Mistral3ForConditionalGeneration

    components = {}
    quantization = index.get("machdoch_quantization")
    if quantization is not None:
        expected = {"transformer": {"format": "gguf", "file": "transformer/model.gguf"}}
        if quantization != expected:
            raise ValueError("The FLUX.2 Dev quantization manifest is invalid")
        checkpoint = root / "transformer/model.gguf"
        if not checkpoint.is_file() or checkpoint.is_symlink():
            raise ValueError("The FLUX.2 Dev GGUF transformer is missing")
        components["transformer"] = diffusers.Flux2Transformer2DModel.from_single_file(
            str(checkpoint), config=str(root), subfolder="transformer",
            quantization_config=diffusers.GGUFQuantizationConfig(compute_dtype=dtype),
            dtype=dtype, local_files_only=True,
        )
    components["text_encoder"] = Mistral3ForConditionalGeneration.from_pretrained(
        str(root / "text_encoder"), dtype=dtype, device_map={"": "cpu"},
        local_files_only=True, use_safetensors=True, trust_remote_code=False,
    )
    pipeline = diffusers.Flux2Pipeline.from_pretrained(
        str(root), dtype=dtype, local_files_only=True,
        use_safetensors=True, trust_remote_code=False, **components,
    )
    pipeline.set_progress_bar_config(disable=True)
    return pipeline
