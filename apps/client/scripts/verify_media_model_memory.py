from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    worker_root = Path(__file__).resolve().parents[1] / "src-tauri/python"
    sys.path.insert(0, str(worker_root))
    import media_diffusers_worker as worker
    from media_model_memory import memory_snapshot, release_allocator

    torch, _ = worker._runtime()
    device, label, _ = worker._device(torch)
    if device == "cpu":
        raise RuntimeError("GPU verification requires CUDA, ROCm, or Metal")
    request = json.loads(args.request.read_text(encoding="utf-8"))
    baseline = memory_snapshot(torch, device)
    environment = {key: value for key, value in os.environ.items() if key not in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN")}
    environment.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", MIOPEN_FIND_MODE="2")
    if torch.version.hip and "HIP_VISIBLE_DEVICES" not in environment:
        environment["HIP_VISIBLE_DEVICES"] = str(torch.cuda.current_device())
        environment["MACHDOCH_MEDIA_CUDA_DEVICE"] = "0"
    responses = queue.Queue()
    progress = []
    with tempfile.TemporaryDirectory(prefix="machdoch-model-memory-") as directory:
        log_path = args.report.with_suffix(".log")
        with log_path.open("w", encoding="utf-8") as log:
            process = subprocess.Popen(
                [sys.executable, "-I", "-B", "-Xutf8", str(worker_root / "media_diffusers_worker.py"), "serve"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", env=environment,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )

            def read_output():
                for line in process.stdout:
                    responses.put(line)

            def read_diagnostics():
                for line in process.stderr:
                    log.write(line)
                    log.flush()
                    if line.startswith("MACHDOCH_PROGRESS "):
                        progress.append(json.loads(line.removeprefix("MACHDOCH_PROGRESS ")))

            readers = [threading.Thread(target=read_output), threading.Thread(target=read_diagnostics)]
            for reader in readers:
                reader.start()

            def send(command, payload=None):
                process.stdin.write(json.dumps({"command": command, "request": payload}) + "\n")
                process.stdin.flush()
                response = json.loads(responses.get(timeout=1800))
                if "error" in response:
                    raise RuntimeError(response["error"])
                return response

            try:
                runs = []
                for index in range(2):
                    output = Path(directory) / str(index)
                    output.mkdir()
                    started = time.monotonic()
                    result = send("generate", {**request, "seed": request["seed"] + index, "outputDirectory": str(output)})
                    record = {
                        "seconds": round(time.monotonic() - started, 3),
                        "retentionSeconds": result["retentionSeconds"],
                        "outputs": result["result"]["outputs"],
                        "loadingEvents": sum(event["stage"] == "Loading image model" for event in progress),
                        "memory": send("memory")["result"],
                    }
                    for item in record["outputs"]:
                        if not (output / item["fileName"]).is_file():
                            raise RuntimeError("Generation did not write its output")
                    runs.append(record)
                    print(json.dumps({"run": index + 1, **record}), flush=True)
                if [run["loadingEvents"] for run in runs] != [1, 1]:
                    raise RuntimeError("Repeated generation reloaded its model")
                process.stdin.close()
                process.wait(timeout=30)
                for reader in readers:
                    reader.join(timeout=10)
                release_allocator(torch, device)
                after = memory_snapshot(torch, device)
                report = {
                    "device": label, "torch": torch.__version__, "hip": torch.version.hip,
                    "baseline": baseline, "runs": runs, "workerExitCode": process.returncode,
                    "afterWorkerExit": after,
                    "releasedDriverBytes": after["freeBytes"] - runs[-1]["memory"]["freeBytes"],
                }
                args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
                print(json.dumps(report), flush=True)
                if process.returncode != 0:
                    raise RuntimeError("Worker did not exit cleanly")
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=30)
                for reader in readers:
                    reader.join(timeout=10)


if __name__ == "__main__":
    main()
