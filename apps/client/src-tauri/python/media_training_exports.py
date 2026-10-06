from __future__ import annotations

import gc
import inspect
import json
import math
import os
from pathlib import Path


def normalize_scheduler_config(scheduler, directory: Path) -> None:
    path = directory / "scheduler_config.json"
    config = json.loads(path.read_text(encoding="utf-8"))
    parameters = inspect.signature(type(scheduler).__init__).parameters
    for name, value in tuple(config.items()):
        if isinstance(value, float) and not math.isfinite(value):
            parameter = parameters.get(name)
            if parameter is None or parameter.default != value:
                raise ValueError(f"The scheduler has an invalid non-finite setting: {name}.")
            del config[name]
    encoded = json.dumps(config, indent=2, allow_nan=False) + "\n"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(encoded, encoding="utf-8")
    os.replace(temporary, path)


def save_pipeline(pipeline, directory: Path) -> None:
    import torch

    gc.collect()
    if torch.cuda.is_initialized():
        torch.cuda.empty_cache()
    elif torch.backends.mps.is_available():
        torch.mps.empty_cache()
    pipeline.save_pretrained(str(directory), safe_serialization=True, max_shard_size="1GB")
    normalize_scheduler_config(pipeline.scheduler, directory / "scheduler")
