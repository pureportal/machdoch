#!/usr/bin/env python3
"""Render a reviewed source-anchored manifest through Media Studio's worker."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "src-tauri" / "python" / "media_diffusers_worker.py"
PINNED_PYTHON = (
    ROOT / "src-tauri" / "python" / "runtime" / "Scripts" / "python.exe"
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output_directory", type=Path)
    parser.add_argument(
        "--encoding-quality",
        choices=("preview", "production", "lossless"),
        default="lossless",
    )
    parser.add_argument("--python", type=Path, default=PINNED_PYTHON)
    arguments = parser.parse_args()

    manifest = arguments.manifest.resolve()
    if not manifest.is_file():
        parser.error(f"Manifest does not exist: {manifest}")
    python = arguments.python.resolve()
    if not python.is_file():
        parser.error(f"Media Studio runtime does not exist: {python}")
    output = arguments.output_directory.resolve()
    if output.exists() and any(output.iterdir()):
        parser.error(f"Output directory is not empty: {output}")
    output.mkdir(parents=True, exist_ok=True)

    request = {
        "manifestPath": str(manifest),
        "outputDirectory": str(output),
        "encodingQuality": arguments.encoding_quality,
    }
    completed = subprocess.run(
        [str(python), str(WORKER), "render-source-anchored-loop"],
        input=json.dumps(request),
        capture_output=True,
        text=True,
        timeout=60 * 60,
        check=False,
    )
    try:
        response = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            "Media Studio worker returned invalid JSON:\n"
            + completed.stderr[-4_000:]
        ) from error
    if completed.returncode != 0 or response.get("error"):
        raise RuntimeError(
            str(response.get("error") or "Media Studio worker failed")
            + ("\n" + completed.stderr[-4_000:] if completed.stderr else "")
        )
    print(json.dumps(response, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
