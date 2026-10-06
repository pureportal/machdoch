import re
from typing import Literal

import torch
from safetensors import SafetensorError, safe_open

from fizgig.krea2.safetensors_utils import MemoryEfficientSafeOpen
from fizgig.minimax.vae import H3VideoVAE


def verify_video_vae_checkpoint(path):
    try:
        with safe_open(str(path), framework="pt", device="cpu") as checkpoint:
            for name in ("encoder.conv_in.weight", "post_quant_conv.weight", "decoder.x_embedder.weight"):
                if name not in checkpoint.keys():
                    raise ValueError("MiniMax H3 video VAE is damaged. Redownload the video VAE.")
                weight = checkpoint.get_tensor(name)
                if not torch.isfinite(weight).all() or not torch.count_nonzero(weight):
                    raise ValueError("MiniMax H3 video VAE is damaged. Redownload the video VAE.")
    except SafetensorError as failure:
        raise ValueError("MiniMax H3 video VAE is incomplete or damaged. Redownload the video VAE.") from failure


def video_vae_source_key(name):
    name = re.sub(r"^encoder\.down_blocks\.(\d+)\.resnets\.(\d+)\.", r"encoder.down.\1.block.\2.", name)
    name = re.sub(r"^encoder\.down_blocks\.(\d+)\.downsamplers\.0\.", r"encoder.down.\1.downsample.", name)
    return (name.replace(".conv_shortcut.", ".nin_shortcut.")
            .replace("decoder.proj_in.", "decoder.x_embedder.")
            .replace(".attn.to_out.0.", ".attn.to_out.")
            .replace(".ff.net.0.proj.", ".ff.w1.")
            .replace(".ff.net.2.", ".ff.w2."))


def video_vae_weight_plan(model):
    plan = {}
    for name, weight in model.state_dict().items():
        match = re.search(r"\.attn\.to_([qkv])\.", name)
        if match:
            source = re.sub(r"\.attn\.to_[qkv]\.", ".attn.to_qkv.", name)
            shape = (weight.shape[0] * 3, *weight.shape[1:])
            projection = "qkv".index(match[1])
        else:
            source, shape, projection = video_vae_source_key(name), tuple(weight.shape), None
        entry = plan.setdefault(source, {"shape": tuple(shape), "targets": []})
        entry["targets"].append((name, projection))
    return plan


def load_video_vae(path, mode: Literal["encode", "decode"], device="cuda"):
    if mode not in ("encode", "decode"):
        raise ValueError("H3 video VAE mode must be encode or decode")
    try:
        with safe_open(str(path), framework="pt", device="cpu"):
            pass
    except SafetensorError as failure:
        raise ValueError("MiniMax H3 video VAE is incomplete or damaged. Redownload the video VAE.") from failure
    with MemoryEfficientSafeOpen(str(path)) as checkpoint:
        for name in ("latents_mean", "latents_std"):
            specification = checkpoint.header.get(name)
            if not specification or specification["shape"] != [24] or specification["dtype"] not in ("F16", "F32"):
                raise ValueError(f"H3 video VAE needs a floating-point [24] {name} tensor. Install the complete video checkpoint.")
        mean = checkpoint.get_tensor("latents_mean").float()
        standard_deviation = checkpoint.get_tensor("latents_std").float()
        if not torch.isfinite(mean).all() or not torch.isfinite(standard_deviation).all() or (standard_deviation <= 0).any():
            raise ValueError("H3 video VAE normalization is damaged. Replace the video checkpoint.")
        from diffusers import AutoencoderKLMiniMaxH3

        with torch.device("meta"):
            model = AutoencoderKLMiniMaxH3()
        for name in (("decoder", "post_quant_conv") if mode == "encode" else ("encoder", "quant_conv")):
            delattr(model, name)
        plan = video_vae_weight_plan(model)
        for name, entry in plan.items():
            specification = checkpoint.header.get(name)
            if not specification or tuple(specification["shape"]) != entry["shape"] or specification["dtype"] not in ("F16", "F32"):
                raise ValueError(f"H3 video VAE weight {name} is missing or incompatible. Install the complete video checkpoint.")
        if torch.device(device).type == "cuda":
            required_bytes = sum(parameter.numel() for parameter in model.parameters()) * 4
            free_bytes, _ = torch.cuda.mem_get_info(device)
            if required_bytes > free_bytes:
                component = "encoder" if mode == "encode" else "decoder"
                raise ValueError(f"H3 video {component} needs at least {required_bytes / 1024 ** 3:.1f} GiB of free GPU memory for weights. Close GPU applications or use a GPU with more memory.")
        state = {}
        for name, entry in plan.items():
            weight = checkpoint.get_tensor(name).float()
            if not torch.isfinite(weight).all():
                raise ValueError(f"H3 video VAE weight {name} is damaged. Replace the video checkpoint.")
            for target, projection in entry["targets"]:
                if projection is not None:
                    grouped = weight.reshape(model.config.decoder_num_attention_heads, 3, model.config.decoder_attention_head_dim, *weight.shape[1:])
                    state[target] = grouped[:, projection].flatten(0, 1).contiguous()
                elif ".ff.w1." in name:
                    gate, value = weight.chunk(2, dim=0)
                    state[target] = torch.cat([value, gate], dim=0)
                else:
                    state[target] = weight
        model.load_state_dict(state, strict=True, assign=True)
    if mode == "decode":
        model.decoder.rope = type(model.decoder.rope)(
            int(model.config.decoder_attention_head_dim * model.config.decoder_rope_dim_ratio),
            theta=model.config.decoder_rope_theta,
        )
    return H3VideoVAE(model, mean, standard_deviation, mode).eval().requires_grad_(False).to(device=device, dtype=torch.float32)
