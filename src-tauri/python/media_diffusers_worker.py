"""Isolated local Diffusers image and video worker for Media Studio.

The desktop process passes only absolute, application-owned paths. Hub access and
remote code are disabled before importing ML libraries. The worker emits exactly
one bounded JSON document on stdout and writes image payloads to a fresh staging
directory selected by the desktop process.
"""

from __future__ import annotations

import gc
import hashlib
import importlib.metadata
import inspect
import json
import math
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile
import time
import traceback
import types
from typing import Any

from PIL import Image

WORKER_VERSION = "media-diffusers-worker/1.31.0"
# Disk group files contain only checkpoint/adapter tensors. Keep their
# compatibility identity independent from response/provenance releases until
# that serialization contract itself changes.
OFFLOAD_CACHE_COMPATIBILITY_VERSION = "media-diffusers-worker/1.19.0"
KREA_IDENTITY_EDIT_V1_2_R64_DIGEST = (
    "f794b47142555c929cf536a2f1e4f335174b9aedbb08572b07d45814d4242423"
)
SCHEMA_VERSION = 4
MIN_EXPERIMENTAL_VIDEO_MEMORY_BYTES = 15 * 1024**3
LTX_13B_MIN_MEMORY_BYTES = 15 * 1024**3
FRAMEPACK_MIN_MEMORY_BYTES = 6 * 1024**3
FRAMEPACK_MIN_PHYSICAL_MEMORY_BYTES = 30 * 1024**3
FRAMEPACK_BFLOAT16_MEMORY_BYTES = 32 * 1024**3
HUNYUAN_VIDEO_15_MIN_MEMORY_BYTES = 14 * 1024**3
HUNYUAN_VIDEO_15_MIN_PHYSICAL_MEMORY_BYTES = 30 * 1024**3
LTX_DISTILLED_TIMESTEPS = (1000, 993, 987, 981, 975, 909, 725, 0.03)
LTX_REFINEMENT_TIMESTEPS = (1000, 909, 725, 421, 0)
LORA_TENSOR_PAIRS = (
    (".lora_down.weight", ".lora_up.weight"),
    (".lora_a.weight", ".lora_b.weight"),
    (".lora_a.default.weight", ".lora_b.default.weight"),
    (".lora_down.default.weight", ".lora_up.default.weight"),
)
LORA_MAGNITUDE_SUFFIXES = (
    ".dora_scale",
    ".dora_scale.weight",
    ".lora_magnitude_vector",
    ".lora_magnitude_vector.weight",
    ".lora_magnitude_vector.default.weight",
)
SUPPORTED_ARCHITECTURES = (
    "stable-diffusion-1",
    "stable-diffusion-2",
    "stable-diffusion-xl",
    "stable-diffusion-3",
    "flux-1",
    "flux-2",
    "framepack-i2v",
    "hunyuan-video-1.5-i2v",
    "krea-2",
    "ltx-video",
    "wan-2.2-ti2v",
)
REQUIRED_PACKAGES = (
    "torch",
    "diffusers",
    "transformers",
    "sentencepiece",
    "protobuf",
    "accelerate",
    "peft",
    "safetensors",
    "Pillow",
    "imageio-ffmpeg",
)
ACCEPTED_PACKAGE_VERSIONS = {
    # Torch is selected with the accelerator bundle. AMD's current supported
    # Windows wheel deliberately trails the generic runtime contract.
    "torch": ("2.13.0", "2.12.0+rocm7.14.0"),
    "diffusers": ("0.39.0",),
    "transformers": ("5.13.0",),
    "sentencepiece": ("0.2.2",),
    "protobuf": ("7.35.1",),
    "accelerate": ("1.14.0",),
    "peft": ("0.19.1",),
    "safetensors": ("0.8.0",),
    "pillow": ("12.3.0",),
    "imageio-ffmpeg": ("0.6.0",),
}

# Never resolve model components or custom Python code over the network.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("DO_NOT_TRACK", "1")


class WorkerError(Exception):
    pass


def _package_versions() -> dict[str, str | None]:
    versions: dict[str, str | None] = {}
    for name in REQUIRED_PACKAGES:
        try:
            versions[name.lower()] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name.lower()] = None
    return versions


def _runtime() -> tuple[Any, Any]:
    try:
        import torch
        import diffusers
    except Exception as error:  # import failures are a readiness result
        raise WorkerError(f"The pinned Diffusers runtime could not be imported: {error}") from error
    return torch, diffusers


def _select_cuda_device(torch: Any) -> int:
    device_count = int(torch.cuda.device_count())
    if device_count < 1:
        raise WorkerError("PyTorch reported CUDA availability without a CUDA device")
    requested = os.environ.get("MACHDOCH_MEDIA_CUDA_DEVICE")
    if requested is not None:
        try:
            index = int(requested)
        except ValueError as error:
            raise WorkerError(
                "MACHDOCH_MEDIA_CUDA_DEVICE must be a numeric CUDA device index"
            ) from error
        if not 0 <= index < device_count:
            raise WorkerError(
                f"MACHDOCH_MEDIA_CUDA_DEVICE={index} is outside the available device range"
            )
        return index

    # Prefer the adapter with the largest usable memory. This is important on
    # hybrid AMD systems where torch.cuda defaults to the integrated adapter.
    return max(
        range(device_count),
        key=lambda index: (
            int(torch.cuda.get_device_properties(index).total_memory),
            0 if "graphics" in str(torch.cuda.get_device_name(index)).lower() else 1,
            -index,
        ),
    )


def _device(torch: Any) -> tuple[str, str, int | None]:
    if torch.cuda.is_available():
        index = _select_cuda_device(torch)
        torch.cuda.set_device(index)
        memory = int(torch.cuda.get_device_properties(index).total_memory)
        return "cuda", f"{torch.cuda.get_device_name(index)} (cuda:{index})", memory
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps", "Apple Metal Performance Shaders", None
    return "cpu", platform.processor() or platform.machine(), None


def probe() -> dict[str, Any]:
    versions = _package_versions()
    physical_memory = _physical_memory_bytes()
    missing = [name for name, version in versions.items() if version is None]
    mismatched = [
        f"{name}={version} (expected one of {', '.join(ACCEPTED_PACKAGE_VERSIONS[name])})"
        for name, version in versions.items()
        if version is not None and version not in ACCEPTED_PACKAGE_VERSIONS[name]
    ]
    if missing or mismatched:
        problems = []
        if missing:
            problems.append("missing " + ", ".join(missing))
        if mismatched:
            problems.append("version mismatch " + ", ".join(mismatched))
        return {
            "schemaVersion": SCHEMA_VERSION,
            "workerVersion": WORKER_VERSION,
            "ready": False,
            "pythonVersion": platform.python_version(),
            "packages": versions,
            "device": None,
            "deviceLabel": None,
            "deviceMemoryBytes": None,
            "physicalMemoryBytes": physical_memory,
            "architectures": list(SUPPORTED_ARCHITECTURES),
            "capabilities": [
                "lora",
                "textual-inversion",
                "multi-lora",
                "local-image-edit",
                "krea2-grounded-reference-edit",
                "image-to-video",
                "start-end-to-video",
                "vp9-alpha",
                "alpha-video",
                "temporal-chroma-matte",
                "video-quality-presets",
                "non-looping-video",
                "seamless-video-loop",
                "video-composite",
            ],
            "diagnostic": "Pinned Python runtime is not ready: " + "; ".join(problems),
        }
    try:
        torch, _ = _runtime()
        device, label, memory = _device(torch)
    except WorkerError as error:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "workerVersion": WORKER_VERSION,
            "ready": False,
            "pythonVersion": platform.python_version(),
            "packages": versions,
            "device": None,
            "deviceLabel": None,
            "deviceMemoryBytes": None,
            "physicalMemoryBytes": physical_memory,
            "architectures": list(SUPPORTED_ARCHITECTURES),
            "capabilities": [
                "lora",
                "textual-inversion",
                "multi-lora",
                "local-image-edit",
                "krea2-grounded-reference-edit",
                "image-to-video",
                "start-end-to-video",
                "vp9-alpha",
                "alpha-video",
                "temporal-chroma-matte",
                "video-quality-presets",
                "non-looping-video",
                "seamless-video-loop",
                "video-composite",
            ],
            "diagnostic": str(error),
        }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "workerVersion": WORKER_VERSION,
        "ready": True,
        "pythonVersion": platform.python_version(),
        "packages": versions,
        "device": device,
        "deviceLabel": label,
        "deviceMemoryBytes": memory,
        "physicalMemoryBytes": physical_memory,
        "architectures": list(SUPPORTED_ARCHITECTURES),
        "capabilities": [
            "lora",
            "textual-inversion",
            "multi-lora",
            "local-image-edit",
            "krea2-grounded-reference-edit",
            "image-to-video",
            "start-end-to-video",
            "vp9-alpha",
            "alpha-video",
            "temporal-chroma-matte",
            "video-quality-presets",
            "non-looping-video",
            "seamless-video-loop",
            "video-composite",
        ],
        "diagnostic": "Pinned local Diffusers imports succeeded.",
    }


def _required_text(container: dict[str, Any], key: str, maximum: int) -> str:
    value = container.get(key)
    if not isinstance(value, str) or not value.strip():
        raise WorkerError(f"{key} is required")
    value = value.strip()
    if len(value) > maximum or any(ord(character) < 32 for character in value):
        raise WorkerError(f"{key} is invalid")
    return value


def _absolute_existing_path(value: Any, *, file: bool) -> Path:
    if not isinstance(value, str):
        raise WorkerError("A managed absolute path is required")
    path = Path(value)
    if not path.is_absolute() or not path.exists() or path.is_symlink():
        raise WorkerError("A managed path is missing, relative, or symbolic")
    if file != path.is_file():
        raise WorkerError("A managed path has the wrong package shape")
    return path.resolve(strict=True)


def _fresh_output_directory(value: Any) -> Path:
    if not isinstance(value, str):
        raise WorkerError("outputDirectory is required")
    path = Path(value)
    if not path.is_absolute() or path.is_symlink() or not path.is_dir():
        raise WorkerError("outputDirectory must be a managed absolute directory")
    if any(path.iterdir()):
        raise WorkerError("outputDirectory must be empty")
    return path.resolve(strict=True)


def _krea_runtime_paths(config_path: Path) -> tuple[Path, Path]:
    manifest_path = config_path / "krea-runtime.json"
    if not manifest_path.is_file() or manifest_path.is_symlink():
        raise WorkerError(
            "KREA runtime manifest is missing; re-import the checkpoint after "
            "installing models/krea-2/runtime"
        )
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise WorkerError(f"KREA runtime manifest is invalid: {error}") from error
    if (
        not isinstance(manifest, dict)
        or manifest.get("schemaVersion") != 1
        or manifest.get("textEncoder", {}).get("revision")
        != "ebb281ec70b05090aa6165b016eac8ec08e71b17"
        or manifest.get("vae", {}).get("revision")
        != "75e0b4be04f60ec59a75f475837eced720f823b6"
    ):
        raise WorkerError("KREA runtime manifest does not pin the supported revisions")
    runtime_root = _absolute_existing_path(manifest.get("runtimeRoot"), file=False)
    text_root = runtime_root / "qwen3-vl"
    vae_root = runtime_root / "qwen-image" / "vae"
    required = (
        text_root / "config.json",
        text_root / "tokenizer_config.json",
        text_root / "tokenizer.json",
        text_root / "model.safetensors.index.json",
        text_root / "model-00001-of-00002.safetensors",
        text_root / "model-00002-of-00002.safetensors",
        vae_root / "config.json",
        vae_root / "diffusion_pytorch_model.safetensors",
    )
    missing = [
        path.relative_to(runtime_root).as_posix()
        for path in required
        if not path.is_file() or path.is_symlink() or path.stat().st_size == 0
    ]
    if missing:
        raise WorkerError("KREA runtime bundle is incomplete; missing " + ", ".join(missing))
    if sum(path.stat().st_size for path in required) < 8_500_000_000:
        raise WorkerError("KREA runtime bundle is truncated")
    return text_root, vae_root


def _krea_state_key(source_key: str) -> str:
    key = source_key.removeprefix("model.diffusion_model.")
    suffix = ""
    for candidate in (".weight", ".bias", ".scale", ".lin"):
        if key.endswith(candidate):
            key, suffix = key[: -len(candidate)], candidate
            break
    standalone = {
        "first": "img_in",
        "last.linear": "final_layer.linear",
        "last.norm": "final_layer.norm",
        "last.modulation": "final_layer.scale_shift_table",
        "tmlp.0": "time_embed.linear_1",
        "tmlp.2": "time_embed.linear_2",
        "tproj.1": "time_mod_proj",
        "txtmlp.0": "txt_in.norm",
        "txtmlp.1": "txt_in.linear_1",
        "txtmlp.3": "txt_in.linear_2",
        "txtfusion.projector": "text_fusion.projector",
    }
    block_match = re.fullmatch(r"blocks\.(\d+)\.(.*)", key)
    text_match = re.fullmatch(
        r"txtfusion\.(layerwise_blocks|refiner_blocks)\.(\d+)\.(.*)", key
    )
    module_map = {
        "prenorm": "norm1",
        "postnorm": "norm2",
        "mod": "scale_shift_table",
        "attn.wq": "attn.to_q",
        "attn.wk": "attn.to_k",
        "attn.wv": "attn.to_v",
        "attn.wo": "attn.to_out.0",
        "attn.gate": "attn.to_gate",
        "attn.qknorm.qnorm": "attn.norm_q",
        "attn.qknorm.knorm": "attn.norm_k",
        "mlp.gate": "ff.gate",
        "mlp.up": "ff.up",
        "mlp.down": "ff.down",
    }
    if block_match:
        index, module = block_match.groups()
        destination = f"transformer_blocks.{index}.{module_map[module]}"
    elif text_match:
        group, index, module = text_match.groups()
        destination = f"text_fusion.{group}.{index}.{module_map[module]}"
    else:
        destination = standalone[key]
    destination_suffix = {
        ".weight": ".weight",
        ".bias": ".bias",
        ".scale": ".weight",
        ".lin": "",
    }[suffix]
    return destination + destination_suffix


def _krea_scaled_fp8_linear_forward(module: Any, input_tensor: Any) -> Any:
    import torch

    original_shape = input_tensor.shape
    input_2d = input_tensor.reshape(-1, original_shape[-1])
    # The checkpoint stores Wq and one FP32 scale such that W = Wq * scale.
    # gfx1201 exposes the scaled FP8 GEMM directly. Dynamically quantizing the
    # activation avoids materializing a BF16 copy of projections as large as
    # 100M parameters (roughly 200 MB each).
    activation_scale = (
        input_2d.detach().abs().amax().to(torch.float32) / 448.0
    ).clamp_min(1e-12)
    quantized_input = (
        input_2d / activation_scale.to(dtype=input_2d.dtype)
    ).to(torch.float8_e4m3fn)
    output = torch._scaled_mm(
        quantized_input,
        module.weight.t(),
        scale_a=activation_scale,
        scale_b=module._machdoch_weight_scale.to(  # noqa: SLF001
            device=input_2d.device, dtype=torch.float32
        ),
        out_dtype=input_2d.dtype,
        use_fast_accum=False,
    )
    if module.bias is not None:
        output.add_(module.bias.to(dtype=output.dtype))
    return output.reshape(*original_shape[:-1], output.shape[-1])


def _load_krea_transformer(diffusers: Any, torch: Any, checkpoint: Path) -> Any:
    from accelerate import init_empty_weights
    from accelerate.utils import set_module_tensor_to_device
    from safetensors import safe_open

    with init_empty_weights():
        transformer = diffusers.Krea2Transformer2DModel()
    expected = set(transformer.state_dict())
    observed: set[str] = set()
    scaled_modules: list[tuple[str, Any]] = []
    with safe_open(str(checkpoint), framework="pt", device="cpu") as tensor_file:
        source_keys = [
            key
            for key in tensor_file.keys()
            if not key.endswith(".comfy_quant") and not key.endswith(".weight_scale")
        ]
        for source_key in source_keys:
            try:
                destination = _krea_state_key(source_key)
            except (KeyError, AttributeError) as error:
                raise WorkerError(
                    f"KREA checkpoint contains an unmapped tensor: {source_key}"
                ) from error
            if destination in observed:
                raise WorkerError(f"KREA checkpoint maps duplicate tensor {destination}")
            value = tensor_file.get_tensor(source_key)
            if destination.endswith("scale_shift_table") and value.ndim == 1:
                value = value.reshape(-1, 6144)
            if tuple(value.shape) != tuple(transformer.state_dict()[destination].shape):
                raise WorkerError(
                    f"KREA tensor {source_key} has an incompatible shape for {destination}"
                )
            is_fp8 = value.dtype in (torch.float8_e4m3fn, torch.float8_e5m2)
            set_module_tensor_to_device(
                transformer,
                destination,
                "cpu",
                value=value,
                # Accelerate treats dtype=None as "cast to the meta
                # parameter's default" (FP32); pass FP8 explicitly so the
                # 13.1 GB checkpoint does not expand to roughly 50 GB.
                dtype=value.dtype if is_fp8 else torch.bfloat16,
            )
            observed.add(destination)
            if is_fp8:
                scale_key = source_key.removesuffix(".weight") + ".weight_scale"
                quant_key = source_key.removesuffix(".weight") + ".comfy_quant"
                if scale_key not in tensor_file.keys() or quant_key not in tensor_file.keys():
                    raise WorkerError(f"KREA FP8 tensor {source_key} has no scale metadata")
                try:
                    quant = json.loads(
                        bytes(tensor_file.get_tensor(quant_key).tolist()).decode("utf-8")
                    )
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise WorkerError(
                        f"KREA FP8 tensor {source_key} has invalid quantization metadata"
                    ) from error
                if quant.get("format") != "float8_e4m3fn":
                    raise WorkerError(
                        f"KREA tensor {source_key} uses unsupported {quant.get('format')} quantization"
                    )
                module_name = destination.removesuffix(".weight")
                scaled_modules.append((module_name, tensor_file.get_tensor(scale_key)))
    if observed != expected:
        missing = sorted(expected - observed)
        raise WorkerError(
            "KREA checkpoint does not cover the complete transformer"
            + (f"; missing {', '.join(missing[:8])}" if missing else "")
        )
    for module_name, scale in scaled_modules:
        module = transformer.get_submodule(module_name)
        if not isinstance(module, torch.nn.Linear):
            raise WorkerError(f"KREA FP8 target {module_name} is not a linear layer")
        module.register_buffer("_machdoch_weight_scale", scale.to(torch.float32))
        module.forward = types.MethodType(_krea_scaled_fp8_linear_forward, module)
    transformer.eval().requires_grad_(False)
    return transformer


def _load_krea_pipeline(
    diffusers: Any, torch: Any, model: dict[str, Any], checkpoint: Path
) -> Any:
    if getattr(torch.version, "hip", None) is None:
        raise WorkerError("The managed KREA 2 FP8 profile requires the AMD ROCm runtime")
    if not torch.cuda.is_bf16_supported():
        raise WorkerError("KREA 2 requires bfloat16 support on the selected AMD adapter")
    config_path = _absolute_existing_path(model.get("configPath"), file=False)
    text_root, vae_root = _krea_runtime_paths(config_path)
    transformer = _load_krea_transformer(diffusers, torch, checkpoint)
    vae = diffusers.AutoencoderKLQwenImage.from_pretrained(
        str(vae_root),
        torch_dtype=torch.bfloat16,
        local_files_only=True,
        use_safetensors=True,
    )
    scheduler = diffusers.FlowMatchEulerDiscreteScheduler(
        num_train_timesteps=1_000,
        use_dynamic_shifting=True,
        base_shift=0.5,
        max_shift=1.15,
        base_image_seq_len=256,
        max_image_seq_len=6_400,
        time_shift_type="exponential",
    )
    pipeline = diffusers.Krea2Pipeline(
        scheduler=scheduler,
        vae=vae,
        text_encoder=None,
        tokenizer=None,
        transformer=transformer,
        is_distilled=True,
    )
    pipeline._machdoch_krea_text_root = text_root
    pipeline._machdoch_krea_runtime_root = text_root.parent
    pipeline.vae.to(torch.device(f"cuda:{torch.cuda.current_device()}"))
    if hasattr(pipeline.vae, "enable_tiling"):
        pipeline.vae.enable_tiling()
    if hasattr(pipeline, "set_progress_bar_config"):
        pipeline.set_progress_bar_config(
            disable=os.environ.get("MACHDOCH_MEDIA_DEBUG_PROGRESS") != "1"
        )
    return pipeline


