from __future__ import annotations

import contextlib
import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import torch

from media_training_state import restore_checkpoint, save_checkpoint, write_json
from media_training_optimizer import create_optimizer


TensorMap = dict[str, torch.Tensor]


@dataclass
class TrainingObjective:
    samples: list[TensorMap]
    parameters: list[torch.nn.Parameter]
    loss: Callable[[TensorMap, list[int], torch.Generator], torch.Tensor]
    weights: Callable[[], TensorMap]
    restore_weights: Callable[[TensorMap], None]


def run_training(specification: dict, directory: Path, signature: str,
                 objective: TrainingObjective, device: str, dtype: torch.dtype) -> int:
    from diffusers.optimization import get_scheduler

    optimizer = create_optimizer(objective.parameters, specification)
    schedule_name = (
        "constant_with_warmup"
        if specification["lr_scheduler"] == "constant" and specification["warmup_steps"]
        else specification["lr_scheduler"]
    )
    scheduler = get_scheduler(
        schedule_name, optimizer=optimizer, num_warmup_steps=specification["warmup_steps"],
        num_training_steps=specification["steps"],
    )
    scaler = torch.amp.GradScaler(device, enabled=device == "cuda" and dtype == torch.float16)
    generator = torch.Generator(device=device if device == "cuda" else "cpu").manual_seed(specification["seed"])
    output = directory / "output"
    output.mkdir(exist_ok=True)
    settings = {key: value for key, value in specification.items() if key not in ("model", "resume")}
    step = (
        restore_checkpoint(output, objective.restore_weights, optimizer, scheduler, scaler,
                           generator, device, signature, settings)
        if specification["resume"] else 0
    )
    started_step = step
    started = time.monotonic()
    buckets: dict[tuple[int, ...], list[int]] = {}
    for index, sample in enumerate(objective.samples):
        buckets.setdefault(tuple(sample["mean"].shape), []).append(index)
    write_json(directory / "status.json", {"state": "running", "message": None})
    metrics = directory / "metrics.jsonl"
    with metrics.open("a" if specification["resume"] else "w", encoding="utf-8") as history:
        while step < specification["steps"]:
            optimizer.zero_grad(set_to_none=True)
            accumulated_loss = 0.0
            for _ in range(specification["gradient_accumulation"]):
                selected = int(torch.randint(len(objective.samples), (1,), generator=generator, device=generator.device).item())
                bucket = buckets[tuple(objective.samples[selected]["mean"].shape)]
                positions = torch.randint(len(bucket), (specification["batch_size"],), generator=generator, device=generator.device).tolist()
                indices = [bucket[position] for position in positions]
                batch = {
                    key: torch.cat([objective.samples[index][key] for index in indices]).to(device=device, dtype=dtype)
                    for key in objective.samples[selected]
                }
                autocast = torch.autocast(device_type=device, dtype=dtype) if dtype != torch.float32 else contextlib.nullcontext()
                with autocast:
                    loss = objective.loss(batch, indices, generator)
                if not torch.isfinite(loss):
                    raise ValueError("Training produced a non-finite loss. Lower the learning rate and try again.")
                scaler.scale(loss / specification["gradient_accumulation"]).backward()
                accumulated_loss += float(loss.detach().cpu()) / specification["gradient_accumulation"]
            scaler.unscale_(optimizer)
            gradient_norm = torch.nn.utils.clip_grad_norm_(
                objective.parameters, specification["max_grad_norm"] or float("inf"),
            )
            if not torch.isfinite(gradient_norm):
                raise ValueError("Training produced non-finite gradients. Lower the learning rate and try again.")
            scaler.step(optimizer)
            scaler.update()
            scheduler.step()
            step += 1
            elapsed = time.monotonic() - started
            progress = {
                "completedSteps": step, "totalSteps": specification["steps"], "loss": accumulated_loss,
                "learningRate": scheduler.get_last_lr()[0], "elapsedSeconds": elapsed,
                "remainingSeconds": elapsed / (step - started_step) * (specification["steps"] - step),
            }
            write_json(directory / "progress.json", progress)
            history.write(json.dumps(progress) + "\n")
            history.flush()
            print(f"Steps: {step}/{specification['steps']} loss={accumulated_loss:.6f}", flush=True)
            if step % specification["checkpoint_interval"] == 0 or step == specification["steps"]:
                write_json(directory / "status.json", {"state": "running", "message": "Saving checkpoint"})
                save_checkpoint(output, step, objective.weights(), optimizer, scheduler, scaler,
                                generator, device, signature, settings, specification["checkpoint_retention"])
                write_json(directory / "status.json", {"state": "running", "message": None})
    optimizer.zero_grad(set_to_none=True)
    return step
