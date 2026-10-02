from __future__ import annotations

import gc
import os
from pathlib import Path
import subprocess
import time
from typing import Any
import wave

import numpy as np
from PIL import Image, ImageOps

import media_open_models


def _mux_audio(destination: Path, audio: Any, sample_rate: int, duration: float) -> None:
    import imageio_ffmpeg

    waveform = audio.detach().float().cpu().numpy()[0]
    if waveform.ndim == 1:
        waveform = waveform[:, None]
    elif waveform.shape[0] <= 8:
        waveform = waveform.T
    if waveform.ndim != 2 or not 1 <= waveform.shape[1] <= 8 or not np.isfinite(waveform).all():
        raise ValueError("The model returned invalid audio")
    audio_path = destination.with_suffix(".wav")
    with wave.open(str(audio_path), "wb") as output:
        output.setnchannels(waveform.shape[1])
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes((waveform.clip(-1, 1) * 32767).astype("<i2").tobytes())
    muxed = destination.with_name("audio-muxed.webm")
    completed = subprocess.run([
        imageio_ffmpeg.get_ffmpeg_exe(), "-loglevel", "error", "-y",
        "-i", str(destination), "-i", str(audio_path), "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "libopus", "-af", "apad", "-t", str(duration), str(muxed),
    ], capture_output=True, text=True, timeout=900, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if completed.returncode != 0:
        raise ValueError(f"Audio encoding failed: {completed.stderr[-2000:]}")
    verified = subprocess.run([
        imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-i", str(muxed),
        "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-",
    ], capture_output=True, text=True, timeout=900, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if verified.returncode != 0:
        raise ValueError(f"Video and audio verification failed: {verified.stderr[-2000:]}")
    os.replace(muxed, destination)
    audio_path.unlink()


def generate(request: dict[str, Any], worker: Any) -> dict[str, Any]:
    started = time.perf_counter()
    if request.get("schemaVersion") != worker.SCHEMA_VERSION:
        raise worker.WorkerError("Unsupported worker request schema")
    model = request["model"]
    profile = media_open_models.PROFILES[model["architecture"]]
    if "video" not in profile:
        raise worker.WorkerError("Select a video model")
    prompt = worker._required_text(request, "prompt", 8_000) if profile.get("prompt", True) else request.get("prompt", "")
    if request.get("transparentBackground") or request.get("animatedBackground") is not None:
        raise worker.WorkerError("This video profile requires opaque output")
    if request.get("loopMode") != "none" and profile.get("audio"):
        raise worker.WorkerError("Choose a non-looping shot to keep generated audio synchronized")
    if request.get("loopMode") == "seamless":
        raise worker.WorkerError("Use a shot, boomerang, or crossfade with this video profile")
    if request.get("addons"):
        raise worker.WorkerError("This video profile does not support LoRAs")
    negative_prompt = request.get("negativePrompt", "")
    if not isinstance(negative_prompt, str) or len(negative_prompt) > 8_000:
        raise worker.WorkerError("negativePrompt must contain at most 8000 characters")
    if negative_prompt and not profile.get("negativePrompt", True):
        raise worker.WorkerError("This video profile does not accept a negative prompt")
    for name, minimum, maximum in (("fps", 1, 60), ("seed", 0, 2**63 - 1), ("numInferenceSteps", 1, 100)):
        value = request.get(name)
        if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
            raise worker.WorkerError(f"{name} must be an integer from {minimum} through {maximum}")
    guidance = request.get("guidanceScale")
    if not isinstance(guidance, (int, float)) or isinstance(guidance, bool) or not np.isfinite(guidance) or not 0 <= guidance <= 20:
        raise worker.WorkerError("Guidance must be between 0 and 20")
    width, height = worker._video_dimensions(request["aspectRatio"], request["resolution"], profile["architecture"])
    if (request.get("width") is None) != (request.get("height") is None):
        raise worker.WorkerError("Enter both video width and height")
    if request.get("width") is not None:
        width, height = request["width"], request["height"]
    multiple = profile.get("spatialMultiple", 8)
    if any(not isinstance(value, int) or isinstance(value, bool) or not 128 <= value <= 1536 or value % multiple for value in (width, height)):
        raise worker.WorkerError(f"Video dimensions must be divisible by {multiple} from 128 through 1536")
    first_path = request.get("firstFramePath")
    last_path = request.get("lastFramePath")
    image = last_image = None
    if first_path is not None:
        first_path = worker._absolute_existing_path(first_path, file=True)
        with Image.open(first_path) as source:
            image = ImageOps.fit(source.convert("RGB"), (width, height), method=Image.Resampling.LANCZOS)
    if last_path is not None:
        last_path = worker._absolute_existing_path(last_path, file=True)
        if image is None:
            raise worker.WorkerError("Choose an opening image before a closing image")
        if worker._sha256_file(first_path) != worker._sha256_file(last_path):
            with Image.open(last_path) as source:
                last_image = ImageOps.fit(source.convert("RGB"), (width, height), method=Image.Resampling.LANCZOS)
    torch, diffusers = worker._runtime()
    device, device_label, device_memory = worker._device(torch)
    backend = worker._configure_video_conv3d_backend(torch, device)
    memory = worker._start_video_memory_observation(torch, device)
    dtype = worker._pipeline_dtype(torch, device)
    generator = torch.Generator(device=device if device == "cuda" else "cpu").manual_seed(request["seed"])
    arguments = media_open_models.video_arguments(profile, request, image, last_image, width, height, generator)
    output_directory = worker._fresh_output_directory(request["outputDirectory"])
    worker._progress("Loading video model", 0.04)
    pipeline = media_open_models.load_pipeline(diffusers, model, dtype, image_conditioned=image is not None)
    if profile["guidanceParameter"] == "guider":
        pipeline.guider = diffusers.ClassifierFreeGuidance(guidance_scale=guidance)
    if device == "cuda":
        if request.get("memoryProfile") == "memory-saver":
            pipeline.enable_sequential_cpu_offload()
        elif request.get("memoryProfile") == "maximum-speed":
            pipeline.to(device)
        else:
            pipeline.enable_model_cpu_offload()
    else:
        pipeline.to(device)
    if hasattr(pipeline.vae, "enable_tiling"):
        pipeline.vae.enable_tiling()
    worker._progress("Generating video", 0.12)
    with torch.inference_mode():
        result = pipeline(**arguments)
    frames = result.frames[0]
    if len(frames) != request["numFrames"]:
        raise worker.WorkerError("The video model returned an unexpected frame count")
    audio = result.audio.detach().cpu() if profile.get("audio") else None
    sample_rate = pipeline.vocoder.config.output_sampling_rate if audio is not None else None
    del pipeline, result, arguments, generator
    gc.collect()
    if device == "cuda":
        torch.cuda.empty_cache()
    worker._progress("Encoding video", 0.86)
    destination, evidence, composite = worker._encode_video_webm(
        frames, output_directory, request["fps"], None, transparent_background=False,
        loop_mode=request["loopMode"], matte_quality=request["matteQuality"], encoding_quality=request["encodingQuality"],
    )
    if composite is not None:
        raise worker.WorkerError("Unexpected video composite")
    if audio is not None:
        _mux_audio(destination, audio, sample_rate, evidence["durationSeconds"])
    memory_evidence = worker._finish_video_memory_observation(torch, device, memory)
    worker._progress("Video complete", 1.0)
    return {
        "schemaVersion": worker.SCHEMA_VERSION, "workerVersion": worker.WORKER_VERSION,
        "packages": worker._package_versions(), "device": device, "deviceLabel": device_label,
        "deviceMemoryBytes": device_memory, "architecture": profile["architecture"], "addons": [],
        "performance": {"gpuMemory": memory_evidence, "timingSeconds": {"total": time.perf_counter() - started}},
        "conv3dBackend": backend,
        "conditioningMode": "native-text-to-video" if image is None else "native-first-last-frame" if last_image is not None else "native-first-frame",
        "conditioningFraming": None, "endpointRestoration": None, "loopEndpointRestoration": None,
        "loopBoundaryInspection": evidence.get("loopBoundaryInspection"),
        "prompt": prompt, "negativePrompt": negative_prompt,
        "negativePromptApplied": bool(negative_prompt) and guidance > 1,
        "resolution": request["resolution"], "requestedGuidanceScale": guidance, "guidanceScale": guidance,
        "requestedNumInferenceSteps": request["numInferenceSteps"], "numInferenceSteps": request["numInferenceSteps"],
        "transparentBackground": False, "modelRevision": model["revision"], "modelDigest": model["digest"],
        "output": {"index": 0, "fileName": destination.name, "seed": request["seed"], **evidence},
    }
