from __future__ import annotations

import math


def validate_options(specification: dict, methods: tuple[str, ...]) -> None:
    if specification["method"] not in methods:
        raise ValueError("Choose a training method for this model.")
    if specification["four_bit"]:
        raise ValueError("This trainer requires unquantized base weights.")
    if specification["precision"] not in ("bf16", "fp16", "float32"):
        raise ValueError("Choose BF16, FP16, or FP32 precision.")
    if specification["optimizer"] not in ("adamw", "adafactor"):
        raise ValueError("Choose AdamW or Adafactor.")
    if specification["trainable_precision"] not in ("bf16", "float32"):
        raise ValueError("Choose BF16 or FP32 trainable weights.")
    if specification["trainable_precision"] == "bf16" and (
            specification["method"] != "finetune" or specification["optimizer"] != "adafactor"
            or specification["precision"] != "bf16"):
        raise ValueError("BF16 trainable weights require finetuning with Adafactor and BF16 precision.")
    if specification["optimizer"] == "adafactor" and specification["max_grad_norm"] != 0:
        raise ValueError("Disable gradient clipping when using Adafactor.")
    ranges = [
        ("steps", 1, 10000), ("resolution", 64, 2048), ("rank", 1, 128),
        ("seed", 0, 4294967295), ("batch_size", 1, 16),
        ("gradient_accumulation", 1, 64), ("warmup_steps", 0, specification["steps"]),
        ("checkpoint_interval", 1, specification["steps"]), ("checkpoint_retention", 1, 20),
    ]
    for field, minimum, maximum in ranges:
        if type(specification[field]) is not int or not minimum <= specification[field] <= maximum:
            raise ValueError(f"Check {field.replace('_', ' ')}.")
    if specification["resolution"] % 64:
        raise ValueError("Resolution must be a multiple of 64.")
    for field, minimum, maximum in [
        ("learning_rate", 0.000001, 0.01), ("weight_decay", 0, 1),
        ("max_grad_norm", 0, 100), ("snr_gamma", 0, 100),
        ("noise_offset", 0, 1), ("lora_dropout", 0, 0.5),
        ("guidance_scale", 0, 20),
    ]:
        if not math.isfinite(specification[field]) or not minimum <= specification[field] <= maximum:
            raise ValueError(f"Check {field.replace('_', ' ')}.")
    if specification["lr_scheduler"] not in ("constant", "linear", "cosine"):
        raise ValueError("Choose a constant, linear, or cosine schedule.")
    if specification["method"] == "embedding":
        token = specification["trigger_phrase"]
        if not token or any(character.isspace() for character in token):
            raise ValueError("Use a single embedding token without spaces.")
        if not specification["initializer_token"].strip():
            raise ValueError("Enter an initializer word for the embedding.")
