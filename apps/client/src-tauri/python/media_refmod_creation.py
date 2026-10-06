import gc
import math
import subprocess
from pathlib import Path

from media_refmods import DEFAULT_TOKEN_BUDGET, MAX_FILE_BYTES, MAX_METADATA_BYTES, Reference, integer, save_destination, save_references, token_count
from media_refmod_models import vae_path


def compress_visual(latent, grid_size, refinement_steps, temporal_size=3):
    import torch
    import torch.nn.functional as functional

    integer(grid_size, "Compression grid", 2, 128)
    integer(refinement_steps, "Refinement steps", 0, 200)
    integer(temporal_size, "Latent frames", 1, 107)
    if grid_size % 2:
        raise ValueError("Compression grid must be even")
    height, width = latent.shape[-2:]
    scale = min(1, grid_size / max(height, width))
    target = (min(latent.shape[2], temporal_size), max(2, int(height * scale) // 2 * 2), max(2, int(width * scale) // 2 * 2))
    full = latent.detach().float()
    pooled = functional.adaptive_avg_pool3d(full, target)
    if refinement_steps:
        with torch.enable_grad():
            pooled = pooled.detach().requires_grad_(True)
            optimizer = torch.optim.Adam([pooled], lr=0.03)
            for _ in range(refinement_steps):
                optimizer.zero_grad()
                restored = functional.interpolate(pooled, size=full.shape[2:], mode="trilinear", align_corners=False)
                functional.mse_loss(restored, full).backward()
                optimizer.step()
    return pooled.detach()


def _source_path(value):
    if not isinstance(value, str):
        raise ValueError("Choose a source file")
    path = Path(value)
    if not path.is_absolute() or not path.is_file():
        raise ValueError("Choose an existing absolute source path")
    return path


def _video_frames(source, dimensions, max_frames):
    import imageio_ffmpeg
    import numpy as np
    from PIL import Image

    integer(max_frames, "Clip frames", 5, 362)
    if (max_frames - 5) % 17:
        raise ValueError("Clip frames must follow the 17n+5 grid: 5, 22, 39…")
    count = max_frames
    start = source.get("startSeconds", 0)
    if isinstance(start, bool) or not isinstance(start, (int, float)) or not math.isfinite(start) or start < 0:
        raise ValueError("Video start must be a non-negative number of seconds")
    width, height = dimensions
    command = [imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-ss", str(start),
               "-i", str(_source_path(source.get("path"))), "-an", "-vf",
               f"fps=24,scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height}",
               "-frames:v", str(count), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]
    completed = subprocess.run(command, capture_output=True, check=False, timeout=120)
    if completed.returncode:
        raise ValueError(f"Could not read video: {completed.stderr.decode(errors='replace')[-500:]}")
    size = width * height * 3
    frames = len(completed.stdout) // size
    if frames < 5:
        raise ValueError("Reference video needs at least five frames at 24 fps")
    frames = 5 + 17 * ((frames - 5) // 17)
    pixels = np.frombuffer(completed.stdout[:frames * size], dtype=np.uint8).reshape(frames, height, width, 3)
    return [Image.fromarray(frame) for frame in pixels]


def _audio_waveform(source, seconds):
    import imageio_ffmpeg
    import numpy as np
    import torch

    start = source.get("startSeconds", 0)
    if isinstance(start, bool) or not isinstance(start, (int, float)) or not math.isfinite(start) or start < 0:
        raise ValueError("Audio start must be a non-negative number of seconds")
    command = [imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-ss", str(start),
               "-i", str(_source_path(source.get("path"))), "-vn", "-t", str(seconds),
               "-ar", "32000", "-ac", "2", "-f", "f32le", "pipe:1"]
    completed = subprocess.run(command, capture_output=True, check=False, timeout=120)
    if completed.returncode:
        raise ValueError(f"Could not read audio: {completed.stderr.decode(errors='replace')[-500:]}")
    samples = np.frombuffer(completed.stdout, dtype=np.float32)
    if samples.size < 1600 or samples.size % 2 or not np.isfinite(samples).all():
        raise ValueError("Reference audio must contain at least 25 ms of finite stereo samples")
    return torch.from_numpy(samples.copy().reshape(-1, 2).T).unsqueeze(0).clamp(-1, 1)


def create(request):
    save_destination(request.get("outputPath"), request.get("name"))
    import torch
    from PIL import Image, ImageOps
    from fizgig.minimax.audio_vae import load_audio_vae
    from fizgig.minimax.video_vae_checkpoint import load_video_vae
    from fizgig.minimax.reference import reference_to_tensor

    sources = request.get("sources")
    if not isinstance(sources, list) or not 1 <= len(sources) <= 256:
        raise ValueError("Choose 1–256 image, video or audio sources")
    for source in sources:
        if not isinstance(source, dict) or source.get("kind") not in ("image", "video", "audio"):
            raise ValueError("Source kind must be image, video or audio")
        _source_path(source.get("path"))
        if source.get("maskPath"):
            _source_path(source["maskPath"])
    for field in ("concept", "description"):
        if not isinstance(request.get(field, ""), str):
            raise ValueError(f"RefMod {field} must be text")
    mode = request.get("mode", "encode")
    if mode not in ("encode", "compressed"):
        raise ValueError("Choose Full or Compressed")
    budget = integer(request.get("maxTokens", DEFAULT_TOKEN_BUDGET), "Token limit", 0, 1048576)
    frame_limit = integer(request.get("maxFrames", 22), "Clip frames", 5, 362)
    if (frame_limit - 5) % 17:
        raise ValueError("Clip frames must follow the 17n+5 grid: 5, 22, 39…")
    seconds = integer(request.get("maxSeconds", 30), "Audio seconds", 1, 300)
    width = integer(request.get("width", 512), "Reference width", 32, 2048)
    height = integer(request.get("height", 512), "Reference height", 32, 2048)
    if width % 32 or height % 32:
        raise ValueError("Reference dimensions must be multiples of 32")
    if mode == "compressed":
        grid = integer(request.get("gridSize", 16), "Compression grid", 2, 128)
        if grid % 2:
            raise ValueError("Compression grid must be even")
        integer(request.get("refinementSteps", 0), "Refinement steps", 0, 200)
        integer(request.get("temporalSize", 3), "Latent frames", 1, 107)
    if any(source["kind"] == "video" for source in sources) and width * height * frame_limit * 3 > 512 * 1024 * 1024:
        raise ValueError("Reference clip exceeds 512 MiB of decoded frames; reduce dimensions or frames")
    if not torch.cuda.is_available():
        raise ValueError("Creating H3 references requires a supported GPU and installed H3 VAEs")
    model_path = request.get("modelPath")
    if not isinstance(model_path, str) or not Path(model_path).is_absolute():
        raise ValueError("Choose the installed H3 model directory")
    models = Path(model_path)
    references, total, tensor_bytes = [], 0, 0
    visual_sources = [source for source in sources if source["kind"] != "audio"]
    audio_sources = [source for source in sources if source["kind"] == "audio"]
    video_checkpoint = vae_path(models, "video") if visual_sources else None
    audio_checkpoint = vae_path(models, "audio") if audio_sources else None
    if visual_sources:
        encoder = load_video_vae(video_checkpoint, "encode")
        try:
            for source in visual_sources:
                if source["kind"] == "video":
                    frames = _video_frames(source, (width, height), frame_limit)
                else:
                    with Image.open(source["path"]) as image:
                        frames = [ImageOps.fit(ImageOps.exif_transpose(image).convert("RGB"), (width, height), method=Image.Resampling.LANCZOS)]
                if source.get("maskPath"):
                    with Image.open(_source_path(source["maskPath"])) as mask_image:
                        mask = ImageOps.fit(ImageOps.exif_transpose(mask_image).convert("L"), (width, height), method=Image.Resampling.NEAREST)
                    frames = [Image.composite(frame, Image.new("RGB", frame.size), mask) for frame in frames]
                pixels = torch.stack([reference_to_tensor(frame)[0] for frame in frames], dim=1).unsqueeze(0)
                with torch.no_grad(), torch.autocast("cuda", dtype=torch.float16):
                    latent = encoder.encode(pixels.to("cuda", torch.float16)).float().cpu()
                if mode == "compressed":
                    latent = compress_visual(latent, request.get("gridSize", 16), request.get("refinementSteps", 0), request.get("temporalSize", 3))
                kind = source["kind"]
                tensor_bytes += latent.numel() * 4
                if tensor_bytes > MAX_FILE_BYTES - MAX_METADATA_BYTES:
                    raise ValueError("Created reference tensors exceed 512 MiB; reduce sources, dimensions or clip lengths")
                total += token_count(kind, latent.shape)
                if budget and total > budget:
                    raise ValueError(f"References need {total} tokens; reduce resolution, sources or clip length, or raise the token limit")
                metadata = {"kind": kind, "name": Path(source["path"]).stem, "mode": mode,
                            "source": str(source["path"]), "concept_type": request.get("concept", ""), "description": request.get("description", "")}
                references.append(Reference(latent.half(), metadata))
        finally:
            del encoder
            gc.collect()
            torch.cuda.empty_cache()
    if audio_sources:
        encoder = load_audio_vae(audio_checkpoint, "encode", device="cuda")
        try:
            for source in audio_sources:
                waveform = _audio_waveform(source, seconds)
                with torch.no_grad():
                    chunks = [encoder.encode(chunk.to("cuda", torch.float32)).cpu()
                              for chunk in waveform.split(320000, dim=-1)]
                latent = torch.cat(chunks, dim=-1)
                tensor_bytes += latent.numel() * 4
                if tensor_bytes > MAX_FILE_BYTES - MAX_METADATA_BYTES:
                    raise ValueError("Created reference tensors exceed 512 MiB; reduce sources, dimensions or audio duration")
                total += token_count("audio", latent.shape)
                if budget and total > budget:
                    raise ValueError(f"References need {total} tokens; shorten audio, reduce sources or raise the token limit")
                references.append(Reference(latent, {"kind": "audio", "name": Path(source["path"]).stem,
                                                     "sample_rate": 32000, "source": str(source["path"]),
                                                     "concept_type": request.get("concept", ""), "description": request.get("description", "")}))
        finally:
            del encoder
            gc.collect()
            torch.cuda.empty_cache()
    return save_references(references, request.get("outputPath", ""), request.get("name"), request.get("temporaryPath"))
