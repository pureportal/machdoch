from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def load_prompt_encoder(directory: Path, torch: Any) -> Any:
    from accelerate import init_empty_weights
    from accelerate.utils import set_module_tensor_to_device
    from safetensors import safe_open
    from transformers import LlamaConfig, LlamaModel

    configuration = LlamaConfig.from_pretrained(
        directory,
        local_files_only=True,
        trust_remote_code=False,
    )
    with init_empty_weights():
        encoder = LlamaModel(configuration)
    expected = set(encoder.state_dict())
    index = json.loads(
        (directory / "model.safetensors.index.json").read_text(encoding="utf-8")
    )
    weight_map = index.get("weight_map")
    if not isinstance(weight_map, dict) or set(weight_map) != expected:
        raise ValueError(
            "FramePack prompt weights do not match the model configuration."
        )
    if any(
        not isinstance(name, str) or Path(name).name != name
        for name in weight_map.values()
    ):
        raise ValueError("FramePack prompt weights contain an invalid shard path.")
    shards = set(weight_map.values())
    loaded = set()
    for shard in sorted(shards):
        with safe_open(
            directory / shard, framework="pt", device="cpu", backend="pread"
        ) as weights:
            for name in weights.keys():
                if name not in expected or weight_map[name] != shard or name in loaded:
                    raise ValueError(
                        "FramePack prompt weights do not match their index."
                    )
                tensor = weights.get_tensor(name).to(dtype=torch.bfloat16)
                set_module_tensor_to_device(
                    encoder, name, "cpu", value=tensor, dtype=torch.bfloat16
                )
                loaded.add(name)
                del tensor
    if loaded != expected:
        raise ValueError(
            "FramePack prompt weights are incomplete. Reinstall the model."
        )
    return encoder.eval().requires_grad_(False)
