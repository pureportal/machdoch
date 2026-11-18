from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

ALGORITHM_TENSORS = {
    "lokr": ("lokr_w1", "lokr_w1_a", "lokr_w1_b", "lokr_w2", "lokr_w2_a", "lokr_w2_b", "lokr_t2"),
    "loha": ("hada_w1_a", "hada_w1_b", "hada_w2_a", "hada_w2_b", "hada_t1", "hada_t2"),
}
COMPONENT_PREFIXES = (
    ("lora_unet_", "denoiser"),
    ("lycoris_", "denoiser"),
    ("lora_transformer_", "denoiser"),
    ("lora_te1_", "text-encoder"),
    ("lora_te2_", "text-encoder-2"),
    ("lora_te_", "text-encoder"),
    ("unet.", "denoiser"),
    ("transformer.", "denoiser"),
    ("text_encoder_2.", "text-encoder-2"),
    ("text_encoder.", "text-encoder"),
)
KOHYA_PREFIXES = ("lora_unet_", "lora_te_", "lora_te1_", "lora_te2_", "lora_transformer_")
RESNET_SGM_NAMES = {
    "norm1": "in_layers.0",
    "conv1": "in_layers.2",
    "time_emb_proj": "emb_layers.1",
    "norm2": "out_layers.0",
    "conv2": "out_layers.3",
    "conv_shortcut": "skip_connection",
}
FIXED_SGM_NAMES = {
    "conv_in": "input_blocks.0.0",
    "time_embedding.linear_1": "time_embed.0",
    "time_embedding.linear_2": "time_embed.2",
    "add_embedding.linear_1": "label_emb.0.0",
    "add_embedding.linear_2": "label_emb.0.2",
    "conv_norm_out": "out.0",
    "conv_out": "out.2",
}


class LycorisError(ValueError):
    pass


def lycoris_algorithm(keys: list[str]) -> str | None:
    found = {
        algorithm
        for algorithm, names in ALGORITHM_TENSORS.items()
        for key in keys
        if key.lower().rsplit(".", 1)[-1] in names
    }
    if len(found) > 1:
        raise LycorisError("Mixed LyCORIS algorithms are not supported in one add-on")
    return next(iter(found), None)


def _modules(algorithm: str, keys: list[str]) -> dict[str, dict[str, str]]:
    allowed = {*ALGORITHM_TENSORS[algorithm], "alpha"}
    modules: dict[str, dict[str, str]] = {}
    for key in keys:
        stem, _, tensor_name = key.rpartition(".")
        if tensor_name.lower() not in allowed:
            raise LycorisError(f"{algorithm.upper()} add-on contains an unsupported tensor: {key}")
        modules.setdefault(stem, {})[tensor_name.lower()] = key
    return modules


def _pair(tensors: Mapping[str, Any], full: str, left: str, right: str) -> bool:
    if full in tensors:
        if left in tensors or right in tensors:
            raise LycorisError(f"LyCORIS module stores {full} both whole and decomposed")
        return False
    if left not in tensors or right not in tensors:
        raise LycorisError(f"LyCORIS module is missing {full}")
    return True


def _module_rank(algorithm: str, shapes: Mapping[str, tuple[int, ...]]) -> int:
    if algorithm == "loha":
        if any(name not in shapes for name in ("hada_w1_a", "hada_w1_b", "hada_w2_a", "hada_w2_b")):
            raise LycorisError("LoHa module is missing a Hadamard factor")
        if ("hada_t1" in shapes) != ("hada_t2" in shapes):
            raise LycorisError("LoHa module has an incomplete Tucker core")
        rank = shapes["hada_w1_b"][0]
        if shapes["hada_w2_b"][0] != rank:
            raise LycorisError("LoHa module has mismatched factor ranks")
        return rank
    w1_decomposed = _pair(shapes, "lokr_w1", "lokr_w1_a", "lokr_w1_b")
    if "lokr_t2" in shapes and "lokr_w2" in shapes:
        raise LycorisError("LoKr module has a Tucker core without decomposed factors")
    w2_decomposed = _pair(shapes, "lokr_w2", "lokr_w2_a", "lokr_w2_b")
    ranks = [shapes["lokr_w1_b"][0]] if w1_decomposed else []
    if w2_decomposed:
        ranks.append(shapes["lokr_w2_b"][0])
    return max(ranks) if ranks else min(shapes["lokr_w2"][:2])


