import argparse
from contextlib import ExitStack, redirect_stdout, redirect_stderr
import hashlib
import json
import logging
import os
from pathlib import Path
import sys
import time
import traceback
from typing import TextIO
from unittest.mock import patch

import media_diffusers_worker as worker
from media_model_memory import ModelPipelineCache, release_allocator
from media_reference_verification import completed_case, runtime_digest, save_results, validate_response


WORKER_PATH = Path(worker.__file__).resolve()
WORKER_DIGEST = hashlib.sha256(WORKER_PATH.read_bytes()).hexdigest()
READER_PATH = WORKER_PATH.parent / "fizgig" / "utils" / "safetensors.py"
READER_DIGEST = hashlib.sha256(READER_PATH.read_bytes()).hexdigest()
RUNTIME_DIGEST = runtime_digest(WORKER_PATH.parent)


def _route_library_logs(stream: TextIO) -> None:
    for name in ("diffusers", "transformers", "peft", "huggingface_hub"):
        for handler in logging.getLogger(name).handlers:
            if isinstance(handler, logging.StreamHandler) and not isinstance(handler, logging.FileHandler):
                handler.setStream(stream)


def verify(template_path: Path, cases_path: Path, output_root: Path, hip_device: str, capture_decoder_latents: bool, stop_on_failure: bool = False) -> bool:
    template = json.loads(template_path.read_text(encoding="utf-8"))
    cases = json.loads(cases_path.read_text(encoding="utf-8"))
    if not isinstance(cases, list) or not cases:
        raise ValueError("Provide at least one reference case")
    architecture = template["model"]["architecture"]
    decoder_classes = {
        "stable-diffusion-1": "AutoencoderKL",
        "stable-diffusion-2": "AutoencoderKL",
        "stable-diffusion-3": "AutoencoderKL",
        "stable-diffusion-xl": "AutoencoderKL",
        "pony": "AutoencoderKL",
        "qwen-image": "AutoencoderKLQwenImage",
        "qwen-image-2512": "AutoencoderKLQwenImage",
        "qwen-image-2.1": "AutoencoderKLQwenImage21",
        "qwen-image-2.1-turbo": "AutoencoderKLQwenImage21",
        "krea-2": "AutoencoderKLQwenImage",
        "krea-2-raw": "AutoencoderKLQwenImage",
        "krea-2-turbo": "AutoencoderKLQwenImage",
        "flux-2-dev": "AutoencoderKLFlux2",
        "stable-diffusion-3.5-large-turbo": "AutoencoderKL",
    }
    if capture_decoder_latents and architecture not in decoder_classes:
        raise ValueError(f"Decoder latent capture is unavailable for {architecture}")
    output_root = output_root.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    summary_path = output_root / "results.json"
    previous = json.loads(summary_path.read_text(encoding="utf-8"))["models"] if summary_path.is_file() else []
    for name in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"):
        os.environ.pop(name, None)
    os.environ.update({
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "DO_NOT_TRACK": "1",
        "MIOPEN_FIND_MODE": "2",
        "HIP_VISIBLE_DEVICES": hip_device,
        "MACHDOCH_MEDIA_CUDA_DEVICE": "0",
    })
    summary = {
        "worker": str(WORKER_PATH),
        "workerSha256": WORKER_DIGEST,
        "tensorReaderSha256": READER_DIGEST,
        "runtimeSha256": RUNTIME_DIGEST,
        "residentWorker": True,
        "models": previous.copy(),
        "passed": False,
    }
    cache = None
    torch = diffusers = None
    completed = []
    log_stack = ExitStack()
    try:
        for index, case in enumerate(cases):
            reference_id = case["id"]
            model = template["model"]
            request = dict(template)
            request.update({
                "prompt": Path(case["promptFile"]).read_text(encoding="utf-8").strip(),
                "negativePrompt": Path(case["negativePromptFile"]).read_text(encoding="utf-8").strip() if case.get("negativePromptFile") else "",
                "aspectRatio": case["aspectRatio"],
                "seed": case["seed"],
                "sampling": {**template.get("sampling", {}), **case["sampling"]},
                "addons": case.get("addons", template["addons"]),
            })
            reused = completed_case(previous, reference_id, request, RUNTIME_DIGEST,
                                    capture_decoder_latents, output_root)
            if reused is not None:
                completed.append(reused)
                print(json.dumps({"reused": reused["directory"], "referenceId": reference_id}), flush=True)
                continue
            name = f"{index + 1:02d}-{model['architecture']}-reference-{reference_id}"
            directory = output_root / name
            attempt = 1
            while directory.exists():
                attempt += 1
                directory = output_root / f"{name}-attempt-{attempt}"
            directory.mkdir()
            images = directory / "images"
            images.mkdir()
            request["outputDirectory"] = str(images)
            (directory / "request.json").write_text(json.dumps(request), encoding="utf-8")
            record = {
                "id": model["id"],
                "name": case["modelName"],
                "architecture": model["architecture"],
                "referenceId": reference_id,
                "directory": str(directory),
                "workerSha256": WORKER_DIGEST,
                "tensorReaderSha256": READER_DIGEST,
                "runtimeSha256": RUNTIME_DIGEST,
                "originalPrompt": case["originalPrompt"],
                "passed": False,
            }
            summary["models"].append(record)
            save_results(summary_path, summary)
            print(json.dumps({"starting": record["name"], "referenceId": reference_id}), flush=True)
            started = time.monotonic()
            log = log_stack.enter_context((directory / "worker.log").open("w", encoding="utf-8"))
            with redirect_stdout(log), redirect_stderr(log), ExitStack() as generation_stack:
                try:
                    if cache is None:
                        if torch is None:
                            torch, diffusers = worker._runtime()
                        device, _, _ = worker._device(torch)
                        cache = ModelPipelineCache(torch, device, worker.PROCESS_STARTED_AT)
                    _route_library_logs(log)
                    if capture_decoder_latents:
                        from safetensors.torch import save_file

                        vae_class = getattr(diffusers, decoder_classes[architecture])
                        original_decode = vae_class.decode

                        def capture_decode(vae, latents, *arguments, **options):
                            save_file({"latents": latents.detach().cpu().contiguous()}, str(directory / "decoder-latents.safetensors"))
                            return original_decode(vae, latents, *arguments, **options)

                        generation_stack.enter_context(patch.object(vae_class, "decode", capture_decode))
                    response = worker.generate(request, cache)
                    if architecture in ("qwen-image", "qwen-image-2512"):
                        encoder = cache.value["pipeline"].text_encoder
                        record["textEncoder"] = {
                            "class": type(encoder).__name__,
                            "loadedIn4Bit": encoder.is_loaded_in_4bit,
                            "quantizationTypes": sorted({parameter.quant_type for parameter in encoder.parameters() if hasattr(parameter, "quant_type")}),
                            "parameterAndBufferBytes": encoder.get_memory_footprint(),
                        }
                    release_allocator(cache.torch, cache.device)
                    (directory / "response.json").write_text(json.dumps(response), encoding="utf-8")
                    record.update(validate_response(request, response))
                except Exception as error:
                    traceback.print_exc(file=log)
                    record["error"] = f"{type(error).__name__}: {error}"
                    if cache is not None:
                        cache.clear()
            log.flush()
            record["seconds"] = time.monotonic() - started
            completed.append(record)
            save_results(summary_path, summary)
            print(json.dumps(record), flush=True)
            if stop_on_failure and not record["passed"]:
                break
        summary["passed"] = len(completed) == len(cases) and all(item["passed"] for item in completed)
        save_results(summary_path, summary)
    finally:
        try:
            if cache is not None:
                cache.clear()
        finally:
            try:
                _route_library_logs(sys.stderr)
            finally:
                log_stack.close()
    return summary["passed"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", type=Path, required=True)
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--hip-device", default="1")
    parser.add_argument("--capture-decoder-latents", action="store_true")
    parser.add_argument("--stop-on-failure", action="store_true")
    arguments = parser.parse_args()
    return 0 if verify(arguments.template, arguments.cases, arguments.output_root, arguments.hip_device, arguments.capture_decoder_latents, arguments.stop_on_failure) else 1


if __name__ == "__main__":
    raise SystemExit(main())
