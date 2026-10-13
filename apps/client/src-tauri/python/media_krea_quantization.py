from __future__ import annotations

import json
from typing import Any


def quantized_layers(tensor_file: Any) -> dict[str, Any]:
    encoded = tensor_file.metadata().get("_quantization_metadata")
    if encoded is None:
        return {}
    value = json.loads(encoded)
    if not isinstance(value, dict) or not isinstance(value.get("layers"), dict):
        raise ValueError("KREA checkpoint has invalid quantization metadata")
    return value["layers"]


def layer_configuration(tensor_file: Any, source_key: str, layers: dict[str, Any], expected_format: str) -> dict[str, Any]:
    layer = source_key.removesuffix(".weight")
    marker = layer + ".comfy_quant"
    configuration = layers.get(layer)
    if marker in tensor_file.header:
        marked = json.loads(bytes(tensor_file.get_tensor(marker).tolist()).decode("utf-8"))
        if not isinstance(marked, dict):
            raise ValueError(f"KREA tensor {source_key} has invalid quantization metadata")
        if configuration is not None and (
            not isinstance(configuration, dict)
            or any(marked.get(key, value) != value for key, value in configuration.items())
        ):
            raise ValueError(f"KREA tensor {source_key} has conflicting quantization metadata")
        configuration = {**(configuration or {}), **marked}
    if not isinstance(configuration, dict):
        raise ValueError(f"KREA tensor {source_key} has no quantization metadata")
    if configuration.get("format") != expected_format:
        raise ValueError(f"KREA tensor {source_key} uses unsupported quantization")
    parameters = configuration.get("params", {})
    if (
        not isinstance(parameters, dict)
        or parameters.keys() - {"convrot"}
        or configuration.get("convrot", False)
        or parameters.get("convrot", False)
    ):
        raise ValueError(f"KREA tensor {source_key} uses unsupported quantization transforms")
    if configuration.get("orig_dtype", "torch.bfloat16") not in ("torch.bfloat16", "torch.float16", "torch.float32"):
        raise ValueError(f"KREA tensor {source_key} has an unsupported original dtype")
    if not isinstance(configuration.get("full_precision_matrix_mult", False), bool):
        raise ValueError(f"KREA tensor {source_key} has invalid matrix multiplication settings")
    return configuration


def dequantized_linear_forward(module: Any, input_tensor: Any) -> Any:
    import torch

    if module.weight.dtype == torch.int8:
        weight = (module.weight.to(dtype=torch.float32) * module._machdoch_weight_scale).to(dtype=input_tensor.dtype)
    else:
        weight = module.weight.to(dtype=input_tensor.dtype) * module._machdoch_weight_scale.to(dtype=input_tensor.dtype)
    return torch.nn.functional.linear(input_tensor, weight, module.bias)
