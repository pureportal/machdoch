from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any

import torch
from safetensors.torch import load_file, save_file


def write_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def checkpoints(output: Path) -> list[Path]:
    return sorted(
        (path for path in output.glob("checkpoint-*")
         if path.is_dir() and path.name[11:].isdigit()
         and (path / "state.pt").is_file()
         and (path / "weights.safetensors").is_file()),
        key=lambda path: int(path.name[11:]),
    )


def save_checkpoint(output: Path, step: int, weights: dict, optimizer: Any,
                    scheduler: Any, scaler: Any, generator: Any, device: str,
                    signature: str, settings: dict, retention: int) -> None:
    temporary = output / f".checkpoint-{step}-{os.getpid()}"
    temporary.mkdir()
    save_file({key: value.detach().cpu().contiguous() for key, value in weights.items()},
              str(temporary / "weights.safetensors"))
    device_rng = (torch.cuda.get_rng_state() if device == "cuda"
                  else torch.mps.get_rng_state() if device == "mps" else None)
    torch.save({"step": step, "optimizer": optimizer.state_dict(),
                "scheduler": scheduler.state_dict(), "scaler": scaler.state_dict(),
                "generator": generator.get_state(), "torch_rng": torch.get_rng_state(),
                "device_rng": device_rng, "signature": signature, "settings": settings},
               temporary / "state.pt")
    os.replace(temporary, output / f"checkpoint-{step}")
    for old in checkpoints(output)[:-retention]:
        if old.resolve().parent != output.resolve():
            raise ValueError("The checkpoint folder is outside the training job.")
        shutil.rmtree(old)


def restore_checkpoint(output: Path, restore_weights: Any, optimizer: Any,
                       scheduler: Any, scaler: Any, generator: Any, device: str,
                       signature: str, settings: dict) -> int:
    available = checkpoints(output)
    if not available:
        raise ValueError("No saved checkpoint is available to resume.")
    latest = available[-1]
    state = torch.load(latest / "state.pt", map_location="cpu", weights_only=True)
    if state["signature"] != signature or state["settings"] != settings:
        raise ValueError("The training dataset, model, or settings changed. Start a new job.")
    restore_weights(load_file(str(latest / "weights.safetensors")))
    optimizer.load_state_dict(state["optimizer"])
    scheduler.load_state_dict(state["scheduler"])
    scaler.load_state_dict(state["scaler"])
    generator.set_state(state["generator"])
    torch.set_rng_state(state["torch_rng"])
    if device == "cuda":
        torch.cuda.set_rng_state(state["device_rng"])
    elif device == "mps":
        torch.mps.set_rng_state(state["device_rng"])
    return state["step"]
