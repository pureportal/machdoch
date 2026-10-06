import argparse
import gc
import os
import subprocess
import sys
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import imageio_ffmpeg
import numpy as np
import torch
from PIL import Image
from safetensors import safe_open

from media_refmods import load_references, reference_map, token_count
from media_refmod_conditioning import prepare_saved_references, reference_step_schedule

from fizgig.minimax.audio_vae import audio_latents_from_rows, load_audio_vae
from fizgig.minimax.embedder import _add_h3_special_tokens, build_numbered_reference_tokens
from fizgig.minimax.loader import load_minimax_h3_dit
from fizgig.minimax.reference import reference_to_tensor, resize_reference
from fizgig.minimax.sampling import sample_image
from fizgig.minimax.trainer import load_preview_turbo, turbo_adaln_patch
from fizgig.minimax.video_vae_checkpoint import load_video_vae, verify_video_vae_checkpoint


def release():
    gc.collect()
    torch.cuda.empty_cache()


def save_audio(path, samples, rate):
    pcm = (samples.clamp(-1, 1).T.numpy() * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(pcm.shape[1])
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(pcm.tobytes())


def save_video(path, frames, audio_path):
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    height, width = frames.shape[-2:]
    command = [
        ffmpeg, "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}",
        "-r", "24", "-i", "-", "-i", str(audio_path), "-c:v", "libx264",
        "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
        "-af", "apad", "-t", str(frames.shape[1] / 24), str(path),
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for frame in frames.permute(1, 2, 3, 0):
            process.stdin.write((frame.clamp(0, 1).numpy() * 255).astype(np.uint8).tobytes())
        process.stdin.close()
        error = process.stderr.read().decode(errors="replace")
        if process.wait() != 0:
            raise RuntimeError(error[-2000:])
    finally:
        if process.poll() is None:
            process.kill()


def render(args, progress=None):
    model_path = args.models / "diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors"
    projection_path = args.small_te / "mmh3-4b-ClipProj-v3.1.safetensors"
    video_vae_path = args.models / "vae/minimax_h3_video_vae_fp16.safetensors"
    audio_vae_path = args.models / "vae/minimax_h3_audio_vae_fp32.safetensors"
    for path in (args.image, model_path, projection_path, video_vae_path, audio_vae_path, args.lora, args.style_lora):
        if path is None:
            continue
        if not path.is_file():
            raise FileNotFoundError(path)
    if args.width % 32 or args.height % 32 or args.frames < 124 or (args.frames - 5) % 17:
        raise ValueError("H3 requires dimensions divisible by 32 and frames on its 17n+5 grid")
    verify_video_vae_checkpoint(video_vae_path)
    references, evidence = load_references(args.ref_mods, args.ref_mod_max_tokens)
    if len(references) + int(args.image is not None) > 256:
        raise ValueError("Image and RefMods exceed 256 active reference blocks")
    image = None
    if args.image is not None:
        with Image.open(args.image) as source_image:
            image = resize_reference(source_image, args.width, args.height)
    image_tokens = (image.width // 32) * (image.height // 32) if image is not None else 0
    if args.ref_mod_max_tokens and evidence["tokens"] + image_tokens > args.ref_mod_max_tokens:
        raise ValueError("Image and RefMods exceed the token limit; reduce references or raise the token limit")
    references.sort(key=lambda reference: reference.kind == "audio")
    reference_latents, reference_items = [], []
    if args.image is not None:
        print("Encoding reference image", flush=True)
        video_encoder = load_video_vae(video_vae_path, "encode")
        with torch.no_grad(), torch.autocast("cuda", dtype=torch.float16):
            reference_latents.append(video_encoder.encode(reference_to_tensor(image).to("cuda", torch.float16)).float().cpu())
        reference_items.append({"type": "image", "data": image})
        del video_encoder
        release()
    if any(reference.kind != "audio" for reference in references):
        print("Decoding saved references for the text encoder", flush=True)
        reference_decoder = load_video_vae(video_vae_path, "decode")
        saved_items, saved_latents = prepare_saved_references(references, reference_decoder)
        del reference_decoder
        release()
    else:
        saved_items, saved_latents = prepare_saved_references(references, None)
    reference_items.extend(saved_items)
    ref_schedule = reference_step_schedule(references, reference_latents)
    reference_latents.extend(saved_latents)
    if not reference_latents:
        raise ValueError("Choose an image or enable a RefMod")
    evidence["totalConditioningTokens"] = sum(token_count("audio" if latent.ndim == 4 else "video", latent.shape) for latent in reference_latents)
    evidence["referenceMap"] = reference_map(references, image_count=int(args.image is not None))
    args.ref_mod_evidence = evidence

    print("Encoding prompt and image", flush=True)
    from transformers import AutoTokenizer, Qwen3VLForConditionalGeneration

    tokenizer = AutoTokenizer.from_pretrained(args.small_te)
    _add_h3_special_tokens(tokenizer)
    ids, token_tags, pixel_values, image_grid = build_numbered_reference_tokens(
        tokenizer, args.prompt, reference_items
    )
    text_encoder = Qwen3VLForConditionalGeneration.from_pretrained(
        args.small_te, dtype=torch.bfloat16, low_cpu_mem_usage=True
    ).to("cuda").eval()
    with torch.no_grad():
        vision_kwargs = {} if pixel_values is None else {
            "pixel_values": pixel_values.to("cuda", torch.bfloat16),
            "image_grid_thw": image_grid.to("cuda"),
        }
        hidden = text_encoder.model(
            input_ids=ids.to("cuda"),
            attention_mask=torch.ones_like(ids).to("cuda"),
            **vision_kwargs,
            mm_token_type_ids=(ids == text_encoder.config.image_token_id).long().to("cuda"),
            output_hidden_states=True,
        ).hidden_states[25]
        with safe_open(str(projection_path), framework="pt", device="cpu") as projection:
            values = {key: projection.get_tensor(key).to("cuda", torch.float32) for key in projection.keys()}
        text_embeddings = (
            ((hidden.float() - values["mean_in"]) / values["std_in"])
            @ values["W"] * values["std_out"] + values["mean_out"]
        )
        text_embeddings[:, 0] = values["sink_out"]
    text_embeddings = text_embeddings.cpu()
    token_tags = token_tags.cpu()
    del text_encoder
    release()

    print("Loading H3 transformer", flush=True)
    model = load_minimax_h3_dit(str(model_path), device="cuda", blocks_to_swap=args.swap_blocks, base_quant="int8")
    model.enable_block_swap(args.swap_blocks, h2d_only=False)
    lora_network, adaln_pairs = load_preview_turbo(model, str(args.lora), 1.0)
    lora_network.to("cuda", dtype=torch.bfloat16)
    for module in lora_network.unet_loras:
        module.enabled = True
    turbo_adaln_patch(model, adaln_pairs, "cuda", torch.bfloat16)
    style_network = None
    if args.style_lora is not None:
        style_network, style_adaln_pairs = load_preview_turbo(
            model, str(args.style_lora), args.style_strength, tag="style"
        )
        if style_adaln_pairs:
            raise ValueError("The selected style LoRA has unsupported AdaLN weights")
        style_network.to("cuda", dtype=torch.bfloat16)
        for module in style_network.unet_loras:
            module.enabled = True
    print("Denoising video and audio", flush=True)
    with torch.no_grad():
        video_latent, audio_latent = sample_image(
            model, text_embeddings.to("cuda", torch.bfloat16),
            width=args.width, height=args.height, num_frames=args.frames,
            steps=args.steps, shift=6.0, schedule_mode="reference", sampler="euler",
            cfg_scale=1.0, seed=args.seed, dtype=torch.bfloat16, ref_latents=reference_latents, ref_schedule=ref_schedule,
            text_token_tags=token_tags, return_audio=True, log_steps=True,
            on_denoised=(lambda step, total, _: progress(step, total)) if progress else None,
        )
    video_latent = video_latent.cpu()
    audio_latent = audio_latent.cpu()
    del model, lora_network, style_network, adaln_pairs, text_embeddings, token_tags, reference_latents, references, reference_items
    release()

    print("Decoding video", flush=True)
    video_decoder = load_video_vae(video_vae_path, "decode")
    with torch.no_grad(), torch.autocast("cuda", dtype=torch.float16):
        frames = video_decoder.decode_clip(video_latent.to("cuda").float())[0].cpu()
    del video_decoder, video_latent
    release()

    print("Decoding audio", flush=True)
    audio_decoder = load_audio_vae(audio_vae_path, "decode", device="cuda")
    with torch.no_grad():
        audio = audio_decoder.decode(audio_latents_from_rows(audio_latent).to("cuda", torch.float32))[0].cpu()
    rate = audio_decoder.sample_rate
    del audio_decoder, audio_latent
    release()

    return frames, audio, rate


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", type=Path)
    parser.add_argument("--ref-mod", action="append", default=[])
    parser.add_argument("--ref-mod-max-tokens", type=int, default=65536)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--lora", type=Path, required=True)
    parser.add_argument("--style-lora", type=Path)
    parser.add_argument("--style-strength", type=float, default=0.7)
    parser.add_argument("--small-te", type=Path, required=True)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=384)
    parser.add_argument("--frames", type=int, default=124)
    parser.add_argument("--steps", type=int, default=9)
    parser.add_argument("--seed", type=int, default=57)
    parser.add_argument("--swap-blocks", type=int, default=44)
    args = parser.parse_args()
    args.ref_mods = [{"path": str(Path(path).resolve())} for path in args.ref_mod]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    frames, audio, rate = render(args)

    audio_path = args.output.with_suffix(".wav")
    save_audio(audio_path, audio, rate)
    print("Muxing final video", flush=True)
    try:
        save_video(args.output, frames, audio_path)
    finally:
        audio_path.unlink(missing_ok=True)
    print(args.output, flush=True)


if __name__ == "__main__":
    main()
