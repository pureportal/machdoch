"""Live SDXL student verification through the production image worker."""

import argparse
import gc
import hashlib
import json
from pathlib import Path
import time

STARTED_AT = time.monotonic()

import numpy as np
from PIL import Image


def prepare_base(checkpoint: Path, config: Path, destination: Path) -> None:
    import torch
    from accelerate import init_empty_weights
    from diffusers import StableDiffusionXLPipeline, UNet2DConditionModel

    started = time.monotonic()
    with init_empty_weights():
        unet = UNet2DConditionModel.from_config(str(config / "unet"))
    pipeline = StableDiffusionXLPipeline.from_single_file(
        str(checkpoint), config=str(config), unet=unet, torch_dtype=torch.float16,
        local_files_only=True, use_safetensors=True,
    )
    for name in ("text_encoder", "text_encoder_2", "vae", "tokenizer", "tokenizer_2", "scheduler"):
        component = getattr(pipeline, name)
        component.save_pretrained(str(destination / name))
        print(json.dumps({"preparedComponent": name}), flush=True)
    (destination / "unet").mkdir(exist_ok=True)
    (destination / "unet/config.json").write_bytes((config / "unet/config.json").read_bytes())
    (destination / "model_index.json").write_bytes((config / "model_index.json").read_bytes())
    print(json.dumps({"preparedBase": str(destination), "seconds": time.monotonic() - started}), flush=True)