def lycoris_profile(tensor_shapes: Mapping[str, tuple[int, ...]]) -> dict[str, Any]:
    algorithm = lycoris_algorithm(list(tensor_shapes))
    if algorithm is None:
        raise LycorisError("No LyCORIS tensors were found")
    modules = _modules(algorithm, list(tensor_shapes))
    ranks: list[int] = []
    convolution_targets = 0
    alpha_count = 0
    for stem, tensors in modules.items():
        shapes = {name: tuple(tensor_shapes[key]) for name, key in tensors.items()}
        alpha = shapes.pop("alpha", None)
        if alpha is not None:
            if alpha not in ((), (1,)):
                raise LycorisError(f"LyCORIS alpha for {stem} must be a scalar tensor")
            alpha_count += 1
        if not shapes:
            raise LycorisError(f"LyCORIS alpha for {stem} has no matching factors")
        if any(not shape or any(value <= 0 for value in shape) for shape in shapes.values()):
            raise LycorisError(f"LyCORIS module {stem} has an invalid shape")
        rank = _module_rank(algorithm, shapes)
        if not 0 < rank <= 4096:
            raise LycorisError(f"LyCORIS module {stem} has an unsupported rank")
        ranks.append(rank)
        if any(len(shape) == 4 for shape in shapes.values()):
            convolution_targets += 1
    dialects = {"kohya" if stem.lower().startswith(KOHYA_PREFIXES) else "generic" for stem in modules}
    if len(dialects) != 1:
        raise LycorisError("Mixed LoRA tensor dialects are not supported")
    return {
        "algorithm": algorithm,
        "dialect": dialects.pop(),
        "rankMinimum": min(ranks),
        "rankMaximum": max(ranks),
        "heterogeneousRanks": min(ranks) != max(ranks),
        "targetModuleCount": len(modules),
        "convolutionTargetCount": convolution_targets,
        "magnitudeVectorCount": 0,
        "networkAlphaCount": alpha_count,
    }


def fold_tucker_locon(state: dict[str, Any]) -> dict[str, Any]:
    import torch

    folded = dict(state)
    for key in [key for key in state if key.endswith(".lora_mid.weight")]:
        stem = key[: -len(".lora_mid.weight")]
        down_key = f"{stem}.lora_down.weight"
        middle, down = state[key], state.get(down_key)
        if down is None or down.ndim != 4 or down.shape[2:] != (1, 1) or middle.ndim != 4:
            raise LycorisError(f"CP-decomposed LoCon module {stem} has invalid factors")
        if middle.shape[1] != down.shape[0]:
            raise LycorisError(f"CP-decomposed LoCon module {stem} has mismatched ranks")
        folded[down_key] = torch.einsum("abhw,bi->aihw", middle.float(), down[:, :, 0, 0].float()).to(down.dtype)
        del folded[key]
    return folded


