from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any


def validate_package(root: Path) -> Path:
    model_root = root / "model"
    config = json.loads((model_root / "config.json").read_text(encoding="utf-8"))
    if config.get("model_type") != "hunyuan_image_3_moe" or config.get("model_version") != "HunyuanImage-3.0":
        raise ValueError("Choose the original HunyuanImage 3.0 model package")
    if not (model_root / "model.safetensors.index.json").is_file():
        raise ValueError("The HunyuanImage 3.0 weight index is missing")
    return model_root


class HunyuanImage3Pipeline:
    def __init__(self, model: Any):
        self.model = model
        self.vae = model.vae

    @property
    def scheduler(self) -> Any:
        return self.model.pipeline.scheduler

    @scheduler.setter
    def scheduler(self, scheduler: Any) -> None:
        pipeline = self.model.pipeline
        self.model.scheduler = scheduler
        pipeline.scheduler = scheduler

    @classmethod
    def from_pretrained(cls, root: Path, dtype: Any) -> HunyuanImage3Pipeline:
        import torch
        model_root = validate_package(root)
        index = json.loads((model_root / "model.safetensors.index.json").read_text(encoding="utf-8"))
        weight_bytes = index["metadata"]["total_size"]
        if not isinstance(weight_bytes, int) or isinstance(weight_bytes, bool) or weight_bytes <= 0:
            raise ValueError("The HunyuanImage 3.0 weight size is invalid")
        memory = sum(torch.cuda.get_device_properties(device).total_memory for device in range(torch.cuda.device_count()))
        if memory < weight_bytes * 1.1:
            raise ValueError("HunyuanImage 3.0 weights exceed this device's GPU memory. Use a host with sufficient GPU memory; Tencent recommends 3 × 80 GB GPUs.")
        try:
            from hunyuan_image_3.modeling_hunyuan_image_3 import HunyuanImage3ForCausalMM
        except ModuleNotFoundError as error:
            raise ValueError("Install Tencent's HunyuanImage 3.0 runtime on a host covered by its licence before using this model.") from error
        model = HunyuanImage3ForCausalMM.from_pretrained(
            str(model_root), torch_dtype=dtype, attn_implementation="sdpa",
            device_map="auto", moe_impl="eager",
            local_files_only=True, use_safetensors=True,
        )
        model.load_tokenizer(str(model_root))
        return cls(model)

    def __call__(self, prompt: str, width: int, height: int, num_inference_steps: int,
                 guidance_scale: float, generator: Any, num_images_per_prompt: int = 1) -> Any:
        if num_images_per_prompt != 1:
            raise ValueError("HunyuanImage 3.0 generates one image per call")
        _, images = self.model.generate_image(
            prompt=prompt, seed=generator.initial_seed(), image_size=(height, width),
            diff_infer_steps=num_inference_steps, diff_guidance_scale=guidance_scale,
            bot_task="image", use_system_prompt="None", verbose=0,
        )
        return SimpleNamespace(images=images)