def verify(model_root: Path, output_root: Path, architectures: list[str], baseline_model: dict | None) -> None:
    import torch
    import media_diffusers_worker as worker
    from media_model_memory import ModelPipelineCache, release_allocator

    device, label, device_memory = worker._device(torch)
    if device != "cuda":
        raise RuntimeError("Live SDXL verification requires the GPU")
    output_root.mkdir(parents=True, exist_ok=False)
    cache = ModelPipelineCache(torch, device, worker.PROCESS_STARTED_AT)
    summary = {"passed": False, "device": label, "deviceMemoryBytes": device_memory, "packages": worker._package_versions(),
               "startupSeconds": time.monotonic() - STARTED_AT, "runs": []}
    (output_root / "results.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    models = architectures + (["stable-diffusion-xl"] if baseline_model else [])
    try:
        for architecture in models:
            profile = worker.media_open_models.PROFILES.get(architecture)
            cases = [
                ("cold", "a photo of a cat", 42),
                ("warm-repeat", "a photo of a cat", 42),
            ]
            if profile:
                cases.extend([
                    ("warm-new-prompt", "A red ceramic teapot on a wooden table, soft window light, photograph", 42),
                    ("warm-new-seed", "a photo of a cat", 43),
                ])
            records = []
            for name, prompt, seed in cases:
                run_root = output_root / f"{architecture}-{name}"
                run_root.mkdir()
                request = {
                    "schemaVersion": worker.SCHEMA_VERSION,
                    "model": {"architecture": architecture, "packageKind": "diffusers-directory",
                              "path": str(model_root), "revision": profile["revision"] if profile else "462165984030d82259a11f4367a4eed129e94a7b",
                              "digest": profile["distillation"]["checkpointSha256"] if profile else "local-sdxl-base"},
                    "prompt": prompt, "negativePrompt": "", "outputCount": 1,
                    "outputFormat": "png", "modelPolicy": "quality", "aspectRatio": "1:1",
                    "sampling": {"width": 1024, "height": 1024,
                                 "numInferenceSteps": profile["steps"] if profile else 24,
                                 "guidanceScale": profile["guidance"] if profile else 5},
                    "seed": seed, "addons": [], "outputDirectory": str(run_root),
                }
                if not profile:
                    request["model"] = baseline_model
                torch.cuda.synchronize()
                torch.cuda.reset_peak_memory_stats()
                started = time.monotonic()
                result = worker.generate(request, cache)
                torch.cuda.synchronize()
                elapsed = time.monotonic() - started
                image_path = run_root / result["outputs"][0]["fileName"]
                pixels = np.asarray(Image.open(image_path).convert("RGB"))
                if pixels.shape != (1024, 1024, 3):
                    raise RuntimeError("SDXL verification output has incorrect dimensions")
                record = {"architecture": architecture, "case": name, "seconds": elapsed,
                          "peakAllocatedBytes": torch.cuda.max_memory_allocated(),
                          "peakReservedBytes": torch.cuda.max_memory_reserved(),
                          "pixelSha256": hashlib.sha256(pixels.tobytes()).hexdigest(),
                          "pixelMean": float(pixels.mean()), "pixelStd": float(pixels.std()),
                          "image": str(image_path), "request": request, "response": result}
                summary["runs"].append(record)
                records.append(record)
                (output_root / "results.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
                print(json.dumps({key: record[key] for key in ("architecture", "case", "seconds", "peakAllocatedBytes", "pixelSha256", "pixelStd")}), flush=True)
                release_allocator(torch, device)
            if records[0]["pixelSha256"] != records[1]["pixelSha256"]:
                raise RuntimeError("Repeated SDXL seed produced different pixels")
            if profile:
                for record in records[2:]:
                    if records[1]["pixelSha256"] == record["pixelSha256"]:
                        raise RuntimeError(f"SDXL student ignored {record['case']}")
                pipeline = cache.value["pipeline"]
                generator = torch.Generator(device=device).manual_seed(42)
                timesteps = []
                def observe_timestep(module, args, kwargs):
                    timestep = kwargs.get("timestep", args[1] if len(args) > 1 else None)
                    timesteps.append(int(timestep.item()))
                handle = pipeline.unet.register_forward_pre_hook(observe_timestep, with_kwargs=True)
                try:
                    image = pipeline(prompt="a photo of a cat", width=1024, height=1024,
                                     num_inference_steps=profile["steps"], guidance_scale=0,
                                     timesteps=profile["distillation"]["timesteps"], generator=generator).images[0]
                finally:
                    handle.remove()
                digest = hashlib.sha256(np.asarray(image.convert("RGB")).tobytes()).hexdigest()
                if digest != records[0]["pixelSha256"] or timesteps != profile["distillation"]["timesteps"]:
                    raise RuntimeError("Production output differs from the direct publisher recipe")
                summary.setdefault("recipeAgreement", {})[architecture] = {"pixelSha256": digest, "unetTimesteps": timesteps}
                del pipeline, image, generator, handle
            cache.clear()
            gc.collect()
            torch.cuda.empty_cache()
        summary["passed"] = True
        summary["totalSeconds"] = time.monotonic() - STARTED_AT
        (output_root / "results.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    except Exception as error:
        summary["error"] = f"{type(error).__name__}: {error}"
        summary["totalSeconds"] = time.monotonic() - STARTED_AT
        (output_root / "results.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        raise
    finally:
        cache.clear()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path)
    parser.add_argument("--base-checkpoint", type=Path)
    parser.add_argument("--base-config", type=Path)
    parser.add_argument("--architectures", nargs="*", default=["stable-diffusion-xl-dmad-4step", "stable-diffusion-xl-dmad-1step"])
    parser.add_argument("--baseline", action="store_true")
    parser.add_argument("--teacher-checkpoint", type=Path)
    parser.add_argument("--teacher-config", type=Path)
    arguments = parser.parse_args()
    if arguments.base_checkpoint:
        if not arguments.base_config:
            parser.error("--base-config is required with --base-checkpoint")
        prepare_base(arguments.base_checkpoint, arguments.base_config, arguments.model_root)
    else:
        if not arguments.output_root:
            parser.error("--output-root is required for verification")
        if not arguments.architectures and not arguments.baseline:
            parser.error("Choose at least one student architecture or --baseline")
        baseline_model = None
        if arguments.baseline:
            if not arguments.teacher_checkpoint or not arguments.teacher_config:
                parser.error("--teacher-checkpoint and --teacher-config are required with --baseline")
            baseline_model = {"architecture": "stable-diffusion-xl", "packageKind": "single-file",
                              "path": str(arguments.teacher_checkpoint), "configPath": str(arguments.teacher_config),
                              "revision": "462165984030d82259a11f4367a4eed129e94a7b", "digest": "local-sdxl-base"}
        verify(arguments.model_root, arguments.output_root, arguments.architectures, baseline_model)


if __name__ == "__main__":
    main()
