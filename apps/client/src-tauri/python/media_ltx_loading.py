from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any


def load_checkpoint_timesteps(checkpoint: Path) -> list[float]:
    from safetensors import safe_open

    with safe_open(checkpoint, framework="pt", device="cpu") as weights:
        metadata = json.loads((weights.metadata() or {}).get("config", "{}"))
    steps = metadata.get("allowed_inference_steps")
    if (
        not isinstance(steps, list)
        or len(steps) != 8
        or any(
            isinstance(step, bool)
            or not isinstance(step, (int, float))
            or not math.isfinite(step)
            or not 0 < step <= 1
            for step in steps
        )
        or any(first <= second for first, second in zip(steps, steps[1:]))
    ):
        raise ValueError("LTX-Video checkpoint has invalid distilled timesteps")
    return [step * 1000 for step in steps]


def load_checkpoint_vae(diffusers: Any, checkpoint: Path, dtype: Any) -> Any:
    from accelerate import init_empty_weights
    from diffusers.loaders.single_file_utils import convert_ltx_vae_checkpoint_to_diffusers
    from safetensors import safe_open

    with safe_open(checkpoint, framework="pt", device="cpu") as weights:
        metadata = json.loads((weights.metadata() or {}).get("config", "{}"))
        if metadata.get("vae", {}).get("timestep_conditioning") is not True:
            raise ValueError("LTX-Video 0.9.8 requires a timestep-conditioned checkpoint VAE")
        state = {
            name: weights.get_tensor(name)
            for name in weights.keys()
            if name.startswith("vae.")
        }
    state = convert_ltx_vae_checkpoint_to_diffusers(state)
    with init_empty_weights():
        vae = diffusers.AutoencoderKLLTXVideo.from_config({
            "in_channels": 3,
            "out_channels": 3,
            "latent_channels": 128,
            "block_out_channels": (128, 256, 512, 1024, 2048),
            "down_block_types": ("LTXVideo095DownBlock3D",) * 4,
            "decoder_block_out_channels": (256, 512, 1024),
            "layers_per_block": (4, 6, 6, 2, 2),
            "decoder_layers_per_block": (5, 5, 5, 5),
            "spatio_temporal_scaling": (True,) * 4,
            "decoder_spatio_temporal_scaling": (True,) * 3,
            "decoder_inject_noise": (False,) * 4,
            "downsample_type": ("spatial", "temporal", "spatiotemporal", "spatiotemporal"),
            "upsample_residual": (True,) * 3,
            "upsample_factor": (2,) * 3,
            "timestep_conditioning": True,
            "patch_size": 4,
            "patch_size_t": 1,
            "resnet_norm_eps": 1e-6,
            "scaling_factor": 1.0,
            "encoder_causal": True,
            "decoder_causal": False,
            "spatial_compression_ratio": 32,
            "temporal_compression_ratio": 8,
        })
    vae.load_state_dict(state, strict=True, assign=True)
    vae.to(dtype=dtype)
    vae.eval()
    return vae
