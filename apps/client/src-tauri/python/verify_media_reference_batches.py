import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
import traceback

from media_reference_verification import save_results


def run_batches(manifest_path: Path, results_path: Path, hip_device: str) -> bool:
    batches = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(batches, list) or not batches:
        raise ValueError("Provide at least one reference batch")
    for batch in batches:
        for field in ("template", "cases"):
            if not Path(batch[field]).is_file():
                raise ValueError(f"Missing batch {field}: {batch[field]}")
    results = {"technicalChecksOnly": True, "batches": [], "passed": False}
    results_path.parent.mkdir(parents=True, exist_ok=True)
    for batch in batches:
        record = {"name": batch["name"], "outputRoot": batch["outputRoot"], "passed": False}
        print(json.dumps({"startingBatch": batch["name"]}), flush=True)
        started = time.monotonic()
        try:
            command = [sys.executable, "-B", str(Path(__file__).with_name("verify_media_reference_sweep.py")),
                       "--template", batch["template"], "--cases", batch["cases"],
                       "--output-root", batch["outputRoot"], "--hip-device", hip_device]
            if batch.get("captureDecoderLatents", False):
                command.append("--capture-decoder-latents")
            result = subprocess.run(command, check=False)
            record["exitCode"] = result.returncode
            record["passed"] = result.returncode == 0
        except Exception as error:
            traceback.print_exc()
            record["error"] = f"{type(error).__name__}: {error}"
        record["seconds"] = time.monotonic() - started
        results["batches"].append(record)
        results["passed"] = len(results["batches"]) == len(batches) and all(
            result["passed"] for result in results["batches"]
        )
        save_results(results_path, results)
        print(json.dumps(record), flush=True)
    return results["passed"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batches", type=Path, required=True)
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--hip-device", default="1")
    arguments = parser.parse_args()
    return 0 if run_batches(arguments.batches, arguments.results, arguments.hip_device) else 1


if __name__ == "__main__":
    raise SystemExit(main())