def _sgm_name(name: str, unet: Any) -> str | None:
    if name in FIXED_SGM_NAMES:
        return FIXED_SGM_NAMES[name]
    layers = unet.config.layers_per_block
    parts = name.split(".")
    if not isinstance(layers, int) or len(parts) < 4 or not parts[1].isdigit() or not parts[3].isdigit():
        return None
    span = layers + 1
    block, kind, index, rest = int(parts[1]), parts[2], int(parts[3]), parts[4:]
    if kind == "resnets" and rest:
        rest = [*RESNET_SGM_NAMES.get(rest[0], rest[0]).split("."), *rest[1:]]
    if parts[0] == "down_blocks":
        if kind == "downsamplers":
            return ".".join(["input_blocks", str(block * span + span), "0", "op", *rest[1:]])
        slot = {"resnets": "0", "attentions": "1"}.get(kind)
        return None if slot is None else ".".join(["input_blocks", str(1 + block * span + index), slot, *rest])
    if parts[0] == "up_blocks":
        if kind == "upsamplers":
            slot = "2" if hasattr(unet.up_blocks[block], "attentions") else "1"
            return ".".join(["output_blocks", str(block * span + layers), slot, *rest])
        slot = {"resnets": "0", "attentions": "1"}.get(kind)
        return None if slot is None else ".".join(["output_blocks", str(block * span + index), slot, *rest])
    return None


def _mid_block_sgm_name(name: str) -> str | None:
    parts = name.split(".")
    if len(parts) < 3 or parts[0] != "mid_block":
        return None
    slot = {("resnets", "0"): "0", ("attentions", "0"): "1", ("resnets", "1"): "2"}.get((parts[1], parts[2]))
    if slot is None:
        return None
    rest = parts[3:]
    if parts[1] == "resnets" and rest:
        rest = [*RESNET_SGM_NAMES.get(rest[0], rest[0]).split("."), *rest[1:]]
    return ".".join(["middle_block", slot, *rest])


def module_index(model: Any, component: str) -> dict[str, str]:
    import torch
    from peft.tuners.tuners_utils import BaseTunerLayer

    tuners = [name for name, module in model.named_modules() if isinstance(module, BaseTunerLayer)]
    index: dict[str, str | None] = {}
    sgm = component == "denoiser" and hasattr(model, "down_blocks") and hasattr(model.config, "layers_per_block")
    for name, module in model.named_modules():
        if not name or any(name.startswith(f"{tuner}.") for tuner in tuners):
            continue
        if not isinstance(module, (torch.nn.Linear, torch.nn.Conv1d, torch.nn.Conv2d, BaseTunerLayer)):
            continue
        aliases = {name}
        if component.startswith("text-encoder") and not name.startswith("text_model."):
            aliases.add(f"text_model.{name}")
        if sgm:
            aliases.update(alias for alias in (_sgm_name(name, model), _mid_block_sgm_name(name)) if alias)
        for alias in aliases:
            flat = alias.replace(".", "_").lower()
            index[flat] = name if index.get(flat, name) == name else None
    return {flat: name for flat, name in index.items() if name is not None}


def _split_stem(stem: str) -> tuple[str, str]:
    lower = stem.lower()
    for prefix, component in COMPONENT_PREFIXES:
        if lower.startswith(prefix):
            return component, lower[len(prefix):].replace(".", "_")
    return "denoiser", lower.replace(".", "_")


def _scale(algorithm: str, tensors: Mapping[str, Any]) -> float:
    if algorithm == "loha":
        rank = tensors["hada_w1_b"].shape[0]
    else:
        decomposed = [tensors[name].shape[0] for name in ("lokr_w1_b", "lokr_w2_b") if name in tensors]
        rank = decomposed[-1] if decomposed else None
    alpha = tensors.get("alpha")
    return float(alpha.item()) / rank if alpha is not None and rank else 1.0


