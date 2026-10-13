import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath

from media_verification_components import verify_component


def prepare(checkpoint: Path, components: Path, publisher_path: Path, license_path: Path, output: Path) -> None:
    publisher = json.loads(publisher_path.read_text(encoding="utf-8"))
    if publisher["id"] != "sd2-community/stable-diffusion-2-1" or publisher["gated"]:
        raise ValueError("Choose the reviewed SD 2.1 component publisher")
    if publisher["cardData"]["license"] != "openrail++":
        raise ValueError("The component publisher licence changed")
    source = json.loads(checkpoint.with_suffix(".provenance.json").read_text(encoding="utf-8"))
    if (source["modelId"], source["versionId"]) != (15303, 46259):
        raise ValueError("Choose the reviewed Civitai SD 2.1 checkpoint")
    with checkpoint.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != source["sha256"]:
        raise ValueError("The Civitai checkpoint digest changed")
    license_text = license_path.read_text(encoding="utf-8")
    if not all(value in license_text for value in (
        "CreativeML Open RAIL++-M License", "November 24, 2022", "Attachment A",
    )):
        raise ValueError("Choose the complete SD 2.1 model licence")
    selected = [
        file for file in publisher["siblings"]
        if file["rfilename"] in {"model_index.json", "README.md"}
        or file["rfilename"].endswith("config.json")
        or file["rfilename"].startswith("tokenizer/")
    ]
    records = []
    for file in selected:
        relative = PurePosixPath(file["rfilename"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Unsafe publisher component path")
        path = components.joinpath(*relative.parts)
        records.append({"path": str(relative), "sha256": verify_component(path, file)})
    scheduler = json.loads((components / "scheduler" / "scheduler_config.json").read_text(encoding="utf-8"))
    encoder = json.loads((components / "text_encoder" / "config.json").read_text(encoding="utf-8"))
    unet = json.loads((components / "unet" / "config.json").read_text(encoding="utf-8"))
    if scheduler["prediction_type"] != "v_prediction" or unet["cross_attention_dim"] != 1024:
        raise ValueError("Choose the SD 2.1 v-prediction configuration")
    if (encoder["hidden_size"], encoder["num_hidden_layers"]) != (1024, 23):
        raise ValueError("Choose the SD 2.1 penultimate OpenCLIP text encoder")
    if output.exists():
        raise ValueError("Choose a new verification package directory")
    import torch
    from diffusers import StableDiffusionPipeline

    pipeline = StableDiffusionPipeline.from_single_file(
        str(checkpoint), config=str(components), torch_dtype=torch.float16,
        local_files_only=True, use_safetensors=True,
    )
    pipeline.save_pretrained(output, safe_serialization=True, max_shard_size="3GB")
    (output / "LICENSE").write_text(license_text, encoding="utf-8")
    (output / "README.md").write_bytes((components / "README.md").read_bytes())
    converted = []
    for path in sorted(output.rglob("*.safetensors")):
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        converted.append({"path": path.relative_to(output).as_posix(), "sha256": digest, "bytes": path.stat().st_size})
    provenance = {
        "architecture": "stable-diffusion-2", "publisher": publisher["id"],
        "publisherRevision": publisher["sha"], "license": "CreativeML Open RAIL++-M",
        "checkpoint": source, "components": records, "convertedComponents": converted,
        "conversion": "Diffusers StableDiffusionPipeline.from_single_file", "dtype": "float16",
    }
    (output / "provenance.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    print(json.dumps({"prepared": str(output), "checkpointSha256": source["sha256"]}), flush=True)


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
