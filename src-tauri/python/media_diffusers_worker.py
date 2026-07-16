"""Isolated local Diffusers image worker for Media Studio.

The desktop process passes only absolute, application-owned paths. Hub access and
remote code are disabled before importing ML libraries. The worker emits exactly
one bounded JSON document on stdout and writes image payloads to a fresh staging
directory selected by the desktop process.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import inspect
import json
import math
import os
from pathlib import Path
import platform
import sys
import traceback
from typing import Any

WORKER_VERSION = "media-diffusers-worker/1.3.0"
SCHEMA_VERSION = 4
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
)
REQUIRED_PACKAGES = (
    "torch",
    "diffusers",
    "transformers",
    "accelerate",
    "peft",
    "safetensors",
    "Pillow",
)
EXPECTED_PACKAGE_VERSIONS = {
    "torch": "2.13.0",
    "diffusers": "0.39.0",
    "transformers": "5.13.0",
    "accelerate": "1.14.0",
    "peft": "0.19.1",
    "safetensors": "0.8.0",
    "pillow": "12.3.0",
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


def _device(torch: Any) -> tuple[str, str, int | None]:
    if torch.cuda.is_available():
        index = torch.cuda.current_device()
        memory = int(torch.cuda.get_device_properties(index).total_memory)
        return "cuda", str(torch.cuda.get_device_name(index)), memory
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps", "Apple Metal Performance Shaders", None
    return "cpu", platform.processor() or platform.machine(), None


def probe() -> dict[str, Any]:
    versions = _package_versions()
    missing = [name for name, version in versions.items() if version is None]
    mismatched = [
        f"{name}={version} (expected {EXPECTED_PACKAGE_VERSIONS[name]})"
        for name, version in versions.items()
        if version is not None and version != EXPECTED_PACKAGE_VERSIONS[name]
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
            "architectures": list(SUPPORTED_ARCHITECTURES),
            "capabilities": ["lora", "textual-inversion", "multi-lora"],
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
            "architectures": list(SUPPORTED_ARCHITECTURES),
            "capabilities": ["lora", "textual-inversion", "multi-lora"],
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
        "architectures": list(SUPPORTED_ARCHITECTURES),
        "capabilities": ["lora", "textual-inversion", "multi-lora"],
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
    if package_kind == "diffusers-directory":
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

    if device == "cuda" and hasattr(pipeline, "enable_model_cpu_offload"):
        pipeline.enable_model_cpu_offload()
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
    pipeline = _load_pipeline(diffusers, torch, model)
    architecture = _required_text(model, "architecture", 64)
    required_methods = ["load_lora_weights", "set_adapters", "get_list_adapters"]
    if architecture in (
        "stable-diffusion-1",
        "stable-diffusion-2",
        "stable-diffusion-xl",
        "flux-1",
    ):
        required_methods.append("load_textual_inversion")
    missing_methods = [name for name in required_methods if not hasattr(pipeline, name)]
    if missing_methods:
        raise WorkerError(
            "Loaded pipeline is missing required add-on methods: "
            + ", ".join(missing_methods)
        )
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
    device, device_label, device_memory = _device(torch)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "workerVersion": WORKER_VERSION,
        "packages": _package_versions(),
        "ready": True,
        "architecture": architecture,
        "pipelineClass": type(pipeline).__name__,
        "components": component_names[:64],
        "capabilities": [
            "lora",
            "multi-lora",
            *(["textual-inversion"] if hasattr(pipeline, "load_textual_inversion") else []),
        ],
        "device": device,
        "deviceLabel": device_label,
        "deviceMemoryBytes": device_memory,
        "diagnostic": f"{type(pipeline).__name__} loaded successfully with offline components.",
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


def _dimensions(architecture: str, aspect_ratio: str) -> tuple[int, int]:
    small = architecture in ("stable-diffusion-1", "stable-diffusion-2")
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
        return {"fast": 4, "balanced": 6, "quality": 8}[policy]
    return {"fast": 16, "balanced": 24, "quality": 32}[policy]


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
    width, height = _dimensions(architecture, request.get("aspectRatio"))
    output_directory = _fresh_output_directory(request.get("outputDirectory"))
    addons = request.get("addons", [])
    if not isinstance(addons, list) or len(addons) > 24:
        raise WorkerError("addons is invalid")

    pipeline = _load_pipeline(diffusers, torch, model)
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
    device, device_label, device_memory = _device(torch)
    call_parameters = inspect.signature(pipeline.__call__).parameters
    step_count = _steps(architecture, policy)
    has_lora_schedule = any(schedule is not None for schedule in lora_schedules)
    if has_lora_schedule and "callback_on_step_end" not in call_parameters:
        raise WorkerError(
            "The selected pipeline cannot change LoRA strength during denoising"
        )
    outputs: list[dict[str, Any]] = []
    for index in range(output_count):
        if lora_names:
            pipeline.set_adapters(
                lora_names,
                adapter_weights=_lora_weights_at_progress(
                    lora_weights, lora_schedules, 0.0
                ),
            )
        image_seed = seed + index
        generator_device = "cuda" if device == "cuda" else "cpu"
        generator = torch.Generator(device=generator_device).manual_seed(image_seed)
        arguments: dict[str, Any] = {
            "prompt": prompt,
            "width": width,
            "height": height,
            "num_inference_steps": step_count,
            "generator": generator,
            "num_images_per_prompt": 1,
        }
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
        result = pipeline(**arguments)
        if not result.images:
            raise WorkerError(f"Pipeline returned no image for output {index + 1}")
        suffix = "jpg" if output_format == "jpeg" else output_format
        filename = f"output-{index:04d}.{suffix}"
        destination = output_directory / filename
        save_format = {"png": "PNG", "jpeg": "JPEG", "webp": "WEBP"}[output_format]
        image = result.images[0].convert("RGB")
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
    return {
        "schemaVersion": SCHEMA_VERSION,
        "workerVersion": WORKER_VERSION,
        "packages": _package_versions(),
        "device": device,
        "deviceLabel": device_label,
        "deviceMemoryBytes": device_memory,
        "prompt": prompt,
        "negativePrompt": negative_prompt,
        "addons": applied,
        "outputs": outputs,
    }


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
        raise WorkerError("Expected exactly one command: probe, probe-model, or generate")
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
