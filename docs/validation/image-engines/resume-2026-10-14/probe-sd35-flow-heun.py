from __future__ import annotations

import json
import sys
from pathlib import Path

import diffusers
import torch


torch.set_num_threads(2)
torch.manual_seed(416)
transformer = diffusers.SD3Transformer2DModel(
    sample_size=16,
    patch_size=2,
    in_channels=4,
    out_channels=4,
    num_layers=2,
    attention_head_dim=16,
    num_attention_heads=2,
    joint_attention_dim=32,
    caption_projection_dim=32,
    pooled_projection_dim=32,
    pos_embed_max_size=32,
    dual_attention_layers=(0,),
    qk_norm="rms_norm",
)
vae = diffusers.AutoencoderKL(
    block_out_channels=(16, 32, 32),
    down_block_types=("DownEncoderBlock2D",) * 3,
    up_block_types=("UpDecoderBlock2D",) * 3,
    latent_channels=4,
    norm_num_groups=8,
)
pipeline = diffusers.StableDiffusion3Pipeline(
    transformer=transformer,
    vae=vae,
    scheduler=diffusers.FlowMatchHeunDiscreteScheduler(shift=3),
    text_encoder=None,
    tokenizer=None,
    text_encoder_2=None,
    tokenizer_2=None,
    text_encoder_3=None,
    tokenizer_3=None,
)
pipeline.set_progress_bar_config(disable=True)
callbacks = []


def step_end(pipe, step, timestep, values):
    callbacks.append({"step": step, "timestep": float(timestep)})
    return values


with torch.inference_mode():
    output = pipeline(
        prompt_embeds=torch.randn(1, 8, 32),
        negative_prompt_embeds=torch.randn(1, 8, 32),
        pooled_prompt_embeds=torch.randn(1, 32),
        negative_pooled_prompt_embeds=torch.randn(1, 32),
        width=64,
        height=64,
        num_inference_steps=4,
        guidance_scale=5,
        generator=torch.Generator(device="cpu").manual_seed(42),
        callback_on_step_end=step_end,
        output_type="latent",
    ).images
assert output.shape == (1, 4, 16, 16)
assert torch.isfinite(output).all()
assert len(callbacks) == 7
assert pipeline.scheduler.config.shift == 3
scheduler = diffusers.FlowMatchHeunDiscreteScheduler(shift=3)
scheduler.set_timesteps(4, device="cpu")
value = torch.zeros(1, 1)
initial_sigma = float(scheduler.sigmas[0])
for timestep in scheduler.timesteps:
    sigma = float(scheduler.sigmas[scheduler.step_index or 0])
    value = scheduler.step(torch.full_like(value, sigma), timestep, value).prev_sample
expected = -initial_sigma**2 / 2
error = abs(float(value) - expected)
assert error < 1e-4, (value, expected)
result = {
    "passed": True,
    "diffusersVersion": diffusers.__version__,
    "schedulerClass": type(pipeline.scheduler).__name__,
    "shift": pipeline.scheduler.config.shift,
    "requestedSteps": 4,
    "modelEvaluations": len(callbacks),
    "callbacks": callbacks,
    "latentShape": list(output.shape),
    "analyticalOdeError": error,
    "fullModelQualityVerified": False,
}
Path(sys.argv[1]).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
print(json.dumps(result), flush=True)
