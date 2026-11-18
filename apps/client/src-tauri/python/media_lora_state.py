from __future__ import annotations

from typing import Any


def freeze_pipeline(pipeline: Any) -> None:
    """Clears requires_grad on every parameter of a freshly loaded pipeline.

    PEFT freezes the base parameters whenever it injects an adapter and unloading never thaws
    them; PyTorch picks a different linear kernel for frozen weights, so a model that is not
    frozen from the start would sample differently once any LoRA has been loaded and removed."""
    import torch

    for component in pipeline.components.values():
        if isinstance(component, torch.nn.Module):
            component.requires_grad_(False)


def _tuner_layers(modules: list[Any]) -> list[Any]:
    import torch
    from peft.tuners.tuners_utils import BaseTunerLayer

    return [
        layer
        for module in modules
        if isinstance(module, torch.nn.Module)
        for layer in module.modules()
        if isinstance(layer, BaseTunerLayer)
    ]


def tuner_bases_on_cpu(modules: list[Any]) -> bool:
    """Fusion pays off only for host-resident weights: their snapshot is a cheap host copy.

    Accelerator-resident weights would need a host snapshot as large as the model, and
    unfused adapters keep small deltas that bfloat16 weights cannot represent exactly."""
    return all(layer.get_base_layer().weight.device.type == "cpu" for layer in _tuner_layers(modules))


def snapshot_tuner_bases(modules: list[Any]) -> list[tuple[Any, Any]]:
    """Copies the base weights under every PEFT layer before fusion.

    Unfusing subtracts the delta again in the storage dtype, which leaves rounding drift in a
    half-precision model; copying the originals back makes a cached model bit-identical to a
    freshly loaded one."""
    import torch

    saved = []
    for layer in _tuner_layers(modules):
        base = layer.get_base_layer()
        for name in ("weight", "bias"):
            tensor = getattr(base, name, None)
            if isinstance(tensor, torch.Tensor):
                saved.append((tensor, tensor.detach().to("cpu", copy=True)))
    return saved


def fuse_tuner_layers(modules: list[Any], adapter_names: list[str]) -> None:
    """Merges the named adapters into their base weights one layer at a time on the GPU.

    PEFT merges CPU-resident layers on the CPU, which takes tens of seconds for an SDXL-sized
    LoRA; each layer is moved to the GPU for its merge and returned to its original device.
    The adapter factors are widened to float32 for the merge so every delta is rounded only
    once, into the base weight's own dtype."""
    import torch

    accelerator = torch.device("cuda", torch.cuda.current_device()) if torch.cuda.is_available() else None
    with torch.no_grad():
        for layer in _tuner_layers(modules):
            home = layer.get_base_layer().weight.device
            moved = accelerator is not None and home.type == "cpu"
            if moved:
                layer.to(accelerator)
            factors = [
                parameter for name, parameter in layer.named_parameters() if not name.startswith("base_layer.")
            ]
            dtypes = [factor.dtype for factor in factors]
            for factor in factors:
                factor.data = factor.data.float()
            layer.merge(adapter_names=adapter_names)
            for factor, dtype in zip(factors, dtypes):
                factor.data = factor.data.to(dtype)
            if moved:
                layer.to(home)


def restore_tuner_bases(saved: list[tuple[Any, Any]]) -> None:
    import torch

    with torch.no_grad():
        for tensor, original in saved:
            tensor.copy_(original)
