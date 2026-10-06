"""Offline DMAD/PDMD MiniMax-H3 video-worker integration.

Component loading and prompt encoding adapted from DMAD (Apache-2.0).
Copyright 2026 the DMAD authors. Machdoch modifications: staged offloading,
published checkpoint validation, worker progress and output integration.
See LICENSE-DMAD.txt and NOTICE-DMAD.txt.
"""

import gc
import json
from pathlib import Path

import torch

from media_h3_adapters import fuse_pairs, load_dmad_adapter, read_pairs
from media_h3_geometry import H3Geometry, latent_shape, packed_sequence
from media_h3_sampling import decode, rollout
from media_student_checkpoints import checkpoint_path


def validate_package(model, profile):
    if model.get("packageKind") != "diffusers-directory":
        raise ValueError("MiniMax-H3 students require a complete Diffusers folder")
    root = Path(model["path"]).resolve()
    index = json.loads((root / "model_index.json").read_text(encoding="utf-8"))
    if index.get("_class_name") != profile["pipeline"]:
        raise ValueError("Choose the full MiniMax-H3 text-to-audio-video folder")
    for name in ("transformer", "text_encoder", "tokenizer", "processor", "vae", "audio_vae", "scheduler", "audio_scheduler"):
        if not (root / name).is_dir():
            raise ValueError(f"Missing MiniMax-H3 component: {name}")
    if not (root / "LICENSE").is_file():
        raise ValueError("Include the MiniMax-H3 licence in the model folder")
    encoder = json.loads((root / "text_encoder/config.json").read_text(encoding="utf-8"))
    text = encoder.get("text_config") if isinstance(encoder, dict) else None
    if (
        not isinstance(text, dict)
        or encoder.get("model_type") != "qwen3_vl"
        or text.get("model_type") != "qwen3_vl_text"
        or type(text.get("num_hidden_layers")) is not int
        or text["num_hidden_layers"] != 64
        or type(text.get("hidden_size")) is not int
        or text["hidden_size"] != 5120
    ):
        raise ValueError("Choose the original MiniMax-H3 Qwen3-VL text encoder")
    geometry = H3Geometry.from_model_dir(root)
    return root, geometry, checkpoint_path(root, profile["distillation"])


def _release():
    gc.collect()
    torch.cuda.empty_cache()


@torch.inference_mode()
def _encode_prompt(root, prompt, device, offload):
    from transformers import Qwen2TokenizerFast, Qwen3VLForConditionalGeneration, Qwen3VLProcessor

    tokenizer = Qwen2TokenizerFast.from_pretrained(str(root / "tokenizer"), local_files_only=True, trust_remote_code=False)
    processor = Qwen3VLProcessor.from_pretrained(str(root / "processor"), local_files_only=True, trust_remote_code=False)
    encoder = Qwen3VLForConditionalGeneration.from_pretrained(
        str(root / "text_encoder"), dtype=torch.bfloat16, local_files_only=True,
        use_safetensors=True, trust_remote_code=False, low_cpu_mem_usage=True,
    ).eval().requires_grad_(False)
    try:
        if offload:
            from diffusers.hooks import apply_group_offloading

            apply_group_offloading(encoder.model, onload_device=torch.device(device), offload_device=torch.device("cpu"), offload_type="leaf_level", use_stream=False)
        else:
            encoder.to(device)
        tokens = tokenizer(prompt, add_special_tokens=False)["input_ids"]
        if not tokens:
            raise ValueError("The prompt produced no tokens")
        ids = torch.tensor([tokens], dtype=torch.long, device=device)
        token_types = torch.tensor(processor.create_mm_token_type_ids([tokens]), dtype=torch.long, device=device)
        result = encoder.model(input_ids=ids, attention_mask=torch.ones_like(ids), mm_token_type_ids=token_types, pixel_values=None, image_grid_thw=None, use_cache=False, output_hidden_states=True)
        return result.hidden_states[50].to(torch.bfloat16).cpu()
    finally:
        del encoder
        _release()


def render(model, profile, request, width, height, device, diffusers, progress):
    student = profile["distillation"]
    if device != "cuda":
        raise ValueError("MiniMax-H3 students need a CUDA or ROCm media runtime. Select an accelerated worker.")
    for class_name in ("MiniMaxH3Transformer3DModel", "AutoencoderKLMiniMaxH3", "AutoencoderKLMiniMaxH3Audio"):
        if not hasattr(diffusers, class_name):
            raise ValueError(f"The media runtime does not expose {class_name}. Repair runtime setup.")
    root, geometry, checkpoint = validate_package(model, profile)
    offload = request.get("memoryProfile") != "maximum-speed"
    progress("Encoding prompt", 0.06)
    embeddings = _encode_prompt(root, request["prompt"], device, offload)
    shape = latent_shape(height, width, request["numFrames"], geometry)
    layout = packed_sequence(embeddings.shape[1], shape, geometry).to(device)
    progress("Loading student transformer", 0.10)
    transformer = diffusers.MiniMaxH3Transformer3DModel.from_pretrained(
        str(root / "transformer"), dtype=torch.bfloat16, local_files_only=True,
        use_safetensors=True, trust_remote_code=False, low_cpu_mem_usage=True,
    ).eval().requires_grad_(False)
    try:
        pairs = read_pairs(checkpoint, student["method"])
        if student["method"] == "dmad":
            transformer = load_dmad_adapter(transformer, pairs)
        else:
            fuse_pairs(transformer, pairs)
        del pairs
        if offload:
            transformer.enable_group_offload(onload_device=torch.device(device), offload_device=torch.device("cpu"), offload_type="block_level", num_blocks_per_group=1, use_stream=False)
        else:
            transformer.to(device)
        video, audio = rollout(
            transformer, embeddings.to(device), layout, shape, geometry,
            {**student, "steps": profile["steps"]}, request["seed"], device,
            lambda step, total: progress(f"Denoising {step}/{total}", 0.12 + 0.64 * step / total),
        )
    finally:
        del transformer
        _release()
    del embeddings, layout
    progress("Decoding video and audio", 0.80)
    vae = diffusers.AutoencoderKLMiniMaxH3.from_pretrained(str(root / "vae"), local_files_only=True, use_safetensors=True).eval()
    vae.encoder = None
    vae.to(device=device, dtype=torch.float32)
    audio_vae = None
    try:
        audio_vae = diffusers.AutoencoderKLMiniMaxH3Audio.from_pretrained(str(root / "audio_vae"), local_files_only=True, use_safetensors=True).eval().to(device=device, dtype=torch.float32)
        frames, waveform, rate = decode(vae, audio_vae, video, audio, shape, geometry, device)
    finally:
        del vae, audio_vae
        _release()
    return frames, waveform, rate, []
