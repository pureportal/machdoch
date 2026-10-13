import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time

import numpy as np
from PIL import Image


PROMPT = "A ceramic red teapot on a wooden table beside a window, soft daylight, realistic photograph."


def run_generation(python: Path, worker: Path, encoded: str, environment: dict[str, str], stdout, stderr, timeout_seconds: int) -> int:
    with subprocess.Popen(
        [str(python), "-I", "-B", "-Xutf8", "-Xfaulthandler", str(worker), "generate"],
        stdin=subprocess.PIPE, text=True, encoding="utf-8", env=environment,
        stdout=stdout, stderr=stderr,
    ) as process:
        try:
            process.communicate(input=encoded, timeout=timeout_seconds)
        except BaseException:
            if process.poll() is None:
                if os.name == "nt":
                    subprocess.run(
                        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                        stdout=subprocess.DEVNULL, stderr=stderr, check=True, timeout=30,
                    )
                else:
                    process.kill()
                process.wait(timeout=30)
            raise
        return process.wait()


def verify(storage_root: Path, output_root: Path, python: Path, hip_device: str | None, model_ids: list[str], *, prompt: str = PROMPT, negative_prompt: str = "", sampling: dict | None = None, seed: int = 41791, aspect_ratio: str = "16:9", addons: list[dict] | None = None, timeout_seconds: int = 4 * 60 * 60) -> bool:
    prompt = prompt.strip()
    negative_prompt = negative_prompt.strip()
    if timeout_seconds < 1:
        raise ValueError("Generation timeout must be positive")
    output_root.mkdir(parents=True, exist_ok=False)
    with sqlite3.connect((storage_root / "media.sqlite3").as_uri() + "?mode=ro", uri=True) as database:
        database.row_factory = sqlite3.Row
        models = [dict(row) for row in database.execute(
            "SELECT m.id, m.display_name, m.architecture, i.revision, i.manifest_digest, i.relative_path "
            "FROM media_models m JOIN media_model_installations i ON i.model_id = m.id "
            "WHERE i.status = 'installed' AND m.target = 'local' "
            "AND EXISTS (SELECT 1 FROM json_each(m.capabilities_json) WHERE value = 'text-to-image') "
            "ORDER BY m.architecture, m.id"
        )]
    if model_ids:
        requested_ids = set(model_ids)
        installed_ids = {model["id"] for model in models}
        if requested_ids - installed_ids:
            raise ValueError("Requested image models are not installed: " + ", ".join(sorted(requested_ids - installed_ids)))
        installed_models = {model["id"]: model for model in models}
        models = [installed_models[model_id] for model_id in dict.fromkeys(model_ids)]
    if not models:
        raise ValueError("No installed image models found")
    environment = dict(os.environ)
    for name in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"):
        environment.pop(name, None)
    environment.update({
        "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1", "DO_NOT_TRACK": "1", "MIOPEN_FIND_MODE": "2",
        "PYTHONFAULTHANDLER": "1",
    })
    if hip_device is not None:
        environment.update({"HIP_VISIBLE_DEVICES": hip_device, "MACHDOCH_MEDIA_CUDA_DEVICE": "0"})
    worker = Path(__file__).with_name("media_diffusers_worker.py")
    tensor_reader = worker.parent / "fizgig" / "utils" / "safetensors.py"
    summary = {"python": str(python), "worker": str(worker),
               "workerSha256": hashlib.sha256(worker.read_bytes()).hexdigest(),
               "tensorReader": str(tensor_reader),
               "tensorReaderSha256": hashlib.sha256(tensor_reader.read_bytes()).hexdigest(), "models": []}
    for index, model in enumerate(models):
        directory = output_root / f"{index + 1:02d}-{model['architecture']}-{model['revision'][:12]}"
        directory.mkdir()
        images = directory / "images"
        images.mkdir()
        package = storage_root / "models" / model["relative_path"]
        checkpoint = package / "checkpoint.safetensors"
        request = {
            "schemaVersion": 5,
            "model": {
                "id": model["id"], "architecture": model["architecture"],
                "packageKind": "single-file" if checkpoint.is_file() else "diffusers-directory",
                "path": str(checkpoint if checkpoint.is_file() else package),
                "configPath": str(package / "config") if checkpoint.is_file() else None,
                "revision": model["revision"], "digest": model["manifest_digest"],
            },
            "prompt": prompt, "negativePrompt": negative_prompt, "outputCount": 1, "outputFormat": "png",
            "modelPolicy": "quality", "aspectRatio": aspect_ratio, "seed": seed,
            "sampling": sampling or {}, "addons": addons or [], "referenceImages": [], "memoryProfile": "auto",
            "requireChromaBackground": False, "outputDirectory": str(images),
            "modelCacheDirectory": str(storage_root / "cache" / "image-models"),
        }
        encoded = json.dumps(request)
        (directory / "request.json").write_text(encoded, encoding="utf-8")
        record = {"id": model["id"], "name": model["display_name"], "architecture": model["architecture"],
                  "directory": str(directory), "workerSha256": hashlib.sha256(worker.read_bytes()).hexdigest(),
                  "tensorReaderSha256": hashlib.sha256(tensor_reader.read_bytes()).hexdigest(),
                  "passed": False}
        print(json.dumps({"starting": record["name"], "directory": str(directory)}), flush=True)
        started = time.monotonic()
        try:
            with (directory / "response.json").open("w", encoding="utf-8") as stdout, \
                    (directory / "worker.log").open("w", encoding="utf-8") as stderr:
                exit_code = run_generation(python, worker, encoded, environment, stdout, stderr, timeout_seconds)
            record["exitCode"] = exit_code
            response_text = (directory / "response.json").read_text(encoding="utf-8")
            if not response_text.strip():
                raise RuntimeError(f"Worker exited with {exit_code} without a generation response")
            response = json.loads(response_text)
            if exit_code != 0 or response.get("error"):
                raise RuntimeError(response.get("error") or f"Worker exited with {exit_code}")
            mismatched_fields = [key for key in (
                "schemaVersion", "prompt", "negativePrompt", "modelPolicy", "aspectRatio", "requireChromaBackground",
            ) if response.get(key) != request[key]]
            if mismatched_fields:
                raise ValueError(f"Generation evidence does not match the request fields: {', '.join(mismatched_fields)}")
            if len(response["outputs"]) != 1:
                raise ValueError("Generation returned an unexpected output count")
            if sampling and sampling.get("sampler") != response.get("sampler"):
                raise ValueError("Generation returned an unexpected sampler")
            output = response["outputs"][0]
            if output["seed"] != request["seed"]:
                raise ValueError("Generation returned an unexpected seed")
            image_path = images / output["fileName"]
            with Image.open(image_path) as image:
                image.load()
                pixels = np.asarray(image.convert("RGB"))
                if image.size != (output["width"], output["height"]) or pixels.std() <= 1:
                    raise ValueError("Generation returned invalid image pixels")
            record.update({"passed": True, "image": str(image_path), "width": output["width"],
                           "height": output["height"], "numInferenceSteps": response["numInferenceSteps"],
                           "workerVersion": response["workerVersion"], "deviceLabel": response["deviceLabel"],
                           "sampler": response.get("sampler"), "schedulerClass": response.get("schedulerClass"),
                           "guidanceScale": response.get("guidanceScale"),
                           "sha256": hashlib.sha256(image_path.read_bytes()).hexdigest()})
        except (OSError, ValueError, KeyError, RuntimeError, subprocess.TimeoutExpired) as error:
            record["error"] = f"{type(error).__name__}: {error}"
        record["seconds"] = time.monotonic() - started
        summary["models"].append(record)
        summary["passed"] = len(summary["models"]) == len(models) and all(item["passed"] for item in summary["models"])
        (output_root / "results.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        print(json.dumps(record), flush=True)
    return summary["passed"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--storage-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--python", type=Path, default=Path(sys.executable))
    parser.add_argument("--hip-device")
    parser.add_argument("--model-id", action="append", default=[])
    parser.add_argument("--prompt-file", type=Path)
    parser.add_argument("--negative-prompt-file", type=Path)
    parser.add_argument("--addons-file", type=Path)
    parser.add_argument("--sampler")
    parser.add_argument("--steps", type=int)
    parser.add_argument("--guidance", type=float)
    parser.add_argument("--width", type=int)
    parser.add_argument("--height", type=int)
    parser.add_argument("--aspect-ratio", default="16:9", choices=["1:1", "4:5", "16:9", "9:16"])
    parser.add_argument("--seed", type=int, default=41791)
    parser.add_argument("--timeout-seconds", type=int, default=4 * 60 * 60)
    arguments = parser.parse_args()
    return 0 if verify(arguments.storage_root.resolve(), arguments.output_root.resolve(),
                       arguments.python.resolve(), arguments.hip_device, arguments.model_id,
                       prompt=arguments.prompt_file.read_text(encoding="utf-8") if arguments.prompt_file else PROMPT,
                       negative_prompt=arguments.negative_prompt_file.read_text(encoding="utf-8") if arguments.negative_prompt_file else "",
                       sampling={key: value for key, value in {"sampler": arguments.sampler, "numInferenceSteps": arguments.steps, "guidanceScale": arguments.guidance, "width": arguments.width, "height": arguments.height}.items() if value is not None},
                       seed=arguments.seed, aspect_ratio=arguments.aspect_ratio,
                       timeout_seconds=arguments.timeout_seconds,
                       addons=json.loads(arguments.addons_file.read_text(encoding="utf-8")) if arguments.addons_file else None) else 1


if __name__ == "__main__":
    raise SystemExit(main())
