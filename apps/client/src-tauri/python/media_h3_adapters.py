"""MiniMax-H3 student adapters adapted from DMAD (Apache-2.0).

Copyright 2026 the DMAD authors. Machdoch modifications: one explicit dialect
per released student, strict target/shape validation, and PDMD adapter fusion.
See LICENSE-DMAD.txt and NOTICE-DMAD.txt.
"""

import torch
from safetensors import safe_open


def read_pairs(path, method):
    suffixes = {".lora.down.weight": "A", ".lora.up.weight": "B"} if method == "dmad" else {".lora_A.weight": "A", ".lora_B.weight": "B"}
    pairs = {}
    with safe_open(str(path), framework="pt", device="cpu") as checkpoint:
        for key in checkpoint.keys():
            match = next(((suffix, part) for suffix, part in suffixes.items() if key.endswith(suffix)), None)
            if match is None:
                raise ValueError(f"Unexpected student tensor: {key}")
            suffix, part = match
            module = key[:-len(suffix)]
            if method == "pdmd":
                if not module.startswith("transformer."):
                    raise ValueError(f"Invalid PDMD target: {module}")
                module = module[len("transformer."):]
            pairs.setdefault(module, {})[part] = checkpoint.get_tensor(key)
    if not pairs or any(set(pair) != {"A", "B"} for pair in pairs.values()):
        raise ValueError("The student checkpoint has missing adapter pairs")
    return pairs


def _validated_parameters(transformer, pairs):
    parameters = dict(transformer.named_parameters())
    for name, pair in pairs.items():
        target = parameters.get(name + ".weight")
        left, right = pair["A"], pair["B"]
        if target is None or target.ndim != 2 or left.ndim != 2 or right.ndim != 2 or left.shape[0] != 128 or right.shape[1] != 128 or (right.shape[0], left.shape[1]) != tuple(target.shape):
            raise ValueError(f"Student adapter does not match the full MiniMax-H3 transformer: {name}")
        if not torch.isfinite(left).all() or not torch.isfinite(right).all():
            raise ValueError(f"Student adapter contains non-finite weights: {name}")
    return parameters


def load_dmad_adapter(transformer, pairs):
    from peft import LoraConfig, inject_adapter_in_model
    from peft.utils import set_peft_model_state_dict

    _validated_parameters(transformer, pairs)
    config = LoraConfig(r=128, lora_alpha=128, init_lora_weights="gaussian", target_modules=sorted(pairs))
    transformer = inject_adapter_in_model(config, transformer, adapter_name="default")
    state = {f"{name}.lora_{part}.weight": tensor for name, pair in pairs.items() for part, tensor in pair.items()}
    result = set_peft_model_state_dict(transformer, state, adapter_name="default")
    expected = {f"{name}.lora_{part}.default.weight" for name, pair in pairs.items() for part in pair}
    loaded = {name for name, _ in transformer.named_parameters() if ".lora_A." in name or ".lora_B." in name}
    if result.unexpected_keys or expected.intersection(result.missing_keys) or loaded != expected:
        raise ValueError("The DMAD adapter did not load every target. Check the checkpoint and PEFT runtime.")
    return transformer.eval().requires_grad_(False)


@torch.inference_mode()
def fuse_pairs(transformer, pairs):
    parameters = _validated_parameters(transformer, pairs)
    for name, pair in pairs.items():
        target = parameters[name + ".weight"]
        update = pair["B"].float() @ pair["A"].float()
        if not torch.isfinite(update).all():
            raise ValueError(f"Student adapter update is not finite: {name}")
        target.copy_((target.float() + update.to(target.device)).to(target.dtype))
