from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from prepare_qwen_verification_package import SOURCES, prepare


def prepare_shared(original: Path, checkpoint: Path, publishers: Path, output: Path) -> None:
    completed = json.loads((original / "source-manifest.json").read_text(encoding="utf-8"))
    repository, revision = SOURCES["qwen-image"]
    if (completed["repository"], completed["revision"]) != (repository, revision):
        raise ValueError("Choose the verified original Qwen component package")
    original_metadata = json.loads((publishers / "qwen-image-publisher-current.json").read_text(encoding="utf-8"))
    target_metadata = json.loads((publishers / "qwen-image-2512-publisher-current.json").read_text(encoding="utf-8"))
    if original_metadata["sha"] != revision or target_metadata["sha"] != SOURCES["qwen-image-2512"][1]:
        raise ValueError("The shared component publisher revisions do not match")
    originals = {file["rfilename"]: file for file in original_metadata["siblings"]}
    output.mkdir(parents=True, exist_ok=False)
    shared = []
    for file in target_metadata["siblings"]:
        name = file["rfilename"]
        if Path(name).is_absolute() or ".." in Path(name).parts:
            raise ValueError("Unsafe publisher component path")
        origin = originals.get(name)
        source = original / name
        if name == "model_index.json" or origin is None or not source.is_file():
            continue
        identity = file.get("lfs", {}).get("sha256", file["blobId"])
        origin_identity = origin.get("lfs", {}).get("sha256", origin["blobId"])
        if file["size"] != origin["size"] or identity != origin_identity:
            continue
        destination = output / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.link(source, destination)
        shared.append(name)
    os.link(original / "LICENSE", output / "LICENSE")
    print(json.dumps({"sharedComponents": len(shared)}), flush=True)
    prepare(output, checkpoint, "qwen-image-2512")
    manifest_path = output / "source-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["sharedComponents"] = shared
    manifest["licenseSource"] = {"repository": repository, "revision": revision, "file": "LICENSE"}
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    for name in ("original", "checkpoint", "publishers", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    arguments = parser.parse_args()
    prepare_shared(arguments.original, arguments.checkpoint, arguments.publishers, arguments.output)


if __name__ == "__main__":
    main()
