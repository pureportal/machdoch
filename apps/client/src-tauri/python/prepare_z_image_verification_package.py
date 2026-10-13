import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath

from media_verification_components import verify_component


def prepare(checkpoint: Path, components: Path, publisher_path: Path, license_path: Path, output: Path) -> None:
    publisher = json.loads(publisher_path.read_text(encoding="utf-8"))
    reviewed_models = {
        "Tongyi-MAI/Z-Image-Turbo": ("z-image-turbo", 2168935, 2442439),
        "Tongyi-MAI/Z-Image": ("z-image", 2342797, 2635223),
    }
    if publisher["id"] not in reviewed_models or publisher["gated"]:
        raise ValueError("Choose reviewed public Z-Image publisher metadata")
    architecture, model_id, version_id = reviewed_models[publisher["id"]]
    license_text = license_path.read_text(encoding="utf-8")
    if "Apache License" not in license_text or "Version 2.0" not in license_text:
        raise ValueError("Choose the publisher Apache-2.0 licence")
    source = json.loads(checkpoint.with_suffix(".provenance.json").read_text(encoding="utf-8"))
    if source["modelId"] != model_id or source["versionId"] != version_id:
        raise ValueError("Choose the reviewed Civitai Z-Image checkpoint")
    with checkpoint.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != source["sha256"]:
        raise ValueError("The Civitai checkpoint digest changed")
    selected = [
        file for file in publisher["siblings"]
        if file["rfilename"] == "model_index.json"
        or file["rfilename"] == "transformer/config.json"
        or file["rfilename"].startswith(("scheduler/", "tokenizer/", "text_encoder/", "vae/"))
    ]
    records = []
    for file in selected:
        relative = PurePosixPath(file["rfilename"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Unsafe publisher component path")
        path = components.joinpath(*relative.parts)
        records.append({"path": str(relative), "sha256": verify_component(path, file)})
    import torch
    from diffusers import ZImageTransformer2DModel

    output.mkdir(parents=True, exist_ok=False)
    (output / "LICENSE").write_text(license_text, encoding="utf-8")
    for file in selected:
        if file["rfilename"] == "transformer/config.json":
            continue
        relative = PurePosixPath(file["rfilename"])
        destination = output.joinpath(*relative.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.link(components.joinpath(*relative.parts), destination)
    transformer = ZImageTransformer2DModel.from_single_file(
        str(checkpoint), config=str(components), subfolder="transformer",
        dtype=torch.bfloat16, local_files_only=True,
    )
    transformer.save_pretrained(output / "transformer", safe_serialization=True, max_shard_size="3GB")
    converted = []
    for path in sorted((output / "transformer").glob("*.safetensors")):
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        converted.append({"path": path.name, "sha256": digest, "bytes": path.stat().st_size})
    provenance = {
        "architecture": architecture, "publisher": publisher["id"],
        "publisherRevision": publisher["sha"], "license": "Apache-2.0",
        "checkpoint": source, "components": records, "convertedTransformer": converted,
        "conversion": "Diffusers ZImageTransformer2DModel.from_single_file", "dtype": "bfloat16",
    }
    (output / "provenance.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    print(json.dumps({"prepared": str(output), "publisherRevision": publisher["sha"], "checkpointSha256": source["sha256"]}), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--components", type=Path, required=True)
    parser.add_argument("--publisher", type=Path, required=True)
    parser.add_argument("--license", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    prepare(arguments.checkpoint, arguments.components, arguments.publisher, arguments.license, arguments.output)


if __name__ == "__main__":
    main()
