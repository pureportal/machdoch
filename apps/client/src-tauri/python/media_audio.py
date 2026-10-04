from __future__ import annotations

import gc
import hashlib
from pathlib import Path
import time
from typing import Any
import wave

import numpy as np

import media_open_models


def validate_request(request: dict[str, Any], schema_version: int) -> None:
    if request.get("schemaVersion") != schema_version:
        raise ValueError("Unsupported audio request schema")
    model = request.get("model")
    if not isinstance(model, dict) or model.get("architecture") != "audioldm-2":
        raise ValueError("Choose an AudioLDM 2 model")
    for key, required in (("prompt", True), ("negativePrompt", False)):
        text = request.get(key, "")
        if not isinstance(text, str) or len(text) > 8_000 or (required and not text.strip()):
            raise ValueError(f"{key} must contain {'1–8000' if required else 'at most 8000'} characters")
    for key, minimum, maximum in (("seed", 0, 9_007_199_254_740_991), ("numInferenceSteps", 1, 200)):
        value = request.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
            raise ValueError(f"{key} must be an integer from {minimum} through {maximum}")
    for key, minimum, maximum in (("durationSeconds", 1, 30), ("guidanceScale", 0, 20)):
        value = request.get(key)
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not np.isfinite(value) or not minimum <= value <= maximum:
            raise ValueError(f"{key} must be between {minimum} and {maximum}")
    if request.get("addons"):
        raise ValueError("AudioLDM 2 does not accept LoRAs")


def write_waveform(destination: Path, waveform: Any, sample_rate: int, duration: float) -> dict[str, Any]:
    samples = np.asarray(waveform, dtype=np.float32)
    frames = round(sample_rate * duration)
    if samples.ndim != 1 or samples.size < frames or not np.isfinite(samples).all():
        raise ValueError("The model returned invalid or incomplete audio. Retry generation.")
    samples = samples[:frames]
    peak = float(np.abs(samples).max())
    rms = float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))
    if rms < 1e-7:
        raise ValueError("The model returned silent audio. Change the prompt or seed and retry.")
    gain = 1 / peak if peak > 1 else 1.0
    pcm = np.rint(samples * gain * 32767).astype("<i2")
    with wave.open(str(destination), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(pcm.tobytes())
    with wave.open(str(destination), "rb") as decoded:
        if decoded.getnframes() != frames or len(decoded.readframes(frames)) != frames * 2:
            raise ValueError("Audio encoding failed. Retry generation.")
    return {
        "fileName": destination.name, "sampleRate": sample_rate, "channels": 1,
        "frames": frames, "durationSeconds": frames / sample_rate,
        "digest": hashlib.sha256(destination.read_bytes()).hexdigest(),
        "byteSize": destination.stat().st_size, "peak": peak, "rms": rms, "gain": gain,
    }


def generate(request: dict[str, Any], worker: Any) -> dict[str, Any]:
    validate_request(request, worker.SCHEMA_VERSION)
    started = time.perf_counter()
    model = request["model"]
    worker._absolute_existing_path(model["path"], file=False)
    output_directory = worker._fresh_output_directory(request["outputDirectory"])
    torch, diffusers = worker._runtime()
    device, device_label, _ = worker._device(torch)
    backend = worker._configure_amd_convolution_backend(torch, device)
    worker._progress("Loading audio model", 0.12)
    pipeline = media_open_models.load_pipeline(diffusers, model, worker._pipeline_dtype(torch, device))
    pipeline.to(device)
    worker._enable_sampling_progress(pipeline)
    generator = torch.Generator(device="cpu").manual_seed(request["seed"])
    loaded_at = time.perf_counter()
    worker._progress("Preparing audio", 0.20)
    with torch.inference_mode():
        result = pipeline(
            prompt=request["prompt"], negative_prompt=request.get("negativePrompt", ""),
            audio_length_in_s=request["durationSeconds"], num_inference_steps=request["numInferenceSteps"],
            guidance_scale=request["guidanceScale"], generator=generator, num_waveforms_per_prompt=1,
        )
    worker._progress("Encoding audio", 0.92)
    sample_rate = int(pipeline.vocoder.config.sampling_rate)
    output = write_waveform(output_directory / "output-0000.wav", result.audios[0], sample_rate, request["durationSeconds"])
    output["seed"] = request["seed"]
    response = {
        "schemaVersion": worker.SCHEMA_VERSION, "workerVersion": worker.WORKER_VERSION,
        "modelArchitecture": model["architecture"], "modelRevision": model["revision"], "modelDigest": model["digest"],
        "device": device, "deviceLabel": device_label, "convBackend": backend,
        "prompt": request["prompt"], "negativePrompt": request.get("negativePrompt", ""),
        "numInferenceSteps": request["numInferenceSteps"], "guidanceScale": request["guidanceScale"],
        "output": output,
        "performance": {"loadSeconds": loaded_at - started, "generationSeconds": time.perf_counter() - loaded_at, "totalSeconds": time.perf_counter() - started},
    }
    del result, pipeline
    gc.collect()
    if device == "cuda":
        torch.cuda.empty_cache()
    return response
