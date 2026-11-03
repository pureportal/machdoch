"""Image-to-3D generation with Idol: one object image in, a 3D Gaussian splat PLY out."""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import time
from typing import Any

from PIL import Image, ImageOps

INPUT_KINDS = ("synthetic", "real")
MAX_SOURCE_PIXELS = 64_000_000
PREVIEW_SIZE = 768
PREVIEW_YAW_OFFSET = math.radians(-32)
PREVIEW_PITCH = math.radians(16)
PREVIEW_FOV = 30.0
VISIBLE_OPACITY = 0.1
MIN_VISIBLE_SHARE = 0.01


def _integer(request: dict[str, Any], key: str, minimum: int, maximum: int) -> int:
    value = request.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise ValueError(f"{key} must be an integer from {minimum} through {maximum}")
    return value


def _number(request: dict[str, Any], key: str, minimum: float, maximum: float) -> float:
    value = request.get(key)
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) \
            or not minimum <= value <= maximum:
        raise ValueError(f"{key} must be between {minimum} and {maximum}")
    return float(value)


def validate_request(request: dict[str, Any], schema_version: int) -> dict[str, Any]:
    if request.get("schemaVersion") != schema_version:
        raise ValueError("Unsupported 3D request schema")
    model = request.get("model")
    if not isinstance(model, dict) or model.get("architecture") != "idol" \
            or model.get("packageKind") != "idol-directory":
        raise ValueError("Install the Idol model package before generating")
    if request.get("inputKind") not in INPUT_KINDS:
        raise ValueError("inputKind must be synthetic or real")
    gaussians = _integer(request, "gaussianCount", 32_768, 1_048_576)
    if gaussians % 32:
        raise ValueError("gaussianCount must be a multiple of 32")
    return {
        "inputKind": request["inputKind"],
        "seed": _integer(request, "seed", 0, 9_007_199_254_740_991),
        "numInferenceSteps": _integer(request, "numInferenceSteps", 4, 100),
        "guidanceScale": _number(request, "guidanceScale", 0.0, 10.0),
        "timeShift": _number(request, "timeShift", 1.0, 6.0),
        "gaussianCount": gaussians,
        "minOpacity": _number(request, "minOpacity", 0.0, 0.5),
    }


def require_visible_object(gaussian: Any) -> None:
    if float((gaussian.opacity[:, 0] > VISIBLE_OPACITY).float().mean()) < MIN_VISIBLE_SHARE:
        raise ValueError("Idol returned an empty object. Generate again.")


def _load_source(path: Path) -> Image.Image:
    with Image.open(path) as opened:
        if opened.width * opened.height > MAX_SOURCE_PIXELS:
            raise ValueError("The source image is too large. Use an image under 64 megapixels.")
        image = ImageOps.exif_transpose(opened)
        has_alpha = image.mode in ("RGBA", "LA", "PA") or (image.mode == "P" and "transparency" in image.info)
        return image.convert("RGBA" if has_alpha else "RGB")


def _file_evidence(path: Path, **extra: Any) -> dict[str, Any]:
    data = path.read_bytes()
    return {"fileName": path.name, "digest": hashlib.sha256(data).hexdigest(), "byteSize": len(data), **extra}


def _load_pipeline(worker: Any, model: dict[str, Any], torch: Any, device: str, cache: Any) -> tuple[Any, float]:
    cached = cache.acquire({"model": model, "engine": "idol"})
    if cached is not None:
        return cached["pipeline"], 0.0
    from idol import IdolPipeline

    started = time.perf_counter()
    worker._progress("Loading Idol", 0.06)
    root = worker._absolute_existing_path(model["path"], file=False)
    pipeline = IdolPipeline(root, torch.device(device))
    cache.store({"pipeline": pipeline})
    return pipeline, time.perf_counter() - started


def generate(request: dict[str, Any], worker: Any, cache: Any) -> dict[str, Any]:
    settings = validate_request(request, worker.SCHEMA_VERSION)
    started = time.perf_counter()
    model = request["model"]
    source_path = worker._absolute_existing_path(request.get("sourceImagePath"), file=True)
    output_directory = worker._fresh_output_directory(request.get("outputDirectory"))
    torch, _ = worker._runtime()
    device, device_label, _ = worker._device(torch)
    if device not in ("cuda", "mps"):
        raise ValueError("Idol needs a supported GPU. Choose a Fleet device with one, or run on a machine with a GPU.")
    backend = worker._configure_amd_convolution_backend(torch, device)
    source = _load_source(source_path)
    pipeline, load_seconds = _load_pipeline(worker, model, torch, device, cache)
    generation_started = time.perf_counter()
    steps = settings["numInferenceSteps"]

    def report(stage: str, fraction: float) -> None:
        if stage == "background":
            worker._progress("Removing background", 0.16)
        elif stage == "encode":
            worker._progress("Reading the image", 0.22)
        elif stage == "sample" and fraction > 0:
            worker._progress(f"Sampling {round(fraction * steps)}/{steps}", 0.26 + 0.62 * fraction)
        elif stage == "decode":
            worker._progress("Placing Gaussians", 0.9)

    with torch.inference_mode():
        result = pipeline(
            source, mode=settings["inputKind"], seed=settings["seed"], steps=steps,
            cfg_strength=settings["guidanceScale"], rescale_t=settings["timeShift"],
            num_gaussians=settings["gaussianCount"], on_progress=report,
        )
        gaussian = result.gaussian
        require_visible_object(gaussian)
        if settings["minOpacity"] > 0:
            gaussian = gaussian.keep(gaussian.opacity[:, 0] >= settings["minOpacity"])
        if len(gaussian) == 0:
            raise ValueError("No visible Gaussians remained. Lower the cleanup threshold and retry.")
        worker._progress("Rendering preview", 0.94)
        from media_splat_render import framing, orbit_camera, render

        camera = result.camera
        center, radius = framing(gaussian, torch)
        preview = render(gaussian, torch, orbit_camera(camera["yaw"] + PREVIEW_YAW_OFFSET, PREVIEW_PITCH,
                                                       PREVIEW_FOV, center, radius), PREVIEW_SIZE)
        bounds_min = gaussian.xyz.min(dim=0).values.tolist()
        bounds_max = gaussian.xyz.max(dim=0).values.tolist()
        gaussian.save_ply(output_directory / "object.ply")
        count = len(gaussian)
    Image.fromarray(preview, mode="RGBA").save(output_directory / "preview.png", optimize=True)
    result.preprocessed_image.save(output_directory / "input.png", optimize=True)
    response = {
        "schemaVersion": worker.SCHEMA_VERSION, "workerVersion": worker.WORKER_VERSION,
        "modelArchitecture": model["architecture"], "modelRevision": model["revision"],
        "modelDigest": model["digest"], "device": device, "deviceLabel": device_label, "convBackend": backend,
        **settings,
        "output": _file_evidence(output_directory / "object.ply", gaussianCount=count,
                                 boundsMin=bounds_min, boundsMax=bounds_max),
        "input": _file_evidence(output_directory / "input.png", width=result.preprocessed_image.width,
                                height=result.preprocessed_image.height),
        "preview": _file_evidence(output_directory / "preview.png", width=PREVIEW_SIZE, height=PREVIEW_SIZE),
        "camera": {key: float(value) for key, value in camera.items()},
        "performance": {
            "loadSeconds": load_seconds,
            "generationSeconds": time.perf_counter() - generation_started,
            "totalSeconds": time.perf_counter() - started,
        },
    }
    json.dumps(response, allow_nan=False)
    del result, gaussian
    return response
