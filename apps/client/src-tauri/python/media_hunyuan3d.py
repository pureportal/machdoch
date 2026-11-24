"""Multi-view image-to-mesh generation with Tencent Hunyuan3D-2mv: up to four object views in, a GLB mesh out."""

from __future__ import annotations

import hashlib
import importlib
import importlib.machinery
import json
import math
from pathlib import Path
import sys
import time
import types
from typing import Any

from PIL import Image, ImageOps

TRANSFORMER_DIRECTORIES = {
    "hunyuan3d-2mv": "hunyuan3d-dit-v2-mv",
    "hunyuan3d-2mv-turbo": "hunyuan3d-dit-v2-mv-turbo",
}
TURBO_DECODER_DIRECTORY = "hunyuan3d-vae-v2-0-turbo"
RUNTIME_WHEEL = "hy3dgen/hy3dgen-2.0.2-py3-none-any.whl"
VIEWS = ("front", "left", "back", "right")
MAX_SOURCE_PIXELS = 64_000_000
PREVIEW_SIZE = 768
PREVIEW_YAW = math.radians(32)
PREVIEW_PITCH = math.radians(18)
PREVIEW_FOV = 30.0
MIN_COMPONENT_SHARE = 0.01


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
        raise ValueError("Unsupported 3D mesh request schema")
    model = request.get("model")
    if not isinstance(model, dict) or model.get("architecture") not in TRANSFORMER_DIRECTORIES \
            or model.get("packageKind") != "hunyuan3d-directory":
        raise ValueError("Install a Hunyuan3D-2mv model package before generating")
    views = request.get("views")
    if not isinstance(views, dict) or "front" not in views or any(view not in VIEWS for view in views):
        raise ValueError("Provide a front view and optional left, back, and right views")
    remove_floaters = request.get("removeFloaters")
    if not isinstance(remove_floaters, bool):
        raise ValueError("removeFloaters must be true or false")
    max_faces = request.get("maxFaceCount")
    if max_faces is not None:
        max_faces = _integer(request, "maxFaceCount", 1_000, 2_000_000)
    voxelize = request.get("voxelize")
    if not isinstance(voxelize, bool):
        raise ValueError("voxelize must be true or false")
    return {
        "views": sorted(views, key=VIEWS.index),
        "seed": _integer(request, "seed", 0, 9_007_199_254_740_991),
        "numInferenceSteps": _integer(request, "numInferenceSteps", 1, 100),
        "guidanceScale": _number(request, "guidanceScale", 0.0, 15.0),
        "octreeResolution": _integer(request, "octreeResolution", 64, 512),
        "numChunks": _integer(request, "numChunks", 1_000, 500_000),
        "removeFloaters": remove_floaters,
        "maxFaceCount": max_faces,
        "voxelize": voxelize,
        "voxelResolution": _integer(request, "voxelResolution", 8, 128),
        "voxelFill": _number(request, "voxelFill", 0.1, 0.9),
    }


def _load_view(path: Path) -> Image.Image:
    with Image.open(path) as opened:
        if opened.width * opened.height > MAX_SOURCE_PIXELS:
            raise ValueError("A view image is too large. Use images under 64 megapixels.")
        return ImageOps.exif_transpose(opened).convert("RGBA")


def _shape_generation_modules(root: Path) -> tuple[Any, Any]:
    wheel = root / RUNTIME_WHEEL
    if not wheel.is_file():
        raise ValueError("The Hunyuan3D runtime package is missing. Reinstall the model.")
    if str(wheel) not in sys.path:
        sys.path.insert(0, str(wheel))
    if "hy3dgen.shapegen" not in sys.modules:
        package = importlib.import_module("hy3dgen")
        location = str(wheel / "hy3dgen" / "shapegen")
        spec = importlib.machinery.ModuleSpec("hy3dgen.shapegen", None, is_package=True)
        spec.submodule_search_locations = [location]
        shape_generation = types.ModuleType("hy3dgen.shapegen")
        shape_generation.__spec__ = spec
        shape_generation.__path__ = [location]
        shape_generation.__package__ = "hy3dgen.shapegen"
        sys.modules["hy3dgen.shapegen"] = shape_generation
        package.shapegen = shape_generation
    pipelines = importlib.import_module("hy3dgen.shapegen.pipelines")
    autoencoders = importlib.import_module("hy3dgen.shapegen.models.autoencoders")
    return pipelines, autoencoders


def _load_pipeline(worker: Any, model: dict[str, Any], torch: Any, device: str, cache: Any) -> tuple[Any, float]:
    cached = cache.acquire({"model": model, "engine": "hunyuan3d"})
    if cached is not None:
        return cached["pipeline"], 0.0
    started = time.perf_counter()
    worker._progress("Loading Hunyuan3D", 0.06)
    root = worker._absolute_existing_path(model["path"], file=False)
    pipelines, autoencoders = _shape_generation_modules(root)
    transformer = root / TRANSFORMER_DIRECTORIES[model["architecture"]]
    pipeline = pipelines.Hunyuan3DDiTFlowMatchingPipeline.from_single_file(
        str(transformer / "model.fp16.safetensors"), str(transformer / "config.yaml"),
        device=device, dtype=torch.float16, use_safetensors=True,
    )
    if model["architecture"] == "hunyuan3d-2mv-turbo":
        decoder = root / TURBO_DECODER_DIRECTORY
        pipeline.vae = autoencoders.ShapeVAE.from_single_file(
            str(decoder / "model.fp16.safetensors"), str(decoder / "config.yaml"),
            device=device, dtype=torch.float16, use_safetensors=True,
        )
    cache.store({"pipeline": pipeline})
    return pipeline, time.perf_counter() - started


