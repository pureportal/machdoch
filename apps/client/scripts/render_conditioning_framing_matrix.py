#!/usr/bin/env python3
"""Render subject-aware WAN conditioning previews for every native aspect."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageOps


WORKSPACE = Path(__file__).resolve().parents[1]
WORKER_PATH = WORKSPACE / "src-tauri" / "python" / "media_diffusers_worker.py"
ASPECTS = ("1:1", "16:9", "9:16", "21:9")


def load_worker() -> Any:
    spec = importlib.util.spec_from_file_location(
        "machdoch_media_worker",
        WORKER_PATH,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load worker module from {WORKER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_input(value: str) -> tuple[str, Path]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("Inputs use NAME=PATH")
    name, raw_path = value.split("=", 1)
    path = Path(raw_path).resolve(strict=True)
    if not name or not path.is_file():
        raise argparse.ArgumentTypeError(f"Invalid input: {value}")
    return name, path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--input",
        action="append",
        required=True,
        help="NAME=PATH; repeat for multiple source designs.",
    )
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    inputs = [parse_input(value) for value in args.input]
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    worker = load_worker()
    evidence: dict[str, Any] = {
        "schemaVersion": 1,
        "workerVersion": worker.WORKER_VERSION,
        "resolution": "quality-640",
        "subjects": {},
    }
    rendered: list[tuple[str, str, Image.Image]] = []
    for name, path in inputs:
        subject_evidence: dict[str, Any] = {
            "source": str(path),
            "aspects": {},
        }
        for aspect in ASPECTS:
            width, height = worker._video_dimensions(aspect, "quality-640")
            image, framing = worker._prepare_video_conditioning_frame(
                path,
                width,
                height,
                True,
            )
            file_name = f"{name}-{aspect.replace(':', 'x')}.png"
            image.save(output / file_name, format="PNG", compress_level=3)
            subject_evidence["aspects"][aspect] = {
                **framing,
                "fileName": file_name,
            }
            rendered.append((name, aspect, image))
        evidence["subjects"][name] = subject_evidence

    tile_width, tile_height = 480, 300
    contact = Image.new(
        "RGB",
        (tile_width * len(ASPECTS), tile_height * len(inputs)),
        (19, 23, 31),
    )
    draw = ImageDraw.Draw(contact)
    for row, (name, _) in enumerate(inputs):
        for column, aspect in enumerate(ASPECTS):
            image = next(
                item[2]
                for item in rendered
                if item[0] == name and item[1] == aspect
            )
            fitted = ImageOps.contain(
                image,
                (tile_width - 16, tile_height - 42),
                method=Image.Resampling.LANCZOS,
            )
            x = column * tile_width + (tile_width - fitted.width) // 2
            y = row * tile_height + 30 + (tile_height - 38 - fitted.height) // 2
            contact.paste(fitted, (x, y))
            draw.text(
                (column * tile_width + 8, row * tile_height + 8),
                f"{name} | {aspect} | native fit",
                fill=(240, 244, 252),
            )
    contact.save(output / "contact-sheet.png", format="PNG", compress_level=3)
    (output / "framing-evidence.json").write_text(
        json.dumps(evidence, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(output / "framing-evidence.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
