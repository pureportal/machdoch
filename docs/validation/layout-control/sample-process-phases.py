import argparse
import csv
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import time

import psutil

parser = argparse.ArgumentParser()
parser.add_argument("--root", type=Path, required=True)
parser.add_argument("--store", type=Path, required=True)
parser.add_argument("--run", required=True)
parser.add_argument("--app-pid", type=int, required=True)
args = parser.parse_args()
directory = args.root / "layout-control/runs" / args.run
application = psutil.Process(args.app_pid)
deadline = time.monotonic() + 4 * 60 * 60
samples = 0
matting_samples = 0
overlapping_samples = 0
worker_pids = set()
with sqlite3.connect(f"file:{args.store.as_posix()}/media.sqlite3?mode=ro", uri=True) as connection, (directory / "process-phases.csv").open("w", newline="", encoding="utf-8") as stream:
    writer = csv.DictWriter(stream, fieldnames=["utc", "status", "stage", "rawAssets", "preparedAssets", "workerPids", "workerPrivateBytes", "appPrivateBytes"])
    writer.writeheader()
    while time.monotonic() < deadline:
        status, stage = connection.execute("SELECT status,current_step FROM runs WHERE id=?", (f"layout-{args.run}",)).fetchone()
        assets = [json.loads(row[0])["generation"] for row in connection.execute("SELECT operation_json FROM assets WHERE run_id=? AND id LIKE 'asset:layout:%'", (f"layout-{args.run}",))]
        raw = sum(bool(asset.get("generation", {}).get("workerVersion")) for asset in assets)
        prepared = sum("source" in asset and "cutout" in asset for asset in assets)
        workers = []
        private_bytes = 0
        for child in application.children(recursive=True):
            try:
                if child.name().lower() == "python.exe":
                    workers.append(child.pid)
                    private_bytes += child.memory_info().private
            except psutil.NoSuchProcess:
                continue
        worker_pids.update(workers)
        if prepared and status == "running":
            matting_samples += 1
            overlapping_samples += bool(workers)
        writer.writerow({"utc": datetime.now(timezone.utc).isoformat(), "status": status, "stage": stage,
                         "rawAssets": raw, "preparedAssets": prepared, "workerPids": json.dumps(sorted(workers)),
                         "workerPrivateBytes": private_bytes, "appPrivateBytes": application.memory_info().private})
        stream.flush()
        samples += 1
        if status in ("completed", "failed", "canceled"):
            result = {"samples": samples, "rawAssets": raw, "preparedAssets": prepared, "observedPythonPids": sorted(worker_pids),
                      "samplesAfterFirstCutoutWhileRunning": matting_samples, "samplesWithPythonAfterFirstCutout": overlapping_samples,
                      "status": status, "scope": "One-second process-tree and retained-asset observations; Python launcher and worker PIDs are both included."}
            (directory / "process-phases.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
            print(json.dumps(result))
            break
        time.sleep(1)
    else:
        raise TimeoutError("Workflow did not finish before the sampling deadline")
