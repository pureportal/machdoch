from pathlib import Path
from typing import Any


def wan_model_paths(model: dict[str, Any]) -> tuple[Path, Path | None]:
    path = Path(model["path"])
    kind = model.get("packageKind")
    if kind == "single-file":
        if not path.is_absolute() or not path.is_file() or path.suffix != ".safetensors":
            raise ValueError("Select an existing Wan safetensors checkpoint")
        config = model.get("configPath")
        if not config:
            raise ValueError("Wan model components are missing. Verify the model to install them.")
        root = Path(config)
        checkpoint = path
    elif kind == "diffusers-directory":
        root = path
        checkpoint = None
    else:
        raise ValueError("Unsupported Wan model package")
    if not root.is_absolute() or not root.is_dir():
        raise ValueError("Wan model components must be an existing absolute directory")
    required = [
        "model_index.json",
        "transformer/config.json",
        "text_encoder/model.safetensors.index.json",
        "vae/diffusion_pytorch_model.safetensors",
        "scheduler/scheduler_config.json",
    ]
    if checkpoint is None:
        required.append("transformer/diffusion_pytorch_model.safetensors.index.json")
    missing = [name for name in required if not (root / name).is_file()]
    if missing:
        raise ValueError("Wan model package is incomplete; missing " + ", ".join(missing))
    return root, checkpoint


def load_wan_transformer(diffusers: Any, torch: Any, root: Path, checkpoint: Path | None) -> Any:
    options = {
        "torch_dtype": torch.bfloat16,
        "local_files_only": True,
        "low_cpu_mem_usage": True,
    }
    if checkpoint is not None:
        return diffusers.WanTransformer3DModel.from_single_file(
            str(checkpoint), config=str(root / "transformer"), **options,
        )
    return diffusers.WanTransformer3DModel.from_pretrained(
        str(root), subfolder="transformer", use_safetensors=True,
        trust_remote_code=False, **options,
    )
