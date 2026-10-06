from __future__ import annotations

import math
from collections.abc import Sequence

import torch
from transformers import Adafactor


class TrainingAdafactor(Adafactor):
    def load_state_dict(self, state_dict: dict) -> None:
        super().load_state_dict(state_dict)
        for saved_group, group in zip(state_dict["param_groups"], self.param_groups, strict=True):
            for identifier, parameter in zip(saved_group["params"], group["params"], strict=True):
                for key, value in state_dict["state"].get(identifier, {}).items():
                    if torch.is_tensor(value) and value.is_floating_point():
                        self.state[parameter][key] = value.to(device=parameter.device, dtype=torch.float32)


def create_optimizer(parameters: list[torch.nn.Parameter], specification: dict) -> torch.optim.Optimizer:
    arguments = {"lr": specification["learning_rate"], "weight_decay": specification["weight_decay"]}
    if specification["optimizer"] == "adafactor":
        return TrainingAdafactor(parameters, relative_step=False, scale_parameter=False,
                                warmup_init=False, clip_threshold=1.0, **arguments)
    return torch.optim.AdamW(parameters, **arguments)


def trainable_dtype(specification: dict) -> torch.dtype:
    return torch.bfloat16 if specification["trainable_precision"] == "bf16" else torch.float32


def finetune_memory_bytes(parameters: Sequence[torch.nn.Parameter], specification: dict) -> int:
    count = sum(parameter.numel() for parameter in parameters)
    if specification["optimizer"] == "adamw":
        return count * 16
    element_size = 2 if specification["trainable_precision"] == "bf16" else 4
    moments = sum((math.prod(parameter.shape[:-1]) + math.prod(parameter.shape[:-2]) * parameter.shape[-1])
                  if parameter.ndim >= 2 else parameter.numel() for parameter in parameters)
    return count * element_size * 2 + moments * 4 + max(parameter.numel() for parameter in parameters) * 16
