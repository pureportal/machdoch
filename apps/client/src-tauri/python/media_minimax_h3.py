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

from fizgig.minimax.audio_vae import load_minimax_h3_audio_vae_decoder, unpack_audio
from fizgig.minimax.embedder import _add_h3_special_tokens, build_image_processor, build_numbered_reference_tokens
from fizgig.minimax.loader import load_minimax_h3_dit
from fizgig.minimax.reference import reference_to_tensor, resize_reference
from fizgig.minimax.sampling import sample_image
from fizgig.minimax.trainer import load_preview_turbo, turbo_adaln_patch
from fizgig.minimax.vae import IMAGENET_MEAN, IMAGENET_STD, MiniMaxH3VideoVAEDecoder, MiniMaxH3VideoVAEEncoder


def release(*objects):
    for item in objects:
        del item
    gc.collect()
    torch.cuda.empty_cache()


def load_video_vae(path, model_type):
    with torch.device("meta"):
        model = model_type()
    model.to_empty(device="cpu")
    wanted = set(model.state_dict())
    with safe_open(str(path), framework="pt", device="cpu") as checkpoint:
        state = {key: checkpoint.get_tensor(key) for key in checkpoint.keys() if key in wanted}
    missing, _ = model.load_state_dict(state, strict=False, assign=True)
    if missing:
        raise RuntimeError(f"Video VAE is missing weights: {missing[:5]}")
    model.register_buffer("pixel_mean", torch.tensor(IMAGENET_MEAN).view(1, 3, 1, 1, 1), persistent=False)
    model.register_buffer("pixel_std", torch.tensor(IMAGENET_STD).view(1, 3, 1, 1, 1), persistent=False)
    if isinstance(model, MiniMaxH3VideoVAEDecoder):
        count = model.decoder.pos_embed.inv_freq.numel()
        inverse_frequency = 100.0 ** (-torch.arange(count, dtype=torch.float32) / count)
        model.decoder.pos_embed.register_buffer("inv_freq", inverse_frequency, persistent=False)
    return model.to(device="cuda", dtype=torch.float16).eval()


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
        "-shortest", str(path),
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
    for path in (args.image, model_path, projection_path, video_vae_path, audio_vae_path, args.lora):
        if not path.is_file():
            raise FileNotFoundError(path)
    if args.width % 32 or args.height % 32 or args.frames < 124 or (args.frames - 5) % 17:
        raise ValueError("H3 requires dimensions divisible by 32 and frames on its 17n+5 grid")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    print("Encoding reference image", flush=True)
    image = resize_reference(Image.open(args.image), args.width, args.height)
    video_encoder = load_video_vae(video_vae_path, MiniMaxH3VideoVAEEncoder)
    with torch.no_grad(), torch.autocast("cuda", dtype=torch.float16):
        reference_latent = video_encoder.encode(reference_to_tensor(image).to("cuda", torch.float16)).float().cpu()
    del video_encoder
    release()

    print("Encoding prompt and image", flush=True)
    from transformers import AutoTokenizer, Qwen3VLForConditionalGeneration

    tokenizer = AutoTokenizer.from_pretrained(args.small_te)
    _add_h3_special_tokens(tokenizer)
    ids, token_tags, pixel_values, image_grid = build_numbered_reference_tokens(
        tokenizer, args.prompt, [{"type": "image", "data": image}]
    )
    text_encoder = Qwen3VLForConditionalGeneration.from_pretrained(
        args.small_te, dtype=torch.bfloat16, low_cpu_mem_usage=True
    ).to("cuda").eval()
    with torch.no_grad():
        hidden = text_encoder.model(
            input_ids=ids.to("cuda"),
            attention_mask=torch.ones_like(ids).to("cuda"),
            pixel_values=pixel_values.to("cuda", torch.bfloat16),
            image_grid_thw=image_grid.to("cuda"),
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
    print("Denoising video and audio", flush=True)
    with torch.no_grad():
        video_latent, audio_latent = sample_image(
            model, text_embeddings.to("cuda", torch.bfloat16),
            width=args.width, height=args.height, num_frames=args.frames,
            steps=args.steps, shift=6.0, schedule_mode="reference", sampler="euler",
            cfg_scale=1.0, seed=args.seed, dtype=torch.bfloat16, ref_latents=[reference_latent],
            text_token_tags=token_tags, return_audio=True, log_steps=True,
            on_denoised=(lambda step, total, _: progress(step, total)) if progress else None,
        )
    video_latent = video_latent.cpu()
    audio_latent = audio_latent.cpu()
    del model, lora_network, adaln_pairs, text_embeddings, token_tags, reference_latent
    release()

    print("Decoding video", flush=True)
    video_decoder = load_video_vae(video_vae_path, MiniMaxH3VideoVAEDecoder)
    with torch.no_grad(), torch.autocast("cuda", dtype=torch.float16):
        frames = video_decoder.decode_clip(video_latent.to("cuda").float())[0].cpu()
    del video_decoder, video_latent
    release()

    print("Decoding audio", flush=True)
    audio_decoder = load_minimax_h3_audio_vae_decoder(str(audio_vae_path), device="cuda")
    with torch.no_grad():
        audio = audio_decoder.decode(unpack_audio(audio_latent).to("cuda", torch.float32))[0].cpu()
    rate = audio_decoder.sample_rate
    del audio_decoder, audio_latent
    release()

    return frames, audio, rate


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--lora", type=Path, required=True)
    parser.add_argument("--small-te", type=Path, required=True)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=384)
    parser.add_argument("--frames", type=int, default=124)
    parser.add_argument("--steps", type=int, default=9)
    parser.add_argument("--seed", type=int, default=57)
    parser.add_argument("--swap-blocks", type=int, default=44)
    args = parser.parse_args()
    frames, audio, rate = render(args)

    audio_path = args.output.with_suffix(".wav")
    save_audio(audio_path, audio, rate)
    print("Muxing final video", flush=True)
    save_video(args.output, frames, audio_path)
    print(args.output, flush=True)


if __name__ == "__main__":
    main()