def _physical_memory_bytes() -> int | None:
    """Return installed RAM without adding a runtime dependency."""
    if os.name == "nt":
        import ctypes

        class MemoryStatus(ctypes.Structure):
            _fields_ = [
                ("length", ctypes.c_ulong),
                ("memory_load", ctypes.c_ulong),
                ("total_physical", ctypes.c_ulonglong),
                ("available_physical", ctypes.c_ulonglong),
                ("total_page_file", ctypes.c_ulonglong),
                ("available_page_file", ctypes.c_ulonglong),
                ("total_virtual", ctypes.c_ulonglong),
                ("available_virtual", ctypes.c_ulonglong),
                ("available_extended_virtual", ctypes.c_ulonglong),
            ]

        status = MemoryStatus()
        status.length = ctypes.sizeof(status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return int(status.total_physical)
        return None
    page_size = getattr(os, "sysconf", lambda _name: None)("SC_PAGE_SIZE")
    page_count = getattr(os, "sysconf", lambda _name: None)("SC_PHYS_PAGES")
    if isinstance(page_size, int) and isinstance(page_count, int):
        return page_size * page_count
    return None


def _krea_disk_cache_directory(
    pipeline: Any,
    model: dict[str, Any],
    addons: list[dict[str, Any]],
) -> tuple[Path, str]:
    model_digest = _required_text(model, "digest", 64)
    enabled_addons = [
        {
            "kind": addon.get("kind"),
            "digest": addon.get("digest"),
        }
        for addon in addons
        if isinstance(addon, dict) and addon.get("enabled", True)
    ]
    signature = hashlib.sha256(
        json.dumps(
            {
                "schemaVersion": 1,
                "workerVersion": OFFLOAD_CACHE_COMPATIBILITY_VERSION,
                "torchVersion": __import__("torch").__version__,
                "diffusersVersion": __import__("diffusers").__version__,
                "modelDigest": model_digest,
                "addons": enabled_addons,
                "groupSize": 1,
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()
    runtime_root = Path(pipeline._machdoch_krea_runtime_root).resolve(strict=True)
    cache_root = runtime_root / "transformer-offload"
    return cache_root / signature, signature


def _validated_krea_disk_cache(cache_directory: Path, signature: str) -> bool:
    manifest_path = cache_directory / "complete.json"
    if not manifest_path.is_file() or manifest_path.is_symlink():
        return False
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    files = manifest.get("files") if isinstance(manifest, dict) else None
    if (
        not isinstance(manifest, dict)
        or manifest.get("schemaVersion") != 1
        or manifest.get("signature") != signature
        or not isinstance(files, list)
        or not files
    ):
        return False
    expected_names: set[str] = set()
    for item in files:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("name"), str)
            or not re.fullmatch(r"group_[0-9a-f]+\.safetensors", item["name"])
            or not isinstance(item.get("sizeBytes"), int)
            or item["sizeBytes"] <= 0
        ):
            return False
        expected_names.add(item["name"])
        path = cache_directory / item["name"]
        if (
            not path.is_file()
            or path.is_symlink()
            or path.stat().st_size != item["sizeBytes"]
        ):
            return False
    observed_names = {
        path.name for path in cache_directory.glob("group_*.safetensors")
    }
    return observed_names == expected_names


def _remove_incomplete_krea_disk_cache(
    cache_directory: Path,
    runtime_root: Path,
) -> None:
    import shutil

    resolved_root = runtime_root.resolve(strict=True)
    resolved_cache = cache_directory.resolve(strict=False)
    if (
        resolved_cache.parent != (resolved_root / "transformer-offload").resolve(
            strict=False
        )
        or not re.fullmatch(r"[0-9a-f]{64}", resolved_cache.name)
    ):
        raise WorkerError("Refusing to replace an unsafe KREA offload cache path")
    if resolved_cache.exists():
        shutil.rmtree(resolved_cache)


def _install_windows_krea_disk_offload_fixes(torch: Any) -> bool:
    if os.name != "nt":
        return False
    import functools
    import safetensors.torch as safe_torch
    from diffusers.hooks.group_offloading import ModuleGroup

    selected_device = int(torch.cuda.current_device())
    original_load_file = getattr(
        safe_torch.load_file,
        "_machdoch_original",
        safe_torch.load_file,
    )

    @functools.wraps(original_load_file)
    def load_file_on_selected_device(
        filename: str,
        device: str = "cpu",
    ) -> Any:
        # Diffusers 0.39 reduces cuda:1 to "cuda" at this boundary.
        if device == "cuda":
            device = f"cuda:{selected_device}"
        return original_load_file(filename, device=device)

    load_file_on_selected_device._machdoch_original = original_load_file
    safe_torch.load_file = load_file_on_selected_device

    original_offload = getattr(
        ModuleGroup._offload_to_disk,
        "_machdoch_original",
        ModuleGroup._offload_to_disk,
    )

    @functools.wraps(original_offload)
    def compact_offload_to_disk(group: Any) -> None:
        group._check_disk_offload_torchao()
        if (
            not group._is_offloaded_to_disk
            and not os.path.exists(group.safetensors_file_path)
        ):
            os.makedirs(os.path.dirname(group.safetensors_file_path), exist_ok=True)
            tensors_to_save = {
                key: tensor.data.to(group.offload_device)
                for tensor, key in group.tensor_to_key.items()
            }
            safe_torch.save_file(tensors_to_save, group.safetensors_file_path)
        group._is_offloaded_to_disk = True
        # Upstream uses empty_like() here. On Windows that reserves the entire
        # 12.2 GB model again and WDDM counts it against the page-file commit,
        # even though the pages are never touched. Parameter.data accepts a
        # zero-sized placeholder and the hook restores the exact shape before
        # every forward, eliminating that false duplicate residency.
        for tensor in group.tensor_to_key:
            tensor.data = torch.empty(
                0,
                dtype=tensor.dtype,
                device=group.offload_device,
            )

    compact_offload_to_disk._machdoch_original = original_offload
    ModuleGroup._offload_to_disk = compact_offload_to_disk
    return True


def _configure_krea_offload(
    pipeline: Any,
    torch: Any,
    model: dict[str, Any],
    addons: list[dict[str, Any]],
    requested_profile: Any,
) -> dict[str, Any]:
    if requested_profile is None:
        requested_profile = "auto"
    if requested_profile not in (
        "auto",
        "memory-saver",
        "balanced",
        "maximum-speed",
    ):
        raise WorkerError(
            "memoryProfile must be auto, memory-saver, balanced, or maximum-speed"
        )
    physical_memory = _physical_memory_bytes()
    if requested_profile == "auto":
        # The 12.2 GB FP8 transformer, WDDM's GPU commit backing, and the host
        # application exceed a 32 GB machine's page-file commit during edit
        # attention. Official Diffusers disk group offload removes the duplicate
        # host residency while preserving the exact checkpoint and adapter.
        effective_profile = (
            "memory-saver"
            if physical_memory is None or physical_memory < 48 * 1024**3
            else "balanced"
        )
    else:
        effective_profile = requested_profile
    disk_cache_hit = False
    windows_disk_fixes = False
    cache_directory: Path | None = None
    group_size = 1 if effective_profile != "maximum-speed" else 4
    arguments: dict[str, Any] = {
        "onload_device": torch.device(f"cuda:{torch.cuda.current_device()}"),
        "offload_device": torch.device("cpu"),
        "offload_type": "block_level",
        "num_blocks_per_group": group_size,
        "use_stream": False,
        "exclude_modules": "vae",
    }
    if effective_profile == "memory-saver":
        cache_directory, signature = _krea_disk_cache_directory(
            pipeline,
            model,
            addons,
        )
        runtime_root = Path(pipeline._machdoch_krea_runtime_root)
        disk_cache_hit = _validated_krea_disk_cache(cache_directory, signature)
        if cache_directory.exists() and not disk_cache_hit:
            _remove_incomplete_krea_disk_cache(cache_directory, runtime_root)
        cache_directory.mkdir(parents=True, exist_ok=True)
        windows_disk_fixes = _install_windows_krea_disk_offload_fixes(torch)
        arguments["offload_to_disk_path"] = str(cache_directory)
    pipeline.enable_group_offload(**arguments)
    cache_size = None
    cache_files = None
    if cache_directory is not None:
        group_files = sorted(cache_directory.glob("group_*.safetensors"))
        cache_size = sum(path.stat().st_size for path in group_files)
        cache_files = len(group_files)
        if not disk_cache_hit:
            manifest = {
                "schemaVersion": 1,
                "signature": signature,
                "files": [
                    {"name": path.name, "sizeBytes": path.stat().st_size}
                    for path in group_files
                ],
            }
            temporary_manifest = cache_directory / f".complete.{os.getpid()}.tmp"
            temporary_manifest.write_text(
                json.dumps(manifest, separators=(",", ":"), sort_keys=True),
                encoding="utf-8",
            )
            os.replace(temporary_manifest, cache_directory / "complete.json")
    return {
        "requestedMemoryProfile": requested_profile,
        "effectiveMemoryProfile": effective_profile,
        "physicalMemoryBytes": physical_memory,
        "offloadType": "block-level-disk"
        if cache_directory is not None
        else "block-level-cpu",
        "blocksPerGroup": group_size,
        "diskCacheHit": disk_cache_hit if cache_directory is not None else None,
        "diskCachePath": str(cache_directory) if cache_directory is not None else None,
        "diskCacheFiles": cache_files,
        "diskCacheBytes": cache_size,
        "windowsDiskOffloadCompatibility": windows_disk_fixes,
    }


def _encode_krea_prompt(torch: Any, text_root: Path, prompt: str) -> tuple[Any, Any]:
    from transformers import AutoTokenizer, Qwen3VLForConditionalGeneration

    tokenizer = AutoTokenizer.from_pretrained(
        str(text_root), local_files_only=True, trust_remote_code=False
    )
    encoder = Qwen3VLForConditionalGeneration.from_pretrained(
        str(text_root),
        torch_dtype=torch.bfloat16,
        local_files_only=True,
        use_safetensors=True,
        trust_remote_code=False,
        low_cpu_mem_usage=True,
    )
    device = torch.device(f"cuda:{torch.cuda.current_device()}")
    encoder.to(device).eval().requires_grad_(False)
    prefix = (
        "<|im_start|>system\nDescribe the image by detailing the color, shape, size, "
        "texture, quantity, text, spatial relationships of the objects and background:"
        "<|im_end|>\n<|im_start|>user\n"
    )
    suffix = "<|im_end|>\n<|im_start|>assistant\n"
    prefix_tokens = 34
    text_tokens = tokenizer(
        [prefix + prompt],
        truncation=True,
        padding="max_length",
        max_length=512 + prefix_tokens - 5,
        return_tensors="pt",
    ).to(device)
    suffix_tokens = tokenizer([suffix], return_tensors="pt").to(device)
    input_ids = torch.cat((text_tokens.input_ids, suffix_tokens.input_ids), dim=1)
    attention_mask = torch.cat(
        (text_tokens.attention_mask, suffix_tokens.attention_mask), dim=1
    ).bool()
    position_ids = (attention_mask.long().cumsum(dim=-1) - 1).clamp(min=0)
    position_ids = position_ids.unsqueeze(0).expand(3, -1, -1)
    with torch.inference_mode():
        states = encoder(
            input_ids=input_ids,
            attention_mask=attention_mask,
            position_ids=position_ids,
            output_hidden_states=True,
        )
        # Windows ROCm 7.14 intermittently faults in the HIP cat kernel used by
        # torch.stack for this 68 MB tensor. The encoder work remains on the
        # GPU; copying the twelve selected taps separately and stacking on the
        # host avoids that unnecessary kernel and lowers peak VRAM.
        selected = [
            states.hidden_states[index][:, prefix_tokens:].to(
                device="cpu", dtype=torch.bfloat16
            )
            for index in (2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35)
        ]
    hidden = torch.stack(selected, dim=2)
    mask = attention_mask[:, prefix_tokens:].to(device="cpu")
    del states, encoder, tokenizer, input_ids, attention_mask, position_ids
    del text_tokens, suffix_tokens, selected
    gc.collect()
    torch.cuda.empty_cache()
    return hidden, mask


def _encode_krea_grounded_prompt(
    torch: Any,
    text_root: Path,
    prompt: str,
    reference_path: Path,
    grounding_pixels: int,
) -> tuple[Any, Any, dict[str, Any]]:
    """Run KREA Edit's training-matched image-plus-instruction Qwen path."""
    from PIL import Image
    from transformers import AutoProcessor, Qwen3VLForConditionalGeneration

    if not 384 <= grounding_pixels <= 1_024:
        raise WorkerError("groundingPixels must be between 384 and 1024")
    source_digest = _sha256_file(reference_path)
    cache_key = hashlib.sha256(
        json.dumps(
            {
                "schemaVersion": 1,
                "engine": "qwen3-vl-grounded-krea-edit-v1",
                "textRevision": "ebb281ec70b05090aa6165b016eac8ec08e71b17",
                "sourceDigest": source_digest,
                "prompt": prompt,
                "groundingPixels": grounding_pixels,
            },
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
    ).hexdigest()
    cache_directory = text_root.parent / "grounding-cache"
    cache_path = cache_directory / f"{cache_key}.safetensors"
    if cache_path.is_file() and not cache_path.is_symlink():
        from safetensors.torch import load_file

        cached = load_file(str(cache_path), device="cpu")
        hidden = cached.get("hidden")
        mask_tensor = cached.get("mask")
        if (
            hidden is not None
            and mask_tensor is not None
            and tuple(hidden.shape) == (1, 512, 12, 2560)
            and tuple(mask_tensor.shape) == (1, 512)
        ):
            with Image.open(reference_path) as opened:
                original_size = opened.size
            return hidden, mask_tensor.bool(), {
                "engine": "qwen3-vl-grounded-krea-edit-v1",
                "sourceDigest": source_digest,
                "originalWidth": original_size[0],
                "originalHeight": original_size[1],
                "groundingPixels": grounding_pixels,
                "device": "persistent-safe-tensor-cache",
                "cacheHit": True,
                "cacheKey": cache_key,
                "sequenceLength": 512,
                "selectedHiddenLayers": [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35],
            }
    processor = AutoProcessor.from_pretrained(
        str(text_root),
        local_files_only=True,
        trust_remote_code=False,
    )
    encoder = Qwen3VLForConditionalGeneration.from_pretrained(
        str(text_root),
        torch_dtype=torch.bfloat16,
        local_files_only=True,
        use_safetensors=True,
        trust_remote_code=False,
        low_cpu_mem_usage=True,
    )
    with Image.open(reference_path) as opened:
        grounded_image = opened.convert("RGB")
    original_size = grounded_image.size
    grounded_image.thumbnail(
        (grounding_pixels, grounding_pixels),
        Image.Resampling.LANCZOS,
    )
    grounded_size = grounded_image.size
    prefix = (
        "<|im_start|>system\nDescribe the image by detailing the color, shape, size, "
        "texture, quantity, text, spatial relationships of the objects and background:"
        "<|im_end|>\n<|im_start|>user\n"
    )
    template = (
        prefix
        + "<|vision_start|><|image_pad|><|vision_end|>"
        + prompt
        + "<|im_end|>\n<|im_start|>assistant\n"
    )
    # The system and opening user turn are 34 tokens for this pinned tokenizer.
    # Padding to 546 leaves the exact 512-token KREA transformer contract after
    # the prefix is removed, while retaining image tokens inside that sequence.
    prefix_tokens = 34
    inputs = processor(
        text=[template],
        images=[grounded_image],
        truncation=True,
        padding="max_length",
        max_length=512 + prefix_tokens,
        return_tensors="pt",
    )
    # Qwen3-VL's multimodal RoPE path reaches a HIP gather kernel that can
    # access-violate (rather than raise) in the pinned Windows ROCm 7.14 build.
    # Text-only Qwen is unaffected. Run only this sequential grounding pass on
    # the host on HIP; it is released before the FP8 KREA denoiser is loaded.
    grounded_on_cpu = getattr(torch.version, "hip", None) is not None
    device = (
        torch.device("cpu")
        if grounded_on_cpu
        else torch.device(f"cuda:{torch.cuda.current_device()}")
    )
    encoder.to(device).eval().requires_grad_(False)
    inputs = inputs.to(device)
    with torch.inference_mode():
        states = encoder(
            **inputs,
            output_hidden_states=True,
        )
        selected = [
            states.hidden_states[index][:, prefix_tokens:].to(
                device="cpu",
                dtype=torch.bfloat16,
            )
            for index in (2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35)
        ]
    hidden = torch.stack(selected, dim=2)
    mask = inputs.attention_mask[:, prefix_tokens:].to(device="cpu").bool()
    if hidden.shape[1] != 512 or mask.shape[1] != 512:
        raise WorkerError("KREA grounded encoder did not preserve its 512-token contract")
    del states, encoder, processor, inputs, selected
    gc.collect()
    torch.cuda.empty_cache()
    evidence = {
        "engine": "qwen3-vl-grounded-krea-edit-v1",
        "sourceDigest": source_digest,
        "originalWidth": original_size[0],
        "originalHeight": original_size[1],
        "groundedWidth": grounded_size[0],
        "groundedHeight": grounded_size[1],
        "groundingPixels": grounding_pixels,
        "device": "cpu-windows-rocm-safety-fallback" if grounded_on_cpu else "cuda",
        "cacheHit": False,
        "cacheKey": cache_key,
        "sequenceLength": 512,
        "selectedHiddenLayers": [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35],
    }
    from safetensors.torch import save_file

    cache_directory.mkdir(parents=True, exist_ok=True)
    temporary_cache = cache_directory / f".{cache_key}.{os.getpid()}.tmp"
    save_file(
        {
            "hidden": hidden.contiguous(),
            "mask": mask.to(dtype=torch.uint8).contiguous(),
        },
        str(temporary_cache),
        metadata={
            "schemaVersion": "1",
            "engine": "qwen3-vl-grounded-krea-edit-v1",
            "sourceDigest": source_digest,
        },
    )
    os.replace(temporary_cache, cache_path)
    return hidden, mask, evidence


def _load_pipeline(diffusers: Any, torch: Any, model: dict[str, Any]) -> Any:
    architecture = _required_text(model, "architecture", 64)
    if architecture not in SUPPORTED_ARCHITECTURES:
        raise WorkerError(f"Unsupported model architecture: {architecture}")
    package_kind = _required_text(model, "packageKind", 64)
    model_path = _absolute_existing_path(model.get("path"), file=package_kind == "single-file")
    device, _, _ = _device(torch)
    dtype = torch.float32 if device == "cpu" else torch.float16
    if device == "cuda" and torch.cuda.is_bf16_supported():
        dtype = torch.bfloat16
    common = {
        "torch_dtype": dtype,
        "local_files_only": True,
        "use_safetensors": True,
    }
    if architecture == "krea-2" and package_kind == "single-file":
        pipeline = _load_krea_pipeline(diffusers, torch, model, model_path)
    elif package_kind == "diffusers-directory":
        pipeline = diffusers.DiffusionPipeline.from_pretrained(
            str(model_path), trust_remote_code=False, **common
        )
    elif package_kind == "single-file":
        class_names = {
            "stable-diffusion-1": "StableDiffusionPipeline",
            "stable-diffusion-2": "StableDiffusionPipeline",
            "stable-diffusion-xl": "StableDiffusionXLPipeline",
            "stable-diffusion-3": "StableDiffusion3Pipeline",
            "flux-1": "FluxPipeline",
            "flux-2": "Flux2Pipeline",
        }
        pipeline_class = getattr(diffusers, class_names[architecture], None)
        if pipeline_class is None or not hasattr(pipeline_class, "from_single_file"):
            raise WorkerError(
                f"Diffusers does not expose a local single-file loader for {architecture}"
            )
        config_path = model.get("configPath")
        if config_path is not None:
            config_path = _absolute_existing_path(config_path, file=False)
            common["config"] = str(config_path)
        pipeline = pipeline_class.from_single_file(str(model_path), **common)
    else:
        raise WorkerError(f"Unsupported model package kind: {package_kind}")

    if architecture == "krea-2":
        pass
    elif device == "cuda" and hasattr(pipeline, "enable_model_cpu_offload"):
        pipeline.enable_model_cpu_offload(gpu_id=torch.cuda.current_device())
    else:
        pipeline.to(device)
    if hasattr(pipeline, "set_progress_bar_config"):
        pipeline.set_progress_bar_config(disable=True)
    return pipeline


def probe_model(request: dict[str, Any]) -> dict[str, Any]:
    if request.get("schemaVersion") != SCHEMA_VERSION:
        raise WorkerError("Unsupported worker request schema")
    model = request.get("model")
    if not isinstance(model, dict):
        raise WorkerError("model is required")
    torch, diffusers = _runtime()
    architecture = _required_text(model, "architecture", 64)
    pipeline_class_name = None
    component_names = None
    probe_diagnostic = None
    if architecture == "framepack-i2v":
        pipeline, _, _, _, _ = _load_framepack_pipeline(
            diffusers,
            torch,
            model,
            "A subject moves naturally with clear continuous motion.",
            "memory-saver",
        )
        required_methods = []
        capabilities = [
            "image-to-video",
            "start-end-to-video",
            "vp9-alpha",
            "alpha-video",
            "video-composite",
        ]
    elif architecture == "hunyuan-video-1.5-i2v":
        _validate_hunyuan_video_15_package(model, torch)
        for class_name in (
            "HunyuanVideo15ImageToVideoPipeline",
            "HunyuanVideo15Transformer3DModel",
            "AutoencoderKLHunyuanVideo15",
        ):
            if getattr(diffusers, class_name, None) is None:
                raise WorkerError(
                    f"The pinned Diffusers runtime does not expose {class_name}"
                )
        pipeline = None
        pipeline_class_name = "HunyuanVideo15ImageToVideoPipeline"
        component_names = [
            "feature_extractor",
            "guider",
            "image_encoder",
            "scheduler",
            "text_encoder",
            "text_encoder_2",
            "tokenizer",
            "tokenizer_2",
            "transformer",
            "vae",
        ]
        probe_diagnostic = (
            "HunyuanVideo15ImageToVideoPipeline and the complete pinned offline "
            "component inventory were validated without retaining model weights."
        )
        required_methods = []
        capabilities = [
            "image-to-video",
            "vp9-alpha",
            "alpha-video",
            "video-composite",
        ]
    elif architecture == "ltx-video":
        pipeline, _, _, _ = _load_ltx_video_pipeline(
            diffusers,
            torch,
            model,
            "A subject moves naturally with clear continuous motion.",
            "memory-saver",
        )
        required_methods = []
        capabilities = [
            "image-to-video",
            "start-end-to-video",
            "vp9-alpha",
            "alpha-video",
            "video-composite",
        ]
    elif architecture == "wan-2.2-ti2v":
        pipeline, _, _ = _load_video_pipeline(diffusers, torch, model)
        required_methods: list[str] = []
        capabilities = [
            "image-to-video",
            "start-end-to-video",
            "vp9-alpha",
            "alpha-video",
            "video-composite",
        ]
    else:
        pipeline = _load_pipeline(diffusers, torch, model)
        required_methods = ["load_lora_weights", "set_adapters", "get_list_adapters"]
        if architecture in (
            "stable-diffusion-1",
            "stable-diffusion-2",
            "stable-diffusion-xl",
            "flux-1",
        ):
            required_methods.append("load_textual_inversion")
        capabilities = [
            "lora",
            "multi-lora",
            *(
                ["textual-inversion"]
                if hasattr(pipeline, "load_textual_inversion")
                else []
            ),
        ]
    missing_methods = [name for name in required_methods if not hasattr(pipeline, name)]
    if missing_methods:
        raise WorkerError(
            "Loaded pipeline is missing required add-on methods: "
            + ", ".join(missing_methods)
        )
    if component_names is None:
        components = getattr(pipeline, "components", {})
        component_names = (
            sorted(
                name
                for name, component in components.items()
                if isinstance(name, str) and component is not None
            )
            if isinstance(components, dict)
            else []
        )
    if pipeline_class_name is None:
        pipeline_class_name = type(pipeline).__name__
    if probe_diagnostic is None:
        probe_diagnostic = (
            f"{pipeline_class_name} loaded successfully with offline components."
        )
    device, device_label, device_memory = _device(torch)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "workerVersion": WORKER_VERSION,
        "packages": _package_versions(),
        "ready": True,
        "architecture": architecture,
        "pipelineClass": pipeline_class_name,
        "components": component_names[:64],
        "capabilities": capabilities,
        "device": device,
        "deviceLabel": device_label,
        "deviceMemoryBytes": device_memory,
        "diagnostic": probe_diagnostic,
    }


def _token_exists(pipeline: Any, token: str) -> bool:
    for name in ("tokenizer", "tokenizer_2", "tokenizer_3"):
        tokenizer = getattr(pipeline, name, None)
        if tokenizer is not None and token in tokenizer.get_vocab():
            return True
    return False


def _registered_token_aliases(token: str, vector_count: int) -> list[str]:
    return [token, *(f"{token}_{index}" for index in range(1, vector_count))]


def _sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            hasher.update(chunk)
    return hasher.hexdigest()


def _embedding_profiles(
    addon: dict[str, Any], target_components: list[str]
) -> list[dict[str, Any]]:
    profiles = addon.get("embeddingVectors")
    if not isinstance(profiles, list) or not profiles:
        raise WorkerError("Textual inversion has no inspected embedding vector profile")
    normalized: list[dict[str, Any]] = []
    tensor_keys: set[str] = set()
    for profile in profiles:
        if not isinstance(profile, dict):
            raise WorkerError("Embedding vector profile must be an object")
        component = _required_text(profile, "component", 64)
        tensor_key = _required_text(profile, "tensorKey", 512)
        vector_count = profile.get("vectorCount")
        dimension = profile.get("dimension")
        if (
            not isinstance(vector_count, int)
            or isinstance(vector_count, bool)
            or vector_count < 1
            or vector_count > 512
        ):
            raise WorkerError("Embedding vector count must be between 1 and 512")
        if (
            not isinstance(dimension, int)
            or isinstance(dimension, bool)
            or dimension < 64
            or dimension > 16_384
        ):
            raise WorkerError("Embedding width must be between 64 and 16384")
        if tensor_key in tensor_keys:
            raise WorkerError("Embedding vector profile repeats a tensor key")
        tensor_keys.add(tensor_key)
        normalized.append(
            {
                "component": component,
                "tensorKey": tensor_key,
                "vectorCount": vector_count,
                "dimension": dimension,
            }
        )
    if [profile["component"] for profile in normalized] != target_components:
        raise WorkerError(
            "Embedding vector profile does not match the inspected component inventory"
        )
    return normalized


def _load_textual_inversion(
    pipeline: Any,
    path: Path,
    token: str,
    target_components: list[str],
    profiles: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    from safetensors.torch import load_file

    state = load_file(str(path), device="cpu")
    runtime_components = {
        "text-encoder": ("tokenizer", "text_encoder"),
        "text-encoder-2": ("tokenizer_2", "text_encoder_2"),
    }
    loaded: list[dict[str, Any]] = []
    for profile in profiles:
        component = profile["component"]
        tensor_key = profile["tensorKey"]
        runtime_names = runtime_components.get(component)
        if runtime_names is None:
            raise WorkerError(f"Unsupported embedding target component: {component}")
        if tensor_key not in state:
            raise WorkerError(f"Embedding tensor is missing at runtime: {tensor_key}")
        tensor = state[tensor_key]
        shape = tuple(int(value) for value in tensor.shape)
        if len(shape) == 1:
            observed_vector_count, observed_dimension = 1, shape[0]
        elif len(shape) == 2:
            observed_vector_count, observed_dimension = shape
        else:
            raise WorkerError(
                f"Embedding tensor {tensor_key} has an unsupported runtime shape"
            )
        if (
            observed_vector_count != profile["vectorCount"]
            or observed_dimension != profile["dimension"]
        ):
            raise WorkerError(
                f"Embedding tensor {tensor_key} does not match its inspected vector profile"
            )
        tokenizer = getattr(pipeline, runtime_names[0], None)
        text_encoder = getattr(pipeline, runtime_names[1], None)
        if tokenizer is None or text_encoder is None:
            raise WorkerError(
                f"The selected pipeline does not expose the required {component}"
            )
        input_embeddings = text_encoder.get_input_embeddings()
        runtime_dimension = int(input_embeddings.weight.shape[-1])
        if runtime_dimension != profile["dimension"]:
            raise WorkerError(
                f"Embedding tensor {tensor_key} has width {profile['dimension']}, but {component} expects {runtime_dimension}"
            )
        pipeline.load_textual_inversion(
            tensor,
            token=token,
            tokenizer=tokenizer,
            text_encoder=text_encoder,
        )
        registered_tokens = _registered_token_aliases(
            token, profile["vectorCount"]
        )
        vocabulary = tokenizer.get_vocab()
        if any(alias not in vocabulary for alias in registered_tokens):
            raise WorkerError(
                f"Textual-inversion aliases were not fully registered in {component}"
            )
        loaded.append({**profile, "registeredTokens": registered_tokens})
    if [profile["component"] for profile in loaded] != target_components:
        raise WorkerError(
            "Loaded textual-inversion components do not match the requested inventory"
        )
    return loaded


def _append_token(prompt: str, token: str) -> str:
    if token in prompt.split():
        return prompt
    return f"{prompt.rstrip()}, {token}" if prompt.strip() else token


def _confirmed_lora_components(
    pipeline: Any, adapter_name: str, target_components: list[str]
) -> list[str]:
    if not hasattr(pipeline, "get_list_adapters"):
        raise WorkerError("The selected pipeline cannot report loaded LoRA targets")
    inventory = pipeline.get_list_adapters()
    if not isinstance(inventory, dict):
        raise WorkerError("The selected pipeline returned an invalid LoRA target inventory")
    runtime_names = {
        "denoiser": "unet" if hasattr(pipeline, "unet") else "transformer",
        "text-encoder": "text_encoder",
        "text-encoder-2": "text_encoder_2",
    }
    loaded: list[str] = []
    for component in target_components:
        runtime_name = runtime_names.get(component)
        if runtime_name is None or adapter_name not in inventory.get(runtime_name, []):
            raise WorkerError(
                f"LoRA {adapter_name} did not load its expected {component} targets"
            )
        loaded.append(component)
    return loaded


def _unsupported_lora_algorithm(keys: list[str]) -> str | None:
    if any(
        "hada_w1_a" in key
        or "hada_w1_b" in key
        or "hada_w2_a" in key
        or ".hada_" in key
        for key in keys
    ):
        return "LoHa"
    if any(
        "lokr_w1" in key
        or "lokr_w2" in key
        or "lokr_t2" in key
        or ".lokr_" in key
        for key in keys
    ):
        return "LoKr"
    if any(
        "oft_blocks" in key or "oft_diag" in key or ".oft_" in key
        for key in keys
    ):
        return "OFT"
    if any(key.endswith(".lora_mid.weight") for key in keys):
        return "CP-decomposed LoCon"
    return None


def _lora_component(key: str) -> str:
    if "text_encoder_2" in key or "lora_te2" in key:
        return "text-encoder-2"
    if "text_encoder" in key or "lora_te" in key:
        return "text-encoder"
    return "denoiser"


def _lora_profile(
    addon: dict[str, Any], tensor_shapes: dict[str, tuple[int, ...]]
) -> dict[str, Any]:
    expected = addon.get("loraProfile")
    if not isinstance(expected, dict):
        raise WorkerError("LoRA has no inspected tensor profile")
    keys = [key.lower() for key in tensor_shapes]
    unsupported = _unsupported_lora_algorithm(keys)
    if unsupported is not None:
        raise WorkerError(f"Unsupported LoRA tensor algorithm at runtime: {unsupported}")
    lower_to_original = {key.lower(): key for key in tensor_shapes}
    if len(lower_to_original) != len(tensor_shapes):
        raise WorkerError("LoRA tensor keys collide when compared case-insensitively")
    magnitude_stems: set[str] = set()
    for key in lower_to_original:
        for suffix in LORA_MAGNITUDE_SUFFIXES:
            if key.endswith(suffix):
                magnitude_stems.add(key[: -len(suffix)])
                break
    alpha_stems = {
        key[: -len(".alpha")]
        for key in lower_to_original
        if key.endswith(".alpha")
    }

    paired_stems: set[str] = set()
    ranks: list[int] = []
    dialects: set[str] = set()
    convolution_target_count = 0
    component_counts: dict[str, list[int]] = {}
    for lower_key, original_key in lower_to_original.items():
        pair = next(
            (
                (left, right, lower_key[: -len(left)])
                for left, right in LORA_TENSOR_PAIRS
                if lower_key.endswith(left)
            ),
            None,
        )
        if pair is None:
            continue
        left_suffix, right_suffix, stem = pair
        right_key = f"{stem}{right_suffix}"
        if right_key not in lower_to_original:
            raise WorkerError(
                f"LoRA tensor {original_key} has no matching {right_suffix} tensor"
            )
        down_shape = tensor_shapes[original_key]
        up_shape = tensor_shapes[lower_to_original[right_key]]
        if (
            len(down_shape) not in (2, 4)
            or len(up_shape) not in (2, 4)
            or any(value <= 0 for value in (*down_shape, *up_shape))
        ):
            raise WorkerError(f"LoRA module {stem} has an invalid runtime shape")
        down_rank = down_shape[0]
        up_rank = up_shape[1]
        if down_rank != up_rank or down_rank > 4096:
            raise WorkerError(f"LoRA module {stem} has incompatible runtime ranks")
        paired_stems.add(stem)
        ranks.append(down_rank)
        if len(down_shape) == 4 or len(up_shape) == 4:
            convolution_target_count += 1
        if "lora_a" in left_suffix:
            dialect = "diffusers-peft"
        elif stem.startswith(
            (
                "lora_unet_",
                "lora_te_",
                "lora_te1_",
                "lora_te2_",
                "lora_transformer_",
            )
        ):
            dialect = "kohya"
        else:
            dialect = "generic"
        dialects.add(dialect)
        counts = component_counts.setdefault(_lora_component(lower_key), [0, 0])
        counts[0] += 1
        if stem in magnitude_stems:
            counts[1] += 1

    for lower_key in lower_to_original:
        for left_suffix, right_suffix in LORA_TENSOR_PAIRS:
            if lower_key.endswith(right_suffix):
                stem = lower_key[: -len(right_suffix)]
                if f"{stem}{left_suffix}" not in lower_to_original:
                    raise WorkerError(
                        f"LoRA tensor {lower_key} has no matching {left_suffix} tensor"
                    )
    if not paired_stems:
        raise WorkerError("No complete standard LoRA tensor pairs were found at runtime")
    if magnitude_stems - paired_stems:
        raise WorkerError("DoRA magnitude tensor has no matching LoRA matrix pair")
    if alpha_stems - paired_stems:
        raise WorkerError("LoRA network alpha tensor has no matching matrix pair")
    for stem in alpha_stems:
        shape = tensor_shapes[lower_to_original[f"{stem}.alpha"]]
        if shape not in ((), (1,)):
            raise WorkerError("LoRA network alpha must be a scalar tensor")
    if any(
        magnitude_count > 0 and magnitude_count != module_count
        for module_count, magnitude_count in component_counts.values()
    ):
        raise WorkerError(
            "DoRA magnitude vectors do not cover every module in a target component"
        )
    if len(dialects) != 1:
        raise WorkerError("Mixed LoRA tensor dialects are not supported")
    rank_minimum = min(ranks)
    rank_maximum = max(ranks)
    magnitude_vector_count = len(magnitude_stems)
    algorithm = (
        "dora"
        if magnitude_vector_count > 0
        else "locon"
        if convolution_target_count > 0
        else "lora"
    )
    observed = {
        "algorithm": algorithm,
        "dialect": next(iter(dialects)),
        "rankMinimum": rank_minimum,
        "rankMaximum": rank_maximum,
        "heterogeneousRanks": rank_minimum != rank_maximum,
        "targetModuleCount": len(paired_stems),
        "convolutionTargetCount": convolution_target_count,
        "magnitudeVectorCount": magnitude_vector_count,
        "networkAlphaCount": len(alpha_stems),
    }
    if observed != expected:
        raise WorkerError("LoRA tensors do not match their inspected profile")
    return observed


def _apply_addons(
    pipeline: Any,
    addons: list[dict[str, Any]],
    prompt: str,
    negative_prompt: str,
) -> tuple[
    str,
    str,
    list[dict[str, Any]],
    list[str],
    list[float | dict[str, float]],
    list[dict[str, float] | None],
]:
    lora_names: list[str] = []
    lora_weights: list[float | dict[str, float]] = []
    lora_schedules: list[dict[str, float] | None] = []
    applied: list[dict[str, Any]] = []
    tokens: set[str] = set()
    for addon in addons:
        if not addon.get("enabled", True):
            continue
        kind = _required_text(addon, "kind", 64)
        path = _absolute_existing_path(addon.get("path"), file=True)
        addon_id = _required_text(addon, "addonId", 256)
        digest = _required_text(addon, "digest", 64)
        if len(digest) != 64 or any(
            character not in "0123456789abcdef" for character in digest
        ):
            raise WorkerError(f"Model add-on {addon_id} has an invalid immutable digest")
        if _sha256_file(path) != digest:
            raise WorkerError(
                f"Model add-on {addon_id} changed after desktop integrity verification"
            )
        if kind == "lora":
            if not hasattr(pipeline, "load_lora_weights"):
                raise WorkerError("The selected pipeline does not expose LoRA loading")
            name = f"machdoch_{digest[:16]}"
            target_components = addon.get("targetComponents")
            if (
                not isinstance(target_components, list)
                or not target_components
                or any(not isinstance(component, str) for component in target_components)
            ):
                raise WorkerError(f"LoRA {addon_id} has no inspected target inventory")
            from safetensors import safe_open

            with safe_open(str(path), framework="pt", device="cpu") as tensor_file:
                tensor_shapes = {
                    key: tuple(int(value) for value in tensor_file.get_slice(key).get_shape())
                    for key in tensor_file.keys()
                }
            lora_profile = _lora_profile(addon, tensor_shapes)
            pipeline.load_lora_weights(
                str(path.parent),
                weight_name=path.name,
                adapter_name=name,
                low_cpu_mem_usage=True,
            )
            # PEFT initializes adapter matrices from the base layer's dtype. For
            # scaled-FP8 KREA checkpoints that would leave LoRA A/B in FP8 and
            # route them through ordinary addmm, which ROCm intentionally does
            # not implement. The frozen base still uses its checkpoint scale
            # through _scaled_mm; adapters are small and compute in BF16.
            if getattr(pipeline, "_machdoch_krea_text_root", None) is not None:
                import torch

                cast_adapter_modules = 0
                for component in pipeline.components.values():
                    if not isinstance(component, torch.nn.Module):
                        continue
                    for module in component.modules():
                        for collection_name in (
                            "lora_A",
                            "lora_B",
                            "lora_embedding_A",
                            "lora_embedding_B",
                        ):
                            collection = getattr(module, collection_name, None)
                            if collection is None or name not in collection:
                                continue
                            adapter_module = collection[name]
                            if isinstance(adapter_module, torch.nn.Module):
                                adapter_module.to(dtype=torch.bfloat16)
                            elif isinstance(adapter_module, torch.nn.Parameter):
                                adapter_module.data = adapter_module.data.to(
                                    dtype=torch.bfloat16
                                )
                            cast_adapter_modules += 1
                if cast_adapter_modules == 0:
                    raise WorkerError(
                        f"LoRA {addon_id} registered no BF16 adapter matrices"
                    )
            loaded_components = _confirmed_lora_components(
                pipeline, name, target_components
            )
            model_strength = float(addon.get("modelStrength", 1.0))
            text_strength = addon.get("textEncoderStrength")
            schedule = _lora_denoising_schedule(
                addon, addon_id, target_components, text_strength
            )
            if text_strength is None:
                weight: float | dict[str, float] = model_strength
            else:
                runtime_components = {
                    "denoiser": "unet" if hasattr(pipeline, "unet") else "transformer",
                    "text-encoder": "text_encoder",
                    "text-encoder-2": "text_encoder_2",
                }
                if not any(
                    component in ("text-encoder", "text-encoder-2")
                    for component in target_components
                ):
                    raise WorkerError(
                        f"LoRA {addon_id} does not target a text encoder"
                    )
                weight = {
                    runtime_components[component]: (
                        model_strength
                        if component == "denoiser"
                        else float(text_strength)
                    )
                    for component in target_components
                }
            lora_names.append(name)
            lora_weights.append(weight)
            lora_schedules.append(schedule)
            applied.append(
                {
                    "kind": kind,
                    "addonId": addon_id,
                    "digest": digest,
                    "modelStrength": model_strength,
                    "textEncoderStrength": text_strength,
                    "denoisingSchedule": schedule,
                    "scheduleApplied": schedule is not None,
                    "adapterName": name,
                    "loadedComponents": loaded_components,
                    "loraProfile": lora_profile,
                }
            )
        elif kind == "textual-inversion":
            if not hasattr(pipeline, "load_textual_inversion"):
                raise WorkerError(
                    "The selected pipeline does not expose textual-inversion loading"
                )
            token = _required_text(addon, "token", 128)
            if token in tokens or _token_exists(pipeline, token):
                raise WorkerError(
                    f"Textual-inversion token alias collides with an existing token: {token}"
                )
            target_components = addon.get("targetComponents")
            if (
                not isinstance(target_components, list)
                or not target_components
                or any(not isinstance(component, str) for component in target_components)
            ):
                raise WorkerError(
                    f"Textual inversion {addon_id} has no inspected target inventory"
                )
            profiles = _embedding_profiles(addon, target_components)
            token_aliases = {
                alias
                for profile in profiles
                for alias in _registered_token_aliases(token, profile["vectorCount"])
            }
            colliding_alias = next(
                (
                    alias
                    for alias in sorted(token_aliases)
                    if alias in tokens or _token_exists(pipeline, alias)
                ),
                None,
            )
            if colliding_alias is not None:
                raise WorkerError(
                    f"Textual-inversion token alias collides with an existing token: {colliding_alias}"
                )
            embedding_vectors = _load_textual_inversion(
                pipeline, path, token, target_components, profiles
            )
            loaded_components = [
                profile["component"] for profile in embedding_vectors
            ]
            tokens.update(token_aliases)
            placement = _required_text(addon, "placement", 16)
            if placement not in ("positive", "negative", "both"):
                raise WorkerError(f"Unsupported embedding placement: {placement}")
            if placement in ("positive", "both"):
                prompt = _append_token(prompt, token)
            if placement in ("negative", "both"):
                negative_prompt = _append_token(negative_prompt, token)
            applied.append(
                {
                    "kind": kind,
                    "addonId": addon_id,
                    "digest": digest,
                    "token": token,
                    "placement": placement,
                    "loadedComponents": loaded_components,
                    "embeddingVectors": embedding_vectors,
                }
            )
        else:
            raise WorkerError(f"Unsupported model add-on kind: {kind}")
    if lora_names:
        if not hasattr(pipeline, "set_adapters"):
            raise WorkerError("The selected pipeline cannot activate multiple named LoRAs")
        pipeline.set_adapters(
            lora_names,
            adapter_weights=_lora_weights_at_progress(
                lora_weights, lora_schedules, 0.0
            ),
        )
    return (
        prompt,
        negative_prompt,
        applied,
        lora_names,
        lora_weights,
        lora_schedules,
    )


def _lora_denoising_schedule(
    addon: dict[str, Any],
    addon_id: str,
    target_components: list[str],
    text_strength: Any,
) -> dict[str, float] | None:
    value = addon.get("denoisingSchedule")
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {"start", "end"}:
        raise WorkerError(
            f"LoRA {addon_id} denoising schedule must contain only start and end"
        )
    start = value.get("start")
    end = value.get("end")
    if (
        isinstance(start, bool)
        or not isinstance(start, (int, float))
        or not math.isfinite(start)
        or isinstance(end, bool)
        or not isinstance(end, (int, float))
        or not math.isfinite(end)
        or start < 0
        or start >= end
        or end > 1
    ):
        raise WorkerError(
            f"LoRA {addon_id} denoising schedule must satisfy 0 <= start < end <= 1"
        )
    if target_components != ["denoiser"] or text_strength is not None:
        raise WorkerError(
            f"LoRA {addon_id} denoising schedule requires denoiser-only weights"
        )
    return {"start": float(start), "end": float(end)}


def _lora_weights_at_progress(
    weights: list[float | dict[str, float]],
    schedules: list[dict[str, float] | None],
    progress: float,
) -> list[float | dict[str, float]]:
    if len(weights) != len(schedules) or not 0 <= progress <= 1:
        raise WorkerError("LoRA denoising schedule state is invalid")
    return [
        weight
        if schedule is None
        or (schedule["start"] <= progress < schedule["end"])
        else 0.0
        for weight, schedule in zip(weights, schedules, strict=True)
    ]


def _scheduled_lora_callback(
    names: list[str],
    weights: list[float | dict[str, float]],
    schedules: list[dict[str, float] | None],
    step_count: int,
) -> Any:
    current_weights = [_lora_weights_at_progress(weights, schedules, 0.0)]

    def on_step_end(
        callback_pipeline: Any,
        step_index: int,
        _timestep: Any,
        callback_kwargs: dict[str, Any],
    ) -> dict[str, Any]:
        progress = min(1.0, (step_index + 1) / step_count)
        next_weights = _lora_weights_at_progress(weights, schedules, progress)
        if next_weights != current_weights[0]:
            callback_pipeline.set_adapters(names, adapter_weights=next_weights)
            current_weights[0] = next_weights
        return callback_kwargs

    return on_step_end


def _dimensions(
    architecture: str, aspect_ratio: str, policy: str
) -> tuple[int, int]:
    small = architecture in ("stable-diffusion-1", "stable-diffusion-2")
    if architecture in ("flux-2", "krea-2"):
        scale = (
            {"fast": 512, "balanced": 768, "quality": 1_024}[policy]
            if architecture == "flux-2"
            else {"fast": 512, "balanced": 768, "quality": 768}[policy]
        )
        table = {
            "1:1": (scale, scale),
            "4:5": (scale // 8 * 7, scale // 8 * 9),
            "16:9": (scale // 8 * 11, scale // 8 * 6),
            "9:16": (scale // 8 * 6, scale // 8 * 11),
        }
        if aspect_ratio not in table:
            raise WorkerError(f"Unsupported aspect ratio: {aspect_ratio}")
        return table[aspect_ratio]
    table = {
        "1:1": (512, 512) if small else (1024, 1024),
        "4:5": (448, 560) if small else (896, 1120),
        "16:9": (768, 432) if small else (1344, 768),
        "9:16": (432, 768) if small else (768, 1344),
    }
    if aspect_ratio not in table:
        raise WorkerError(f"Unsupported aspect ratio: {aspect_ratio}")
    return table[aspect_ratio]


def _steps(architecture: str, policy: str) -> int:
    if architecture == "flux-2":
        # FLUX.2 Klein is step-distilled for exactly four production steps.
        # Extra steps do not turn it into the 50-step Base checkpoint and can
        # move the sample away from the checkpoint's trained trajectory.
        return 4
    if architecture == "krea-2":
        return {"fast": 8, "balanced": 10, "quality": 12}[policy]
    return {"fast": 16, "balanced": 24, "quality": 32}[policy]


def _configure_large_image_vae_decode(
    pipeline: Any,
    architecture: str,
    torch: Any,
    width: int,
    height: int,
) -> dict[str, Any]:
    """Use the model's overlapping tiled decoder above a 1024-pixel edge.

    FLUX.2 quality canvases exceed the VAE's native 1024 sample size. On the
    validated Windows RDNA 4 runtime a monolithic BF16 decode can dispatch an
    unsupported MIOpen convolution after sampling has already completed.
    Diffusers' native tiler preserves the generated latent while bounding every
    decode convolution and blending overlaps.
    """
    enabled = max(width, height) > 1_024
    vae = getattr(pipeline, "vae", None)
    enable_tiling = getattr(vae, "enable_tiling", None)
    if enabled and not callable(enable_tiling):
        raise WorkerError(
            "The selected model cannot decode its quality canvas with bounded VAE tiles"
        )
    if enabled:
        enable_tiling()
        if architecture == "flux-2":
            # The FLUX.2 VAE's default 1024-pixel tile still dispatches a
            # 128x128 latent convolution. Use its supported configurable tile
            # contract to keep the CPU fallback bounded.
            vae.tile_sample_min_size = 512
            vae.tile_latent_min_size = 64
    post_quant_backend = "native"
    post_quant = getattr(vae, "post_quant_conv", None)
    if (
        enabled
        and architecture == "flux-2"
        and getattr(torch.version, "hip", None) is not None
        and getattr(post_quant, "kernel_size", None) == (1, 1)
    ):
        def linear_1x1_conv(module: Any, inputs: Any) -> Any:
            channels_last = inputs.permute(0, 2, 3, 1)
            projected = torch.nn.functional.linear(
                channels_last,
                module.weight[:, :, 0, 0],
                module.bias,
            )
            return projected.permute(0, 3, 1, 2).contiguous()

        post_quant.forward = types.MethodType(linear_1x1_conv, post_quant)
        post_quant_backend = "hip-linear-equivalent-1x1"
    return {
        "mode": (
            "cpu-overlap-tiled"
            if enabled
            and architecture == "flux-2"
            and getattr(torch.version, "hip", None) is not None
            else "native-overlap-tiled"
            if enabled
            else "native-full-frame"
        ),
        "enabled": enabled,
        "thresholdPixels": 1_024,
        "postQuantBackend": post_quant_backend,
        "device": (
            "cpu"
            if enabled
            and architecture == "flux-2"
            and getattr(torch.version, "hip", None) is not None
            else "pipeline"
        ),
    }


def _decode_flux2_latents_on_cpu(
    pipeline: Any,
    torch: Any,
    latents: Any,
) -> Any:
    """Decode an already-sampled FLUX.2 latent without a Windows HIP conv."""
    from accelerate.hooks import remove_hook_from_module

    vae = pipeline.vae
    remove_hook_from_module(vae, recurse=True)
    vae.to(device=torch.device("cpu"), dtype=torch.float32)
    host_latents = latents.detach().to(
        device=torch.device("cpu"),
        dtype=torch.float32,
    )
    with torch.inference_mode():
        decoded = vae.decode(host_latents, return_dict=False)[0]
    return pipeline.image_processor.postprocess(decoded, output_type="pil")[0]


def _validate_generated_pixels(
    image: Any,
    applied_addons: list[dict[str, Any]],
    require_chroma_background: bool,
) -> None:
    """Reject collapsed adapter output and explicitly requested broken chroma plates."""
    if any(addon.get("kind") == "lora" for addon in applied_addons):
        sample = image.convert("RGB")
        sample.thumbnail((128, 128))
        extrema = sample.getextrema()
        histogram = sample.histogram()
        pixel_count = sample.width * sample.height
        channel_means = [
            sum(
                value * count
                for value, count in enumerate(histogram[offset : offset + 256])
            )
            / pixel_count
            for offset in (0, 256, 512)
        ]
        peak = max(maximum for _, maximum in extrema)
        floor = min(minimum for minimum, _ in extrema)
        collapsed_dark = max(channel_means) < 6.0 and peak < 160
        collapsed_light = min(channel_means) > 249.0 and floor > 95
        if collapsed_dark or collapsed_light:
            addon_ids = ", ".join(
                str(addon.get("addonId", "unknown"))
                for addon in applied_addons
                if addon.get("kind") == "lora"
            )
            raise WorkerError(
                "Generated pixels collapsed near "
                f"{'black' if collapsed_dark else 'white'} after applying LoRA {addon_ids}. "
                "The adapter is incompatible with this model/runtime at the selected strength; "
                "lower its strength or choose a compatible adapter."
            )
    if require_chroma_background:
        import numpy as np

        pixels = np.asarray(image.convert("RGB"), dtype=np.uint8).astype(np.int16)
        border_width = max(2, round(min(pixels.shape[:2]) * 0.025))
        border = np.concatenate(
            (
                pixels[:border_width].reshape(-1, 3),
                pixels[-border_width:].reshape(-1, 3),
                pixels[:, :border_width].reshape(-1, 3),
                pixels[:, -border_width:].reshape(-1, 3),
            )
        )
        dominance = border[:, 1] - np.maximum(border[:, 0], border[:, 2])
        keyed_ratio = float(np.mean(dominance >= 28))
        if keyed_ratio < 0.55:
            raise WorkerError(
                "Generated pixels lost the requested chroma-green background "
                f"({keyed_ratio:.1%} usable border). The edit numerically collapsed "
                "or ignored its transparency staging instruction; retry with a "
                "reviewed seed or lower edit/reference strength."
            )


def _krea_edit_source_pixels(
    source: Any,
    target_width: int,
    target_height: int,
    fit_mode: str,
) -> tuple[Any, dict[str, Any]]:
    from PIL import Image, ImageOps

    if fit_mode not in ("fit", "crop"):
        raise WorkerError("referenceFit must be fit or crop")
    source = source.convert("RGB")
    input_width, input_height = source.size
    if fit_mode == "crop":
        prepared = ImageOps.fit(
            source,
            (target_width, target_height),
            method=Image.Resampling.BICUBIC,
            centering=(0.5, 0.5),
        )
    else:
        scale = min(target_height / input_height, target_width / input_width)
        scaled_height = input_height * scale
        scaled_width = input_width * scale
        near_match = (
            scaled_height >= target_height * 0.92
            and scaled_width >= target_width * 0.92
        )
        if near_match:
            prepared = ImageOps.fit(
                source,
                (target_width, target_height),
                method=Image.Resampling.BICUBIC,
                centering=(0.5, 0.5),
            )
        else:
            # v1.2 was trained with a fit-inside source whose dimensions are
            # floored to /16, then positioned at a centered integer token offset.
            prepared_width = min(
                max(16, int(scaled_width) // 16 * 16),
                max(16, target_width // 16 * 16),
            )
            prepared_height = min(
                max(16, int(scaled_height) // 16 * 16),
                max(16, target_height // 16 * 16),
            )
            prepared = source.resize(
                (prepared_width, prepared_height),
                Image.Resampling.BICUBIC,
            )
    return prepared, {
        "fitMode": fit_mode,
        "sourceWidth": input_width,
        "sourceHeight": input_height,
        "encodedWidth": prepared.width,
        "encodedHeight": prepared.height,
        "targetWidth": target_width,
        "targetHeight": target_height,
    }


def _patch_krea_transformer_for_edit(
    pipeline: Any,
    torch: Any,
    source_tokens: Any,
    source_grid: tuple[int, int],
    target_grid: tuple[int, int],
    reference_boost: float,
) -> None:
    """Prepend clean source tokens to Diffusers KREA's [text|target] stream."""
    import torch.nn.functional as functional
    from diffusers.models.modeling_outputs import Transformer2DModelOutput

    transformer = pipeline.transformer
    transformer._machdoch_edit_source_tokens = source_tokens
    transformer._machdoch_edit_source_grid = source_grid
    transformer._machdoch_edit_target_grid = target_grid
    transformer._machdoch_edit_reference_boost = reference_boost

    def edit_forward(
        self: Any,
        hidden_states: Any,
        encoder_hidden_states: Any,
        timestep: Any,
        position_ids: Any,
        encoder_attention_mask: Any = None,
        attention_kwargs: dict[str, Any] | None = None,
        return_dict: bool = True,
    ) -> Any:
        del position_ids, attention_kwargs
        batch_size, target_sequence_length, _ = hidden_states.shape
        text_sequence_length = encoder_hidden_states.shape[1]
        source = self._machdoch_edit_source_tokens.to(
            device=hidden_states.device,
            dtype=hidden_states.dtype,
        )
        if source.shape[0] != batch_size:
            source = source[:1].expand(batch_size, -1, -1)
        source_sequence_length = source.shape[1]

        temporal_embedding = self.time_embed(
            timestep,
            dtype=hidden_states.dtype,
        )
        temporal_modulation = self.time_mod_proj(
            functional.gelu(temporal_embedding, approximate="tanh")
        )
        text_attention_mask = None
        attention_mask = None
        if encoder_attention_mask is not None:
            text_attention_mask = encoder_attention_mask[:, None, None, :]
            image_mask = encoder_attention_mask.new_ones(
                (batch_size, source_sequence_length + target_sequence_length)
            )
            attention_mask = torch.cat(
                [encoder_attention_mask, image_mask],
                dim=1,
            )[:, None, None, :]

        encoder_hidden_states = self.text_fusion(
            encoder_hidden_states,
            attention_mask=text_attention_mask,
        )
        encoder_hidden_states = self.txt_in(encoder_hidden_states)
        source_hidden_states = self.img_in(source)
        target_hidden_states = self.img_in(hidden_states)
        combined = torch.cat(
            [
                encoder_hidden_states,
                source_hidden_states,
                target_hidden_states,
            ],
            dim=1,
        )

        source_height, source_width = self._machdoch_edit_source_grid
        target_height, target_width = self._machdoch_edit_target_grid
        source_ids = torch.zeros(
            source_height,
            source_width,
            3,
            device=combined.device,
        )
        source_ids[..., 0] = 1.0
        source_ids[..., 1] = (
            torch.arange(source_height, device=combined.device)[:, None]
            + max(0, (target_height - source_height) // 2)
        )
        source_ids[..., 2] = (
            torch.arange(source_width, device=combined.device)[None, :]
            + max(0, (target_width - source_width) // 2)
        )
        target_ids = torch.zeros(
            target_height,
            target_width,
            3,
            device=combined.device,
        )
        target_ids[..., 1] = torch.arange(
            target_height,
            device=combined.device,
        )[:, None]
        target_ids[..., 2] = torch.arange(
            target_width,
            device=combined.device,
        )[None, :]
        text_ids = torch.zeros(
            text_sequence_length,
            3,
            device=combined.device,
        )
        edit_position_ids = torch.cat(
            [
                text_ids,
                source_ids.reshape(-1, 3),
                target_ids.reshape(-1, 3),
            ],
            dim=0,
        )
        if edit_position_ids.shape[0] != combined.shape[1]:
            raise WorkerError(
                "KREA edit source/target token geometry changed unexpectedly"
            )
        image_rotary_embedding = self.rotary_emb(edit_position_ids)

        reference_boost_value = float(
            self._machdoch_edit_reference_boost
        )
        if reference_boost_value != 1.0:
            sequence_length = combined.shape[1]
            additive_mask = torch.zeros(
                (batch_size, 1, sequence_length, sequence_length),
                device=combined.device,
                dtype=combined.dtype,
            )
            if encoder_attention_mask is not None:
                invalid_text = ~encoder_attention_mask.bool()
                additive_mask[:, :, :, :text_sequence_length].masked_fill_(
                    invalid_text[:, None, None, :],
                    torch.finfo(combined.dtype).min,
                )
            source_start = text_sequence_length
            target_start = source_start + source_sequence_length
            additive_mask[
                :,
                :,
                target_start:,
                source_start:target_start,
            ] += math.log(max(reference_boost_value, 1e-4))
            attention_mask = additive_mask

        for block in self.transformer_blocks:
            combined = block(
                combined,
                temporal_modulation,
                image_rotary_embedding,
                attention_mask,
            )
        target_output = combined[
            :,
            text_sequence_length + source_sequence_length :,
        ]
        output = self.final_layer(target_output, temporal_embedding)
        if not return_dict:
            return (output,)
        return Transformer2DModelOutput(sample=output)

    patched_forward = types.MethodType(edit_forward, transformer)
    hook_registry = getattr(transformer, "_diffusers_hook", None)
    hook_references = getattr(hook_registry, "_fn_refs", None)
    if hook_references:
        # Diffusers' native HookRegistry wraps Module.forward and stores the
        # original callable in the first reference. Replacing the public wrapper
        # bypasses its group-onload pre-hook; replacing this leaf preserves the
        # complete device-alignment chain.
        hook_references[0].forward = patched_forward
    elif hasattr(transformer, "_old_forward"):
        transformer._old_forward = patched_forward
    else:
        transformer.forward = patched_forward


def _prepare_krea_edit_source(
    pipeline: Any,
    torch: Any,
    reference_path: Path,
    width: int,
    height: int,
    fit_mode: str,
    reference_boost: float,
) -> dict[str, Any]:
    from PIL import Image

    with Image.open(reference_path) as opened:
        source_image = opened.convert("RGB")
    prepared, evidence = _krea_edit_source_pixels(
        source_image,
        width,
        height,
        fit_mode,
    )
    device = torch.device(f"cuda:{torch.cuda.current_device()}")
    pixels = pipeline.image_processor.preprocess(
        prepared,
        height=prepared.height,
        width=prepared.width,
    ).to(device=device, dtype=pipeline.vae.dtype)
    if getattr(torch.version, "hip", None) is not None:
        # Match the native HIP Conv3D fallback used by WAN. MIOpen's gfx1201
        # tiled Qwen VAE encode path currently reports invalid-device-function.
        torch.backends.cudnn.enabled = False
    with torch.inference_mode():
        posterior = pipeline.vae.encode(pixels.unsqueeze(2)).latent_dist
        source_latent = posterior.mode()
    latent_mean = torch.tensor(
        pipeline.vae.config.latents_mean,
        device=device,
        dtype=source_latent.dtype,
    ).view(1, pipeline.vae.config.z_dim, 1, 1, 1)
    latent_std = torch.tensor(
        pipeline.vae.config.latents_std,
        device=device,
        dtype=source_latent.dtype,
    ).view(1, pipeline.vae.config.z_dim, 1, 1, 1)
    source_latent = (source_latent - latent_mean) / latent_std
    source_latent = source_latent[:, :, 0]
    latent_height, latent_width = source_latent.shape[-2:]
    source_tokens = pipeline._pack_latents(  # noqa: SLF001
        source_latent,
        source_latent.shape[0],
        source_latent.shape[1],
        latent_height,
        latent_width,
    )
    target_grid = (
        height // (pipeline.vae_scale_factor * pipeline.patch_size),
        width // (pipeline.vae_scale_factor * pipeline.patch_size),
    )
    source_grid = (
        latent_height // pipeline.patch_size,
        latent_width // pipeline.patch_size,
    )
    _patch_krea_transformer_for_edit(
        pipeline,
        torch,
        source_tokens,
        source_grid,
        target_grid,
        reference_boost,
    )
    return {
        "engine": "clean-vae-source-tokens-v1",
        "sourceDigest": _sha256_file(reference_path),
        **evidence,
        "sourceGridHeight": source_grid[0],
        "sourceGridWidth": source_grid[1],
        "targetGridHeight": target_grid[0],
        "targetGridWidth": target_grid[1],
        "sourceTokenCount": int(source_tokens.shape[1]),
        "targetTokenCount": target_grid[0] * target_grid[1],
        "referenceBoost": reference_boost,
        "sourceRopeFrame": 1,
        "targetRopeFrame": 0,
    }


def generate(request: dict[str, Any]) -> dict[str, Any]:
    if request.get("schemaVersion") != SCHEMA_VERSION:
        raise WorkerError("Unsupported worker request schema")
    torch, diffusers = _runtime()
    model = request.get("model")
    if not isinstance(model, dict):
        raise WorkerError("model is required")
    prompt = _required_text(request, "prompt", 8_000)
    negative_prompt = request.get("negativePrompt", "")
    if not isinstance(negative_prompt, str) or len(negative_prompt) > 8_000:
        raise WorkerError("negativePrompt is invalid")
    output_count = request.get("outputCount")
    if not isinstance(output_count, int) or not 1 <= output_count <= 8:
        raise WorkerError("outputCount must be between 1 and 8")
    output_format = request.get("outputFormat")
    if output_format not in ("png", "jpeg", "webp"):
        raise WorkerError("outputFormat is invalid")
    policy = request.get("modelPolicy")
    if policy not in ("fast", "balanced", "quality"):
        raise WorkerError("modelPolicy is invalid")
    seed = request.get("seed")
    if not isinstance(seed, int) or not 0 <= seed < 2**63:
        raise WorkerError("seed is invalid")
    architecture = _required_text(model, "architecture", 64)
    width, height = _dimensions(architecture, request.get("aspectRatio"), policy)
    output_directory = _fresh_output_directory(request.get("outputDirectory"))
    addons = request.get("addons", [])
    if not isinstance(addons, list) or len(addons) > 24:
        raise WorkerError("addons is invalid")
    require_chroma_background = request.get("requireChromaBackground", False)
    if not isinstance(require_chroma_background, bool):
        raise WorkerError("requireChromaBackground must be a boolean")

    krea_prompt_embeds = None
    krea_prompt_mask = None
    krea_grounding_evidence = None
    krea_source_evidence = None
    krea_performance_evidence = None
    reference_path = None
    reference_value = request.get("referenceImagePath")
    if reference_value is not None:
        reference_path = _absolute_existing_path(reference_value, file=True)
        if reference_path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
            raise WorkerError("referenceImagePath must be a supported image")
        if architecture != "krea-2":
            raise WorkerError(
                "Local reference editing currently requires a KREA 2 model"
            )
    if architecture == "krea-2":
        config_path = _absolute_existing_path(model.get("configPath"), file=False)
        krea_text_root, _ = _krea_runtime_paths(config_path)
        # Qwen3-VL and the 12B KREA transformer do not overlap in the graph.
        # Encode first and release Qwen before materializing the FP8 denoiser,
        # avoiding a 22+ GB host working set on 32 GB systems.
        if reference_path is None:
            krea_prompt_embeds, krea_prompt_mask = _encode_krea_prompt(
                torch,
                krea_text_root,
                prompt,
            )
        else:
            grounding_pixels = request.get("groundingPixels", 768)
            if (
                not isinstance(grounding_pixels, int)
                or isinstance(grounding_pixels, bool)
            ):
                raise WorkerError("groundingPixels must be an integer")
            (
                krea_prompt_embeds,
                krea_prompt_mask,
                krea_grounding_evidence,
            ) = _encode_krea_grounded_prompt(
                torch,
                krea_text_root,
                prompt,
                reference_path,
                grounding_pixels,
            )
    pipeline = _load_pipeline(diffusers, torch, model)
    vae_decode_evidence = _configure_large_image_vae_decode(
        pipeline,
        architecture,
        torch,
        width,
        height,
    )
    (
        prompt,
        negative_prompt,
        applied,
        lora_names,
        lora_weights,
        lora_schedules,
    ) = _apply_addons(
        pipeline, addons, prompt, negative_prompt
    )
    if reference_path is not None:
        edit_addons = [
            addon
            for addon in addons
            if addon.get("enabled", True)
            and addon.get("kind") == "lora"
            and (
                addon.get("digest") == KREA_IDENTITY_EDIT_V1_2_R64_DIGEST
                or Path(str(addon.get("path", ""))).name.startswith(
                    "krea2_identity_edit_v1_2"
                )
            )
        ]
        if len(edit_addons) != 1:
            raise WorkerError(
                "KREA local editing requires exactly one reviewed "
                "krea2_identity_edit_v1_2 adapter"
            )
        edit_strength = request.get("editStrength", 0.5)
        if (
            not isinstance(edit_strength, (int, float))
            or isinstance(edit_strength, bool)
            or not math.isfinite(float(edit_strength))
            or not 0.0 <= float(edit_strength) <= 1.0
        ):
            raise WorkerError("editStrength must be between 0 and 1")
        default_reference_boost = 1.0 + (1.0 - float(edit_strength)) * 3.0
        reference_boost = request.get(
            "referenceBoost",
            default_reference_boost,
        )
        if (
            not isinstance(reference_boost, (int, float))
            or isinstance(reference_boost, bool)
            or not math.isfinite(float(reference_boost))
            or not 0.25 <= float(reference_boost) <= 8.0
        ):
            raise WorkerError("referenceBoost must be between 0.25 and 8")
        reference_fit = request.get("referenceFit", "fit")
        if not isinstance(reference_fit, str):
            raise WorkerError("referenceFit must be a string")
        krea_source_evidence = _prepare_krea_edit_source(
            pipeline,
            torch,
            reference_path,
            width,
            height,
            reference_fit,
            float(reference_boost),
        )
        krea_source_evidence["editStrength"] = float(edit_strength)
    if architecture == "krea-2":
        krea_performance_evidence = _configure_krea_offload(
            pipeline,
            torch,
            model,
            addons,
            request.get("memoryProfile"),
        )
    device, device_label, device_memory = _device(torch)
    call_parameters = inspect.signature(pipeline.__call__).parameters
    step_count = _steps(architecture, policy)
    has_lora_schedule = any(schedule is not None for schedule in lora_schedules)
    if has_lora_schedule and "callback_on_step_end" not in call_parameters:
        raise WorkerError(
            "The selected pipeline cannot change LoRA strength during denoising"
        )
    outputs: list[dict[str, Any]] = []
    pending_cpu_decodes: list[tuple[int, int, Any]] = []

    def publish_image(index: int, image_seed: int, generated_image: Any) -> None:
        suffix = "jpg" if output_format == "jpeg" else output_format
        filename = f"output-{index:04d}.{suffix}"
        destination = output_directory / filename
        save_format = {"png": "PNG", "jpeg": "JPEG", "webp": "WEBP"}[output_format]
        image = generated_image.convert("RGB")
        _validate_generated_pixels(image, applied, require_chroma_background)
        image.save(destination, format=save_format, quality=95, exif=b"")
        outputs.append(
            {
                "index": index,
                "fileName": filename,
                "seed": image_seed,
                "width": image.width,
                "height": image.height,
            }
        )

    for index in range(output_count):
        if lora_names:
            pipeline.set_adapters(
                lora_names,
                adapter_weights=_lora_weights_at_progress(
                    lora_weights, lora_schedules, 0.0
                ),
            )
        image_seed = seed + index
        generator_device = (
            f"cuda:{torch.cuda.current_device()}" if device == "cuda" else "cpu"
        )
        generator = torch.Generator(device=generator_device).manual_seed(image_seed)
        arguments: dict[str, Any] = {
            "prompt": prompt,
            "width": width,
            "height": height,
            "num_inference_steps": step_count,
            "generator": generator,
            "num_images_per_prompt": 1,
        }
        if architecture == "krea-2":
            cuda_device = torch.device(f"cuda:{torch.cuda.current_device()}")
            arguments["prompt"] = None
            arguments["prompt_embeds"] = krea_prompt_embeds.to(cuda_device)
            arguments["prompt_embeds_mask"] = krea_prompt_mask.to(cuda_device)
            # Community KREA 2 accelerated checkpoints document CFG=1. In the
            # Diffusers KREA convention the conditional-only equivalent is 0.
            arguments["guidance_scale"] = 0.0
        if architecture == "flux-2" and "guidance_scale" in call_parameters:
            # FLUX.2 Klein is distilled for guidance 1.0. Larger classifier-free
            # guidance values cost memory and diverge from the model card recipe.
            arguments["guidance_scale"] = 1.0
        if "negative_prompt" in call_parameters and negative_prompt.strip():
            arguments["negative_prompt"] = negative_prompt
        elif negative_prompt.strip():
            raise WorkerError(
                f"{architecture} does not expose negative-prompt conditioning in this pipeline"
            )
        if has_lora_schedule:
            arguments["callback_on_step_end"] = _scheduled_lora_callback(
                lora_names, lora_weights, lora_schedules, step_count
            )
        cpu_vae_decode = vae_decode_evidence["device"] == "cpu"
        if cpu_vae_decode:
            arguments["output_type"] = "latent"
        result = pipeline(**arguments)
        if cpu_vae_decode:
            if result.images is None:
                raise WorkerError(f"Pipeline returned no latent for output {index + 1}")
            pending_cpu_decodes.append(
                (
                    index,
                    image_seed,
                    result.images.detach().to(device=torch.device("cpu")),
                )
            )
            continue
        else:
            if not result.images:
                raise WorkerError(f"Pipeline returned no image for output {index + 1}")
            generated_image = result.images[0]
        publish_image(index, image_seed, generated_image)

    for index, image_seed, latents in pending_cpu_decodes:
        generated_image = _decode_flux2_latents_on_cpu(
            pipeline,
            torch,
            latents,
        )
        publish_image(index, image_seed, generated_image)
    outputs.sort(key=lambda output: output["index"])
    return {
        "schemaVersion": SCHEMA_VERSION,
        "workerVersion": WORKER_VERSION,
        "packages": _package_versions(),
        "device": device,
        "deviceLabel": device_label,
        "deviceMemoryBytes": device_memory,
        "prompt": prompt,
        "negativePrompt": negative_prompt,
        "modelPolicy": policy,
        "aspectRatio": request.get("aspectRatio"),
        "numInferenceSteps": step_count,
        "vaeDecode": vae_decode_evidence,
        "addons": applied,
        "performance": krea_performance_evidence,
        "requireChromaBackground": require_chroma_background,
        "editConditioning": (
            {
                "mode": "krea2-identity-edit-v1.2",
                "grounding": krea_grounding_evidence,
                "sourceTokens": krea_source_evidence,
            }
            if reference_path is not None
            else None
        ),
        "outputs": outputs,
    }


def _encode_video_prompt_embeddings(
    torch: Any,
    model_path: Path,
    prompt: str,
    negative_prompt: str,
) -> tuple[Any, Any]:
    """Encode WAN text before loading the transformer.

    UMT5-XXL and the WAN transformer together exceed this host's available
    commit during pipeline.from_pretrained(). Their execution order does not
    overlap, so retaining both models is unnecessary. Encode both prompt
    channels first, release UMT5, and only then load the denoiser.
    """
    from diffusers.pipelines.wan.pipeline_wan import prompt_clean
    from transformers import AutoTokenizer, UMT5EncoderModel

    tokenizer = AutoTokenizer.from_pretrained(
        str(model_path),
        subfolder="tokenizer",
        local_files_only=True,
        trust_remote_code=False,
    )
    text_encoder = UMT5EncoderModel.from_pretrained(
        str(model_path),
        subfolder="text_encoder",
        torch_dtype=torch.bfloat16,
        local_files_only=True,
        use_safetensors=True,
        trust_remote_code=False,
        low_cpu_mem_usage=True,
    )
    cuda_device = torch.device(f"cuda:{torch.cuda.current_device()}")
    text_encoder.to(cuda_device)
    cleaned_prompts = [prompt_clean(prompt), prompt_clean(negative_prompt)]
    text_inputs = tokenizer(
        cleaned_prompts,
        padding="max_length",
        max_length=512,
        truncation=True,
        add_special_tokens=True,
        return_attention_mask=True,
        return_tensors="pt",
    )
    input_ids = text_inputs.input_ids.to(cuda_device)
    attention_mask = text_inputs.attention_mask.to(cuda_device)
    sequence_lengths = attention_mask.gt(0).sum(dim=1).long().tolist()
    with torch.inference_mode():
        hidden_states = text_encoder(input_ids, attention_mask).last_hidden_state
    embeddings = []
    for hidden_state, sequence_length in zip(hidden_states, sequence_lengths):
        # The text encoder itself runs on the AMD adapter. Assemble the small
        # padded result on the host because Windows ROCm 7.14 can
        # nondeterministically fault in a standalone HIP cat kernel after a
        # large model forward (the same limitation handled by KREA above).
        trimmed = hidden_state[:sequence_length].to(
            device="cpu", dtype=torch.bfloat16
        )
        embeddings.append(
            torch.cat(
                (
                    trimmed,
                    trimmed.new_zeros(512 - trimmed.size(0), trimmed.size(1)),
                )
            )
        )
    embeddings = torch.stack(embeddings)
    prompt_embeddings = embeddings[0:1].contiguous()
    negative_prompt_embeddings = embeddings[1:2].contiguous()
    del hidden_states, embeddings, text_inputs, input_ids, attention_mask
    del text_encoder, tokenizer
    gc.collect()
    torch.cuda.empty_cache()
    return prompt_embeddings, negative_prompt_embeddings


def _configure_video_offload(
    transformer: Any,
    torch: Any,
    requested_profile: Any,
) -> dict[str, Any]:
    if requested_profile is None:
        requested_profile = "auto"
    if requested_profile not in (
        "auto",
        "memory-saver",
        "balanced",
        "maximum-speed",
    ):
        raise WorkerError(
            "memoryProfile must be auto, memory-saver, balanced, or maximum-speed"
        )
    physical_memory = _physical_memory_bytes()
    device_memory = int(
        torch.cuda.get_device_properties(torch.cuda.current_device()).total_memory
    )
    effective_profile = _select_video_memory_profile(
        requested_profile,
        physical_memory,
        device_memory,
    )
    group_size = _video_offload_group_size(device_memory, effective_profile)
    if effective_profile == "maximum-speed" and device_memory >= 48 * 1024**3:
        transformer.to(torch.device(f"cuda:{torch.cuda.current_device()}"))
        offload_type = "none"
        group_size = None
    else:
        transformer.enable_group_offload(
            onload_device=torch.device(f"cuda:{torch.cuda.current_device()}"),
            offload_device=torch.device("cpu"),
            offload_type="block_level",
            num_blocks_per_group=group_size,
            use_stream=False,
        )
        offload_type = "block-level-cpu"
    return {
        "requestedMemoryProfile": requested_profile,
        "effectiveMemoryProfile": effective_profile,
        "physicalMemoryBytes": physical_memory,
        "deviceMemoryBytes": device_memory,
        "offloadType": offload_type,
        "blocksPerGroup": group_size,
        "diskCacheHit": None,
        "diskCachePath": None,
        "diskCacheFiles": None,
        "diskCacheBytes": None,
        "windowsDiskOffloadCompatibility": False,
    }


def _select_video_memory_profile(
    requested_profile: str,
    physical_memory: int | None,
    device_memory: int | None,
) -> str:
    if requested_profile != "auto":
        return requested_profile
    if (
        physical_memory is None
        or device_memory is None
        or physical_memory < 16 * 1024**3
        or device_memory < 12 * 1024**3
    ):
        return "memory-saver"
    if physical_memory >= 48 * 1024**3 and device_memory >= 48 * 1024**3:
        return "maximum-speed"
    return "balanced"


def _video_offload_group_size(
    device_memory: int | None,
    memory_profile: str = "balanced",
) -> int:
    if memory_profile == "memory-saver":
        return 1
    if device_memory is not None and device_memory >= 23 * 1024**3:
        return 8
    if device_memory is not None and device_memory >= 15 * 1024**3:
        return 4
    if device_memory is not None and device_memory >= 11 * 1024**3:
        return 2
    return 1


def _framepack_vae_tile_configuration(device_memory: int | None) -> dict[str, int]:
    if device_memory is not None and device_memory >= 24 * 1024**3:
        return {
            "tile_sample_min_height": 256,
            "tile_sample_min_width": 256,
            "tile_sample_min_num_frames": 16,
            "tile_sample_stride_height": 192,
            "tile_sample_stride_width": 192,
            "tile_sample_stride_num_frames": 12,
        }
    return {
        "tile_sample_min_height": 64,
        "tile_sample_min_width": 64,
        "tile_sample_min_num_frames": 8,
        "tile_sample_stride_height": 48,
        "tile_sample_stride_width": 48,
        "tile_sample_stride_num_frames": 6,
    }


def _indexed_checkpoint_files(model_path: Path, relative_index: str) -> list[Path]:
    index_path = model_path / relative_index
    if not index_path.is_file():
        raise WorkerError(f"Model package is missing {relative_index}")
    index = json.loads(index_path.read_text(encoding="utf-8"))
    weight_map = index.get("weight_map")
    if not isinstance(weight_map, dict) or not weight_map:
        raise WorkerError(f"{relative_index} has no checkpoint weight map")
    index_directory = index_path.parent
    files: list[Path] = []
    for filename in sorted(set(weight_map.values())):
        if not isinstance(filename, str) or Path(filename).name != filename:
            raise WorkerError(f"{relative_index} contains an unsafe checkpoint path")
        files.append(index_directory / filename)
    return files


def _validate_hunyuan_video_15_package(
    model: dict[str, Any],
    torch: Any,
) -> tuple[Path, int]:
    if _required_text(model, "packageKind", 64) != "diffusers-directory":
        raise WorkerError("HunyuanVideo 1.5 generation requires a Diffusers directory")
    model_path = _absolute_existing_path(model.get("path"), file=False)
    required = [
        model_path / "model_index.json",
        model_path / "scheduler" / "scheduler_config.json",
        model_path / "guider" / "guider_config.json",
        model_path / "text_encoder" / "config.json",
        model_path / "text_encoder" / "model.safetensors.index.json",
        model_path / "text_encoder_2" / "config.json",
        model_path / "text_encoder_2" / "model.safetensors",
        model_path / "tokenizer" / "tokenizer.json",
        model_path / "tokenizer" / "tokenizer_config.json",
        model_path / "tokenizer_2" / "tokenizer_config.json",
        model_path / "transformer" / "config.json",
        model_path
        / "transformer"
        / "diffusion_pytorch_model.safetensors.index.json",
        model_path / "vae" / "config.json",
        model_path / "vae" / "diffusion_pytorch_model.safetensors",
        model_path / "feature_extractor" / "preprocessor_config.json",
        model_path / "image_encoder" / "config.json",
        model_path / "image_encoder" / "model.safetensors",
    ]
    required.extend(
        _indexed_checkpoint_files(
            model_path,
            "text_encoder/model.safetensors.index.json",
        )
    )
    required.extend(
        _indexed_checkpoint_files(
            model_path,
            "transformer/diffusion_pytorch_model.safetensors.index.json",
        )
    )
    missing = [
        path.relative_to(model_path).as_posix()
        for path in required
        if not path.is_file() or path.stat().st_size == 0
    ]
    if missing:
        raise WorkerError(
            "HunyuanVideo 1.5 model package is incomplete; missing "
            + ", ".join(missing)
        )
    model_index = json.loads(
        (model_path / "model_index.json").read_text(encoding="utf-8")
    )
    transformer_config = json.loads(
        (model_path / "transformer" / "config.json").read_text(encoding="utf-8")
    )
    if model_index.get("_class_name") != "HunyuanVideo15ImageToVideoPipeline":
        raise WorkerError(
            "HunyuanVideo 1.5 package does not declare the reviewed I2V pipeline"
        )
    reviewed_transformer = {
        "_class_name": "HunyuanVideo15Transformer3DModel",
        "task_type": "i2v",
        "num_layers": 54,
        "num_refiner_layers": 2,
        "num_attention_heads": 16,
        "attention_head_dim": 128,
        "text_embed_dim": 3584,
        "text_embed_2_dim": 1472,
        "image_embed_dim": 1152,
        "in_channels": 65,
        "out_channels": 32,
        "use_meanflow": True,
    }
    mismatched = [
        key
        for key, expected in reviewed_transformer.items()
        if transformer_config.get(key) != expected
    ]
    if mismatched:
        raise WorkerError(
            "HunyuanVideo 1.5 transformer does not match the reviewed "
            "step-distilled I2V profile: "
            + ", ".join(mismatched)
        )
    device, _, device_memory = _device(torch)
    if device != "cuda":
        raise WorkerError(
            "HunyuanVideo 1.5 I2V requires a supported GPU; use LTX-Video 2B "
            "on CPU-only systems"
        )
    if (
        device_memory is None
        or device_memory < HUNYUAN_VIDEO_15_MIN_MEMORY_BYTES
    ):
        raise WorkerError(
            "HunyuanVideo 1.5 I2V requires at least 14 GiB of usable GPU memory"
        )
    physical_memory = _physical_memory_bytes()
    if (
        physical_memory is not None
        and physical_memory < HUNYUAN_VIDEO_15_MIN_PHYSICAL_MEMORY_BYTES
    ):
        raise WorkerError(
            "HunyuanVideo 1.5 I2V requires at least 30 GiB of physical memory; "
            "use FramePack or LTX-Video 2B on this system"
        )
    if not torch.cuda.is_bf16_supported():
        raise WorkerError("HunyuanVideo 1.5 generation requires bfloat16 support")
    return model_path, device_memory


def _hunyuan_video_15_vae_tile_configuration(
    device_memory: int | None,
) -> dict[str, int]:
    sample_size = 256 if device_memory is not None and device_memory >= 24 * 1024**3 else 128
    latent_size = sample_size // 16
    return {
        "tile_sample_min_height": sample_size,
        "tile_sample_min_width": sample_size,
        "tile_latent_min_height": latent_size,
        "tile_latent_min_width": latent_size,
    }


def _encode_hunyuan_video_15_prompt(
    pipeline_class: Any,
    torch: Any,
    prompt: str,
    execution_device: Any,
    tokenizer: Any,
    text_encoder: Any,
    tokenizer_2: Any,
    text_encoder_2: Any,
) -> tuple[Any, Any, Any, Any]:
    with torch.inference_mode():
        prompt_embeddings, prompt_attention_mask = (
            pipeline_class._get_mllm_prompt_embeds(
                tokenizer=tokenizer,
                text_encoder=text_encoder,
                prompt=prompt,
                device=execution_device,
                tokenizer_max_length=1000,
            )
        )
        prompt_embeddings_2, prompt_attention_mask_2 = (
            pipeline_class._get_byt5_prompt_embeds(
                tokenizer=tokenizer_2,
                text_encoder=text_encoder_2,
                prompt=prompt,
                device=execution_device,
                tokenizer_max_length=256,
            )
        )
        tensors = tuple(
            tensor.to(
                device="cpu",
                dtype=torch.bfloat16,
            ).contiguous()
            for tensor in (
                prompt_embeddings,
                prompt_attention_mask,
                prompt_embeddings_2,
                prompt_attention_mask_2,
            )
        )
    return tensors


def _encode_hunyuan_video_15_prompt_embeddings_in_process(
    diffusers: Any,
    torch: Any,
    model_path: Path,
    prompt: str,
) -> tuple[Any, Any, Any, Any, dict[str, Any]]:
    from diffusers.hooks import apply_group_offloading
    from transformers import (
        ByT5Tokenizer,
        Qwen2_5_VLTextModel,
        Qwen2TokenizerFast,
        T5EncoderModel,
    )

    execution_device = torch.device(f"cuda:{torch.cuda.current_device()}")
    device_memory = int(
        torch.cuda.get_device_properties(torch.cuda.current_device()).total_memory
    )
    prompt_group_size = _video_offload_group_size(device_memory)
    torch.cuda.reset_peak_memory_stats()
    initial_free_bytes = int(torch.cuda.mem_get_info()[0])
    tokenizer = Qwen2TokenizerFast.from_pretrained(
        str(model_path),
        subfolder="tokenizer",
        local_files_only=True,
        trust_remote_code=False,
    )
    text_encoder = Qwen2_5_VLTextModel.from_pretrained(
        str(model_path),
        subfolder="text_encoder",
        torch_dtype=torch.bfloat16,
        local_files_only=True,
        use_safetensors=True,
        trust_remote_code=False,
        low_cpu_mem_usage=True,
    )
    tokenizer_2 = ByT5Tokenizer.from_pretrained(
        str(model_path),
        subfolder="tokenizer_2",
        local_files_only=True,
        trust_remote_code=False,
    )
    text_encoder_2 = T5EncoderModel.from_pretrained(
        str(model_path),
        subfolder="text_encoder_2",
        torch_dtype=torch.bfloat16,
        local_files_only=True,
        use_safetensors=True,
        trust_remote_code=False,
        low_cpu_mem_usage=True,
    )
    text_encoder.eval()
    text_encoder_2.eval()
    apply_group_offloading(
        text_encoder,
        onload_device=execution_device,
        offload_device=torch.device("cpu"),
        offload_type="block_level",
        num_blocks_per_group=prompt_group_size,
        use_stream=False,
    )
    text_encoder_2.to(execution_device)
    (
        prompt_embeddings,
        prompt_attention_mask,
        prompt_embeddings_2,
        prompt_attention_mask_2,
    ) = _encode_hunyuan_video_15_prompt(
        diffusers.HunyuanVideo15ImageToVideoPipeline,
        torch,
        prompt,
        execution_device,
        tokenizer,
        text_encoder,
        tokenizer_2,
        text_encoder_2,
    )
    del text_encoder, text_encoder_2, tokenizer, tokenizer_2
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.synchronize()
    return (
        prompt_embeddings,
        prompt_attention_mask,
        prompt_embeddings_2,
        prompt_attention_mask_2,
        {
            "processIsolation": "prompt-encoder-subprocess",
            "blocksPerGroup": prompt_group_size,
            "initialFreeBytes": initial_free_bytes,
            "peakAllocatedBytes": int(torch.cuda.max_memory_allocated()),
            "postReleaseAllocatedBytes": int(torch.cuda.memory_allocated()),
            "postReleaseReservedBytes": int(torch.cuda.memory_reserved()),
        },
    )


def _encode_hunyuan_video_15_prompt_subprocess(
    request: dict[str, Any],
) -> dict[str, Any]:
    model_path = _absolute_existing_path(request.get("modelPath"), file=False)
    prompt = request.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 8_000:
        raise WorkerError(
            "HunyuanVideo 1.5 prompt must be a string from 1 to 8000 characters"
        )
    output_directory = _fresh_output_directory(request.get("outputDirectory"))
    torch, diffusers = _runtime()
    device, _, _ = _device(torch)
    if device != "cuda" or not torch.cuda.is_bf16_supported():
        raise WorkerError(
            "HunyuanVideo 1.5 prompt encoding requires a bfloat16 GPU"
        )
    (
        prompt_embeddings,
        prompt_attention_mask,
        prompt_embeddings_2,
        prompt_attention_mask_2,
        memory_evidence,
    ) = _encode_hunyuan_video_15_prompt_embeddings_in_process(
        diffusers,
        torch,
        model_path,
        prompt,
    )
    from safetensors.torch import save_file

    destination = output_directory / "hunyuan-video-1.5-prompt-embeddings.safetensors"
    save_file(
        {
            "prompt_embeddings": prompt_embeddings,
            "prompt_attention_mask": prompt_attention_mask,
            "prompt_embeddings_2": prompt_embeddings_2,
            "prompt_attention_mask_2": prompt_attention_mask_2,
        },
        destination,
    )
    return {
        "schemaVersion": SCHEMA_VERSION,
        "workerVersion": WORKER_VERSION,
        "fileName": destination.name,
        "gpuMemory": memory_evidence,
    }


def _encode_hunyuan_video_15_prompt_embeddings(
    model_path: Path,
    prompt: str,
) -> tuple[Any, Any, Any, Any, dict[str, Any]]:
    with tempfile.TemporaryDirectory(
        prefix="machdoch-hunyuan-video-1.5-prompt-"
    ) as temporary:
        environment = os.environ.copy()
        environment.update(
            {
                "HF_HUB_OFFLINE": "1",
                "TRANSFORMERS_OFFLINE": "1",
                "HF_HUB_DISABLE_TELEMETRY": "1",
                "DO_NOT_TRACK": "1",
            }
        )
        environment.pop("HF_TOKEN", None)
        environment.pop("HUGGING_FACE_HUB_TOKEN", None)
        for attempt in range(2):
            output_directory = Path(temporary) / f"attempt-{attempt + 1}"
            output_directory.mkdir()
            completed = subprocess.run(
                [
                    sys.executable,
                    "-I",
                    "-B",
                    str(Path(__file__).resolve()),
                    "_encode-hunyuan-video-1.5-prompt",
                ],
                input=json.dumps(
                    {
                        "modelPath": str(model_path),
                        "prompt": prompt,
                        "outputDirectory": str(output_directory),
                    }
                ),
                capture_output=True,
                text=True,
                timeout=20 * 60,
                check=False,
                env=environment,
            )
            try:
                response = json.loads(completed.stdout)
                break
            except json.JSONDecodeError as error:
                if attempt == 0:
                    gc.collect()
                    continue
                diagnostic = (
                    completed.stderr.strip()[-2_000:]
                    or completed.stdout.strip()[-1_000:]
                )
                raise WorkerError(
                    "HunyuanVideo 1.5 prompt encoder returned an invalid "
                    f"response (exit code {completed.returncode})"
                    f"{f': {diagnostic}' if diagnostic else ''}"
                ) from error
        if completed.returncode != 0 or response.get("error"):
            diagnostic = completed.stderr.strip()[-2_000:]
            message = (
                response.get("error")
                or "HunyuanVideo 1.5 prompt encoding failed"
            )
            raise WorkerError(
                f"{message}{f': {diagnostic}' if diagnostic else ''}"
            )
        destination = output_directory / str(response.get("fileName"))
        if (
            destination.parent != output_directory
            or destination.name
            != "hunyuan-video-1.5-prompt-embeddings.safetensors"
            or not destination.is_file()
        ):
            raise WorkerError(
                "HunyuanVideo 1.5 prompt encoder returned an unsafe output"
            )
        from safetensors.torch import load_file

        tensors = load_file(destination, device="cpu")
        memory_evidence = response.get("gpuMemory")
        if not isinstance(memory_evidence, dict):
            raise WorkerError(
                "HunyuanVideo 1.5 prompt encoder omitted GPU memory evidence"
            )
        return (
            tensors["prompt_embeddings"].clone(),
            tensors["prompt_attention_mask"].clone(),
            tensors["prompt_embeddings_2"].clone(),
            tensors["prompt_attention_mask_2"].clone(),
            memory_evidence,
        )


def _framepack_parameter_uses_compute_dtype(name: str) -> bool:
    return any(
        pattern in name
        for pattern in (
            "x_embedder",
            "context_embedder",
            "norm",
            "pos_embed",
            "patch_embed",
            "proj_in",
            "proj_out",
        )
    )


def _framepack_requested_frames(frames: list[Any], num_frames: int) -> list[Any]:
    if len(frames) < num_frames:
        raise WorkerError(
            "FramePack returned fewer decoded frames than the requested video"
        )
    if len(frames) == num_frames:
        return frames
    if num_frames == 1:
        return [frames[0]]
    denominator = num_frames - 1
    last_index = len(frames) - 1
    indices = [
        (index * last_index + denominator // 2) // denominator
        for index in range(num_frames)
    ]
    return [frames[index] for index in indices]


def _validated_framepack_fp8_cache(model_path: Path) -> tuple[Path, list[Path]] | None:
    cache_root = model_path / "runtime" / "framepack-transformer-fp8-v1"
    manifest_path = cache_root / "complete.json"
    index_name = "diffusion_pytorch_model.safetensors.index.json"
    cache_index_path = cache_root / index_name
    source_index_path = model_path / "transformer" / index_name
    if (
        not cache_root.is_dir()
        or cache_root.is_symlink()
        or not manifest_path.is_file()
        or manifest_path.is_symlink()
        or not cache_index_path.is_file()
        or cache_index_path.is_symlink()
    ):
        return None
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        cache_index = json.loads(cache_index_path.read_text(encoding="utf-8"))
        source_index = json.loads(source_index_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("sourceIndexSha256") != _sha256_file(source_index_path)
        or cache_index.get("weight_map") != source_index.get("weight_map")
    ):
        return None
    file_sizes = manifest.get("files")
    if not isinstance(file_sizes, dict):
        return None
    files: list[Path] = []
    for filename in sorted(set(cache_index["weight_map"].values())):
        if not isinstance(filename, str) or Path(filename).name != filename:
            return None
        path = cache_root / filename
        expected_size = file_sizes.get(filename)
        if (
            not isinstance(expected_size, int)
            or expected_size <= 0
            or not path.is_file()
            or path.is_symlink()
            or path.stat().st_size != expected_size
        ):
            return None
        files.append(path)
    return cache_root, files


def _encode_framepack_prompt(
    encoder: Any,
    torch: Any,
    prompt: str,
    execution_device: Any,
    compute_dtype: Any,
) -> tuple[Any, Any, Any]:
    with torch.inference_mode():
        prompt_embeddings, pooled_prompt_embeddings, prompt_attention_mask = (
            encoder.encode_prompt(
                prompt=prompt,
                device=execution_device,
                dtype=compute_dtype,
                max_sequence_length=256,
            )
        )
        prompt_embeddings = prompt_embeddings.to(
            device="cpu", dtype=compute_dtype
        ).contiguous()
        pooled_prompt_embeddings = pooled_prompt_embeddings.to(
            device="cpu", dtype=compute_dtype
        ).contiguous()
        prompt_attention_mask = prompt_attention_mask.to(
            device="cpu", dtype=compute_dtype
        ).contiguous()
    return (
        prompt_embeddings,
        pooled_prompt_embeddings,
        prompt_attention_mask,
    )


def _encode_framepack_prompt_embeddings_in_process(
    diffusers: Any,
    torch: Any,
    model_path: Path,
    prompt: str,
    compute_dtype: Any,
) -> tuple[Any, Any, Any, dict[str, Any]]:
    from diffusers.hooks import apply_group_offloading
    from transformers import (
        CLIPTextModel,
        CLIPTokenizer,
        LlamaModel,
        LlamaTokenizerFast,
    )

    execution_device = torch.device(f"cuda:{torch.cuda.current_device()}")
    torch.cuda.reset_peak_memory_stats()
    initial_free_bytes = int(torch.cuda.mem_get_info()[0])
    tokenizer = LlamaTokenizerFast.from_pretrained(
        str(model_path),
        subfolder="tokenizer",
        local_files_only=True,
        trust_remote_code=False,
    )
    text_encoder = LlamaModel.from_pretrained(
        str(model_path),
        subfolder="text_encoder",
        torch_dtype=torch.bfloat16,
        local_files_only=True,
        use_safetensors=True,
        trust_remote_code=False,
        low_cpu_mem_usage=True,
    )
    tokenizer_2 = CLIPTokenizer.from_pretrained(
        str(model_path),
        subfolder="tokenizer_2",
        local_files_only=True,
    )
    text_encoder_2 = CLIPTextModel.from_pretrained(
        str(model_path),
        subfolder="text_encoder_2",
        torch_dtype=torch.bfloat16,
        local_files_only=True,
        use_safetensors=True,
        low_cpu_mem_usage=True,
    )
    apply_group_offloading(
        text_encoder,
        onload_device=execution_device,
        offload_device=torch.device("cpu"),
        offload_type="block_level",
        num_blocks_per_group=1,
        use_stream=False,
    )
    text_encoder_2.to(execution_device)
    encoder = diffusers.HunyuanVideoFramepackPipeline(
        text_encoder=text_encoder,
        tokenizer=tokenizer,
        transformer=None,
        vae=None,
        scheduler=None,
        text_encoder_2=text_encoder_2,
        tokenizer_2=tokenizer_2,
        image_encoder=None,
        feature_extractor=None,
    )
    prompt_embeddings, pooled_prompt_embeddings, prompt_attention_mask = (
        _encode_framepack_prompt(
            encoder,
            torch,
            prompt,
            execution_device,
            compute_dtype,
        )
    )
    del encoder, text_encoder, text_encoder_2, tokenizer, tokenizer_2
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.synchronize()
    return (
        prompt_embeddings,
        pooled_prompt_embeddings,
        prompt_attention_mask,
        {
            "processIsolation": "prompt-encoder-subprocess",
            "initialFreeBytes": initial_free_bytes,
            "peakAllocatedBytes": int(torch.cuda.max_memory_allocated()),
            "postReleaseAllocatedBytes": int(torch.cuda.memory_allocated()),
            "postReleaseReservedBytes": int(torch.cuda.memory_reserved()),
        },
    )


def _encode_framepack_prompt_subprocess(request: dict[str, Any]) -> dict[str, Any]:
    model_path = _absolute_existing_path(request.get("modelPath"), file=False)
    prompt = request.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 8_000:
        raise WorkerError("FramePack prompt must be a string from 1 to 8000 characters")
    output_directory = _fresh_output_directory(request.get("outputDirectory"))
    torch, diffusers = _runtime()
    device, _, _ = _device(torch)
    if device != "cuda" or not torch.cuda.is_bf16_supported():
        raise WorkerError("FramePack prompt encoding requires a bfloat16 GPU")
    (
        prompt_embeddings,
        pooled_prompt_embeddings,
        prompt_attention_mask,
        memory_evidence,
    ) = _encode_framepack_prompt_embeddings_in_process(
        diffusers,
        torch,
        model_path,
        prompt,
        torch.bfloat16,
    )
    from safetensors.torch import save_file

    destination = output_directory / "prompt-embeddings.safetensors"
    save_file(
        {
            "prompt_embeddings": prompt_embeddings,
            "pooled_prompt_embeddings": pooled_prompt_embeddings,
            "prompt_attention_mask": prompt_attention_mask,
        },
        destination,
    )
    return {
        "schemaVersion": SCHEMA_VERSION,
        "workerVersion": WORKER_VERSION,
        "fileName": destination.name,
        "gpuMemory": memory_evidence,
    }


def _encode_framepack_prompt_embeddings(
    torch: Any,
    model_path: Path,
    prompt: str,
    compute_dtype: Any,
) -> tuple[Any, Any, Any, dict[str, Any]]:
    with tempfile.TemporaryDirectory(
        prefix="machdoch-framepack-prompt-"
    ) as temporary:
        environment = os.environ.copy()
        environment.update(
            {
                "HF_HUB_OFFLINE": "1",
                "TRANSFORMERS_OFFLINE": "1",
                "HF_HUB_DISABLE_TELEMETRY": "1",
                "DO_NOT_TRACK": "1",
            }
        )
        environment.pop("HF_TOKEN", None)
        environment.pop("HUGGING_FACE_HUB_TOKEN", None)
        completed = subprocess.run(
            [
                sys.executable,
                "-I",
                "-B",
                str(Path(__file__).resolve()),
                "_encode-framepack-prompt",
            ],
            input=json.dumps(
                {
                    "modelPath": str(model_path),
                    "prompt": prompt,
                    "outputDirectory": temporary,
                }
            ),
            capture_output=True,
            text=True,
            timeout=20 * 60,
            check=False,
            env=environment,
        )
        try:
            response = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise WorkerError(
                "FramePack prompt encoder returned an invalid response"
            ) from error
        if completed.returncode != 0 or response.get("error"):
            diagnostic = completed.stderr.strip()[-2_000:]
            message = response.get("error") or "FramePack prompt encoding failed"
            raise WorkerError(
                f"{message}{f': {diagnostic}' if diagnostic else ''}"
            )
        destination = Path(temporary) / str(response.get("fileName"))
        if (
            destination.parent != Path(temporary)
            or destination.name != "prompt-embeddings.safetensors"
            or not destination.is_file()
        ):
            raise WorkerError("FramePack prompt encoder returned an unsafe output")
        from safetensors.torch import load_file

        tensors = load_file(destination, device="cpu")
        memory_evidence = response.get("gpuMemory")
        if not isinstance(memory_evidence, dict):
            raise WorkerError("FramePack prompt encoder omitted GPU memory evidence")
        return (
            tensors["prompt_embeddings"].to(dtype=compute_dtype).clone(),
            tensors["pooled_prompt_embeddings"].to(dtype=compute_dtype).clone(),
            tensors["prompt_attention_mask"].to(dtype=compute_dtype).clone(),
            memory_evidence,
        )


def _load_framepack_transformer(
    diffusers: Any,
    torch: Any,
    model_path: Path,
    compute_dtype: Any,
    device_memory: int,
) -> tuple[Any, str, bool]:
    from accelerate import init_empty_weights
    from accelerate.utils import set_module_tensor_to_device
    from safetensors import safe_open

    transformer_root = model_path / "transformer"
    index_path = transformer_root / "diffusion_pytorch_model.safetensors.index.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    weight_map = index["weight_map"]
    config = diffusers.HunyuanVideoFramepackTransformer3DModel.load_config(
        str(model_path),
        subfolder="transformer",
        local_files_only=True,
    )
    with init_empty_weights():
        transformer = (
            diffusers.HunyuanVideoFramepackTransformer3DModel.from_config(config)
        )
    expected = set(transformer.state_dict())
    if expected != set(weight_map):
        missing = sorted(expected - set(weight_map))
        unexpected = sorted(set(weight_map) - expected)
        details = (missing + unexpected)[:8]
        raise WorkerError(
            "FramePack transformer index does not match the model: "
            + ", ".join(details)
        )
    use_bfloat16_storage = device_memory >= FRAMEPACK_BFLOAT16_MEMORY_BYTES
    storage_dtype = compute_dtype if use_bfloat16_storage else torch.float8_e4m3fn
    cached_checkpoint = (
        None
        if use_bfloat16_storage
        else _validated_framepack_fp8_cache(model_path)
    )
    checkpoint_files = (
        cached_checkpoint[1]
        if cached_checkpoint is not None
        else _indexed_checkpoint_files(
            model_path,
            "transformer/diffusion_pytorch_model.safetensors.index.json",
        )
    )
    loaded: set[str] = set()
    for shard in checkpoint_files:
        with safe_open(shard, framework="pt", device="cpu") as weights:
            for name in weights.keys():
                tensor = weights.get_tensor(name)
                target_dtype = (
                    tensor.dtype
                    if cached_checkpoint is not None
                    else (
                    compute_dtype
                    if use_bfloat16_storage
                    or _framepack_parameter_uses_compute_dtype(name)
                    or not tensor.is_floating_point()
                    else storage_dtype
                    )
                )
                set_module_tensor_to_device(
                    transformer,
                    name,
                    "cpu",
                    value=tensor,
                    dtype=target_dtype,
                    clear_cache=False,
                )
                loaded.add(name)
    missing = sorted(expected - loaded)
    if missing:
        raise WorkerError(
            "FramePack checkpoint is missing transformer tensors: "
            + ", ".join(missing[:8])
        )
    transformer.eval()
    if not use_bfloat16_storage:
        transformer.enable_layerwise_casting(
            storage_dtype=storage_dtype,
            compute_dtype=compute_dtype,
            skip_modules_pattern=(
                "x_embedder",
                "context_embedder",
                "norm",
                "pos_embed",
                "patch_embed",
                "proj_in",
                "proj_out",
            ),
        )
    return transformer, (
        "bfloat16" if use_bfloat16_storage else "float8_e4m3fn"
    ), cached_checkpoint is not None


def _load_framepack_pipeline(
    diffusers: Any,
    torch: Any,
    model: dict[str, Any],
    prompt: str,
    memory_profile: Any = None,
) -> tuple[Any, Any, Any, Any, dict[str, Any]]:
    from transformers import SiglipImageProcessor, SiglipVisionModel

    if _required_text(model, "packageKind", 64) != "diffusers-directory":
        raise WorkerError("FramePack generation requires a Diffusers directory")
    model_path = _absolute_existing_path(model.get("path"), file=False)
    required = [
        model_path / "model_index.json",
        model_path / "scheduler" / "scheduler_config.json",
        model_path / "text_encoder" / "model.safetensors.index.json",
        model_path / "text_encoder_2" / "model.safetensors",
        model_path / "tokenizer" / "tokenizer.json",
        model_path / "tokenizer_2" / "vocab.json",
        model_path / "vae" / "diffusion_pytorch_model.safetensors",
        model_path / "transformer" / "config.json",
        model_path
        / "transformer"
        / "diffusion_pytorch_model.safetensors.index.json",
        model_path / "feature_extractor" / "preprocessor_config.json",
        model_path / "image_encoder" / "config.json",
        model_path / "image_encoder" / "model.safetensors",
    ]
    required.extend(
        _indexed_checkpoint_files(
            model_path,
            "text_encoder/model.safetensors.index.json",
        )
    )
    required.extend(
        _indexed_checkpoint_files(
            model_path,
            "transformer/diffusion_pytorch_model.safetensors.index.json",
        )
    )
    missing = [
        path.relative_to(model_path).as_posix()
        for path in required
        if not path.is_file()
    ]
    if missing:
        raise WorkerError(
            "FramePack model package is incomplete; missing " + ", ".join(missing)
        )
    device, _, device_memory = _device(torch)
    if device != "cuda":
        raise WorkerError(
            "FramePack 13B requires a supported GPU; use LTX-Video 2B on CPU-only systems"
        )
    physical_memory = _physical_memory_bytes()
    if (
        physical_memory is not None
        and physical_memory < FRAMEPACK_MIN_PHYSICAL_MEMORY_BYTES
    ):
        raise WorkerError(
            "FramePack 13B requires at least 30 GiB of physical memory for prompt encoding; use LTX-Video 2B on this system"
        )
    if device_memory is None or device_memory < FRAMEPACK_MIN_MEMORY_BYTES:
        raise WorkerError(
            "FramePack requires at least 6 GiB of usable GPU memory"
        )
    if not torch.cuda.is_bf16_supported():
        raise WorkerError("FramePack generation requires bfloat16 support")
    compute_dtype = torch.bfloat16
    (
        prompt_embeddings,
        pooled_prompt_embeddings,
        prompt_attention_mask,
        prompt_encoder_memory,
    ) = (
        _encode_framepack_prompt_embeddings(
            torch,
            model_path,
            prompt,
            compute_dtype,
        )
    )
    transformer, storage_dtype, fp8_cache_hit = _load_framepack_transformer(
        diffusers,
        torch,
        model_path,
        compute_dtype,
        device_memory,
    )
    performance = _configure_video_offload(
        transformer,
        torch,
        memory_profile,
    )
    performance["promptEncoderGpuMemory"] = prompt_encoder_memory
    gc.collect()
    torch.cuda.empty_cache()
    vae = diffusers.AutoencoderKLHunyuanVideo.from_pretrained(
        str(model_path),
        subfolder="vae",
        torch_dtype=compute_dtype,
        local_files_only=True,
        use_safetensors=True,
    )
    vae.enable_tiling(**_framepack_vae_tile_configuration(device_memory))
    image_encoder = SiglipVisionModel.from_pretrained(
        str(model_path),
        subfolder="image_encoder",
        torch_dtype=torch.float16,
        local_files_only=True,
        use_safetensors=True,
        low_cpu_mem_usage=True,
    )
    feature_extractor = SiglipImageProcessor.from_pretrained(
        str(model_path),
        subfolder="feature_extractor",
        local_files_only=True,
    )
    scheduler = diffusers.FlowMatchEulerDiscreteScheduler.from_pretrained(
        str(model_path),
        subfolder="scheduler",
        local_files_only=True,
    )
    pipeline = diffusers.HunyuanVideoFramepackPipeline(
        text_encoder=None,
        tokenizer=None,
        transformer=transformer,
        vae=vae,
        scheduler=scheduler,
        text_encoder_2=None,
        tokenizer_2=None,
        image_encoder=image_encoder,
        feature_extractor=feature_extractor,
    )
    execution_device = torch.device(f"cuda:{torch.cuda.current_device()}")
    original_vae_encode = pipeline.vae.encode
    original_encode_image = pipeline.encode_image

    def vae_encode_with_release(sample: Any, *args: Any, **kwargs: Any) -> Any:
        pipeline.vae.to(execution_device)
        try:
            return original_vae_encode(sample, *args, **kwargs)
        finally:
            pipeline.vae.to("cpu")
            gc.collect()
            torch.cuda.empty_cache()

    def encode_image_with_release(image: Any, device: Any) -> Any:
        pipeline.image_encoder.to(device)
        try:
            return original_encode_image(image, device=device)
        finally:
            pipeline.image_encoder.to("cpu")
            gc.collect()
            torch.cuda.empty_cache()

    pipeline.vae.encode = vae_encode_with_release
    pipeline.encode_image = encode_image_with_release
    if hasattr(pipeline, "set_progress_bar_config"):
        pipeline.set_progress_bar_config(
            disable=os.environ.get("MACHDOCH_MEDIA_DEBUG_PROGRESS") != "1"
        )
    performance["variant"] = "framepack-i2v-hy-13b"
    performance["weightStorageDtype"] = storage_dtype
    performance["fp8CacheHit"] = fp8_cache_hit
    performance["computeDtype"] = "bfloat16"
    performance["textEncoderDevice"] = "isolated-block-level-gpu-offload"
    performance["imageEncoderDevice"] = "sequential-gpu-offload"
    performance["vaeDevice"] = "stage-sequential-gpu"
    performance["renderStrategy"] = "inverted-anti-drifting-single-window"
    return (
        pipeline,
        prompt_embeddings,
        pooled_prompt_embeddings,
        prompt_attention_mask,
        performance,
    )


def _generate_framepack_latents_subprocess(
    request: dict[str, Any],
) -> dict[str, Any]:
    model = request.get("model")
    if not isinstance(model, dict):
        raise WorkerError("FramePack denoising requires a model")
    prompt = request.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 8_000:
        raise WorkerError("FramePack prompt must be a string from 1 to 8000 characters")
    first_frame_path = _absolute_existing_path(
        request.get("firstFramePath"), file=True
    )
    last_frame_path = _absolute_existing_path(
        request.get("lastFramePath"), file=True
    )
    output_directory = _fresh_output_directory(request.get("outputDirectory"))
    width = request.get("width")
    height = request.get("height")
    num_frames = request.get("numFrames")
    steps = request.get("numInferenceSteps")
    guidance_scale = request.get("guidanceScale")
    seed = request.get("seed")
    transparent_background = request.get("transparentBackground")
    if (
        not isinstance(width, int)
        or isinstance(width, bool)
        or width < 64
        or not isinstance(height, int)
        or isinstance(height, bool)
        or height < 64
    ):
        raise WorkerError("FramePack denoising dimensions are invalid")
    if (
        not isinstance(num_frames, int)
        or isinstance(num_frames, bool)
        or not 17 <= num_frames <= 129
        or (num_frames - 1) % 4 != 0
    ):
        raise WorkerError("FramePack denoising frame count is invalid")
    if (
        not isinstance(steps, int)
        or isinstance(steps, bool)
        or not 4 <= steps <= 50
    ):
        raise WorkerError("FramePack denoising step count is invalid")
    if (
        not isinstance(guidance_scale, (int, float))
        or isinstance(guidance_scale, bool)
        or not math.isfinite(float(guidance_scale))
        or not 1.0 <= float(guidance_scale) <= 10.0
    ):
        raise WorkerError("FramePack denoising guidance is invalid")
    if not isinstance(seed, int) or not 0 <= seed < 2**63:
        raise WorkerError("FramePack denoising seed is invalid")
    if not isinstance(transparent_background, bool):
        raise WorkerError("FramePack denoising transparency flag is invalid")

    torch, diffusers = _runtime()
    device, _, _ = _device(torch)
    if device != "cuda":
        raise WorkerError("FramePack denoising requires a supported GPU")
    source, _ = _prepare_video_conditioning_frame(
        first_frame_path,
        width,
        height,
        transparent_background,
    )
    last_source, _ = _prepare_video_conditioning_frame(
        last_frame_path,
        width,
        height,
        transparent_background,
    )
    memory_evidence = _start_video_memory_observation(torch, device)
    started_at = time.perf_counter()
    (
        pipeline,
        prompt_embeddings,
        pooled_prompt_embeddings,
        prompt_attention_mask,
        performance,
    ) = _load_framepack_pipeline(
        diffusers,
        torch,
        model,
        prompt,
        request.get("memoryProfile"),
    )
    model_ready_at = time.perf_counter()
    execution_device = torch.device(f"cuda:{torch.cuda.current_device()}")
    prompt_embeddings = prompt_embeddings.to(execution_device)
    pooled_prompt_embeddings = pooled_prompt_embeddings.to(execution_device)
    prompt_attention_mask = prompt_attention_mask.to(execution_device)
    generator = torch.Generator(device=execution_device).manual_seed(seed)
    result = pipeline(
        image=source,
        last_image=last_source,
        prompt=None,
        prompt_embeds=prompt_embeddings,
        pooled_prompt_embeds=pooled_prompt_embeddings,
        prompt_attention_mask=prompt_attention_mask,
        width=width,
        height=height,
        num_frames=num_frames,
        num_inference_steps=steps,
        guidance_scale=float(guidance_scale),
        true_cfg_scale=1.0,
        generator=generator,
        sampling_type="inverted_anti_drifting",
        output_type="latent",
    )
    if not result.frames:
        raise WorkerError("FramePack returned no latent video")
    latents = result.frames[-1].detach().to("cpu").contiguous()
    denoised_at = time.perf_counter()
    from safetensors.torch import save_file

    destination = output_directory / "framepack-latents.safetensors"
    save_file({"latents": latents}, destination)
    del (
        result,
        pipeline,
        generator,
        prompt_embeddings,
        pooled_prompt_embeddings,
        prompt_attention_mask,
        latents,
    )
    gc.collect()
    torch.cuda.empty_cache()
    memory_evidence = _finish_video_memory_observation(
        torch,
        device,
        memory_evidence,
    )
    return {
        "schemaVersion": SCHEMA_VERSION,
        "workerVersion": WORKER_VERSION,
        "fileName": destination.name,
        "performance": performance,
        "gpuMemory": memory_evidence,
        "timingSeconds": {
            "modelLoadAndPrompt": round(model_ready_at - started_at, 3),
            "denoise": round(denoised_at - model_ready_at, 3),
            "saveAndRelease": round(time.perf_counter() - denoised_at, 3),
        },
    }


def _generate_framepack_latents(
    torch: Any,
    model: dict[str, Any],
    prompt: str,
    first_frame_path: Path,
    last_frame_path: Path,
    width: int,
    height: int,
    num_frames: int,
    steps: int,
    guidance_scale: float,
    seed: int,
    transparent_background: bool,
    memory_profile: Any,
) -> tuple[Any, dict[str, Any], dict[str, Any]]:
    with tempfile.TemporaryDirectory(
        prefix="machdoch-framepack-denoise-"
    ) as temporary:
        output_directory = Path(temporary) / "output"
        output_directory.mkdir()
        environment = os.environ.copy()
        environment.update(
            {
                "HF_HUB_OFFLINE": "1",
                "TRANSFORMERS_OFFLINE": "1",
                "HF_HUB_DISABLE_TELEMETRY": "1",
                "DO_NOT_TRACK": "1",
            }
        )
        environment.pop("HF_TOKEN", None)
        environment.pop("HUGGING_FACE_HUB_TOKEN", None)
        completed = subprocess.run(
            [
                sys.executable,
                "-I",
                "-B",
                str(Path(__file__).resolve()),
                "_generate-framepack-latents",
            ],
            input=json.dumps(
                {
                    "model": model,
                    "prompt": prompt,
                    "firstFramePath": str(first_frame_path),
                    "lastFramePath": str(last_frame_path),
                    "outputDirectory": str(output_directory),
                    "width": width,
                    "height": height,
                    "numFrames": num_frames,
                    "numInferenceSteps": steps,
                    "guidanceScale": guidance_scale,
                    "seed": seed,
                    "transparentBackground": transparent_background,
                    "memoryProfile": memory_profile,
                }
            ),
            capture_output=True,
            text=True,
            timeout=2 * 60 * 60,
            check=False,
            env=environment,
        )
        try:
            response = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise WorkerError(
                "FramePack denoiser returned an invalid response"
            ) from error
        if completed.returncode != 0 or response.get("error"):
            diagnostic = completed.stderr.strip()[-4_000:]
            message = response.get("error") or "FramePack denoising failed"
            raise WorkerError(
                f"{message}{f': {diagnostic}' if diagnostic else ''}"
            )
        destination = output_directory / str(response.get("fileName"))
        if (
            destination.parent != output_directory
            or destination.name != "framepack-latents.safetensors"
            or not destination.is_file()
        ):
            raise WorkerError("FramePack denoiser returned an unsafe output")
        performance = response.get("performance")
        gpu_memory = response.get("gpuMemory")
        timing = response.get("timingSeconds")
        if (
            not isinstance(performance, dict)
            or not isinstance(gpu_memory, dict)
            or not isinstance(timing, dict)
        ):
            raise WorkerError("FramePack denoiser omitted performance evidence")
        from safetensors.torch import load_file

        latents = load_file(destination, device="cpu").get("latents")
        if latents is None or latents.ndim != 5:
            raise WorkerError("FramePack denoiser returned invalid latents")
        performance["denoiserGpuMemory"] = gpu_memory
        performance["componentIsolation"] = (
            "prompt-encoder-subprocess->denoiser-subprocess->vae-parent"
        )
        return latents.clone(), performance, timing


def _load_framepack_vae(
    diffusers: Any,
    torch: Any,
    model_path: Path,
    device_memory: int | None,
) -> tuple[Any, Any, dict[str, int]]:
    vae = diffusers.AutoencoderKLHunyuanVideo.from_pretrained(
        str(model_path),
        subfolder="vae",
        torch_dtype=torch.bfloat16,
        local_files_only=True,
        use_safetensors=True,
    )
    tile_configuration = _framepack_vae_tile_configuration(device_memory)
    vae.enable_tiling(**tile_configuration)
    from diffusers.video_processor import VideoProcessor

    return (
        vae,
        VideoProcessor(vae_scale_factor=vae.spatial_compression_ratio),
        tile_configuration,
    )


def _decode_framepack_video(
    torch: Any,
    vae: Any,
    video_processor: Any,
    framepack_latents: Any,
    execution_device: Any,
) -> list[Any]:
    current_latents = framepack_latents.to(
        execution_device,
        dtype=vae.dtype,
    )
    current_latents = current_latents / vae.config.scaling_factor
    vae.to(execution_device)
    with torch.inference_mode():
        decoded_video = vae.decode(current_latents, return_dict=False)[0]
        return list(
            video_processor.postprocess_video(
                decoded_video, output_type="pil"
            )[0]
        )


def _load_hunyuan_video_15_pipeline(
    diffusers: Any,
    torch: Any,
    model: dict[str, Any],
    prompt: str,
    memory_profile: Any,
) -> tuple[Any, Any, Any, Any, Any, dict[str, Any]]:
    from transformers import SiglipImageProcessor, SiglipVisionModel

    model_path, device_memory = _validate_hunyuan_video_15_package(model, torch)
    (
        prompt_embeddings,
        prompt_attention_mask,
        prompt_embeddings_2,
        prompt_attention_mask_2,
        prompt_encoder_memory,
    ) = _encode_hunyuan_video_15_prompt_embeddings(model_path, prompt)
    transformer, storage_dtype = _load_hunyuan_video_15_transformer(
        diffusers,
        torch,
        model_path,
        device_memory,
        memory_profile,
    )
    transformer.eval()
    performance = _configure_video_offload(
        transformer,
        torch,
        memory_profile,
    )
    performance["promptEncoderGpuMemory"] = prompt_encoder_memory
    gc.collect()
    torch.cuda.empty_cache()
    vae = diffusers.AutoencoderKLHunyuanVideo15.from_pretrained(
        str(model_path),
        subfolder="vae",
        torch_dtype=torch.bfloat16,
        local_files_only=True,
        use_safetensors=True,
        low_cpu_mem_usage=True,
    )
    vae.eval()
    vae_tiles = _hunyuan_video_15_vae_tile_configuration(device_memory)
    vae.enable_tiling(**vae_tiles)
    image_encoder = SiglipVisionModel.from_pretrained(
        str(model_path),
        subfolder="image_encoder",
        torch_dtype=torch.float16,
        local_files_only=True,
        use_safetensors=True,
        low_cpu_mem_usage=True,
    )
    image_encoder.eval()
    feature_extractor = SiglipImageProcessor.from_pretrained(
        str(model_path),
        subfolder="feature_extractor",
        local_files_only=True,
    )
    scheduler = diffusers.FlowMatchEulerDiscreteScheduler.from_pretrained(
        str(model_path),
        subfolder="scheduler",
        local_files_only=True,
    )
    guider = diffusers.ClassifierFreeGuidance.from_pretrained(
        str(model_path),
        subfolder="guider",
        local_files_only=True,
    )
    pipeline = diffusers.HunyuanVideo15ImageToVideoPipeline(
        text_encoder=None,
        tokenizer=None,
        transformer=transformer,
        vae=vae,
        scheduler=scheduler,
        text_encoder_2=None,
        tokenizer_2=None,
        guider=guider,
        image_encoder=image_encoder,
        feature_extractor=feature_extractor,
    )
    execution_device = torch.device(f"cuda:{torch.cuda.current_device()}")
    original_vae_encode = pipeline.vae.encode
    original_encode_image = pipeline.encode_image

    def vae_encode_with_release(sample: Any, *args: Any, **kwargs: Any) -> Any:
        pipeline.vae.to(execution_device)
        try:
            return original_vae_encode(sample, *args, **kwargs)
        finally:
            pipeline.vae.to("cpu")
            gc.collect()
            torch.cuda.empty_cache()

    def encode_image_with_release(*args: Any, **kwargs: Any) -> Any:
        pipeline.image_encoder.to(execution_device)
        try:
            return original_encode_image(*args, **kwargs)
        finally:
            pipeline.image_encoder.to("cpu")
            gc.collect()
            torch.cuda.empty_cache()

    pipeline.vae.encode = vae_encode_with_release
    pipeline.encode_image = encode_image_with_release
    if hasattr(pipeline, "set_progress_bar_config"):
        pipeline.set_progress_bar_config(
            disable=os.environ.get("MACHDOCH_MEDIA_DEBUG_PROGRESS") != "1"
        )
    performance["variant"] = "hunyuan-video-1.5-i2v-8.3b-step-distilled"
    performance["weightStorageDtype"] = storage_dtype
    performance["computeDtype"] = "bfloat16"
    performance["textEncoderDevice"] = "isolated-block-level-gpu-offload"
    performance["imageEncoderDevice"] = "stage-sequential-gpu"
    performance["vaeDevice"] = "stage-sequential-gpu"
    performance["vaeTileConfiguration"] = vae_tiles
    performance["renderStrategy"] = "native-first-frame-mean-flow-step-distilled"
    return (
        pipeline,
        prompt_embeddings,
        prompt_attention_mask,
        prompt_embeddings_2,
        prompt_attention_mask_2,
        performance,
    )


def _generate_hunyuan_video_15_latents_subprocess(
    request: dict[str, Any],
) -> dict[str, Any]:
    model = request.get("model")
    if not isinstance(model, dict):
        raise WorkerError("HunyuanVideo 1.5 denoising requires a model")
    prompt = request.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 8_000:
        raise WorkerError(
            "HunyuanVideo 1.5 prompt must be a string from 1 to 8000 characters"
        )
    first_frame_path = _absolute_existing_path(
        request.get("firstFramePath"), file=True
    )
    output_directory = _fresh_output_directory(request.get("outputDirectory"))
    width = request.get("width")
    height = request.get("height")
    target_size = request.get("targetSize")
    num_frames = request.get("numFrames")
    steps = request.get("numInferenceSteps")
    seed = request.get("seed")
    transparent_background = request.get("transparentBackground")
    if (
        not isinstance(width, int)
        or isinstance(width, bool)
        or width < 64
        or not isinstance(height, int)
        or isinstance(height, bool)
        or height < 64
        or target_size not in (512, 640, 768)
    ):
        raise WorkerError("HunyuanVideo 1.5 denoising dimensions are invalid")
    if (
        not isinstance(num_frames, int)
        or isinstance(num_frames, bool)
        or not 17 <= num_frames <= 121
        or (num_frames - 1) % 4 != 0
    ):
        raise WorkerError("HunyuanVideo 1.5 denoising frame count is invalid")
    if steps not in (8, 12):
        raise WorkerError(
            "HunyuanVideo 1.5 step-distilled denoising requires 8 or 12 steps"
        )
    if not isinstance(seed, int) or not 0 <= seed < 2**63:
        raise WorkerError("HunyuanVideo 1.5 denoising seed is invalid")
    if not isinstance(transparent_background, bool):
        raise WorkerError(
            "HunyuanVideo 1.5 denoising transparency flag is invalid"
        )

    torch, diffusers = _runtime()
    device, _, _ = _device(torch)
    if device != "cuda":
        raise WorkerError("HunyuanVideo 1.5 denoising requires a supported GPU")
    source, _ = _prepare_video_conditioning_frame(
        first_frame_path,
        width,
        height,
        transparent_background,
    )
    memory_evidence = _start_video_memory_observation(torch, device)
    started_at = time.perf_counter()
    (
        pipeline,
        prompt_embeddings,
        prompt_attention_mask,
        prompt_embeddings_2,
        prompt_attention_mask_2,
        performance,
    ) = _load_hunyuan_video_15_pipeline(
        diffusers,
        torch,
        model,
        prompt,
        request.get("memoryProfile"),
    )
    pipeline.target_size = target_size
    model_ready_at = time.perf_counter()
    execution_device = torch.device(f"cuda:{torch.cuda.current_device()}")
    generator = torch.Generator(device=execution_device).manual_seed(seed)
    result = pipeline(
        image=source,
        prompt=None,
        prompt_embeds=prompt_embeddings,
        prompt_embeds_mask=prompt_attention_mask,
        prompt_embeds_2=prompt_embeddings_2,
        prompt_embeds_mask_2=prompt_attention_mask_2,
        num_frames=num_frames,
        num_inference_steps=steps,
        generator=generator,
        output_type="latent",
    )
    latents = result.frames
    if latents is None or latents.ndim != 5:
        raise WorkerError("HunyuanVideo 1.5 returned no latent video")
    latents = latents.detach().to("cpu").contiguous()
    denoised_at = time.perf_counter()
    from safetensors.torch import save_file

    destination = output_directory / "hunyuan-video-1.5-latents.safetensors"
    save_file({"latents": latents}, destination)
    del (
        result,
        pipeline,
        generator,
        prompt_embeddings,
        prompt_attention_mask,
        prompt_embeddings_2,
        prompt_attention_mask_2,
        latents,
    )
    gc.collect()
    torch.cuda.empty_cache()
    memory_evidence = _finish_video_memory_observation(
        torch,
        device,
        memory_evidence,
    )
    return {
        "schemaVersion": SCHEMA_VERSION,
        "workerVersion": WORKER_VERSION,
        "fileName": destination.name,
        "performance": performance,
        "gpuMemory": memory_evidence,
        "timingSeconds": {
            "modelLoadAndPrompt": round(model_ready_at - started_at, 3),
            "denoise": round(denoised_at - model_ready_at, 3),
            "saveAndRelease": round(time.perf_counter() - denoised_at, 3),
        },
    }


def _generate_hunyuan_video_15_latents(
    model: dict[str, Any],
    prompt: str,
    first_frame_path: Path,
    width: int,
    height: int,
    target_size: int,
    num_frames: int,
    steps: int,
    seed: int,
    transparent_background: bool,
    memory_profile: Any,
) -> tuple[Any, dict[str, Any], dict[str, Any]]:
    with tempfile.TemporaryDirectory(
        prefix="machdoch-hunyuan-video-1.5-denoise-"
    ) as temporary:
        output_directory = Path(temporary) / "output"
        output_directory.mkdir()
        environment = os.environ.copy()
        environment.update(
            {
                "HF_HUB_OFFLINE": "1",
                "TRANSFORMERS_OFFLINE": "1",
                "HF_HUB_DISABLE_TELEMETRY": "1",
                "DO_NOT_TRACK": "1",
            }
        )
        environment.pop("HF_TOKEN", None)
        environment.pop("HUGGING_FACE_HUB_TOKEN", None)
        completed = subprocess.run(
            [
                sys.executable,
                "-I",
                "-B",
                str(Path(__file__).resolve()),
                "_generate-hunyuan-video-1.5-latents",
            ],
            input=json.dumps(
                {
                    "model": model,
                    "prompt": prompt,
                    "firstFramePath": str(first_frame_path),
                    "outputDirectory": str(output_directory),
                    "width": width,
                    "height": height,
                    "targetSize": target_size,
                    "numFrames": num_frames,
                    "numInferenceSteps": steps,
                    "seed": seed,
                    "transparentBackground": transparent_background,
                    "memoryProfile": memory_profile,
                }
            ),
            capture_output=True,
            text=True,
            timeout=2 * 60 * 60,
            check=False,
            env=environment,
        )
        try:
            response = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise WorkerError(
                "HunyuanVideo 1.5 denoiser returned an invalid response"
            ) from error
        if completed.returncode != 0 or response.get("error"):
            diagnostic = completed.stderr.strip()[-4_000:]
            message = (
                response.get("error") or "HunyuanVideo 1.5 denoising failed"
            )
            raise WorkerError(
                f"{message}{f': {diagnostic}' if diagnostic else ''}"
            )
        destination = output_directory / str(response.get("fileName"))
        if (
            destination.parent != output_directory
            or destination.name != "hunyuan-video-1.5-latents.safetensors"
            or not destination.is_file()
        ):
            raise WorkerError(
                "HunyuanVideo 1.5 denoiser returned an unsafe output"
            )
        performance = response.get("performance")
        gpu_memory = response.get("gpuMemory")
        timing = response.get("timingSeconds")
        if (
            not isinstance(performance, dict)
            or not isinstance(gpu_memory, dict)
            or not isinstance(timing, dict)
        ):
            raise WorkerError(
                "HunyuanVideo 1.5 denoiser omitted performance evidence"
            )
        from safetensors.torch import load_file

        latents = load_file(destination, device="cpu").get("latents")
        if latents is None or latents.ndim != 5:
            raise WorkerError("HunyuanVideo 1.5 denoiser returned invalid latents")
        performance["denoiserGpuMemory"] = gpu_memory
        performance["componentIsolation"] = (
            "prompt-encoder-subprocess->denoiser-subprocess->vae-parent"
        )
        return latents.clone(), performance, timing


def _hunyuan_video_15_uses_bfloat16_storage(
    device_memory: int | None,
    physical_memory: int | None,
    memory_profile: Any = "auto",
) -> bool:
    return (
        memory_profile != "memory-saver"
        and device_memory is not None
        and physical_memory is not None
        and device_memory >= 15 * 1024**3
        and physical_memory >= 30 * 1024**3
    )


def _hunyuan_video_15_parameter_uses_compute_dtype(name: str) -> bool:
    return any(
        pattern in name
        for pattern in (
            "cond_type_embed",
            "context_embedder",
            "image_embedder",
            "norm",
            "proj_out",
            "time_embed",
            "x_embedder",
        )
    )


def _load_hunyuan_video_15_transformer(
    diffusers: Any,
    torch: Any,
    model_path: Path,
    device_memory: int,
    memory_profile: Any,
) -> tuple[Any, str]:
    from accelerate import init_empty_weights
    from accelerate.utils import set_module_tensor_to_device
    from safetensors import safe_open

    compute_dtype = torch.bfloat16
    transformer_root = model_path / "transformer"
    index_path = (
        transformer_root / "diffusion_pytorch_model.safetensors.index.json"
    )
    index = json.loads(index_path.read_text(encoding="utf-8"))
    weight_map = index["weight_map"]
    config = diffusers.HunyuanVideo15Transformer3DModel.load_config(
        str(model_path),
        subfolder="transformer",
        local_files_only=True,
    )
    with init_empty_weights():
        transformer = diffusers.HunyuanVideo15Transformer3DModel.from_config(
            config
        )
    expected = set(transformer.state_dict())
    if expected != set(weight_map):
        missing = sorted(expected - set(weight_map))
        unexpected = sorted(set(weight_map) - expected)
        raise WorkerError(
            "HunyuanVideo 1.5 transformer index does not match the model: "
            + ", ".join((missing + unexpected)[:8])
        )
    use_bfloat16_storage = _hunyuan_video_15_uses_bfloat16_storage(
        device_memory,
        _physical_memory_bytes(),
        memory_profile,
    )
    storage_dtype = (
        compute_dtype if use_bfloat16_storage else torch.float8_e4m3fn
    )
    loaded: set[str] = set()
    for shard in _indexed_checkpoint_files(
        model_path,
        "transformer/diffusion_pytorch_model.safetensors.index.json",
    ):
        with safe_open(shard, framework="pt", device="cpu") as weights:
            for name in weights.keys():
                tensor = weights.get_tensor(name)
                target_dtype = (
                    compute_dtype
                    if use_bfloat16_storage
                    or _hunyuan_video_15_parameter_uses_compute_dtype(name)
                    or not tensor.is_floating_point()
                    else storage_dtype
                )
                set_module_tensor_to_device(
                    transformer,
                    name,
                    "cpu",
                    value=tensor,
                    dtype=target_dtype,
                    clear_cache=False,
                )
                loaded.add(name)
    missing = sorted(expected - loaded)
    if missing:
        raise WorkerError(
            "HunyuanVideo 1.5 checkpoint is missing transformer tensors: "
            + ", ".join(missing[:8])
        )
    transformer.eval()
    if not use_bfloat16_storage:
        transformer.enable_layerwise_casting(
            storage_dtype=storage_dtype,
            compute_dtype=compute_dtype,
            skip_modules_pattern=(
                "cond_type_embed",
                "context_embedder",
                "image_embedder",
                "norm",
                "proj_out",
                "time_embed",
                "x_embedder",
            ),
        )
    return transformer, (
        "bfloat16" if use_bfloat16_storage else "float8_e4m3fn"
    )


def _load_hunyuan_video_15_vae(
    diffusers: Any,
    torch: Any,
    model_path: Path,
    device_memory: int | None,
) -> tuple[Any, Any, dict[str, int]]:
    vae = diffusers.AutoencoderKLHunyuanVideo15.from_pretrained(
        str(model_path),
        subfolder="vae",
        torch_dtype=torch.bfloat16,
        local_files_only=True,
        use_safetensors=True,
        low_cpu_mem_usage=True,
    )
    vae.eval()
    tile_configuration = _hunyuan_video_15_vae_tile_configuration(device_memory)
    vae.enable_tiling(**tile_configuration)
    from diffusers.pipelines.hunyuan_video1_5.image_processor import (
        HunyuanVideo15ImageProcessor,
    )

    return (
        vae,
        HunyuanVideo15ImageProcessor(
            vae_scale_factor=vae.spatial_compression_ratio,
            do_resize=False,
            do_convert_rgb=True,
        ),
        tile_configuration,
    )


def _decode_hunyuan_video_15(
    torch: Any,
    vae: Any,
    video_processor: Any,
    latents: Any,
    execution_device: Any,
) -> list[Any]:
    current_latents = latents.to(execution_device, dtype=vae.dtype)
    current_latents = current_latents / vae.config.scaling_factor
    vae.to(execution_device)
    with torch.inference_mode():
        decoded_video = vae.decode(current_latents, return_dict=False)[0]
        return list(
            video_processor.postprocess_video(
                decoded_video,
                output_type="pil",
            )[0]
        )


def _ltx_checkpoint(
    model: dict[str, Any],
    model_path: Path,
) -> tuple[Path, str, str]:
    model_id = _required_text(model, "id", 160).lower()
    if "13b" in model_id:
        return (
            model_path / "ltxv-13b-0.9.8-distilled-fp8.safetensors",
            "transformer-13b",
            "13b-distilled-fp8",
        )
    if "2b" in model_id:
        return (
            model_path / "ltxv-2b-0.9.8-distilled-fp8.safetensors",
            "transformer",
            "2b-distilled-fp8",
        )
    raise WorkerError(
        "LTX-Video model id must select the 2B or 13B distilled FP8 variant"
    )


def _encode_ltx_prompt_embeddings(
    torch: Any,
    model_path: Path,
    prompt: str,
    compute_dtype: Any,
    device: str,
) -> tuple[Any, Any]:
    from diffusers.hooks import apply_group_offloading
    from transformers import AutoTokenizer, T5EncoderModel

    tokenizer = AutoTokenizer.from_pretrained(
        str(model_path),
        subfolder="tokenizer",
        local_files_only=True,
        trust_remote_code=False,
    )
    text_encoder = T5EncoderModel.from_pretrained(
        str(model_path),
        subfolder="text_encoder",
        torch_dtype=torch.bfloat16,
        local_files_only=True,
        use_safetensors=True,
        trust_remote_code=False,
        low_cpu_mem_usage=True,
    )
    execution_device = torch.device(
        f"cuda:{torch.cuda.current_device()}" if device == "cuda" else device
    )
    if device == "cuda":
        apply_group_offloading(
            text_encoder,
            onload_device=execution_device,
            offload_device=torch.device("cpu"),
            offload_type="block_level",
            num_blocks_per_group=2,
            use_stream=False,
        )
    else:
        text_encoder.to(execution_device)
    text_inputs = tokenizer(
        [prompt],
        padding="max_length",
        max_length=256,
        truncation=True,
        add_special_tokens=True,
        return_attention_mask=True,
        return_tensors="pt",
    )
    input_ids = text_inputs.input_ids.to(execution_device)
    attention_mask = text_inputs.attention_mask.bool().to(execution_device)
    with torch.inference_mode():
        prompt_embeddings = text_encoder(
            input_ids,
            attention_mask=attention_mask,
        )[0]
    prompt_embeddings = prompt_embeddings.to(
        device="cpu", dtype=compute_dtype
    ).contiguous()
    prompt_attention_mask = attention_mask.to(device="cpu").contiguous()
    del text_inputs, input_ids, attention_mask
    del text_encoder, tokenizer
    gc.collect()
    if device == "cuda":
        torch.cuda.empty_cache()
    return prompt_embeddings, prompt_attention_mask


def _load_ltx_fp8_transformer(
    diffusers: Any,
    torch: Any,
    model_path: Path,
    checkpoint: Path,
    config_subfolder: str,
    compute_dtype: Any,
) -> Any:
    from accelerate import init_empty_weights
    from accelerate.utils import set_module_tensor_to_device
    from safetensors import safe_open

    config = diffusers.LTXVideoTransformer3DModel.load_config(
        str(model_path),
        subfolder=config_subfolder,
        local_files_only=True,
    )
    with init_empty_weights():
        transformer = diffusers.LTXVideoTransformer3DModel.from_config(config)
    expected = set(transformer.state_dict())
    loaded: set[str] = set()
    replacements = (
        ("model.diffusion_model.", ""),
        ("patchify_proj", "proj_in"),
        ("adaln_single", "time_embed"),
        ("q_norm", "norm_q"),
        ("k_norm", "norm_k"),
    )
    with safe_open(checkpoint, framework="pt", device="cpu") as weights:
        for source_name in weights.keys():
            if "vae" in source_name:
                continue
            target_name = source_name
            for source, target in replacements:
                target_name = target_name.replace(source, target)
            if target_name not in expected:
                raise WorkerError(
                    f"LTX-Video checkpoint contains unexpected transformer tensor {source_name}"
                )
            tensor = weights.get_tensor(source_name)
            set_module_tensor_to_device(
                transformer,
                target_name,
                "cpu",
                value=tensor,
                dtype=tensor.dtype,
                clear_cache=False,
            )
            loaded.add(target_name)
    missing = sorted(expected - loaded)
    if missing:
        raise WorkerError(
            "LTX-Video checkpoint is missing transformer tensors: "
            + ", ".join(missing[:8])
        )
    transformer.eval()
    transformer.enable_layerwise_casting(
        storage_dtype=torch.float8_e4m3fn,
        compute_dtype=compute_dtype,
    )
    return transformer


def _load_ltx_video_pipeline(
    diffusers: Any,
    torch: Any,
    model: dict[str, Any],
    prompt: str,
    memory_profile: Any = None,
) -> tuple[Any, Any, Any, dict[str, Any]]:
    if _required_text(model, "packageKind", 64) != "diffusers-directory":
        raise WorkerError("LTX-Video generation requires a Diffusers directory")
    model_path = _absolute_existing_path(model.get("path"), file=False)
    checkpoint, config_subfolder, variant = _ltx_checkpoint(model, model_path)
    required = (
        model_path / "model_index.json",
        model_path / "scheduler" / "scheduler_config.json",
        model_path / "text_encoder" / "model.safetensors.index.json",
        model_path / "vae" / "diffusion_pytorch_model.safetensors",
        model_path / config_subfolder / "config.json",
        checkpoint,
        model_path / "spatial_upscaler" / "model_index.json",
        model_path / "spatial_upscaler" / "latent_upsampler" / "config.json",
        model_path
        / "spatial_upscaler"
        / "latent_upsampler"
        / "diffusion_pytorch_model.safetensors",
    )
    missing = [
        path.relative_to(model_path).as_posix()
        for path in required
        if not path.is_file()
    ]
    if missing:
        raise WorkerError(
            "LTX-Video model package is incomplete; missing " + ", ".join(missing)
        )
    device, _, device_memory = _device(torch)
    if (
        variant.startswith("13b")
        and device != "cuda"
    ):
        raise WorkerError(
            "The LTX-Video 13B path requires a supported GPU; use the 2B variant "
            "on CPU-only systems"
        )
    if (
        variant.startswith("13b")
        and device_memory is not None
        and device_memory < LTX_13B_MIN_MEMORY_BYTES
    ):
        raise WorkerError(
            "The LTX-Video 13B quality path requires a nominal 16 GB adapter; "
            "use the 2B variant on lower-VRAM systems"
        )
    if device == "cuda" and not torch.cuda.is_bf16_supported():
        raise WorkerError("LTX-Video GPU generation requires bfloat16 support")
    compute_dtype = torch.bfloat16 if device == "cuda" else torch.float32
    text_encoder_device = (
        "cpu"
        if device == "cuda"
        and device_memory is not None
        and device_memory < 10 * 1024**3
        else device
    )
    prompt_embeddings, prompt_attention_mask = _encode_ltx_prompt_embeddings(
        torch,
        model_path,
        prompt,
        compute_dtype,
        text_encoder_device,
    )
    transformer = _load_ltx_fp8_transformer(
        diffusers,
        torch,
        model_path,
        checkpoint,
        config_subfolder,
        compute_dtype,
    )
    if device == "cuda":
        performance = _configure_video_offload(
            transformer,
            torch,
            memory_profile,
        )
        gc.collect()
        torch.cuda.empty_cache()
    else:
        performance = {
            "requestedMemoryProfile": memory_profile or "auto",
            "effectiveMemoryProfile": "cpu",
            "physicalMemoryBytes": _physical_memory_bytes(),
            "offloadType": "none",
            "blocksPerGroup": None,
            "diskCacheHit": None,
            "diskCachePath": None,
            "diskCacheFiles": None,
            "diskCacheBytes": None,
            "windowsDiskOffloadCompatibility": False,
        }
    vae_dtype = torch.bfloat16 if device == "cuda" else torch.float32
    vae = diffusers.AutoencoderKLLTXVideo.from_pretrained(
        str(model_path),
        subfolder="vae",
        torch_dtype=vae_dtype,
        local_files_only=True,
        use_safetensors=True,
    )
    if hasattr(vae, "enable_tiling"):
        vae.enable_tiling()
    if device == "cuda":
        from diffusers.hooks import apply_group_offloading

        apply_group_offloading(
            vae,
            onload_device=torch.device(f"cuda:{torch.cuda.current_device()}"),
            offload_device=torch.device("cpu"),
            offload_type="leaf_level",
            use_stream=False,
        )
    else:
        vae.to(torch.device(device))
        transformer.to(torch.device(device))
    scheduler = diffusers.FlowMatchEulerDiscreteScheduler.from_pretrained(
        str(model_path),
        subfolder="scheduler",
        local_files_only=True,
    )
    pipeline = diffusers.LTXConditionPipeline(
        tokenizer=None,
        text_encoder=None,
        vae=vae,
        scheduler=scheduler,
        transformer=transformer,
    )
    if hasattr(pipeline, "set_progress_bar_config"):
        pipeline.set_progress_bar_config(
            disable=os.environ.get("MACHDOCH_MEDIA_DEBUG_PROGRESS") != "1"
        )
    performance["variant"] = variant
    performance["weightStorageDtype"] = "float8_e4m3fn"
    performance["computeDtype"] = str(compute_dtype).removeprefix("torch.")
    performance["textEncoderDevice"] = text_encoder_device
    return pipeline, prompt_embeddings, prompt_attention_mask, performance


def _ltx_multiscale_dimensions(width: int, height: int) -> tuple[int, int, int, int]:
    first_width = max(32, int(width * (2 / 3)) // 32 * 32)
    first_height = max(32, int(height * (2 / 3)) // 32 * 32)
    return first_width, first_height, first_width * 2, first_height * 2


def _load_video_pipeline(
    diffusers: Any,
    torch: Any,
    model: dict[str, Any],
    prompt: str = "",
    negative_prompt: str = "",
    memory_profile: Any = None,
) -> tuple[Any, Any, Any]:
    architecture = _required_text(model, "architecture", 64)
    if architecture != "wan-2.2-ti2v":
        raise WorkerError(
            "The local video adapter supports only Wan2.2 TI2V 5B Diffusers packages"
        )
    if _required_text(model, "packageKind", 64) != "diffusers-directory":
        raise WorkerError("Wan video generation requires a Diffusers directory")
    model_path = _absolute_existing_path(model.get("path"), file=False)
    required = (
        model_path / "model_index.json",
        model_path / "transformer" / "diffusion_pytorch_model.safetensors.index.json",
        model_path / "text_encoder" / "model.safetensors.index.json",
        model_path / "vae" / "diffusion_pytorch_model.safetensors",
    )
    missing = [path.relative_to(model_path).as_posix() for path in required if not path.is_file()]
    if missing:
        raise WorkerError(
            "Wan model package is incomplete; missing " + ", ".join(missing)
        )
    device, _, _ = _device(torch)
    if device != "cuda":
        raise WorkerError("Wan video generation requires a supported GPU runtime")
    if not torch.cuda.is_bf16_supported():
        raise WorkerError("Wan video generation requires bfloat16 GPU support")
    prompt_embeddings, negative_prompt_embeddings = (
        _encode_video_prompt_embeddings(
            torch,
            model_path,
            prompt,
            negative_prompt,
        )
    )
    transformer = diffusers.WanTransformer3DModel.from_pretrained(
        str(model_path),
        subfolder="transformer",
        torch_dtype=torch.bfloat16,
        local_files_only=True,
        use_safetensors=True,
        trust_remote_code=False,
        low_cpu_mem_usage=True,
    )
    # Offload the 9.3 GB BF16 denoiser before loading the 2.6 GB FP32 VAE. This
    # ordering prevents their initialization peaks from overlapping on 32 GB
    # Windows systems and leaves the VAE resident for endpoint encode/decode.
    performance = _configure_video_offload(
        transformer,
        torch,
        memory_profile,
    )
    gc.collect()
    torch.cuda.empty_cache()
    vae = diffusers.AutoencoderKLWan.from_pretrained(
        str(model_path),
        subfolder="vae",
        torch_dtype=torch.float32,
        local_files_only=True,
        use_safetensors=True,
    )
    vae.to(torch.device(f"cuda:{torch.cuda.current_device()}"))
    scheduler = diffusers.UniPCMultistepScheduler.from_pretrained(
        str(model_path),
        subfolder="scheduler",
        local_files_only=True,
    )
    pipeline = diffusers.WanImageToVideoPipeline(
        tokenizer=None,
        text_encoder=None,
        vae=vae,
        scheduler=scheduler,
        transformer=transformer,
        transformer_2=None,
        boundary_ratio=None,
        expand_timesteps=True,
    )
    _enable_wan_last_frame_conditioning(pipeline, torch)
    if hasattr(pipeline.vae, "enable_tiling"):
        pipeline.vae.enable_tiling()
    pipeline._machdoch_wan_performance = performance
    if hasattr(pipeline, "set_progress_bar_config"):
        pipeline.set_progress_bar_config(
            disable=os.environ.get("MACHDOCH_MEDIA_DEBUG_PROGRESS") != "1"
        )
    return pipeline, prompt_embeddings, negative_prompt_embeddings


def _enable_wan_last_frame_conditioning(pipeline: Any, torch: Any) -> None:
    """Lock both WAN 2.2 TI2V endpoints in latent space.

    Diffusers 0.39 documents ``last_image`` for ``WanImageToVideoPipeline``,
    but its WAN 2.2 ``expand_timesteps`` branch builds ``video_condition`` from
    only the first image and masks only latent frame zero. As a result, a
    radically different supplied last image is silently ignored. Preserve the
    model's required expanded-timestep input while encoding the endpoints once
    as a complete temporal sequence. WAN's causal VAE must see a valid
    four-frame terminal group: an isolated one-frame encode produces a
    first-frame latent in the terminal slot, while neutral context leaks into
    the decoded tail. Repeating the last endpoint over one temporal stride
    supplies stable causal context without conditioning the denoised middle.
    """
    from diffusers.pipelines.wan.pipeline_wan_i2v import retrieve_latents
    from diffusers.utils.torch_utils import randn_tensor

    original_prepare_latents = pipeline.prepare_latents

    def prepare_first_last_latents(
        self: Any,
        image: Any,
        batch_size: int,
        num_channels_latents: int = 16,
        height: int = 480,
        width: int = 832,
        num_frames: int = 81,
        dtype: Any = None,
        device: Any = None,
        generator: Any = None,
        latents: Any = None,
        last_image: Any = None,
    ) -> tuple[Any, Any, Any]:
        if last_image is None:
            return original_prepare_latents(
                image,
                batch_size,
                num_channels_latents,
                height,
                width,
                num_frames,
                dtype,
                device,
                generator,
                latents,
                None,
            )
        num_latent_frames = (
            (num_frames - 1) // self.vae_scale_factor_temporal + 1
        )
        if num_latent_frames < 2:
            raise WorkerError(
                "Distinct WAN endpoints require at least two latent frames"
            )
        latent_height = height // self.vae_scale_factor_spatial
        latent_width = width // self.vae_scale_factor_spatial
        shape = (
            batch_size,
            num_channels_latents,
            num_latent_frames,
            latent_height,
            latent_width,
        )
        if isinstance(generator, list) and len(generator) != batch_size:
            raise WorkerError(
                "WAN generator list length does not match the effective batch size"
            )
        if latents is None:
            latents = randn_tensor(
                shape,
                generator=generator,
                device=device,
                dtype=dtype,
            )
        else:
            latents = latents.to(device=device, dtype=dtype)

        first_video = image.unsqueeze(2).to(device=device, dtype=self.vae.dtype)
        last_video = last_image.unsqueeze(2).to(
            device=device,
            dtype=self.vae.dtype,
        )
        terminal_context_frames = min(
            num_frames - 1,
            self.vae_scale_factor_temporal,
        )
        neutral_frame_count = num_frames - 1 - terminal_context_frames
        neutral_middle = first_video.new_zeros(
            (
                first_video.shape[0],
                first_video.shape[1],
                neutral_frame_count,
                height,
                width,
            )
        )
        terminal_context = last_video.repeat(
            1,
            1,
            terminal_context_frames,
            1,
            1,
        )
        video_condition = torch.cat(
            (first_video, neutral_middle, terminal_context),
            dim=2,
        )
        if isinstance(generator, list):
            encoded = [
                retrieve_latents(
                    self.vae.encode(video_condition),
                    sample_mode="argmax",
                )
                for _ in generator
            ]
            latent_condition = torch.cat(encoded)
        else:
            latent_condition = retrieve_latents(
                self.vae.encode(video_condition),
                sample_mode="argmax",
            )
            latent_condition = latent_condition.repeat(
                batch_size,
                1,
                1,
                1,
                1,
            )
        if (
            latent_condition.shape[0] != batch_size
            or latent_condition.shape[1] != num_channels_latents
            or latent_condition.shape[2] != num_latent_frames
            or latent_condition.shape[3] != latent_height
            or latent_condition.shape[4] != latent_width
        ):
            raise WorkerError(
                "WAN temporal endpoint VAE encoding returned an incompatible latent shape"
            )
        latent_condition = latent_condition.to(dtype=dtype)
        latents_mean = (
            torch.tensor(self.vae.config.latents_mean)
            .view(1, self.vae.config.z_dim, 1, 1, 1)
            .to(latents.device, latents.dtype)
        )
        latents_std = (
            1.0
            / torch.tensor(self.vae.config.latents_std)
            .view(1, self.vae.config.z_dim, 1, 1, 1)
            .to(latents.device, latents.dtype)
        )
        latent_condition = (latent_condition - latents_mean) * latents_std
        endpoint_mask = torch.ones(
            batch_size,
            1,
            num_latent_frames,
            latent_height,
            latent_width,
            dtype=dtype,
            device=device,
        )
        endpoint_mask[:, :, 0] = 0
        endpoint_mask[:, :, -1] = 0
        return latents, latent_condition, endpoint_mask

    pipeline.prepare_latents = types.MethodType(
        prepare_first_last_latents,
        pipeline,
    )
    pipeline._machdoch_wan_conditioning_mode = (  # noqa: SLF001
        "first-last-temporal-context-lock-v3"
    )


def _configure_video_conv3d_backend(torch: Any, device: str) -> str:
    """Select and prove a working 3D-convolution path for video VAEs.

    PyTorch exposes AMD ROCm through its CUDA-compatible API. On the current
    Windows ROCm stack, MIOpen advertises BF16 Conv3D for gfx1201 but dispatches
    a kernel that fails with ``hipErrorInvalidDeviceFunction``. Disabling the
    cuDNN compatibility switch bypasses MIOpen for Conv3D while all tensors and
    model blocks remain on the selected HIP device. A real GPU convolution is
    exercised here so an incompatible runtime fails before the 32 GiB model is
    loaded.
    """
    if device != "cuda":
        return f"{device}-native"
    if getattr(torch.version, "hip", None) is None:
        return "cudnn"
    if not hasattr(torch.backends, "cudnn"):
        raise WorkerError(
            "The AMD PyTorch runtime does not expose the MIOpen compatibility switch "
            "required by the video Conv3D fallback"
        )
    torch.backends.cudnn.enabled = False
    device = torch.device(f"cuda:{torch.cuda.current_device()}")
    try:
        sample = torch.ones((1, 1, 3, 8, 8), device=device, dtype=torch.bfloat16)
        kernel = torch.ones((1, 1, 3, 3, 3), device=device, dtype=torch.bfloat16)
        with torch.inference_mode():
            result = torch.nn.functional.conv3d(sample, kernel, padding=1)
        if result.device.type != "cuda" or not bool(torch.isfinite(result).all()):
            raise RuntimeError("native HIP Conv3D returned invalid output")
    except Exception as error:
        raise WorkerError(
            "The selected video model cannot execute a BF16 Conv3D on the AMD "
            "adapter after "
            f"bypassing MIOpen: {type(error).__name__}: {error}"
        ) from error
    finally:
        for name in ("sample", "kernel", "result"):
            if name in locals():
                del locals()[name]
        torch.cuda.empty_cache()
    return "aten-native-hip"


def _video_dimensions(
    aspect_ratio: str,
    resolution: str = "preview-512",
    architecture: str = "wan-2.2-ti2v",
) -> tuple[int, int]:
    """Resolve a native video canvas without stretching or post-generation cropping.

    Every dimension is divisible by WAN's 16-pixel spatial compression factor.
    The 768 profile remains well below the official 1280x704/24 GiB recipe but
    gives 2.25x as many pixels as the legacy 512x288 preview on capable consumer
    adapters. Square is deliberately bounded at 640 for that profile because it
    otherwise exceeds the 16:9 latent area by 78 percent.
    """
    profiles = {
        "preview-512": {
            "1:1": (512, 512),
            "16:9": (512, 288),
            "9:16": (288, 512),
            "21:9": (512, 224),
        },
        "quality-640": {
            "1:1": (576, 576),
            "16:9": (640, 352),
            "9:16": (352, 640),
            "21:9": (640, 288),
        },
        "quality-768": {
            "1:1": (640, 640),
            "16:9": (768, 432),
            "9:16": (432, 768),
            "21:9": (768, 336),
        },
    }
    if architecture == "hunyuan-video-1.5-i2v":
        profiles = {
            "preview-512": {
                "1:1": (512, 512),
                "16:9": (672, 384),
                "9:16": (384, 672),
                "21:9": (768, 336),
            },
            "quality-640": {
                "1:1": (640, 640),
                "16:9": (848, 480),
                "9:16": (480, 848),
                "21:9": (960, 416),
            },
            "quality-768": {
                "1:1": (768, 768),
                "16:9": (1024, 576),
                "9:16": (576, 1024),
                "21:9": (1152, 496),
            },
        }
    if architecture == "ltx-video" and resolution == "quality-768":
        profiles["quality-768"] = {
            "1:1": (640, 640),
            "16:9": (768, 448),
            "9:16": (448, 768),
            "21:9": (768, 320),
        }
    dimensions = profiles.get(resolution)
    if dimensions is None:
        raise WorkerError(
            "Video resolution must be preview-512, quality-640, or quality-768"
        )
    resolved = dimensions.get(aspect_ratio)
    if resolved is None:
        raise WorkerError("Video aspectRatio must be 1:1, 16:9, 9:16, or 21:9")
    return resolved


def _frame_rgb_array(frame: Any) -> Any:
    import numpy as np
    from PIL import Image

    if isinstance(frame, Image.Image):
        return np.asarray(frame.convert("RGB"), dtype=np.uint8)
    array = np.asarray(frame)
    if array.dtype.kind == "f":
        array = np.clip(
            array * 255.0 if float(array.max()) <= 1.0 else array,
            0.0,
            255.0,
        )
    if array.ndim != 3 or array.shape[2] < 3:
        raise WorkerError("WAN returned a frame without three color channels")
    return np.asarray(array[..., :3], dtype=np.uint8)


def _green_screen_alpha(
    rgb: Any,
    opaque_dominance: float = 18.0,
    transparent_dominance: float = 58.0,
) -> Any:
    import numpy as np

    signed = np.asarray(rgb, dtype=np.uint8).astype(np.int16)
    red = signed[..., 0]
    green = signed[..., 1]
    blue = signed[..., 2]
    green_dominance = green - np.maximum(red, blue)
    span = max(transparent_dominance - opaque_dominance, 1.0)
    alpha = np.clip(
        (
            transparent_dominance
            - green_dominance.astype(np.float32)
        )
        / span,
        0.0,
        1.0,
    )
    return np.rint(alpha * 255.0).astype(np.uint8)


def _frame_green_key(rgb: Any) -> tuple[Any, float, float]:
    """Estimate the generated screen from border pixels, not ideal #00ff00."""
    import numpy as np

    signed = np.asarray(rgb, dtype=np.uint8).astype(np.int16)
    height, width = signed.shape[:2]
    border_width = max(2, round(min(width, height) * 0.025))
    border = np.concatenate(
        (
            signed[:border_width, :, :].reshape(-1, 3),
            signed[-border_width:, :, :].reshape(-1, 3),
            signed[:, :border_width, :].reshape(-1, 3),
            signed[:, -border_width:, :].reshape(-1, 3),
        ),
        axis=0,
    )
    dominance = border[:, 1] - np.maximum(border[:, 0], border[:, 2])
    keyed = dominance >= 28
    keyed_ratio = float(np.mean(keyed))
    if keyed_ratio < 0.55:
        raise WorkerError(
            "Transparent video requires a predominantly green border in every WAN "
            f"frame; observed {keyed_ratio:.1%}. Keep subject motion and effects away "
            "from the boundary and use a uniform chroma-green source background."
        )
    candidates = border[keyed]
    key = np.median(candidates, axis=0).astype(np.float32)
    background_floor = float(np.percentile(dominance[keyed], 8.0))
    transparent_dominance = float(np.clip(background_floor * 0.42, 48.0, 72.0))
    return key, keyed_ratio, transparent_dominance


def _spatially_refine_alpha(alpha: Any, strength: float) -> Any:
    import numpy as np
    from PIL import Image, ImageFilter

    raw = np.asarray(alpha, dtype=np.uint8)
    if strength <= 0.0:
        return raw
    alpha_image = Image.fromarray(raw)
    median = np.asarray(alpha_image.filter(ImageFilter.MedianFilter(3)), dtype=np.float32)
    feathered = np.asarray(
        alpha_image.filter(ImageFilter.GaussianBlur(radius=0.55)),
        dtype=np.float32,
    )
    raw_float = raw.astype(np.float32)
    uncertain = (raw_float > 2.0) & (raw_float < 253.0)
    refined = raw_float.copy()
    blended = raw_float * (1.0 - 0.55 * strength)
    blended += median * (0.35 * strength)
    blended += feathered * (0.20 * strength)
    refined[uncertain] = blended[uncertain]
    refined[raw_float <= 1.0] = 0.0
    refined[raw_float >= 254.0] = 255.0
    return np.rint(np.clip(refined, 0.0, 255.0)).astype(np.uint8)


def _temporally_stabilize_alpha(
    alphas: list[Any],
    strength: float,
) -> list[Any]:
    """Suppress stationary matte chatter without smearing moving boundaries."""
    import numpy as np

    if strength <= 0.0 or len(alphas) < 3:
        return alphas
    stabilized: list[Any] = []
    for index, current_value in enumerate(alphas):
        current = np.asarray(current_value, dtype=np.float32)
        if index == 0 or index == len(alphas) - 1:
            stabilized.append(current_value)
            continue
        window = np.stack(
            (
                np.asarray(alphas[index - 1], dtype=np.float32),
                current,
                np.asarray(alphas[index + 1], dtype=np.float32),
            )
        )
        median = np.median(window, axis=0)
        spread = np.max(window, axis=0) - np.min(window, axis=0)
        # Large spread is usually real edge motion. Only use temporal memory in
        # a stable ambiguity band, retaining sub-pixel hair/fabric motion.
        stable_edge = (
            (current > 2.0)
            & (current < 253.0)
            & (spread <= 42.0)
        )
        output = current.copy()
        output[stable_edge] = (
            current[stable_edge] * (1.0 - strength)
            + median[stable_edge] * strength
        )
        output[current <= 1.0] = 0.0
        output[current >= 254.0] = 255.0
        stabilized.append(
            np.rint(np.clip(output, 0.0, 255.0)).astype(np.uint8)
        )
    return stabilized


def _isolate_primary_alpha_subject(alpha: Any) -> tuple[Any, dict[str, Any]]:
    """Keep the keyed character and its soft edge, not a restaged studio plate.

    A generated endpoint can contain wrinkles, seams, shadows, or tracking
    markers whose color is no longer sufficiently green for a chroma-distance
    threshold. Those regions may form large, partially opaque islands even
    though the actual character still has a clean opaque core. Production
    character mattes use that core as a hysteresis seed and retain a generous
    soft-edge envelope around it. This is deliberately performed before color
    decontamination; otherwise low-alpha green plate pixels can be amplified
    into saturated magenta or cyan contamination.
    """
    import numpy as np
    from PIL import Image, ImageFilter

    output = np.asarray(alpha, dtype=np.uint8).copy()
    height, width = output.shape
    # Seed only from effectively opaque pixels. A badly lit backdrop can reach
    # the lower "strong edge" band (roughly 224-245), but a real foreground
    # character contains a much larger 250+ core.
    strong_components = _binary_run_components(output >= 250)
    non_border = [
        component
        for component in strong_components
        if not component["touchesBorder"]
    ]
    if not non_border:
        return output, {
            "engine": "primary-opaque-core-hysteresis-v2",
            "applied": False,
            "reason": "no-non-border-opaque-core",
            "removedPixels": 0,
        }

    primary = max(non_border, key=lambda component: component["area"])
    minimum_core_area = max(64, round(width * height * 0.001))
    if primary["area"] < minimum_core_area:
        return output, {
            "engine": "primary-opaque-core-hysteresis-v2",
            "applied": False,
            "reason": "opaque-core-too-small",
            "primaryCoreArea": int(primary["area"]),
            "removedPixels": 0,
        }

    primary_mask = np.zeros((height, width), dtype=np.uint8)
    for y, start, end in primary["runs"]:
        primary_mask[y, start : end + 1] = 255
    # A 3.5%-of-short-edge envelope is wide enough for antialiased hair,
    # fabric, fingers, and nearby magic particles, while excluding remote
    # plate seams and floor wrinkles. Clamp it so preview and 768 profiles
    # behave consistently.
    envelope_radius = max(8, min(24, round(min(width, height) * 0.035)))
    filter_size = envelope_radius * 2 + 1
    envelope = np.asarray(
        Image.fromarray(primary_mask).filter(ImageFilter.MaxFilter(filter_size)),
        dtype=np.uint8,
    ) > 0
    before = int(np.count_nonzero(output))
    output[~envelope] = 0
    retained = int(np.count_nonzero(output))
    removed = before - retained
    retained_fraction = retained / before
    if retained_fraction < 0.35:
        return np.asarray(alpha, dtype=np.uint8).copy(), {
            "engine": "primary-opaque-core-hysteresis-v2",
            "applied": False,
            "reason": "candidate-retained-too-little-foreground",
            "primaryCoreArea": int(primary["area"]),
            "primaryCoreBox": [int(value) for value in primary["box"]],
            "candidateRemovedPixels": removed,
            "candidateRetainedFraction": round(retained_fraction, 6),
            "removedPixels": 0,
        }
    return output, {
        "engine": "primary-opaque-core-hysteresis-v2",
        "applied": True,
        "primaryCoreArea": int(primary["area"]),
        "primaryCoreBox": [int(value) for value in primary["box"]],
        "envelopeRadiusPixels": envelope_radius,
        "removedPixels": removed,
    }


def _binary_run_components(mask: Any) -> list[dict[str, Any]]:
    """Return 8-connected components as row spans.

    A pixel-by-pixel Python flood fill is prohibitively slow for production
    video mattes, especially when finding holes in a 512-768px background.
    Run-length union-find keeps the work proportional to boundary complexity
    and avoids adding an OpenCV/SciPy runtime dependency.
    """
    import numpy as np

    binary = np.asarray(mask, dtype=bool)
    if binary.ndim != 2:
        raise WorkerError("Connected-component masks must be two-dimensional")
    height, width = binary.shape
    parent: list[int] = []
    runs: list[tuple[int, int, int, int]] = []
    previous: list[tuple[int, int, int]] = []

    def create_label() -> int:
        label = len(parent)
        parent.append(label)
        return label

    def find(label: int) -> int:
        root = label
        while parent[root] != root:
            root = parent[root]
        while parent[label] != label:
            next_label = parent[label]
            parent[label] = root
            label = next_label
        return root

    def union(first: int, second: int) -> None:
        first_root = find(first)
        second_root = find(second)
        if first_root != second_root:
            parent[max(first_root, second_root)] = min(first_root, second_root)

    for y in range(height):
        padded = np.pad(binary[y].astype(np.int8), (1, 1))
        changes = np.diff(padded)
        starts = np.flatnonzero(changes == 1)
        ends = np.flatnonzero(changes == -1) - 1
        current: list[tuple[int, int, int]] = []
        previous_index = 0
        for start, end in zip(starts.tolist(), ends.tolist(), strict=True):
            while (
                previous_index < len(previous)
                and previous[previous_index][1] < start - 1
            ):
                previous_index += 1
            overlaps: list[int] = []
            candidate = previous_index
            while (
                candidate < len(previous)
                and previous[candidate][0] <= end + 1
            ):
                overlaps.append(previous[candidate][2])
                candidate += 1
            label = overlaps[0] if overlaps else create_label()
            for overlap in overlaps[1:]:
                union(label, overlap)
            current.append((start, end, label))
            runs.append((y, start, end, label))
        previous = current

    components: dict[int, dict[str, Any]] = {}
    for y, start, end, label in runs:
        root = find(label)
        component = components.setdefault(
            root,
            {
                "runs": [],
                "area": 0,
                "box": [start, y, end, y],
                "touchesBorder": False,
            },
        )
        component["runs"].append((y, start, end))
        component["area"] += end - start + 1
        component["box"][0] = min(component["box"][0], start)
        component["box"][1] = min(component["box"][1], y)
        component["box"][2] = max(component["box"][2], end)
        component["box"][3] = max(component["box"][3], y)
        component["touchesBorder"] |= (
            y in (0, height - 1) or start == 0 or end == width - 1
        )
    return list(components.values())


def _cleanup_alpha_components(alpha: Any) -> tuple[Any, dict[str, int]]:
    """Remove detached key noise and fill pinholes without losing real limbs."""
    import numpy as np

    output = np.asarray(alpha, dtype=np.uint8).copy()
    foreground = output >= 8
    height, width = foreground.shape
    components = _binary_run_components(foreground)
    if not components:
        return output, {
            "removedComponents": 0,
            "removedPixels": 0,
            "filledHoles": 0,
            "filledHolePixels": 0,
        }
    # A faint spill bridge can connect a valid subject to the border. Select
    # the component with the strongest opaque evidence, not merely any
    # non-border fragment such as a detached hand highlight.
    opaque_areas = [
        sum(
            int(np.count_nonzero(output[y, start : end + 1] >= 128))
            for y, start, end in component["runs"]
        )
        for component in components
    ]
    largest_index = max(
        range(len(components)),
        key=lambda index: (
            opaque_areas[index],
            not components[index]["touchesBorder"],
            components[index]["area"],
        ),
    )
    largest_component = components[largest_index]
    largest_box = largest_component["box"]
    largest_area = largest_component["area"]
    # Only bridge a genuinely adjacent antialias gap. The previous 2.5% radius
    # retained five-to-nine-pixel tracking markers near a hand or boot; 1% is
    # still enough for separated hair tips at every supported delivery size.
    proximity = max(3, min(8, round(min(width, height) * 0.01)))
    minimum_detached_area = max(24, round(largest_area * 0.02))
    largest_rows: dict[int, list[tuple[int, int]]] = {}
    for y, start, end in largest_component["runs"]:
        largest_rows.setdefault(y, []).append((start, end))

    def is_near_largest(
        component: dict[str, Any],
        allowed_proximity: int,
    ) -> bool:
        # Bounding boxes are insufficient here: a tracking marker can sit well
        # inside a full-body subject's tall box while remaining hundreds of
        # pixels from the actual silhouette. Compare row spans directly using
        # Chebyshev distance so nearby hair/cloth fragments survive and plate
        # debris does not.
        for y, start, end in component["runs"]:
            for nearby_y in range(
                max(largest_box[1], y - allowed_proximity),
                min(largest_box[3], y + allowed_proximity) + 1,
            ):
                for largest_start, largest_end in largest_rows.get(nearby_y, ()):
                    if (
                        largest_start <= end + allowed_proximity
                        and largest_end >= start - allowed_proximity
                    ):
                        return True
        return False

    removed_components = 0
    removed_pixels = 0
    for index, component in enumerate(components):
        # A valid chroma-keyed subject is required to leave a predominantly
        # green border. Any residual alpha connected to that border is screen
        # contamination, even when a shadow or seam makes it relatively large.
        if component["touchesBorder"] and index != largest_index:
            for y, start, end in component["runs"]:
                output[y, start : end + 1] = 0
            removed_components += 1
            removed_pixels += component["area"]
            continue
        fragment_proximity = (
            1
            if component["area"] < 64
            else proximity
        )
        if (
            index == largest_index
            or component["area"] >= minimum_detached_area
            or is_near_largest(component, fragment_proximity)
        ):
            continue
        for y, start, end in component["runs"]:
            output[y, start : end + 1] = 0
        removed_components += 1
        removed_pixels += component["area"]

    # Fill only tiny enclosed holes. Larger gaps preserve fingers, hair strands,
    # cape cutouts, and other legitimate negative space.
    foreground = output >= 128
    background = ~foreground
    maximum_hole_area = max(12, round(largest_area * 0.001))
    filled_holes = 0
    filled_hole_pixels = 0
    for component in _binary_run_components(background):
        if (
            not component["touchesBorder"]
            and component["area"] <= maximum_hole_area
        ):
            for y, start, end in component["runs"]:
                output[y, start : end + 1] = 255
            filled_holes += 1
            filled_hole_pixels += component["area"]
    return output, {
        "removedComponents": removed_components,
        "removedPixels": removed_pixels,
        "filledHoles": filled_holes,
        "filledHolePixels": filled_hole_pixels,
    }


def _pad_transparent_edge_colors(
    colors: Any,
    alpha: Any,
    iterations: int,
) -> Any:
    """Extend straight foreground color under alpha for 4:2:0-safe edges."""
    import numpy as np

    output = np.asarray(colors, dtype=np.float32).copy()
    valid = np.asarray(alpha, dtype=np.float32) >= 20.0
    for _ in range(iterations):
        padded_colors = np.pad(output, ((1, 1), (1, 1), (0, 0)), mode="edge")
        padded_valid = np.pad(valid, ((1, 1), (1, 1)), mode="constant")
        color_sum = np.zeros_like(output)
        count = np.zeros(valid.shape, dtype=np.float32)
        for y_offset in range(3):
            for x_offset in range(3):
                if y_offset == 1 and x_offset == 1:
                    continue
                neighbor_valid = padded_valid[
                    y_offset : y_offset + valid.shape[0],
                    x_offset : x_offset + valid.shape[1],
                ]
                neighbor_colors = padded_colors[
                    y_offset : y_offset + valid.shape[0],
                    x_offset : x_offset + valid.shape[1],
                    :,
                ]
                color_sum += neighbor_colors * neighbor_valid[..., None]
                count += neighbor_valid
        candidates = (~valid) & (count > 0.0)
        output[candidates] = color_sum[candidates] / count[candidates, None]
        valid |= candidates
    output[~valid] = 0.0
    return output


def _decontaminate_green_edges(
    rgb: Any,
    alpha: Any,
    key_color: Any,
    padding_iterations: int,
) -> Any:
    """Recover straight foreground RGB and remove generated green spill."""
    import numpy as np

    colors = np.asarray(rgb, dtype=np.float32)
    matte = np.asarray(alpha, dtype=np.float32) / 255.0
    key = np.asarray(key_color, dtype=np.float32)[None, None, :]
    safe_alpha = np.maximum(matte[..., None], 0.08)
    recovered = (
        colors - (1.0 - matte[..., None]) * key
    ) / safe_alpha
    recovered = np.clip(recovered, 0.0, 255.0)

    despilled = colors.copy()
    green_excess = np.maximum(
        despilled[..., 1] - np.maximum(despilled[..., 0], despilled[..., 2]),
        0.0,
    )
    despill_strength = np.clip((0.98 - matte) / 0.90, 0.0, 1.0)
    despilled[..., 1] -= green_excess * despill_strength * 0.92
    recovery_strength = np.clip((0.92 - matte) / 0.82, 0.0, 1.0) * 0.82
    cleaned = (
        despilled * (1.0 - recovery_strength[..., None])
        + recovered * recovery_strength[..., None]
    )
    cleaned = _pad_transparent_edge_colors(
        cleaned,
        alpha,
        padding_iterations,
    )
    return np.rint(np.clip(cleaned, 0.0, 255.0)).astype(np.uint8)


def _matte_video_frames(
    frames: list[Any],
    matte_quality: str,
) -> tuple[list[Any], dict[str, Any]]:
    """Create a calibrated, temporally stable, decontaminated RGBA sequence."""
    import numpy as np

    if matte_quality not in ("fast", "balanced", "production"):
        raise WorkerError("matteQuality must be fast, balanced, or production")
    profiles = {
        "fast": (0.20, 0.0, 2),
        "balanced": (0.55, 0.24, 4),
        "production": (0.85, 0.42, 6),
    }
    spatial_strength, temporal_strength, padding_iterations = profiles[matte_quality]
    rgb_frames = [_frame_rgb_array(frame) for frame in frames]
    calibrations = []
    for index, rgb in enumerate(rgb_frames):
        try:
            calibrations.append(_frame_green_key(rgb))
        except WorkerError as error:
            raise WorkerError(f"WAN frame {index}: {error}") from error
    key_colors = np.stack([calibration[0] for calibration in calibrations])
    keyed_ratios = [calibration[1] for calibration in calibrations]
    transparent_threshold = float(
        np.median([calibration[2] for calibration in calibrations])
    )
    # A shot-wide key and threshold prevent framewise screen fluctuations from
    # becoming alpha flicker. Per-frame estimates remain in provenance.
    shot_key = np.median(key_colors, axis=0).astype(np.float32)
    raw_alphas = [
        _green_screen_alpha(
            rgb,
            opaque_dominance=18.0,
            transparent_dominance=transparent_threshold,
        )
        for rgb in rgb_frames
    ]
    refined_alphas = [
        _spatially_refine_alpha(alpha, spatial_strength)
        for alpha in raw_alphas
    ]
    final_alphas = _temporally_stabilize_alpha(
        refined_alphas,
        temporal_strength,
    )
    primary_subject_isolation: list[dict[str, Any]] = []
    component_cleanup: list[dict[str, int]] = []
    if matte_quality == "production":
        isolated_alphas = []
        for alpha in final_alphas:
            isolated, isolation = _isolate_primary_alpha_subject(alpha)
            isolated_alphas.append(isolated)
            primary_subject_isolation.append(isolation)
        final_alphas = isolated_alphas
        cleaned_alphas = []
        for alpha in final_alphas:
            cleaned, cleanup = _cleanup_alpha_components(alpha)
            cleaned_alphas.append(cleaned)
            component_cleanup.append(cleanup)
        final_alphas = cleaned_alphas
    ground_suppression = None
    if matte_quality == "production":
        final_alphas, ground_suppression = _suppress_transient_ground_alpha(
            final_alphas
        )
    rgba_frames: list[Any] = []
    spill_before: list[float] = []
    spill_after: list[float] = []
    for rgb, alpha in zip(rgb_frames, final_alphas, strict=True):
        edge = (alpha > 4) & (alpha < 251)
        original = rgb.astype(np.float32)
        original_spill = np.maximum(
            original[..., 1] - np.maximum(original[..., 0], original[..., 2]),
            0.0,
        )
        cleaned = _decontaminate_green_edges(
            rgb,
            alpha,
            shot_key,
            padding_iterations,
        )
        cleaned_float = cleaned.astype(np.float32)
        cleaned_spill = np.maximum(
            cleaned_float[..., 1]
            - np.maximum(cleaned_float[..., 0], cleaned_float[..., 2]),
            0.0,
        )
        spill_before.append(float(original_spill[edge].mean()) if np.any(edge) else 0.0)
        spill_after.append(float(cleaned_spill[edge].mean()) if np.any(edge) else 0.0)
        rgba_frames.append(
            np.concatenate((cleaned, alpha[..., None]), axis=2)
        )
    return rgba_frames, {
        "engine": "adaptive-temporal-chroma-matte-v1",
        "quality": matte_quality,
        "shotKeyRgb": [round(float(value), 3) for value in shot_key],
        "perFrameKeyRgb": [
            [round(float(value), 3) for value in key]
            for key in key_colors
        ],
        "minimumKeyedBorderRatio": round(min(keyed_ratios), 6),
        "meanKeyedBorderRatio": round(float(np.mean(keyed_ratios)), 6),
        "opaqueDominance": 18.0,
        "transparentDominance": round(transparent_threshold, 3),
        "spatialRefinementStrength": spatial_strength,
        "temporalStabilizationStrength": temporal_strength,
        "primarySubjectIsolation": (
            {
                "engine": "primary-opaque-core-hysteresis-v2",
                "appliedFrames": int(
                    sum(bool(frame.get("applied")) for frame in primary_subject_isolation)
                ),
                "removedPixels": int(
                    sum(int(frame.get("removedPixels", 0)) for frame in primary_subject_isolation)
                ),
                "minimumEnvelopeRadiusPixels": int(
                    min(
                        (
                            int(frame["envelopeRadiusPixels"])
                            for frame in primary_subject_isolation
                            if frame.get("applied")
                        ),
                        default=0,
                    )
                ),
                "maximumEnvelopeRadiusPixels": int(
                    max(
                        (
                            int(frame["envelopeRadiusPixels"])
                            for frame in primary_subject_isolation
                            if frame.get("applied")
                        ),
                        default=0,
                    )
                ),
            }
            if primary_subject_isolation
            else None
        ),
        "componentCleanup": (
            {
                key: int(sum(frame[key] for frame in component_cleanup))
                for key in (
                    "removedComponents",
                    "removedPixels",
                    "filledHoles",
                    "filledHolePixels",
                )
            }
            if component_cleanup
            else None
        ),
        "transientGroundSuppression": ground_suppression,
        "transparentColorPaddingPixels": padding_iterations,
        "edgeGreenSpillBeforeMean": round(float(np.mean(spill_before)), 6),
        "edgeGreenSpillAfterMean": round(float(np.mean(spill_after)), 6),
    }


def _suppress_transient_ground_alpha(
    alphas: list[Any],
) -> tuple[list[Any], dict[str, Any]]:
    """Remove low-opacity, short-lived floor shadows without clipping feet.

    Chroma-conditioned generators can darken the plate beneath a character.
    A color key interprets that darkening as foreground, and temporal smoothing
    can spread it into a wide translucent floor halo. Restrict suppression to
    the bottom 22 percent and require low temporal persistence. Opaque transient
    pixels survive only when the same column has strong foreground support in
    the preceding 12 pixels, preserving a moving foot attached to its leg while
    removing detached horizontal shadow fragments.
    """
    from collections import deque
    import numpy as np

    if not alphas:
        return [], {
            "engine": "low-persistence-ground-alpha-v3",
            "floorStartFraction": 0.78,
            "suppressedPixels": 0,
            "affectedFrames": 0,
        }
    stack = np.stack(alphas).astype(np.uint8)
    persistent = np.percentile(stack, 25.0, axis=0)
    height = stack.shape[1]
    floor_start = int(round(height * 0.78))
    floor_mask = np.zeros(stack.shape[1:], dtype=bool)
    floor_mask[floor_start:, :] = True
    cleaned: list[Any] = []
    suppressed_pixels = 0
    affected_frames = 0
    removed_opaque_components = 0
    removed_opaque_pixels = 0
    for alpha in stack:
        vertical_support = np.zeros_like(floor_mask)
        for row in range(floor_start, stack.shape[1]):
            support_start = max(0, row - 12)
            vertical_support[row] = np.max(
                alpha[support_start : row + 1],
                axis=0,
            ) >= 160
        suppress = floor_mask & (
            ((persistent < 8.0) & (alpha < 160))
            | ((persistent < 32.0) & (alpha < 64))
            | ((persistent < 8.0) & ~vertical_support)
        )
        removed = int(np.count_nonzero(suppress & (alpha > 0)))
        output = alpha.copy()
        output[suppress] = 0
        strong = output >= 128
        visited = np.zeros_like(strong)
        for start_y, start_x in zip(
            *np.nonzero(strong & floor_mask),
            strict=True,
        ):
            if visited[start_y, start_x]:
                continue
            queue = deque([(int(start_y), int(start_x))])
            visited[start_y, start_x] = True
            component: list[int] = []
            anchored = False
            while queue:
                row, column = queue.popleft()
                component.append(row * strong.shape[1] + column)
                anchored |= (
                    row < floor_start
                    or persistent[row, column] >= 128.0
                )
                for neighbor_y in range(max(0, row - 1), min(strong.shape[0], row + 2)):
                    for neighbor_x in range(
                        max(0, column - 1),
                        min(strong.shape[1], column + 2),
                    ):
                        if (
                            strong[neighbor_y, neighbor_x]
                            and not visited[neighbor_y, neighbor_x]
                        ):
                            visited[neighbor_y, neighbor_x] = True
                            queue.append((neighbor_y, neighbor_x))
            if not anchored:
                flattened = output.reshape(-1)
                flattened[np.asarray(component, dtype=np.int64)] = 0
                removed_opaque_components += 1
                removed_opaque_pixels += len(component)
                removed += len(component)
        cleaned.append(output)
        suppressed_pixels += removed
        affected_frames += int(removed > 0)
    return cleaned, {
        "engine": "low-persistence-ground-alpha-v3",
        "floorStartFraction": 0.78,
        "persistencePercentile": 25,
        "softRuleMaximumAlpha": 159,
        "opaqueTransientRule": "retain-with-12px-vertical-support",
        "removedOpaqueComponents": removed_opaque_components,
        "removedOpaquePixels": removed_opaque_pixels,
        "suppressedPixels": suppressed_pixels,
        "affectedFrames": affected_frames,
    }


def _restore_wan_endpoint_colors(
    frames: list[Any],
    endpoint: Any,
) -> tuple[list[Any], dict[str, Any]]:
    """Restore contrast near a causally encoded WAN release endpoint.

    Encoding the last still with a causal terminal context makes WAN honor its
    pose on the 5B expanded-timestep path, but the final decoded frames can
    still inherit a compressed tonal range. Estimate a bounded per-channel affine
    correction from the exact endpoint reference and ease it across the final
    five forward frames. A smoothstep ramp avoids the legacy pass's abrupt
    65-percent correction on its first affected frame. Geometry and motion
    remain model-generated.
    """
    import numpy as np
    from PIL import Image

    if len(frames) < 5:
        raise WorkerError("WAN endpoint restoration requires at least five frames")
    endpoint_rgb = _frame_rgb_array(endpoint)
    final_rgb = _frame_rgb_array(frames[-1])
    if endpoint_rgb.shape != final_rgb.shape:
        raise WorkerError("WAN endpoint reference dimensions changed unexpectedly")
    final_alpha = _green_screen_alpha(final_rgb)
    endpoint_alpha = _green_screen_alpha(endpoint_rgb)
    common_subject = (final_alpha >= 224) & (endpoint_alpha >= 224)
    if int(common_subject.sum()) < 2_048:
        raise WorkerError(
            "WAN endpoint restoration could not align enough foreground pixels"
        )

    channel_scales: list[float] = []
    channel_offsets: list[float] = []
    for channel in range(3):
        generated_values = final_rgb[..., channel][common_subject]
        reference_values = endpoint_rgb[..., channel][common_subject]
        generated_low, generated_high = np.percentile(
            generated_values,
            (5.0, 95.0),
        )
        reference_low, reference_high = np.percentile(
            reference_values,
            (5.0, 95.0),
        )
        generated_range = max(float(generated_high - generated_low), 1.0)
        scale = float(
            np.clip(
                (reference_high - reference_low) / generated_range,
                0.75,
                2.5,
            )
        )
        offset = float(
            np.clip(reference_low - generated_low * scale, -160.0, 160.0)
        )
        channel_scales.append(scale)
        channel_offsets.append(offset)

    scales = np.asarray(channel_scales, dtype=np.float32)[None, None, :]
    offsets = np.asarray(channel_offsets, dtype=np.float32)[None, None, :]
    restored = list(frames)
    restoration_frame_count = min(5, len(restored))
    start_frame = len(restored) - restoration_frame_count
    strengths = []
    for offset in range(restoration_frame_count):
        linear = (offset + 1) / restoration_frame_count
        strengths.append(linear * linear * (3.0 - 2.0 * linear))
    for index, strength in zip(
        range(start_frame, len(restored)),
        strengths,
        strict=True,
    ):
        original = _frame_rgb_array(restored[index])
        corrected = np.clip(
            original.astype(np.float32) * scales + offsets,
            0.0,
            255.0,
        )
        subject = (
            _green_screen_alpha(original).astype(np.float32) / 255.0
        )[..., None]
        blend = subject * strength
        output = np.rint(
            original.astype(np.float32) * (1.0 - blend) + corrected * blend
        ).astype(np.uint8)
        restored[index] = Image.fromarray(output)
    final_restored = _frame_rgb_array(restored[-1]).astype(np.float32)
    endpoint_blend = endpoint_alpha.astype(np.float32)[..., None] / 255.0
    exact_endpoint = np.rint(
        final_restored * (1.0 - endpoint_blend)
        + endpoint_rgb.astype(np.float32) * endpoint_blend
    ).astype(np.uint8)
    restored[-1] = Image.fromarray(exact_endpoint)
    return restored, {
        "engine": "endpoint-reference-color-and-pixel-restore-v3",
        "startFrame": start_frame,
        "frameCount": restoration_frame_count,
        "exactEndpointFrame": True,
        "easing": "smoothstep",
        "lowPercentile": 5,
        "highPercentile": 95,
        "channelScales": [round(value, 6) for value in channel_scales],
        "channelOffsets": [round(value, 6) for value in channel_offsets],
    }


def _restore_wan_seam_endpoints(
    frames: list[Any],
    endpoint: Any,
) -> tuple[list[Any], dict[str, Any]]:
    """Pin a requested loop to the exact same decoded first/last still."""
    if len(frames) < 3:
        raise WorkerError("WAN seamless restoration requires at least three frames")
    restored = list(frames)
    from PIL import Image

    exact = Image.fromarray(_frame_rgb_array(endpoint))
    restored[0] = exact.copy()
    restored[-1] = exact.copy()
    return restored, {
        "engine": "exact-source-loop-endpoint-v1",
        "exactFirstFrame": True,
        "exactLastFrame": True,
        "duplicateClosureFrame": True,
    }


def _video_frame_to_rgba(frame: Any) -> tuple[Any, int, int]:
    import numpy as np
    from PIL import Image

    rgba_frames, _ = _matte_video_frames([frame], "balanced")
    rgba = rgba_frames[0]
    alpha = rgba[..., 3]
    return Image.fromarray(rgba), int(alpha.min()), int(alpha.max())


def _animated_background_config(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise WorkerError("animatedBackground must be an object")
    style = value.get("style")
    direction = value.get("direction")
    color_start = value.get("colorStart")
    color_end = value.get("colorEnd")
    cycles = value.get("cycles")
    if style not in ("gradient-wave", "enchanted-beach"):
        raise WorkerError(
            "animatedBackground.style must be gradient-wave or enchanted-beach"
        )
    if direction not in ("horizontal", "vertical", "diagonal"):
        raise WorkerError(
            "animatedBackground.direction must be horizontal, vertical, or diagonal"
        )
    for name, color in (("colorStart", color_start), ("colorEnd", color_end)):
        if (
            not isinstance(color, str)
            or not re.fullmatch(r"#[0-9a-fA-F]{6}", color)
        ):
            raise WorkerError(f"animatedBackground.{name} must be a six-digit color")
    if (
        not isinstance(cycles, int)
        or isinstance(cycles, bool)
        or not 1 <= cycles <= 4
    ):
        raise WorkerError("animatedBackground.cycles must be an integer from 1 to 4")
    return {
        "style": style,
        "direction": direction,
        "colorStart": color_start.lower(),
        "colorEnd": color_end.lower(),
        "cycles": cycles,
    }


def _rgb_hex(value: str) -> Any:
    import numpy as np

    return np.asarray(
        [int(value[index : index + 2], 16) for index in (1, 3, 5)],
        dtype=np.float32,
    )


def _enchanted_beach_pixels(
    width: int,
    height: int,
    phase: float,
    color_start: Any,
    color_end: Any,
) -> tuple[Any, Any, Any]:
    """Render a seamless layered beach plus foreground spell interaction.

    The background deliberately contains several independently moving cues:
    clouds and aurora in the sky, rolling sea bands and foam at the shore,
    drifting magic motes, a pulsing rune around the casting hand, and spray
    around the character's boots. Every term is periodic in ``phase`` so the
    first and last loop samples remain identical.
    """
    import numpy as np

    x = np.linspace(0.0, 1.0, width, dtype=np.float32)[None, :]
    y = np.linspace(0.0, 1.0, height, dtype=np.float32)[:, None]
    xx = np.broadcast_to(x, (height, width))
    yy = np.broadcast_to(y, (height, width))

    # Sunset sky with a moving lavender cloud shelf and magical aurora.
    sky_mix = np.clip(yy / 0.56, 0.0, 1.0)[..., None]
    sky_top = np.asarray([10.0, 18.0, 63.0], dtype=np.float32)
    sky_horizon = np.asarray([239.0, 126.0, 159.0], dtype=np.float32)
    background = sky_top * (1.0 - sky_mix) + sky_horizon * sky_mix
    cloud_center = 0.19 + 0.035 * np.sin(2.0 * np.pi * xx * 0.85 - phase)
    cloud = np.exp(-((yy - cloud_center) ** 2) / 0.0025)
    cloud *= 0.55 + 0.45 * np.sin(2.0 * np.pi * xx * 1.7 + phase * 2.0) ** 2
    background += cloud[..., None] * np.asarray(
        [37.0, 24.0, 55.0], dtype=np.float32
    )
    aurora_center = 0.31 + 0.045 * np.sin(2.0 * np.pi * xx * 1.2 + phase)
    aurora = np.exp(-((yy - aurora_center) ** 2) / 0.0018)
    aurora *= 0.35 + 0.65 * np.sin(2.0 * np.pi * xx * 2.1 - phase * 2.0) ** 2
    aurora_color = color_end * 0.65 + np.asarray(
        [30.0, 95.0, 120.0], dtype=np.float32
    )
    background += aurora[..., None] * aurora_color[None, None, :] * 0.38

    # A glowing moon/sun gives the moving water a visible reflected light path.
    sun_distance = (xx - 0.82) ** 2 + ((yy - 0.18) * 1.8) ** 2
    sun_glow = np.exp(-sun_distance / 0.012)
    background += sun_glow[..., None] * np.asarray(
        [82.0, 49.0, 18.0], dtype=np.float32
    )

    # Layered ocean. Independent waves move at different rates and the horizon
    # gently rises and falls, making the environment read as animation even
    # behind a large centered character.
    horizon = 0.53 + 0.006 * np.sin(phase)
    shore = 0.77 + 0.018 * np.sin(2.0 * np.pi * xx * 1.7 - phase)
    ocean_mask = (yy >= horizon) & (yy < shore)
    ocean_depth = np.clip((yy - horizon) / 0.25, 0.0, 1.0)
    ocean = (
        np.asarray([15.0, 68.0, 129.0], dtype=np.float32)[None, None, :]
        * (1.0 - ocean_depth[..., None])
        + np.asarray([22.0, 151.0, 177.0], dtype=np.float32)[None, None, :]
        * ocean_depth[..., None]
    )
    water_ripples = (
        np.sin(2.0 * np.pi * (xx * 5.5 + yy * 2.0) - phase * 2.0)
        + np.sin(2.0 * np.pi * (xx * 9.0 - yy * 1.5) + phase)
    )
    ocean += water_ripples[..., None] * np.asarray(
        [3.0, 8.0, 12.0], dtype=np.float32
    )
    background = np.where(ocean_mask[..., None], ocean, background)
    crest = np.exp(
        -(
            (
                yy
                - (
                    0.62
                    + 0.012 * np.sin(2.0 * np.pi * xx * 3.2 - phase * 2.0)
                )
            )
            ** 2
        )
        / 0.00009
    )
    background += crest[..., None] * ocean_mask[..., None] * np.asarray(
        [54.0, 63.0, 60.0], dtype=np.float32
    )

    # Warm sand and a travelling shoreline foam band.
    sand_mask = yy >= shore
    sand_depth = np.clip((yy - 0.74) / 0.26, 0.0, 1.0)
    sand = (
        np.asarray([201.0, 146.0, 91.0], dtype=np.float32)[None, None, :]
        * (1.0 - sand_depth[..., None])
        + np.asarray([119.0, 72.0, 73.0], dtype=np.float32)[None, None, :]
        * sand_depth[..., None]
    )
    sand += (
        4.0 * np.sin(2.0 * np.pi * (xx * 4.0 + yy) + phase)
    )[..., None]
    background = np.where(sand_mask[..., None], sand, background)
    foam = np.exp(-((yy - shore) ** 2) / 0.00018)
    foam *= 0.55 + 0.45 * np.sin(2.0 * np.pi * xx * 7.0 + phase) ** 2
    background += foam[..., None] * np.asarray(
        [64.0, 71.0, 69.0], dtype=np.float32
    )

    # A subtle moving reflection connects the hand spell to the ocean.
    cast_progress = 0.5 - 0.5 * np.cos(phase)
    spell_center_x = 0.50 + 0.25 * cast_progress
    spell_center_y = 0.34 - 0.14 * cast_progress
    reflection = np.exp(-((xx - spell_center_x) ** 2) / 0.008)
    reflection *= ocean_mask * (
        0.3 + 0.7 * np.sin(2.0 * np.pi * (yy * 11.0) - phase) ** 2
    )
    background += reflection[..., None] * color_start[None, None, :] * 0.28

    # Additive spell layer composited after the character: a pulsing double
    # rune, orbiting motes, and sea spray around her feet.
    spell_rgb = np.zeros((height, width, 3), dtype=np.float32)
    spell_alpha = np.zeros((height, width, 1), dtype=np.float32)
    rune_distance = np.sqrt(
        ((xx - spell_center_x) * 1.0) ** 2
        + ((yy - spell_center_y) * 1.78) ** 2
    )
    pulse = 0.052 + 0.036 * cast_progress + 0.006 * np.sin(phase * 2.0)
    rune = np.exp(-((rune_distance - pulse) ** 2) / 0.000035)
    rune += 0.7 * np.exp(-((rune_distance - pulse * 0.68) ** 2) / 0.000025)
    spokes = np.sin(
        np.arctan2(
            (yy - spell_center_y) * 1.78,
            xx - spell_center_x,
        )
        * 8.0
        + phase
    )
    rune *= 0.72 + 0.28 * spokes**2
    spell_alpha[..., 0] = np.clip(rune * 0.78, 0.0, 0.88)
    spell_rgb += rune[..., None] * (
        color_start[None, None, :] * 0.55
        + np.asarray([46.0, 188.0, 210.0], dtype=np.float32)
    )
    golden_angle = 2.3999632
    for mote_index in range(20):
        mote_offset = mote_index * golden_angle
        radius = 0.055 + 0.012 * (mote_index % 5)
        mote_x = spell_center_x + radius * np.cos(
            phase * (1 + mote_index % 3) + mote_offset
        )
        mote_y = spell_center_y + radius * 0.56 * np.sin(
            phase * (1 + mote_index % 2) + mote_offset
        )
        mote = np.exp(
            -(
                (xx - mote_x) ** 2
                + ((yy - mote_y) * 1.78) ** 2
            )
            / 0.000045
        )
        spell_alpha[..., 0] = np.maximum(
            spell_alpha[..., 0], np.clip(mote * 0.9, 0.0, 0.9)
        )
        spell_rgb += mote[..., None] * np.asarray(
            [85.0, 235.0, 255.0], dtype=np.float32
        )
    for spray_index in range(11):
        spray_offset = spray_index * 0.83
        spray_x = 0.50 + 0.12 * np.sin(
            phase * (1 + spray_index % 2) + spray_offset
        )
        spray_y = 0.86 - 0.035 * (
            0.5
            + 0.5
            * np.sin(phase * (2 + spray_index % 3) + spray_offset)
        )
        spray = np.exp(
            -(
                (xx - spray_x) ** 2
                + ((yy - spray_y) * 1.78) ** 2
            )
            / 0.000035
        )
        spell_alpha[..., 0] = np.maximum(
            spell_alpha[..., 0], np.clip(spray * 0.55, 0.0, 0.6)
        )
        spell_rgb += spray[..., None] * np.asarray(
            [90.0, 190.0, 205.0], dtype=np.float32
        )
    return (
        np.clip(background, 0.0, 255.0),
        np.clip(spell_rgb, 0.0, 255.0),
        np.clip(spell_alpha, 0.0, 0.92),
    )


def _vp9_quality_arguments(
    encoding_quality: str,
    *,
    alpha: bool,
) -> list[str]:
    if encoding_quality not in ("draft", "balanced", "production", "lossless"):
        raise WorkerError(
            "encodingQuality must be draft, balanced, production, or lossless"
        )
    if encoding_quality == "lossless":
        rate_control = ["-lossless", "1", "-b:v", "0"]
        cpu_used = "1"
    else:
        crf = {
            "draft": "30",
            "balanced": "20",
            "production": "12",
        }[encoding_quality]
        rate_control = ["-crf", crf, "-b:v", "0"]
        cpu_used = {
            "draft": "6",
            "balanced": "4",
            "production": "2",
        }[encoding_quality]
    arguments = [
        "-deadline",
        "good",
        "-cpu-used",
        cpu_used,
        "-row-mt",
        "1",
        *rate_control,
    ]
    if alpha:
        # VP9 alpha cannot use alternate reference frames without corrupting the
        # alpha plane in common WebM decoders.
        arguments.extend(
            [
                "-auto-alt-ref",
                "0",
                "-metadata:s:v:0",
                "alpha_mode=1",
            ]
        )
    return arguments


def _assemble_video_frames(frames: list[Any], loop_mode: str) -> list[Any]:
    if loop_mode == "none":
        return list(frames)
    if loop_mode == "ping-pong":
        return list(frames) + list(reversed(frames[:-1]))
    if loop_mode == "seamless":
        # First/last endpoint restoration is handled before matting. Retaining
        # the exact closing endpoint makes the repeat seam deterministic; at a
        # quality delivery rate the duplicate hold lasts one frame.
        return list(frames)
    raise WorkerError("loopMode must be none, ping-pong, or seamless")


def _encode_animated_composite(
    rgba_frames: list[Any],
    output_directory: Path,
    fps: int,
    config: dict[str, Any],
    loop_mode: str,
    encoding_quality: str,
) -> tuple[Path, dict[str, Any]]:
    """Composite an alpha sequence over a deterministic seamless background."""
    import imageio_ffmpeg
    import numpy as np
    import subprocess
    from PIL import Image

    if not rgba_frames:
        raise WorkerError("Animated video composition requires at least one frame")
    frame_count = len(rgba_frames)
    height, width = rgba_frames[0].shape[:2]
    color_start = _rgb_hex(config["colorStart"])
    color_end = _rgb_hex(config["colorEnd"])
    x = np.linspace(0.0, 1.0, width, dtype=np.float32)[None, :]
    y = np.linspace(0.0, 1.0, height, dtype=np.float32)[:, None]
    if config["direction"] == "horizontal":
        position = np.broadcast_to(x, (height, width))
    elif config["direction"] == "vertical":
        position = np.broadcast_to(y, (height, width))
    else:
        position = (x + y) * 0.5
    composite_directory = output_directory / "composite-frames"
    composite_directory.mkdir()
    endpoint_frames: list[Any] = []
    denominator = max(frame_count - 1, 1)
    for index, rgba in enumerate(rgba_frames):
        # Integer cycles ensure the procedural background's final sample is
        # identical to its first sample, preserving the repeat seam.
        phase = 2.0 * np.pi * config["cycles"] * (index / denominator)
        if config["style"] == "enchanted-beach":
            background, spell_rgb, spell_alpha = _enchanted_beach_pixels(
                width,
                height,
                phase,
                color_start,
                color_end,
            )
        else:
            blend = (np.sin(2.0 * np.pi * position + phase) + 1.0) * 0.5
            blend = np.clip(0.12 + 0.76 * blend, 0.0, 1.0)[..., None]
            background = (
                color_start[None, None, :] * (1.0 - blend)
                + color_end[None, None, :] * blend
            )
            spell_rgb = np.zeros_like(background)
            spell_alpha = np.zeros((height, width, 1), dtype=np.float32)
        alpha = rgba[..., 3:4].astype(np.float32) / 255.0
        composed_float = (
            rgba[..., :3].astype(np.float32) * alpha
            + background * (1.0 - alpha)
        )
        composed_float = (
            composed_float * (1.0 - spell_alpha)
            + np.maximum(composed_float, spell_rgb) * spell_alpha
        )
        composed = np.rint(composed_float).clip(0, 255).astype(np.uint8)
        Image.fromarray(composed).save(
            composite_directory / f"frame-{index:04d}.png",
            format="PNG",
            compress_level=3,
        )
        if index in (0, frame_count - 1):
            endpoint_frames.append(composed)
    endpoint_mae = float(
        np.mean(
            np.abs(
                endpoint_frames[0].astype(np.int16)
                - endpoint_frames[-1].astype(np.int16)
            )
        )
    )
    destination = output_directory / "output-0001.webm"
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    encoded = subprocess.run(
        [
            ffmpeg,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-framerate",
            str(fps),
            "-i",
            str(composite_directory / "frame-%04d.png"),
            "-an",
            "-c:v",
            "libvpx-vp9",
            "-pix_fmt",
            "yuv420p",
            *_vp9_quality_arguments(encoding_quality, alpha=False),
            str(destination),
        ],
        capture_output=True,
        text=True,
        timeout=15 * 60,
        check=False,
    )
    if encoded.returncode != 0:
        raise WorkerError(
            "Animated-background VP9 encoding failed: "
            + encoded.stderr.strip()[-2_000:]
        )
    if (
        not destination.is_file()
        or destination.stat().st_size == 0
        or destination.read_bytes()[:4] != b"\x1aE\xdf\xa3"
    ):
        raise WorkerError(
            "Animated-background encoder produced an invalid WebM container"
        )
    verified = subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(destination),
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "-",
        ],
        capture_output=True,
        timeout=5 * 60,
        check=False,
    )
    expected_bytes = width * height * 3 * frame_count
    if verified.returncode != 0 or len(verified.stdout) != expected_bytes:
        raise WorkerError(
            "Animated-background WebM did not decode to the expected RGB VP9 frame sequence"
        )
    decoded_frames = np.frombuffer(verified.stdout, dtype=np.uint8).reshape(
        (frame_count, height, width, 3)
    )
    decoded_endpoint_mae = float(
        np.mean(
            np.abs(
                decoded_frames[0].astype(np.int16)
                - decoded_frames[-1].astype(np.int16)
            )
        )
    )
    if loop_mode != "none" and decoded_endpoint_mae > 1.0:
        raise WorkerError(
            "Animated-background WebM introduced an excessive decoded loop seam: "
            f"{decoded_endpoint_mae:.3f} MAE"
        )
    return destination, {
        "index": 1,
        "fileName": destination.name,
        "width": width,
        "height": height,
        "frameCount": frame_count,
        "fps": fps,
        "durationSeconds": frame_count / fps,
        "hasAlpha": False,
        "loopMode": loop_mode,
        "loopEndpointMae": endpoint_mae,
        "decodedFrameCount": frame_count,
        "decodedLoopEndpointMae": decoded_endpoint_mae,
        "encodingQuality": encoding_quality,
        "codec": "vp9",
        "container": "webm",
        "background": {
            "engine": (
                "animated-enchanted-beach-v1"
                if config["style"] == "enchanted-beach"
                else "animated-gradient-v1"
            ),
            **config,
        },
    }


def _encode_video_webm(
    frames: list[Any],
    output_directory: Path,
    fps: int,
    animated_background: dict[str, Any] | None,
    *,
    transparent_background: bool,
    loop_mode: str,
    matte_quality: str,
    encoding_quality: str,
) -> tuple[
    Path,
    dict[str, Any],
    tuple[Path, dict[str, Any]] | None,
]:
    import imageio_ffmpeg
    import numpy as np
    import subprocess

    if not frames:
        raise WorkerError("WAN returned no frames")
    if animated_background is not None and not transparent_background:
        raise WorkerError(
            "animatedBackground requires transparentBackground so the generated "
            "subject can be composited"
        )
    frame_directory = output_directory / "frames"
    frame_directory.mkdir()
    if transparent_background:
        rgba_arrays, matte_evidence = _matte_video_frames(frames, matte_quality)
    else:
        rgba_arrays = []
        for frame in frames:
            rgb = _frame_rgb_array(frame)
            rgba_arrays.append(
                np.concatenate(
                    (
                        rgb,
                        np.full(
                            (*rgb.shape[:2], 1),
                            255,
                            dtype=np.uint8,
                        ),
                    ),
                    axis=2,
                )
            )
        matte_evidence = None
    alpha_minimum = min(int(frame[..., 3].min()) for frame in rgba_arrays)
    alpha_maximum = max(int(frame[..., 3].max()) for frame in rgba_arrays)
    output_frames = _assemble_video_frames(rgba_arrays, loop_mode)
    for index, frame in enumerate(output_frames):
        from PIL import Image

        Image.fromarray(
            frame if transparent_background else frame[..., :3],
        ).save(
            frame_directory / f"frame-{index:04d}.png",
            format="PNG",
            compress_level=3,
        )
    endpoint_mae = float(
        np.mean(
            np.abs(
                output_frames[0].astype(np.int16)
                - output_frames[-1].astype(np.int16)
            )
        )
    )
    destination = output_directory / "output-0000.webm"
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    command = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-framerate",
        str(fps),
        "-i",
        str(frame_directory / "frame-%04d.png"),
        "-an",
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuva420p" if transparent_background else "yuv420p",
        *_vp9_quality_arguments(
            encoding_quality,
            alpha=transparent_background,
        ),
        str(destination),
    ]
    encoded = subprocess.run(
        command, capture_output=True, text=True, timeout=15 * 60, check=False
    )
    if encoded.returncode != 0:
        raise WorkerError(
            "VP9 alpha encoding failed: " + encoded.stderr.strip()[-2_000:]
        )
    if not destination.is_file() or destination.stat().st_size == 0:
        raise WorkerError("VP9 alpha encoder produced no output")
    if destination.read_bytes()[:4] != b"\x1aE\xdf\xa3":
        raise WorkerError("VP9 alpha encoder produced an invalid WebM container")

    # Force libvpx for transparent decode; FFmpeg's native decoder may discard
    # the WebM alpha plane even when the stream metadata is valid.
    verify_command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
    ]
    if transparent_background:
        verify_command.extend(["-c:v", "libvpx-vp9"])
    verify_command.extend(
        [
            "-i",
            str(destination),
            "-pix_fmt",
            "rgba" if transparent_background else "rgb24",
            "-f",
            "rawvideo",
            "-",
        ]
    )
    verified = subprocess.run(
        verify_command,
        capture_output=True,
        timeout=5 * 60,
        check=False,
    )
    channel_count = 4 if transparent_background else 3
    expected_frame_bytes = (
        output_frames[0].shape[0]
        * output_frames[0].shape[1]
        * channel_count
    )
    expected_bytes = expected_frame_bytes * len(output_frames)
    if verified.returncode != 0 or len(verified.stdout) != expected_bytes:
        raise WorkerError(
            "Encoded WebM did not decode to the expected "
            f"{'RGBA' if transparent_background else 'RGB'} VP9 frame sequence"
        )
    decoded_frames = np.frombuffer(verified.stdout, dtype=np.uint8).reshape(
        (
            len(output_frames),
            output_frames[0].shape[0],
            output_frames[0].shape[1],
            channel_count,
        )
    )
    if transparent_background:
        decoded_alpha = decoded_frames[..., 3]
        decoded_alpha_minimum = int(decoded_alpha.min())
        decoded_alpha_maximum = int(decoded_alpha.max())
        if decoded_alpha_minimum == 255 or decoded_alpha_maximum != 255:
            raise WorkerError(
                "Encoded WebM did not retain a usable transparent alpha plane"
            )
    else:
        decoded_alpha = np.full(
            decoded_frames.shape[:3],
            255,
            dtype=np.uint8,
        )
        decoded_alpha_minimum = 255
        decoded_alpha_maximum = 255
    decoded_loop_endpoint_mae = float(
        np.mean(
            np.abs(
                decoded_frames[0].astype(np.int16)
                - decoded_frames[-1].astype(np.int16)
            )
        )
    )
    decoded_alpha_loop_endpoint_mae = (
        float(
            np.mean(
                np.abs(
                    decoded_frames[0, ..., 3].astype(np.int16)
                    - decoded_frames[-1, ..., 3].astype(np.int16)
                )
            )
        )
        if transparent_background
        else 0.0
    )
    if (
        loop_mode != "none"
        and (
            decoded_loop_endpoint_mae > 1.0
            or decoded_alpha_loop_endpoint_mae > 1.0
        )
    ):
        raise WorkerError(
            "Encoded WebM introduced an excessive decoded loop seam: "
            f"{decoded_loop_endpoint_mae:.3f} RGBA MAE, "
            f"{decoded_alpha_loop_endpoint_mae:.3f} alpha MAE"
        )
    evidence = {
        "frameCount": len(output_frames),
        "sourceFrameCount": len(frames),
        "fps": fps,
        "durationSeconds": len(output_frames) / fps,
        "alphaMinimum": alpha_minimum,
        "alphaMaximum": alpha_maximum,
        "decodedAlphaMinimum": decoded_alpha_minimum,
        "decodedAlphaMaximum": decoded_alpha_maximum,
        "decodedFrameCount": len(decoded_frames),
        "decodedLoopEndpointMae": decoded_loop_endpoint_mae,
        "decodedAlphaLoopEndpointMae": decoded_alpha_loop_endpoint_mae,
        "loopMode": loop_mode,
        "loopEndpointMae": endpoint_mae,
        "hasAlpha": transparent_background,
        "matte": matte_evidence,
        "encodingQuality": encoding_quality,
        "codec": "vp9",
        "container": "webm",
    }
    composite = (
        _encode_animated_composite(
            output_frames,
            output_directory,
            fps,
            animated_background,
            loop_mode,
            encoding_quality,
        )
        if animated_background is not None
        else None
    )
    return destination, evidence, composite


def _prepare_video_conditioning_frame(
    path: Path,
    width: int,
    height: int,
    transparent_background: bool,
) -> tuple[Any, dict[str, Any]]:
    """Frame a detected subject without stretching or blind aspect cropping."""
    import numpy as np
    from PIL import Image, ImageOps

    with Image.open(path) as opened:
        rgba = opened.convert("RGBA")
        rgba_pixels = np.asarray(rgba, dtype=np.uint8)
    source_height, source_width = rgba_pixels.shape[:2]
    original_alpha = rgba_pixels[..., 3]
    alpha_is_usable = bool(
        int(original_alpha.min()) < 250
        and int(original_alpha.max()) == 255
    )
    detected_plate = False
    if alpha_is_usable:
        plate_color = (
            np.asarray((0, 255, 0), dtype=np.uint8)
            if transparent_background
            else np.asarray((18, 20, 26), dtype=np.uint8)
        )
        alpha, _ = _cleanup_alpha_components(original_alpha)
    elif transparent_background:
        rgb = rgba_pixels[..., :3]
        key_color, keyed_border_ratio, transparent_threshold = _frame_green_key(rgb)
        detected_plate = keyed_border_ratio >= 0.80
        if detected_plate:
            plate_color = np.rint(np.clip(key_color, 0, 255)).astype(np.uint8)
            raw_alpha = _green_screen_alpha(
                rgb,
                opaque_dominance=18.0,
                transparent_dominance=transparent_threshold,
            )
            alpha, _ = _cleanup_alpha_components(
                _spatially_refine_alpha(raw_alpha, 0.55)
            )
        else:
            plate_color = np.asarray((18, 20, 26), dtype=np.uint8)
            alpha = np.full((source_height, source_width), 255, dtype=np.uint8)
    else:
        border_width = max(1, round(min(source_width, source_height) * 0.025))
        border = np.concatenate(
            (
                rgba_pixels[:border_width, :, :3].reshape(-1, 3),
                rgba_pixels[-border_width:, :, :3].reshape(-1, 3),
                rgba_pixels[:, :border_width, :3].reshape(-1, 3),
                rgba_pixels[:, -border_width:, :3].reshape(-1, 3),
            ),
            axis=0,
        )
        plate_color = np.median(border, axis=0).astype(np.uint8)
        alpha = np.full((source_height, source_width), 255, dtype=np.uint8)

    background = Image.new(
        "RGBA",
        (source_width, source_height),
        (*[int(value) for value in plate_color], 255),
    )
    composite = Image.alpha_composite(
        background,
        Image.fromarray(rgba_pixels),
    ).convert("RGB")
    detected_components = _binary_run_components(alpha >= 8)
    primary_component = (
        max(detected_components, key=lambda component: component["area"])
        if detected_components
        else None
    )
    subject_detected = bool(
        (alpha_is_usable or detected_plate)
        and primary_component is not None
    )
    if not subject_detected:
        contained = ImageOps.contain(
            composite,
            (width, height),
            method=Image.Resampling.LANCZOS,
        )
        target = Image.new(
            "RGB",
            (width, height),
            tuple(int(value) for value in plate_color),
        )
        paste_x = (width - contained.width) // 2
        paste_y = (height - contained.height) // 2
        target.paste(contained, (paste_x, paste_y))
        return target, {
            "mode": "background-pad",
            "sourceWidth": source_width,
            "sourceHeight": source_height,
            "targetWidth": width,
            "targetHeight": height,
            "subjectDetected": False,
            "placedWidth": contained.width,
            "placedHeight": contained.height,
            "leftMargin": paste_x,
            "rightMargin": width - contained.width - paste_x,
            "topMargin": paste_y,
            "bottomMargin": height - contained.height - paste_y,
            "stretched": False,
            "croppedSubject": False,
        }

    assert primary_component is not None
    minimum_x, minimum_y, maximum_x, maximum_y = [
        int(value) for value in primary_component["box"]
    ]
    subject_width = maximum_x - minimum_x + 1
    subject_height = maximum_y - minimum_y + 1
    crop_padding = max(4, round(max(subject_width, subject_height) * 0.04))
    crop_left = max(0, minimum_x - crop_padding)
    crop_top = max(0, minimum_y - crop_padding)
    crop_right = min(source_width, maximum_x + crop_padding + 1)
    crop_bottom = min(source_height, maximum_y + crop_padding + 1)
    primary_alpha = np.zeros_like(alpha)
    for y, start, end in primary_component["runs"]:
        primary_alpha[y, start : end + 1] = alpha[y, start : end + 1]
    cleaned_rgb = _decontaminate_green_edges(
        rgba_pixels[..., :3],
        primary_alpha,
        plate_color,
        4,
    )
    subject_rgba = np.concatenate(
        (cleaned_rgb, primary_alpha[..., None]),
        axis=2,
    )
    cropped = Image.fromarray(subject_rgba).crop(
        (crop_left, crop_top, crop_right, crop_bottom)
    )
    safe_width = max(16, round(width * 0.88))
    safe_height = max(16, round(height * 0.88))
    contained = ImageOps.contain(
        cropped,
        (safe_width, safe_height),
        method=Image.Resampling.LANCZOS,
    )
    target = Image.new(
        "RGBA",
        (width, height),
        (*[int(value) for value in plate_color], 255),
    )
    paste_x = (width - contained.width) // 2
    paste_y = (height - contained.height) // 2
    target.alpha_composite(contained, (paste_x, paste_y))
    return target.convert("RGB"), {
        "mode": "subject-aware-fit",
        "sourceWidth": source_width,
        "sourceHeight": source_height,
        "targetWidth": width,
        "targetHeight": height,
        "subjectDetected": True,
        "sourceHadAlpha": alpha_is_usable,
        "chromaPlateDetected": detected_plate,
        "detectedComponentCount": len(detected_components),
        "primaryComponentPixels": int(primary_component["area"]),
        "plateDebrisExcluded": True,
        "subjectBounds": {
            "left": minimum_x,
            "top": minimum_y,
            "right": maximum_x,
            "bottom": maximum_y,
        },
        "cropBounds": {
            "left": crop_left,
            "top": crop_top,
            "right": crop_right,
            "bottom": crop_bottom,
        },
        "placedWidth": contained.width,
        "placedHeight": contained.height,
        "leftMargin": paste_x,
        "topMargin": paste_y,
        "rightMargin": width - paste_x - contained.width,
        "bottomMargin": height - paste_y - contained.height,
        "stretched": False,
        "croppedSubject": False,
    }


def _start_video_memory_observation(torch: Any, device: str) -> dict[str, Any]:
    evidence: dict[str, Any] = {
        "processIsolation": "one-generation-per-process",
        "initialDeviceFreeBytes": None,
        "initialDeviceTotalBytes": None,
        "peakAllocatedBytes": None,
        "peakReservedBytes": None,
        "postReleaseAllocatedBytes": None,
        "postReleaseReservedBytes": None,
        "postReleaseDeviceFreeBytes": None,
    }
    if device != "cuda":
        return evidence
    torch.cuda.synchronize()
    free_bytes, total_bytes = torch.cuda.mem_get_info()
    torch.cuda.reset_peak_memory_stats()
    evidence["initialDeviceFreeBytes"] = int(free_bytes)
    evidence["initialDeviceTotalBytes"] = int(total_bytes)
    return evidence


def _finish_video_memory_observation(
    torch: Any,
    device: str,
    evidence: dict[str, Any],
) -> dict[str, Any]:
    if device != "cuda":
        return evidence
    torch.cuda.synchronize()
    evidence["peakAllocatedBytes"] = int(torch.cuda.max_memory_allocated())
    evidence["peakReservedBytes"] = int(torch.cuda.max_memory_reserved())
    evidence["postReleaseAllocatedBytes"] = int(torch.cuda.memory_allocated())
    evidence["postReleaseReservedBytes"] = int(torch.cuda.memory_reserved())
    free_bytes, _ = torch.cuda.mem_get_info()
    evidence["postReleaseDeviceFreeBytes"] = int(free_bytes)
    return evidence


def generate_video(request: dict[str, Any]) -> dict[str, Any]:
    started_at = time.perf_counter()
    if request.get("schemaVersion") != SCHEMA_VERSION:
        raise WorkerError("Unsupported worker request schema")
    torch, diffusers = _runtime()
    model = request.get("model")
    if not isinstance(model, dict):
        raise WorkerError("model is required")
    architecture = _required_text(model, "architecture", 64)
    if architecture not in (
        "framepack-i2v",
        "hunyuan-video-1.5-i2v",
        "ltx-video",
        "wan-2.2-ti2v",
    ):
        raise WorkerError(
            "The local video adapter supports FramePack, HunyuanVideo 1.5, "
            "LTX-Video, and Wan2.2 TI2V packages"
        )
    if (
        architecture == "wan-2.2-ti2v"
        and request.get("experimentalLowMemory") is not True
    ):
        raise WorkerError(
            "Wan2.2 TI2V requires the explicit experimentalLowMemory profile on this adapter"
        )
    prompt = _required_text(request, "prompt", 8_000)
    first_frame_path = _absolute_existing_path(
        request.get("firstFramePath"), file=True
    )
    last_frame_path = _absolute_existing_path(
        request.get("lastFramePath"), file=True
    )
    if first_frame_path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
        raise WorkerError("firstFramePath must be a supported image")
    if last_frame_path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
        raise WorkerError("lastFramePath must be a supported image")
    output_directory = _fresh_output_directory(request.get("outputDirectory"))
    animated_background = _animated_background_config(
        request.get("animatedBackground")
    )
    aspect_ratio = request.get("aspectRatio")
    resolution = request.get("resolution", "preview-512")
    if not isinstance(resolution, str):
        raise WorkerError("resolution must be a string")
    width, height = _video_dimensions(aspect_ratio, resolution, architecture)
    num_frames = request.get("numFrames")
    if architecture == "ltx-video":
        if (
            not isinstance(num_frames, int)
            or isinstance(num_frames, bool)
            or not 9 <= num_frames <= 257
            or (num_frames - 1) % 8 != 0
        ):
            raise WorkerError(
                "LTX-Video numFrames must be from 9 through 257 in the required 8k+1 form"
            )
    else:
        maximum_frames = 129 if architecture == "framepack-i2v" else 121
        if (
            not isinstance(num_frames, int)
            or isinstance(num_frames, bool)
            or not 17 <= num_frames <= maximum_frames
            or (num_frames - 1) % 4 != 0
        ):
            raise WorkerError(
                f"{'FramePack' if architecture == 'framepack-i2v' else 'HunyuanVideo 1.5' if architecture == 'hunyuan-video-1.5-i2v' else 'Wan'} "
                f"numFrames must be from 17 through {maximum_frames} in the required 4k+1 form"
            )
    steps = request.get("numInferenceSteps")
    if (
        not isinstance(steps, int)
        or isinstance(steps, bool)
        or not 4 <= steps <= (10 if architecture == "ltx-video" else 50)
    ):
        raise WorkerError(
            "numInferenceSteps must be between 4 and "
            + ("10" if architecture == "ltx-video" else "50")
        )
    fps = request.get("fps")
    if (
        not isinstance(fps, int)
        or isinstance(fps, bool)
        or not 1 <= fps <= 60
    ):
        raise WorkerError("fps must be between 1 and 60")
    loop_mode = request.get("loopMode", "ping-pong")
    if loop_mode not in ("none", "ping-pong", "seamless"):
        raise WorkerError("loopMode must be none, ping-pong, or seamless")
    transparent_background = request.get("transparentBackground", True)
    if not isinstance(transparent_background, bool):
        raise WorkerError("transparentBackground must be boolean")
    matte_quality = request.get("matteQuality", "production")
    if not isinstance(matte_quality, str):
        raise WorkerError("matteQuality must be a string")
    encoding_quality = request.get("encodingQuality", "lossless")
    if not isinstance(encoding_quality, str):
        raise WorkerError("encodingQuality must be a string")
    guidance_scale = request.get("guidanceScale", 5.0)
    if (
        not isinstance(guidance_scale, (int, float))
        or isinstance(guidance_scale, bool)
        or not math.isfinite(float(guidance_scale))
        or not 1.0 <= float(guidance_scale) <= 10.0
    ):
        raise WorkerError("guidanceScale must be between 1 and 10")
    seed = request.get("seed")
    if not isinstance(seed, int) or not 0 <= seed < 2**63:
        raise WorkerError("seed is invalid")
    device, device_label, device_memory = _device(torch)
    # Display drivers reserve a small portion of VRAM, so nominal 16 GB
    # adapters report just under 16 GiB usable to Torch.
    if (
        architecture == "wan-2.2-ti2v"
        and device_memory is not None
        and device_memory < MIN_EXPERIMENTAL_VIDEO_MEMORY_BYTES
    ):
        raise WorkerError(
            "The bounded Wan preview profile requires a nominal 16 GB adapter "
            "(at least 15 GiB reported usable)"
        )
    if (
        architecture == "hunyuan-video-1.5-i2v"
        and (
            device == "cpu"
            or device_memory is None
            or device_memory < HUNYUAN_VIDEO_15_MIN_MEMORY_BYTES
        )
    ):
        raise WorkerError(
            "HunyuanVideo 1.5 I2V requires a bfloat16 GPU with at least "
            "14 GiB of usable memory"
        )
    if (
        architecture == "wan-2.2-ti2v"
        and device_memory is not None
        and device_memory < 23 * 1024**3
        and num_frames > 33
    ):
        raise WorkerError(
            "Adapters below 24 GiB are bounded to at most 33 WAN source frames; "
            "use frame interpolation for a higher delivery rate"
        )

    source, first_frame_framing = _prepare_video_conditioning_frame(
        first_frame_path,
        width,
        height,
        transparent_background,
    )
    last_source, last_frame_framing = _prepare_video_conditioning_frame(
        last_frame_path,
        width,
        height,
        transparent_background,
    )
    same_endpoint = _sha256_file(first_frame_path) == _sha256_file(last_frame_path)
    if architecture == "hunyuan-video-1.5-i2v" and not same_endpoint:
        raise WorkerError(
            "HunyuanVideo 1.5 supports one native first-frame reference; "
            "use FramePack or LTX-Video for distinct first and last references"
        )
    if loop_mode == "seamless" and not same_endpoint:
        raise WorkerError(
            "seamless loopMode requires the same first and last source asset; "
            "use none for an intentionally changing shot or ping-pong for reversal"
        )
    memory_evidence = _start_video_memory_observation(torch, device)
    conv3d_backend = _configure_video_conv3d_backend(torch, device)
    requested_negative_prompt = request.get("negativePrompt")
    if requested_negative_prompt is not None and (
        not isinstance(requested_negative_prompt, str)
        or len(requested_negative_prompt) > 8_000
    ):
        raise WorkerError("negativePrompt must be a string up to 8000 characters")
    default_negative_prompt = (
        "static, motionless, frozen pose, still picture, idle pose, mannequin, "
        "camera shake, unintended camera movement, zoom, pan, scene cut, "
        "background-only motion, changing identity, changing costume, changing "
        "face, changing prop, low resolution, blur, motion smear, texture crawl, "
        "flicker, temporal discontinuity, compression artifacts, subtitles, "
        "watermark, duplicate character, extra limbs, missing limbs, deformed "
        "hands, fused fingers, extra fingers, poorly drawn face, malformed anatomy"
    )
    negative_prompt = (
        requested_negative_prompt.strip()
        if isinstance(requested_negative_prompt, str)
        and requested_negative_prompt.strip()
        else default_negative_prompt
    )
    endpoint_restoration = None
    loop_endpoint_restoration = None
    pipeline = None
    result = None
    generator = None
    prompt_embeddings = None
    pooled_prompt_embeddings = None
    prompt_attention_mask = None
    negative_prompt_embeddings = None
    model_load_started_at = time.perf_counter()
    if architecture == "hunyuan-video-1.5-i2v":
        effective_hunyuan_steps = 8 if steps <= 8 else 12
        target_size = {
            "preview-512": 512,
            "quality-640": 640,
            "quality-768": 768,
        }[resolution]
        hunyuan_latents, performance, denoiser_timing = (
            _generate_hunyuan_video_15_latents(
                model,
                prompt,
                first_frame_path,
                width,
                height,
                target_size,
                num_frames,
                effective_hunyuan_steps,
                seed,
                transparent_background,
                request.get("memoryProfile"),
            )
        )
        model_ready_at = model_load_started_at + float(
            denoiser_timing["modelLoadAndPrompt"]
        )
        torch.cuda.synchronize()
        performance["postDenoiserReleaseAllocatedBytes"] = int(
            torch.cuda.memory_allocated()
        )
        performance["postDenoiserReleaseReservedBytes"] = int(
            torch.cuda.memory_reserved()
        )
        post_denoiser_free, _ = torch.cuda.mem_get_info()
        performance["postDenoiserProcessExitDeviceFreeBytes"] = int(
            post_denoiser_free
        )
        model_path = _absolute_existing_path(model.get("path"), file=False)
        vae, video_processor, vae_tiles = _load_hunyuan_video_15_vae(
            diffusers,
            torch,
            model_path,
            device_memory,
        )
        performance["vaeTileConfiguration"] = vae_tiles
        generated_frames = _decode_hunyuan_video_15(
            torch,
            vae,
            video_processor,
            hunyuan_latents,
            torch.device(f"cuda:{torch.cuda.current_device()}"),
        )
        if len(generated_frames) != num_frames:
            raise WorkerError(
                "HunyuanVideo 1.5 decoded a different frame count than requested"
            )
        vae.to("cpu")
        torch.cuda.empty_cache()
        del hunyuan_latents, vae
        conditioning_mode = "hunyuan-video-1.5-native-first-frame"
        effective_guidance_scale = 1.0
        effective_steps = effective_hunyuan_steps
        negative_prompt_applied = False
    elif architecture == "framepack-i2v":
        framepack_latents, performance, denoiser_timing = _generate_framepack_latents(
            torch,
            model,
            prompt,
            first_frame_path,
            last_frame_path,
            width,
            height,
            num_frames,
            steps,
            float(guidance_scale),
            seed,
            transparent_background,
            request.get("memoryProfile"),
        )
        model_ready_at = model_load_started_at + float(
            denoiser_timing["modelLoadAndPrompt"]
        )
        torch.cuda.synchronize()
        performance["postDenoiserReleaseAllocatedBytes"] = int(
            torch.cuda.memory_allocated()
        )
        performance["postDenoiserReleaseReservedBytes"] = int(
            torch.cuda.memory_reserved()
        )
        post_denoiser_free, _ = torch.cuda.mem_get_info()
        performance["postDenoiserProcessExitDeviceFreeBytes"] = int(
            post_denoiser_free
        )
        model_path = _absolute_existing_path(model.get("path"), file=False)
        vae, video_processor, vae_tiles = _load_framepack_vae(
            diffusers,
            torch,
            model_path,
            device_memory,
        )
        performance["vaeTileConfiguration"] = vae_tiles
        generated_frames = _decode_framepack_video(
            torch,
            vae,
            video_processor,
            framepack_latents,
            torch.device(f"cuda:{torch.cuda.current_device()}"),
        )
        decoded_section_frame_count = len(generated_frames)
        generated_frames = _framepack_requested_frames(
            generated_frames,
            num_frames,
        )
        performance["temporalSelection"] = {
            "engine": "framepack-full-section-nearest-v1",
            "decodedSectionFrameCount": decoded_section_frame_count,
            "selectedFrameCount": len(generated_frames),
            "preservesFirstFrame": True,
            "preservesLastFrame": True,
            "synthesizesFrames": False,
        }
        vae.to("cpu")
        torch.cuda.empty_cache()
        del framepack_latents, vae
        conditioning_mode = "framepack-inverted-anti-drifting-first-last"
        effective_guidance_scale = float(guidance_scale)
        effective_steps = steps
        negative_prompt_applied = False
    elif architecture == "ltx-video":
        pipeline, prompt_embeddings, prompt_attention_mask, performance = (
            _load_ltx_video_pipeline(
                diffusers,
                torch,
                model,
                prompt,
                request.get("memoryProfile"),
            )
        )
        from diffusers.pipelines.ltx.pipeline_ltx_condition import (
            LTXVideoCondition,
        )

        execution_device = torch.device(
            f"cuda:{torch.cuda.current_device()}" if device == "cuda" else device
        )
        prompt_embeddings = prompt_embeddings.to(execution_device)
        prompt_attention_mask = prompt_attention_mask.to(execution_device)
        generator = torch.Generator(device=execution_device).manual_seed(seed)
        model_ready_at = time.perf_counter()
        conditions = [
            LTXVideoCondition(
                image=source,
                frame_index=0,
                strength=1.0,
            ),
            LTXVideoCondition(
                image=last_source,
                frame_index=num_frames - 1,
                strength=1.0,
            ),
        ]
        multiscale = (
            performance["variant"].startswith("13b")
            and resolution in ("quality-640", "quality-768")
        )
        if multiscale:
            from diffusers.pipelines.ltx.modeling_latent_upsampler import (
                LTXLatentUpsamplerModel,
            )

            first_width, first_height, refined_width, refined_height = (
                _ltx_multiscale_dimensions(width, height)
            )
            first_pass = pipeline(
                conditions=conditions,
                prompt=None,
                negative_prompt=None,
                prompt_embeds=prompt_embeddings,
                prompt_attention_mask=prompt_attention_mask,
                width=first_width,
                height=first_height,
                num_frames=num_frames,
                frame_rate=fps,
                timesteps=list(LTX_DISTILLED_TIMESTEPS),
                guidance_scale=1.0,
                guidance_rescale=0.7,
                image_cond_noise_scale=0.0,
                generator=generator,
                output_type="latent",
            )
            upsampler = LTXLatentUpsamplerModel.from_pretrained(
                str(_absolute_existing_path(model.get("path"), file=False)),
                subfolder="spatial_upscaler/latent_upsampler",
                torch_dtype=(
                    torch.bfloat16 if device == "cuda" else torch.float32
                ),
                local_files_only=True,
                use_safetensors=True,
            )
            upsampler.to(execution_device)
            upsample_pipeline = diffusers.LTXLatentUpsamplePipeline(
                vae=pipeline.vae,
                latent_upsampler=upsampler,
            )
            upscaled_latents = upsample_pipeline(
                latents=first_pass.frames,
                adain_factor=1.0,
                tone_map_compression_ratio=0.6,
                output_type="latent",
            ).frames
            del first_pass, upsample_pipeline, upsampler
            gc.collect()
            if device == "cuda":
                torch.cuda.empty_cache()
            result = pipeline(
                conditions=conditions,
                prompt=None,
                negative_prompt=None,
                prompt_embeds=prompt_embeddings,
                prompt_attention_mask=prompt_attention_mask,
                width=refined_width,
                height=refined_height,
                num_frames=num_frames,
                frame_rate=fps,
                denoise_strength=0.999,
                timesteps=list(LTX_REFINEMENT_TIMESTEPS),
                latents=upscaled_latents,
                guidance_scale=1.0,
                guidance_rescale=0.7,
                image_cond_noise_scale=0.0,
                decode_timestep=0.05,
                decode_noise_scale=0.025,
                generator=generator,
            )
            generated_frames = [
                frame.resize((width, height), resample=Image.Resampling.LANCZOS)
                for frame in result.frames[0]
            ]
            performance["renderStrategy"] = "official-multiscale-latent-refinement"
            performance["firstPass"] = {
                "width": first_width,
                "height": first_height,
                "timesteps": list(LTX_DISTILLED_TIMESTEPS),
            }
            performance["refinementPass"] = {
                "width": refined_width,
                "height": refined_height,
                "timesteps": list(LTX_REFINEMENT_TIMESTEPS),
                "downsampledWidth": width,
                "downsampledHeight": height,
            }
            conditioning_mode = "ltx-native-first-last-keyframes-multiscale"
        else:
            result = pipeline(
                conditions=conditions,
                prompt=None,
                negative_prompt=None,
                prompt_embeds=prompt_embeddings,
                prompt_attention_mask=prompt_attention_mask,
                width=width,
                height=height,
                num_frames=num_frames,
                frame_rate=fps,
                timesteps=list(LTX_DISTILLED_TIMESTEPS),
                guidance_scale=1.0,
                guidance_rescale=0.7,
                image_cond_noise_scale=0.0,
                decode_timestep=0.05,
                decode_noise_scale=0.025,
                generator=generator,
            )
            generated_frames = list(result.frames[0])
            performance["renderStrategy"] = "distilled-single-pass"
            conditioning_mode = "ltx-native-first-last-keyframes"
        effective_guidance_scale = 1.0
        effective_steps = len(LTX_DISTILLED_TIMESTEPS)
        negative_prompt_applied = False
    else:
        pipeline, prompt_embeddings, negative_prompt_embeddings = _load_video_pipeline(
            diffusers,
            torch,
            model,
            prompt,
            negative_prompt,
            request.get("memoryProfile"),
        )
        cuda_device = torch.device(f"cuda:{torch.cuda.current_device()}")
        prompt_embeddings = prompt_embeddings.to(cuda_device)
        negative_prompt_embeddings = negative_prompt_embeddings.to(cuda_device)
        generator = torch.Generator(
            device=f"cuda:{torch.cuda.current_device()}"
        ).manual_seed(seed)
        model_ready_at = time.perf_counter()
        result = pipeline(
            image=source,
            last_image=last_source,
            prompt=None,
            negative_prompt=None,
            prompt_embeds=prompt_embeddings,
            negative_prompt_embeds=negative_prompt_embeddings,
            width=width,
            height=height,
            num_frames=num_frames,
            num_inference_steps=steps,
            guidance_scale=float(guidance_scale),
            generator=generator,
        )
        performance = pipeline._machdoch_wan_performance  # noqa: SLF001
        conditioning_mode = pipeline._machdoch_wan_conditioning_mode  # noqa: SLF001
        effective_guidance_scale = float(guidance_scale)
        effective_steps = steps
        negative_prompt_applied = True
        generated_frames = list(result.frames[0])
    generated_at = time.perf_counter()
    if not generated_frames:
        raise WorkerError("Video pipeline returned no video frames")
    if architecture == "wan-2.2-ti2v" and not same_endpoint:
        generated_frames, endpoint_restoration = _restore_wan_endpoint_colors(
            generated_frames,
            last_source,
        )
    elif architecture == "wan-2.2-ti2v" and loop_mode == "seamless":
        generated_frames, loop_endpoint_restoration = _restore_wan_seam_endpoints(
            generated_frames,
            source,
        )
    destination, evidence, composite = _encode_video_webm(
        generated_frames,
        output_directory,
        fps,
        animated_background,
        transparent_background=transparent_background,
        loop_mode=loop_mode,
        matte_quality=matte_quality,
        encoding_quality=encoding_quality,
    )
    encoded_at = time.perf_counter()
    del result, pipeline, generator, prompt_embeddings
    if pooled_prompt_embeddings is not None:
        del pooled_prompt_embeddings
    if prompt_attention_mask is not None:
        del prompt_attention_mask
    if negative_prompt_embeddings is not None:
        del negative_prompt_embeddings
    gc.collect()
    if device == "cuda":
        torch.cuda.empty_cache()
    memory_evidence = _finish_video_memory_observation(
        torch,
        device,
        memory_evidence,
    )
    denoiser_memory = performance.get("denoiserGpuMemory")
    prompt_encoder_memory = performance.get("promptEncoderGpuMemory")
    if device == "cuda":
        stage_peaks = {
            "vaeAndPostprocess": memory_evidence.get("peakAllocatedBytes"),
        }
        if isinstance(prompt_encoder_memory, dict):
            stage_peaks["promptEncoder"] = prompt_encoder_memory.get(
                "peakAllocatedBytes"
            )
        if isinstance(denoiser_memory, dict):
            stage_peaks["denoiser"] = denoiser_memory.get("peakAllocatedBytes")
        measured_peaks = [
            peak for peak in stage_peaks.values() if isinstance(peak, int)
        ]
        if measured_peaks:
            memory_evidence["stagePeakAllocatedBytes"] = stage_peaks
            memory_evidence["peakAllocatedBytes"] = max(measured_peaks)
        if architecture in ("framepack-i2v", "hunyuan-video-1.5-i2v"):
            memory_evidence["componentIsolation"] = performance.get(
                "componentIsolation"
            )
        elif isinstance(prompt_encoder_memory, dict):
            memory_evidence["componentIsolation"] = "prompt-encoder-subprocess"
    finished_at = time.perf_counter()
    performance = {
        **performance,
        "gpuMemory": memory_evidence,
        "timingSeconds": {
            "setupAndConditioning": round(model_load_started_at - started_at, 3),
            "modelLoadAndPrompt": round(model_ready_at - model_load_started_at, 3),
            "denoiseAndDecode": round(generated_at - model_ready_at, 3),
            "postprocessAndEncode": round(encoded_at - generated_at, 3),
            "release": round(finished_at - encoded_at, 3),
            "total": round(finished_at - started_at, 3),
        },
    }
    response = {
        "schemaVersion": SCHEMA_VERSION,
        "workerVersion": WORKER_VERSION,
        "packages": _package_versions(),
        "device": device,
        "deviceLabel": device_label,
        "deviceMemoryBytes": device_memory,
        "architecture": architecture,
        "performance": performance,
        "conv3dBackend": conv3d_backend,
        "conditioningMode": conditioning_mode,
        "conditioningFraming": {
            "firstFrame": first_frame_framing,
            "lastFrame": last_frame_framing,
        },
        "endpointRestoration": endpoint_restoration,
        "loopEndpointRestoration": loop_endpoint_restoration,
        "prompt": prompt,
        "negativePrompt": negative_prompt,
        "negativePromptApplied": negative_prompt_applied,
        "resolution": resolution,
        "requestedGuidanceScale": float(guidance_scale),
        "guidanceScale": effective_guidance_scale,
        "requestedNumInferenceSteps": steps,
        "numInferenceSteps": effective_steps,
        "transparentBackground": transparent_background,
        "modelRevision": _required_text(model, "revision", 128),
        "modelDigest": _required_text(model, "digest", 160),
        "output": {
            "index": 0,
            "fileName": destination.name,
            "seed": seed,
            "width": width,
            "height": height,
            **evidence,
        },
    }
    if composite is not None:
        _, composite_evidence = composite
        response["compositeOutput"] = {
            "seed": seed,
            **composite_evidence,
        }
    return response


def _emit(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":"), ensure_ascii=False))
    sys.stdout.flush()


def main() -> int:
    command = sys.argv[1] if len(sys.argv) == 2 else ""
    try:
        if command == "probe":
            _emit(probe())
            return 0
        if command == "probe-model":
            request = json.load(sys.stdin)
            if not isinstance(request, dict):
                raise WorkerError("Worker request must be a JSON object")
            _emit(probe_model(request))
            return 0
        if command == "generate":
            request = json.load(sys.stdin)
            if not isinstance(request, dict):
                raise WorkerError("Worker request must be a JSON object")
            _emit(generate(request))
            return 0
        if command == "generate-video":
            request = json.load(sys.stdin)
            if not isinstance(request, dict):
                raise WorkerError("Worker request must be a JSON object")
            _emit(generate_video(request))
            return 0
        if command == "_encode-framepack-prompt":
            request = json.load(sys.stdin)
            if not isinstance(request, dict):
                raise WorkerError("Worker request must be a JSON object")
            _emit(_encode_framepack_prompt_subprocess(request))
            return 0
        if command == "_generate-framepack-latents":
            request = json.load(sys.stdin)
            if not isinstance(request, dict):
                raise WorkerError("Worker request must be a JSON object")
            _emit(_generate_framepack_latents_subprocess(request))
            return 0
        if command == "_encode-hunyuan-video-1.5-prompt":
            request = json.load(sys.stdin)
            if not isinstance(request, dict):
                raise WorkerError("Worker request must be a JSON object")
            _emit(_encode_hunyuan_video_15_prompt_subprocess(request))
            return 0
        if command == "_generate-hunyuan-video-1.5-latents":
            request = json.load(sys.stdin)
            if not isinstance(request, dict):
                raise WorkerError("Worker request must be a JSON object")
            _emit(_generate_hunyuan_video_15_latents_subprocess(request))
            return 0
        raise WorkerError(
            "Expected exactly one command: probe, probe-model, generate, or generate-video"
        )
    except WorkerError as error:
        _emit(
            {
                "schemaVersion": SCHEMA_VERSION,
                "workerVersion": WORKER_VERSION,
                "error": str(error),
            }
        )
        return 2
    except Exception as error:  # keep internals on stderr, bounded message on stdout
        traceback.print_exc(file=sys.stderr)
        _emit(
            {
                "schemaVersion": SCHEMA_VERSION,
                "workerVersion": WORKER_VERSION,
                "error": f"Local Diffusers worker failed: {type(error).__name__}: {error}",
            }
        )
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
