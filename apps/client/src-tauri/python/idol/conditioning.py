from pathlib import Path

import torch
import torch.nn.functional as F
from safetensors.torch import load_file

IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


def dinov3_state_dict(timm_weights: dict[str, torch.Tensor], num_layers: int) -> dict[str, torch.Tensor]:
    """Rename the timm DINOv3 ViT checkpoint into the transformers DINOv3ViTModel layout.

    The fused qkv projection is split in q, k, v order. The checkpoint carries no query or value biases, and Meta's
    original release stores none either, so they are zero. The mask token is only used for masked training."""
    if len(timm_weights) != 6 + 15 * num_layers:
        raise ValueError('The DINOv3 checkpoint does not match the ViT-H+/16 layout')
    hidden = timm_weights['cls_token'].shape[-1]
    converted = {
        'embeddings.cls_token': timm_weights['cls_token'],
        'embeddings.mask_token': torch.zeros_like(timm_weights['cls_token']),
        'embeddings.register_tokens': timm_weights['reg_token'],
        'embeddings.patch_embeddings.weight': timm_weights['patch_embed.proj.weight'],
        'embeddings.patch_embeddings.bias': timm_weights['patch_embed.proj.bias'],
        'norm.weight': timm_weights['norm.weight'],
        'norm.bias': timm_weights['norm.bias'],
    }
    renamed = {
        'norm1.weight': 'norm1.weight', 'norm1.bias': 'norm1.bias',
        'norm2.weight': 'norm2.weight', 'norm2.bias': 'norm2.bias',
        'attn.proj.weight': 'attention.o_proj.weight', 'attn.proj.bias': 'attention.o_proj.bias',
        'gamma_1': 'layer_scale1.lambda1', 'gamma_2': 'layer_scale2.lambda1',
        'mlp.fc1_g.weight': 'mlp.gate_proj.weight', 'mlp.fc1_g.bias': 'mlp.gate_proj.bias',
        'mlp.fc1_x.weight': 'mlp.up_proj.weight', 'mlp.fc1_x.bias': 'mlp.up_proj.bias',
        'mlp.fc2.weight': 'mlp.down_proj.weight', 'mlp.fc2.bias': 'mlp.down_proj.bias',
    }
    for layer in range(num_layers):
        source, target = f'blocks.{layer}.', f'model.layer.{layer}.'
        for old, new in renamed.items():
            converted[target + new] = timm_weights[source + old]
        query, key, value = timm_weights[source + 'attn.qkv.weight'].split(hidden, dim=0)
        converted[target + 'attention.q_proj.weight'] = query
        converted[target + 'attention.k_proj.weight'] = key
        converted[target + 'attention.v_proj.weight'] = value
        converted[target + 'attention.q_proj.bias'] = torch.zeros(hidden, dtype=query.dtype)
        converted[target + 'attention.v_proj.bias'] = torch.zeros(hidden, dtype=value.dtype)
    return converted


def load_dinov3(directory: Path, dtype: torch.dtype, device: torch.device):
    from transformers import DINOv3ViTConfig, DINOv3ViTModel
    from transformers.initialization import no_init_weights

    config = DINOv3ViTConfig.from_json_file(str(directory / 'config.json'))
    with no_init_weights():
        model = DINOv3ViTModel(config)
    weights = dinov3_state_dict(load_file(str(directory / 'model.safetensors')), config.num_hidden_layers)
    model.load_state_dict(weights, strict=True, assign=True)
    for parameter in model.parameters():
        source = parameter.data.pin_memory() if device.type == 'cuda' else parameter.data
        parameter.data = source.to(device, non_blocking=True).to(dtype)
    return model.eval().requires_grad_(False).to(device)


class ImageEncoder:
    def __init__(self, dinov3_directory: Path, vae_directory: Path, device: torch.device):
        from diffusers.models import AutoencoderKLFlux2

        self.device = device
        self.dinov3 = load_dinov3(dinov3_directory, torch.bfloat16, device)
        self.flux2_vae = AutoencoderKLFlux2.from_pretrained(str(vae_directory), torch_dtype=torch.bfloat16,
                                                            local_files_only=True)
        self.flux2_vae = self.flux2_vae.eval().requires_grad_(False).to(device)

    def _dinov3_tokens(self, images):
        mean = torch.tensor(IMAGENET_MEAN, device=images.device).view(1, 3, 1, 1)
        std = torch.tensor(IMAGENET_STD, device=images.device).view(1, 3, 1, 1)
        images = (images.float() - mean) / std
        dtype = next(self.dinov3.parameters()).dtype
        tokens = self.dinov3(pixel_values=images.to(dtype)).last_hidden_state.float()
        return F.layer_norm(tokens, tokens.shape[-1:])

    def _flux2_tokens(self, images):
        vae = self.flux2_vae
        latents = vae.encode(images.to(torch.bfloat16) * 2 - 1).latent_dist.sample()
        batch, channels, height, width = latents.shape
        latents = latents.view(batch, channels, height // 2, 2, width // 2, 2).permute(0, 1, 3, 5, 2, 4)
        latents = latents.reshape(batch, channels * 4, height // 2, width // 2)
        mean = vae.bn.running_mean.view(1, -1, 1, 1).to(latents.device, latents.dtype)
        std = torch.sqrt(vae.bn.running_var.view(1, -1, 1, 1) + vae.config.batch_norm_eps).to(latents.device, latents.dtype)
        tokens = ((latents - mean) / std).float().flatten(2).transpose(1, 2).contiguous()
        padding = torch.zeros(batch, 5, tokens.shape[2], dtype=tokens.dtype, device=tokens.device)
        return torch.cat([padding, tokens], dim=1)

    @torch.no_grad()
    def __call__(self, images: torch.Tensor) -> dict[str, torch.Tensor]:
        """images: [B, 3, 1024, 1024] in [0, 1] -> feature1 (DINOv3 tokens) and feature2 (FLUX.2 VAE tokens)."""
        images = images.to(self.device)
        return {'feature1': self._dinov3_tokens(images), 'feature2': self._flux2_tokens(images)}
