import argparse
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import json
import os
from pathlib import Path
import time
from unittest.mock import patch


def verify(request_path: Path, output: Path) -> None:
    os.environ.update({
        "HIP_VISIBLE_DEVICES": "1", "MACHDOCH_MEDIA_CUDA_DEVICE": "0",
        "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "MIOPEN_FIND_MODE": "2",
    })
    import media_diffusers_worker as worker
    from media_model_memory import ModelPipelineCache

    output.mkdir(parents=True, exist_ok=False)
    request = json.loads(request_path.read_text(encoding="utf-8"))
    if request["model"]["architecture"] not in ("stable-diffusion-1", "stable-diffusion-2"):
        raise ValueError("Choose an SD1 or SD2 request")
    torch, _ = worker._runtime()
    device, _, _ = worker._device(torch)
    records = []
    for dtype in (torch.float32, torch.bfloat16):
        name = str(dtype).removeprefix("torch.")
        directory = output / name
        directory.mkdir()
        images = directory / "images"
        images.mkdir()
        diagnostic_request = {**request, "outputDirectory": str(images)}
        (directory / "request.json").write_text(json.dumps(diagnostic_request), encoding="utf-8")
        started = time.monotonic()
        cache = ModelPipelineCache(torch, device, worker.PROCESS_STARTED_AT)
        try:
            with (directory / "worker.log").open("w", encoding="utf-8") as log:
                with redirect_stdout(log), redirect_stderr(log), patch.object(worker, "_pipeline_dtype", return_value=dtype):
                    response = worker.generate(diagnostic_request, cache)
            (directory / "response.json").write_text(json.dumps(response), encoding="utf-8")
            image_path = images / response["outputs"][0]["fileName"]
            record = {"dtype": name, "image": str(image_path), "sha256": hashlib.sha256(image_path.read_bytes()).hexdigest()}
        finally:
            cache.clear()
        record["seconds"] = time.monotonic() - started
        records.append(record)
        print(json.dumps(record), flush=True)
        evidence = {
            "diagnosticOnly": True, "pipelineDtypeOverridden": True,
            "request": str(request_path), "workerSha256": hashlib.sha256(Path(worker.__file__).read_bytes()).hexdigest(),
            "sameRequestAndSeed": True, "records": records,
        }
        (output / "precision-comparison.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    verify(arguments.request, arguments.output)
