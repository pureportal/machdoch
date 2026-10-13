import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re

from media_verification_components import verify_component
from media_verification_checkpoints import stage_checkpoint


def flux_dev_distribution_notice(license_text: str) -> str:
    attribution = re.search(
        r"“(The FLUX\.1 \[dev\] Model is licensed.*?USE OF THIS MODEL\.)”",
        license_text, re.DOTALL,
    )
    if attribution is None:
        raise ValueError("The publisher's Flux Dev attribution notice is missing")
    retained = "\n".join(line.strip() for line in attribution.group(1).splitlines())
    return retained + (
        "\n\nMachdoch converted the Civitai checkpoint to Diffusers file and tensor-key layout "
        "in bfloat16; no fine-tuning was performed. This converted package is not an official "
        "Black Forest Labs product and is not endorsed by Black Forest Labs.\n"
    )


def prepare(architecture: str, checkpoint: Path, components: Path, publisher_path: Path, license_path: Path, clip_license: Path, t5_license: Path, output: Path) -> None:
    schnell = architecture == "flux-1-schnell"
    repository = "black-forest-labs/FLUX.1-schnell" if schnell else "black-forest-labs/FLUX.1-dev"
    version_id = 699279 if schnell else 691639
    license_name = "Apache-2.0" if schnell else "FLUX.1 [dev] Non-Commercial License"
    publisher = json.loads(publisher_path.read_text(encoding="utf-8"))
    if publisher["id"] != repository or schnell and publisher["cardData"]["license"] != "apache-2.0":
        raise ValueError("Choose the reviewed Flux publisher")
    source = json.loads(checkpoint.with_suffix(".provenance.json").read_text(encoding="utf-8"))
    if (source["modelId"], source["versionId"]) != (618692, version_id):
        raise ValueError("Choose the reviewed Civitai Flux checkpoint")
    staged = stage_checkpoint(checkpoint, Path(__file__).resolve().parents[4] / ".cache/image-conversion", source["sha256"])
    print(json.dumps({"stagedCheckpoint": str(staged), "sha256": source["sha256"]}), flush=True)
    license_text = license_path.read_text(encoding="utf-8")
    clip_text = clip_license.read_text(encoding="utf-8")
    t5_text = t5_license.read_text(encoding="utf-8")
    if schnell and ("Apache License" not in license_text or "Version 2.0" not in license_text):
        raise ValueError("Choose the complete Apache-2.0 licence")
    if not schnell:
        license_metadata = next(file for file in publisher["siblings"] if file["rfilename"] == "LICENSE.md")
        verify_component(license_path, license_metadata)
        if "FLUX.1 [dev] Non-Commercial License" not in license_text:
            raise ValueError("Choose the original Flux Dev licence")
    if "MIT License" not in clip_text or "OpenAI" not in clip_text:
        raise ValueError("Choose the original CLIP component licence")
    if "Apache License" not in t5_text or "Version 2.0" not in t5_text:
        raise ValueError("Choose the complete T5 Apache-2.0 licence")
    selected = [file for file in publisher["siblings"] if (
        file["rfilename"] in {"model_index.json", "transformer/config.json", "README.md"}
        or file["rfilename"].startswith(("scheduler/", "tokenizer/", "tokenizer_2/", "text_encoder/", "text_encoder_2/", "vae/"))
    )]
    records = []
    for file in selected:
        relative = PurePosixPath(file["rfilename"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Unsafe publisher component path")
        records.append({"path": str(relative), "sha256": verify_component(components.joinpath(*relative.parts), file)})
    index = json.loads((components / "model_index.json").read_text(encoding="utf-8"))
    config = json.loads((components / "transformer" / "config.json").read_text(encoding="utf-8"))
    if index["_class_name"] != "FluxPipeline" or config["guidance_embeds"] != (not schnell):
        raise ValueError("Choose the original Flux variant configuration")
    if (config["num_layers"], config["num_single_layers"]) != (19, 38):
        raise ValueError("The transformer configuration does not match Flux")
    if output.exists():
        raise ValueError("Choose a new verification package directory")
    import torch
    from diffusers import FluxTransformer2DModel
    from safetensors.torch import load_file

    output.mkdir(parents=True)
    (output / "LICENSE").write_text(license_text, encoding="utf-8")
    if not schnell:
        (output / "NOTICE").write_text(flux_dev_distribution_notice(license_text), encoding="utf-8")
    for file in selected:
        if file["rfilename"] == "transformer/config.json":
            continue
        relative = PurePosixPath(file["rfilename"])
        destination = output.joinpath(*relative.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.link(components.joinpath(*relative.parts), destination)
    (output / "text_encoder" / "LICENSE").write_text(clip_text, encoding="utf-8")
    (output / "text_encoder_2" / "LICENSE").write_text(t5_text, encoding="utf-8")
    transformer = FluxTransformer2DModel.from_single_file(
        load_file(str(staged)), config=str(components), subfolder="transformer",
        dtype=torch.bfloat16, local_files_only=True,
    )
    transformer.save_pretrained(output / "transformer", safe_serialization=True, max_shard_size="3GB")
    del transformer
    converted = []
    for path in sorted((output / "transformer").glob("*.safetensors")):
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        converted.append({"path": path.name, "sha256": digest, "bytes": path.stat().st_size})
    provenance = {
        "architecture": architecture, "publisher": publisher["id"], "publisherRevision": publisher["sha"],
        "license": license_name, "clipLicense": "MIT", "t5License": "Apache-2.0", "checkpoint": source, "components": records,
        "convertedTransformer": converted, "conversion": "Diffusers FluxTransformer2DModel.from_single_file",
        "sourceReader": "safetensors.torch.load_file", "dtype": "bfloat16",
        "stagedCheckpoint": str(staged),
    }
    (output / "provenance.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    print(json.dumps({"prepared": str(output), "checkpointSha256": source["sha256"]}), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--architecture", choices=("flux-1-schnell", "flux-1-dev"), required=True)
    for name in ("checkpoint", "components", "publisher", "license", "clip-license", "t5-license", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    arguments = parser.parse_args()
    prepare(arguments.architecture, arguments.checkpoint, arguments.components, arguments.publisher, arguments.license, arguments.clip_license, arguments.t5_license, arguments.output)


if __name__ == "__main__":
    main()
