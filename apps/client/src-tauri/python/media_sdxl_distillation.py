"""SDXL DMAD inference using the publisher's model-card sampling recipe.

Student provenance: https://huggingface.co/ZhengmingYu/DMAD.
SDXL weights remain subject to CreativeML Open RAIL++-M.
"""

import json
from pathlib import Path
from typing import Any

from media_student_checkpoints import checkpoint_path


def fold_spectral_weights(state: dict[str, Any]) -> dict[str, Any]:
    import torch

    marker = ".parametrizations.weight."
    suffixes = ("original", "0.u", "0.v", "0.gain")
    targets = {key.split(marker)[0] for key in state if marker in key}
    expected = {target + marker + suffix for target in targets for suffix in suffixes}
    if {key for key in state if marker in key} != expected:
        raise ValueError("The SDXL student has incomplete spectral-normalization parameters")
    result = {key: value for key, value in state.items() if marker not in key}
    with torch.no_grad():
        for target in sorted(targets):
            weight, left, right, gain = (state[target + marker + suffix] for suffix in suffixes)
            if (
                target + ".weight" in result or weight.ndim != 4
                or left.shape != (weight.shape[0],)
                or right.shape != (weight[0].numel(),) or gain.ndim != 0
            ):
                raise ValueError(f"Invalid SDXL spectral-normalization target: {target}")
            matrix = weight.float().flatten(1)
            next_right = torch.nn.functional.normalize(matrix.T.mv(left.float()), dim=0)
            next_left = torch.nn.functional.normalize(matrix.mv(next_right), dim=0)
            norm = (next_left * matrix.mv(next_right)).sum().clamp_min(1e-12)
            scale = gain.float() / norm
            if not torch.isfinite(scale):
                raise ValueError(f"Non-finite SDXL spectral-normalization gain: {target}")
            result[target + ".weight"] = (matrix * scale).reshape(weight.shape).to(weight.dtype)
    return result


def load_pipeline(diffusers: Any, root: Path, profile: dict, dtype: Any) -> Any:
    import torch
    from accelerate import init_empty_weights

    student_path = checkpoint_path(root, profile["distillation"])
    config = json.loads((root / "unet/config.json").read_text(encoding="utf-8"))
    if (
        config.get("in_channels") != 4
        or config.get("out_channels") != 4
        or config.get("cross_attention_dim") != 2048
        or config.get("addition_embed_type") != "text_time"
        or config.get("block_out_channels") != [320, 640, 1280]
    ):
        raise ValueError("Choose the SDXL base 1.0 components for this student")
    state = torch.load(student_path, map_location="cpu", weights_only=True, mmap=True)
    if not isinstance(state, dict) or not state or any(not isinstance(key, str) or not isinstance(value, torch.Tensor) for key, value in state.items()):
        raise ValueError("The SDXL student must contain a UNet tensor state dictionary")
    state = fold_spectral_weights(state)
    with init_empty_weights():
        unet = diffusers.UNet2DConditionModel.from_config(config)
    try:
        unet.load_state_dict(state, strict=True, assign=True)
    except RuntimeError as error:
        raise ValueError("The SDXL student does not match the base UNet") from error
    unet.to(dtype=dtype).eval().requires_grad_(False)
    pipeline = diffusers.StableDiffusionXLPipeline.from_pretrained(
        str(root), unet=unet, dtype=dtype, local_files_only=True,
        use_safetensors=True, trust_remote_code=False,
    )
    pipeline.scheduler = diffusers.LCMScheduler.from_config(pipeline.scheduler.config)
    return pipeline


def validate_request(request: dict, profile: dict) -> None:
    if request.get("negativePrompt", "").strip():
        raise ValueError(f"{profile['displayName']} does not use negative prompts")
    if request.get("addons"):
        raise ValueError(f"{profile['displayName']} does not accept add-ons")
    if any(request.get(key) for key in ("referenceImages", "baseImagePath", "maskImagePath", "editMask", "poseImagePath", "controlNet")):
        raise ValueError(f"{profile['displayName']} generates images from a prompt")