def _delta_shape(algorithm: str, tensors: Mapping[str, Any]) -> tuple[int, int, int]:
    def size(name: str, axis: int) -> int:
        return int(tensors[name].shape[axis])

    if algorithm == "loha":
        output = size("hada_w1_a", 1) if "hada_t1" in tensors else size("hada_w1_a", 0)
        width = size("hada_w1_b", 1)
        kernel = tensors["hada_t1"].shape[2] * tensors["hada_t1"].shape[3] if "hada_t1" in tensors else 1
        return output, width, kernel
    w1_out, w1_in = (size("lokr_w1", 0), size("lokr_w1", 1)) if "lokr_w1" in tensors else (size("lokr_w1_a", 0), size("lokr_w1_b", 1))
    if "lokr_w2" in tensors:
        w2 = tensors["lokr_w2"]
        w2_out, w2_in, kernel = int(w2.shape[0]), int(w2.shape[1]), int(w2[0, 0].numel())
    elif "lokr_t2" in tensors:
        t2 = tensors["lokr_t2"]
        w2_out, w2_in, kernel = size("lokr_w2_a", 1), size("lokr_w2_b", 1), int(t2.shape[2] * t2.shape[3])
    else:
        w2_out, w2_in, kernel = size("lokr_w2_a", 0), size("lokr_w2_b", 1), 1
    return w1_out * w2_out, w1_in * w2_in, kernel


def _assign(layer: Any, adapter_name: str, algorithm: str, tensors: dict[str, Any], stem: str) -> None:
    import torch

    base = layer.get_base_layer().weight
    output, width, kernel = _delta_shape(algorithm, tensors)
    if output != base.shape[0] or output * width * kernel != base.numel():
        raise LycorisError(f"LyCORIS module {stem} does not fit its target layer")
    dtype = base.dtype if base.dtype in (torch.float16, torch.bfloat16, torch.float32) else torch.bfloat16
    for name in ALGORITHM_TENSORS[algorithm]:
        if adapter_name in getattr(layer, name):
            del getattr(layer, name)[adapter_name]
    for name, tensor in tensors.items():
        if name != "alpha":
            getattr(layer, name)[adapter_name] = torch.nn.Parameter(
                tensor.to(device=base.device, dtype=dtype), requires_grad=False
            )
    scale = _scale(algorithm, tensors)
    layer.r[adapter_name] = 1
    layer.alpha[adapter_name] = scale
    layer.scaling[adapter_name] = scale


def load_lycoris(pipeline: Any, path: Path, adapter_name: str, target_components: list[str]) -> None:
    from peft import LoHaConfig, LoKrConfig, inject_adapter_in_model
    from safetensors.torch import load_file

    state = load_file(str(path))
    algorithm = lycoris_algorithm(list(state))
    if algorithm is None:
        raise LycorisError("No LyCORIS tensors were found")
    runtime = {
        "denoiser": getattr(pipeline, "unet", None) or getattr(pipeline, "transformer", None),
        "text-encoder": getattr(pipeline, "text_encoder", None),
        "text-encoder-2": getattr(pipeline, "text_encoder_2", None),
    }
    indexes: dict[str, dict[str, str]] = {}
    targets: dict[str, dict[str, str]] = {}
    for stem in _modules(algorithm, list(state)):
        component, flat = _split_stem(stem)
        model = runtime[component]
        if component not in target_components or model is None:
            raise LycorisError(f"LyCORIS module {stem} targets an unexpected component")
        if component not in indexes:
            indexes[component] = module_index(model, component)
        module_name = indexes[component].get(flat)
        if module_name is None:
            raise LycorisError(f"LyCORIS module {stem} does not match the selected model")
        if module_name in targets.setdefault(component, {}):
            raise LycorisError(f"LyCORIS modules map twice onto {module_name}")
        targets[component][module_name] = stem
    if set(targets) != set(target_components):
        raise LycorisError("LyCORIS tensors do not cover their inspected target components")
    modules = _modules(algorithm, list(state))
    config_class = LoKrConfig if algorithm == "lokr" else LoHaConfig
    for component, mapping in targets.items():
        model = runtime[component]
        inject_adapter_in_model(config_class(r=1, alpha=1, target_modules=sorted(mapping)), model, adapter_name)
        model._hf_peft_config_loaded = True
        for module_name, stem in mapping.items():
            tensors = {name: state[key] for name, key in modules[stem].items()}
            _assign(model.get_submodule(module_name), adapter_name, algorithm, tensors, stem)
