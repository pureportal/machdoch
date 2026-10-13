from pathlib import Path
from types import SimpleNamespace
from typing import Any


def load_pipeline(diffusers: Any, root: Path, dtype: Any) -> Any:
    pipeline = diffusers.AnimaModularPipeline.from_pretrained(str(root), local_files_only=True)
    pipeline.load_components(dtype=dtype, pretrained_model_name_or_path=str(root), local_files_only=True, use_safetensors=True)
    return pipeline


def generate_image(pipeline: Any, arguments: dict[str, Any]) -> Any:
    inputs = dict(arguments)
    guidance = inputs.pop("guidance_scale")
    pipeline.update_components(guider=type(pipeline.guider).from_config(pipeline.guider.config, guidance_scale=guidance))
    images = pipeline(output="images", **inputs)
    return SimpleNamespace(images=images)
