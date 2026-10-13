import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath

from media_verification_components import verify_component
from media_verification_checkpoints import stage_checkpoint


def prepare(checkpoint: Path, components: Path, publisher_path: Path, license_path: Path, output: Path) -> None:
    publisher = json.loads(publisher_path.read_text(encoding="utf-8"))
    profiles = {
        "black-forest-labs/FLUX.2-klein-4B": ("flux-2", True, (2341785, 2634080)),
        "black-forest-labs/FLUX.2-klein-base-4B": ("flux-2-klein-base-4b", False, (2322332, 2612552)),
    }
    profile = profiles.get(publisher["id"])
    if profile is None or publisher["gated"]:
        raise ValueError("Choose the reviewed public Flux Klein 4B publisher")
    architecture, distilled, source_ids = profile
    if publisher["cardData"]["license"] != "apache-2.0":
        raise ValueError("The publisher licence changed")
    source = json.loads(checkpoint.with_suffix(".provenance.json").read_text(encoding="utf-8"))
    if (source["modelId"], source["versionId"]) != source_ids:
        raise ValueError("Choose the reviewed Civitai Flux Klein 4B checkpoint")
    staged = stage_checkpoint(checkpoint, Path(__file__).resolve().parents[4] / ".cache/image-conversion", source["sha256"])
    print(json.dumps({"stagedCheckpoint": str(staged), "sha256": source["sha256"]}), flush=True)
    license_text = license_path.read_text(encoding="utf-8")
    if "Apache License" not in license_text or "Version 2.0" not in license_text:
        raise ValueError("Choose the publisher Apache-2.0 licence")
    selected = [
        file for file in publisher["siblings"]
        if file["rfilename"] in {"model_index.json", "transformer/config.json"}
        or file["rfilename"].startswith(("scheduler/", "tokenizer/", "text_encoder/", "vae/"))
    ]
    records = []
    for file in selected:
        relative = PurePosixPath(file["rfilename"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Unsafe publisher component path")
        path = components.joinpath(*relative.parts)
        records.append({"path": str(relative), "sha256": verify_component(path, file)})
    index = json.loads((components / "model_index.json").read_text(encoding="utf-8"))
    if index["_class_name"] != "Flux2KleinPipeline" or index.get("is_distilled", False) is not distilled:
        raise ValueError("Choose the matching original Flux Klein pipeline configuration")
    index["is_distilled"] = distilled
    config = json.loads((components / "transformer" / "config.json").read_text(encoding="utf-8"))
    if config["num_attention_heads"] * config["attention_head_dim"] != 3072:
        raise ValueError("The original transformer configuration is not Klein 4B")
    import torch
    from diffusers import Flux2Transformer2DModel
    from safetensors.torch import load_file

    output.mkdir(parents=True, exist_ok=False)
    (output / "LICENSE").write_text(license_text, encoding="utf-8")
    (output / "model_index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
    for file in selected:
        if file["rfilename"] in {"transformer/config.json", "model_index.json"}:
            continue
        relative = PurePosixPath(file["rfilename"])
        destination = output.joinpath(*relative.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.link(components.joinpath(*relative.parts), destination)
    weights = load_file(str(staged))
    weights = {name.removeprefix("model.diffusion_model."): tensor for name, tensor in weights.items()}
    transformer = Flux2Transformer2DModel.from_single_file(
        weights, config=str(components), subfolder="transformer",
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
        "pipelineConfig": {"is_distilled": distilled},
        "conversion": "Diffusers Flux2Transformer2DModel.from_single_file", "dtype": "bfloat16",
        "tensorNames": "Civitai diffusion-model prefix removed before upstream conversion",
        "stagedCheckpoint": str(staged),
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