def _clean(mesh: Any, settings: dict[str, Any]) -> Any:
    import trimesh

    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.remove_unreferenced_vertices()
    mesh.merge_vertices()
    if settings["removeFloaters"]:
        components = mesh.split(only_watertight=False)
        if len(components) > 1:
            total = sum(len(component.faces) for component in components)
            mesh = trimesh.util.concatenate(
                [component for component in components if len(component.faces) >= total * MIN_COMPONENT_SHARE]
            )
    if not settings["voxelize"] and settings["maxFaceCount"] is not None             and len(mesh.faces) > settings["maxFaceCount"]:
        mesh = mesh.simplify_quadric_decimation(face_count=settings["maxFaceCount"])
    if len(mesh.faces) == 0:
        raise ValueError("Hunyuan3D returned an empty mesh. Use clearer views and generate again.")
    mesh.fix_normals()
    return mesh


def _file_evidence(path: Path, **extra: Any) -> dict[str, Any]:
    data = path.read_bytes()
    return {"fileName": path.name, "digest": hashlib.sha256(data).hexdigest(), "byteSize": len(data), **extra}


def generate(request: dict[str, Any], worker: Any, cache: Any) -> dict[str, Any]:
    settings = validate_request(request, worker.SCHEMA_VERSION)
    started = time.perf_counter()
    model = request["model"]
    views = {
        view: _load_view(worker._absolute_existing_path(request["views"][view], file=True))
        for view in settings["views"]
    }
    output_directory = worker._fresh_output_directory(request.get("outputDirectory"))
    torch, _ = worker._runtime()
    device, device_label, _ = worker._device(torch)
    if device not in ("cuda", "mps"):
        raise ValueError("Hunyuan3D needs a supported GPU. Choose a Fleet device with one, or run on a machine with a GPU.")
    backend = worker._configure_amd_convolution_backend(torch, device)
    pipeline, load_seconds = _load_pipeline(worker, model, torch, device, cache)
    generation_started = time.perf_counter()
    steps = settings["numInferenceSteps"]

    def report(step: int, _timestep: Any, _outputs: Any) -> None:
        worker._progress(f"Sampling {step + 1}/{steps}", 0.12 + 0.6 * (step + 1) / steps)

    worker._progress("Reading the views", 0.1)
    generator = torch.Generator(device="cpu").manual_seed(settings["seed"])
    meshes = pipeline(
        image=views, num_inference_steps=steps, guidance_scale=settings["guidanceScale"],
        generator=generator, octree_resolution=settings["octreeResolution"], num_chunks=settings["numChunks"],
        output_type="trimesh", enable_pbar=False, callback=report, callback_steps=1,
    )
    worker._progress("Cleaning the mesh", 0.86)
    mesh = _clean(meshes[0], settings)
    if settings["voxelize"]:
        worker._progress("Voxelizing", 0.89)
        from media_mesh_voxelize import voxelize

        mesh = voxelize(mesh, settings["voxelResolution"], settings["voxelFill"], settings["removeFloaters"])
    worker._progress("Rendering preview", 0.92)
    from media_mesh_render import framing, orbit_camera, render

    vertices = mesh.vertices.astype("float32")
    faces = mesh.faces.astype("int64")
    center, radius = framing(vertices)
    preview = render(vertices, faces, torch, device,
                     orbit_camera(PREVIEW_YAW, PREVIEW_PITCH, PREVIEW_FOV, center, radius), PREVIEW_SIZE)
    mesh.export(output_directory / "object.glb", file_type="glb")
    Image.fromarray(preview, mode="RGBA").save(output_directory / "preview.png", optimize=True)
    response = {
        "schemaVersion": worker.SCHEMA_VERSION, "workerVersion": worker.WORKER_VERSION,
        "modelArchitecture": model["architecture"], "modelRevision": model["revision"],
        "modelDigest": model["digest"], "device": device, "deviceLabel": device_label, "convBackend": backend,
        **settings,
        "output": _file_evidence(output_directory / "object.glb", faceCount=int(len(mesh.faces)),
                                 vertexCount=int(len(mesh.vertices)),
                                 boundsMin=[float(value) for value in mesh.bounds[0]],
                                 boundsMax=[float(value) for value in mesh.bounds[1]]),
        "preview": _file_evidence(output_directory / "preview.png", width=PREVIEW_SIZE, height=PREVIEW_SIZE),
        "performance": {
            "loadSeconds": load_seconds,
            "generationSeconds": time.perf_counter() - generation_started,
            "totalSeconds": time.perf_counter() - started,
        },
    }
    json.dumps(response, allow_nan=False)
    del meshes, mesh
    return response
