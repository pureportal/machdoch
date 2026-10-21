import argparse
import csv
import ctypes
from ctypes import wintypes
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import time


class PerformanceInfo(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD)] + [(name, ctypes.c_size_t) for name in (
        "commit", "commitLimit", "commitPeak", "physical", "available", "systemCache",
        "kernel", "kernelPaged", "kernelNonpaged", "pageSize",
    )] + [(name, wintypes.DWORD) for name in ("handles", "processes", "threads")]


parser = argparse.ArgumentParser()
parser.add_argument("--root", type=Path, required=True)
parser.add_argument("--run", required=True)
parser.add_argument("--run-id")
parser.add_argument("--store", type=Path)
args = parser.parse_args()
directory = args.root / "layout-control/runs" / args.run
directory.mkdir(exist_ok=True)
database = (args.store or args.root / "layout-control/desktop-store") / "media.sqlite3"
query = ctypes.WinDLL("psapi", use_last_error=True).GetPerformanceInfo
query.argtypes = [ctypes.POINTER(PerformanceInfo), wintypes.DWORD]
query.restype = wintypes.BOOL
peak_commit = 0
minimum_available = None
count = 0
active_samples = 0
deadline = time.monotonic() + 4 * 60 * 60
with sqlite3.connect(database) as connection, (directory / "system-memory.csv").open("w", newline="", encoding="utf-8") as stream:
    writer = csv.DictWriter(stream, fieldnames=["utc", "committedBytes", "commitLimitBytes", "availablePhysicalBytes", "runStatus"])
    writer.writeheader()
    while time.monotonic() < deadline:
        info = PerformanceInfo()
        info.size = ctypes.sizeof(info)
        if not query(ctypes.byref(info), info.size):
            raise ctypes.WinError(ctypes.get_last_error())
        row = connection.execute("SELECT status FROM runs WHERE id=?", (args.run_id or f"layout-{args.run}",)).fetchone()
        status = row[0] if row else "not-started"
        committed = info.commit * info.pageSize
        available = info.available * info.pageSize
        peak_commit = max(peak_commit, committed)
        minimum_available = available if minimum_available is None else min(minimum_available, available)
        writer.writerow({"utc": datetime.now(timezone.utc).isoformat(), "committedBytes": committed,
                         "commitLimitBytes": info.commitLimit * info.pageSize, "availablePhysicalBytes": available, "runStatus": status})
        stream.flush()
        count += 1
        active_samples += status in ("queued", "running", "canceling")
        if status in ("completed", "failed", "canceled"):
            break
        time.sleep(1)
result = {"samples": count, "activeRunSamples": active_samples, "maximumSampledSystemCommitBytes": peak_commit,
          "minimumSampledAvailablePhysicalBytes": minimum_available, "finalStatus": status,
          "scope": "One-second whole-system samples, including other applications; not per-process or GPU peaks."}
(directory / "system-memory.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps(result))
