import argparse
import json
import os
from pathlib import Path, PurePosixPath
import shutil

from media_verification_components import verify_component


def prepare(checkpoint: Path, components: Path, publisher_path: Path, gguf_publisher_path: Path, licenses: Path, output: Path) -> None:
    publisher = json.loads(publisher_path.read_text(encoding="utf-8"))
    gguf_publisher = json.loads(gguf_publisher_path.read_text(encoding="utf-8"))
    if publisher["id"] != "diffusers/FLUX.2-dev-bnb-4bit" or gguf_publisher["id"] != "city96/FLUX.2-dev-gguf":
        raise ValueError("Choose the reviewed FLUX.2 Dev companion and GGUF publishers")
    source = json.loads(checkpoint.with_suffix(".provenance.json").read_text(encoding="utf-8"))
    if (source["modelId"], source["versionId"]) != (2167454, 2441386):
        raise ValueError("Choose the reviewed Civitai FLUX.2 Dev Q4_K_M checkpoint")
    gguf = next(file for file in gguf_publisher["siblings"] if file["rfilename"] == "flux2-dev-Q4_K_M.gguf")
    digest = verify_component(checkpoint, gguf)
    if digest != source["sha256"]:
        raise ValueError("The Civitai checkpoint does not match the original City96 weights")
    selected = [
        file for file in publisher["siblings"]
        if file["rfilename"] != ".gitattributes" and not file["rfilename"].startswith("transformer/")
    ]
    records = []
    for file in selected:
        relative = PurePosixPath(file["rfilename"])
        if relative.is_absolute() or ".." in relative.parts or "\\" in file["rfilename"]:
            raise ValueError("Unsafe publisher component path")
        path = components.joinpath(*relative.parts)
        if path.is_symlink():
            raise ValueError("Publisher components must be regular files")
        records.append({"path": str(relative), "sha256": verify_component(path, file)})
    config_file = next(file for file in publisher["siblings"] if file["rfilename"] == "transformer/config.json")
    config_path = components / "transformer/config.json"
    config_digest = verify_component(config_path, config_file)
    index = json.loads((components / "model_index.json").read_text(encoding="utf-8"))
    if index["_class_name"] != "Flux2Pipeline":
        raise ValueError("Choose the full FLUX.2 Dev pipeline configuration")
    configuration = json.loads(config_path.read_text(encoding="utf-8"))
    if configuration["num_attention_heads"] != 48 or configuration["joint_attention_dim"] != 15360:
        raise ValueError("Choose the full FLUX.2 Dev 32B transformer configuration")
    configuration.pop("quantization_config")
    configuration.pop("_name_or_path", None)
    index["machdoch_quantization"] = {"transformer": {"format": "gguf", "file": "transformer/model.gguf"}}
    for name, required in [("LICENSE-FLUX-DEV.txt", "FLUX.2 [dev]"), ("LICENSE-Mistral.txt", "Apache License")]:
        if required not in (licenses / name).read_text(encoding="utf-8"):
            raise ValueError(f"Choose the publisher license: {name}")
    output.mkdir(parents=True, exist_ok=False)
    for file in selected:
        if file["rfilename"] == "model_index.json":
            continue
        relative = PurePosixPath(file["rfilename"])
        destination = output.joinpath(*relative.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.link(components.joinpath(*relative.parts), destination)
    transformer = output / "transformer"
    transformer.mkdir()
    os.link(checkpoint, transformer / "model.gguf")
    (transformer / "config.json").write_text(json.dumps(configuration, indent=2), encoding="utf-8")
    (output / "model_index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
    for name in ("LICENSE-FLUX-DEV.txt", "LICENSE-Mistral.txt"):
        shutil.copyfile(licenses / name, output / name)
    (output / "NOTICE.txt").write_text(
        "The FLUX [dev] Model is licensed by Black Forest Labs Inc. under the FLUX [dev] Non-Commercial License. Copyright Black Forest Labs Inc.\n\n"
        "IN NO EVENT SHALL BLACK FOREST LABS INC. BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH USE OF THIS MODEL.\n\n"
        "City96 converted the transformer to GGUF. Hugging Face's Diffusers team quantized the companion encoder. Machdoch assembles the local Diffusers folder and declares the GGUF transformer; downloaded weight bytes are unchanged.\n"
        "Mistral Small 3.2 is by Mistral AI, under the Apache License, Version 2.0.\n",
        encoding="utf-8",
    )
    provenance = {
        "architecture": "flux-2-dev", "checkpoint": source,
        "publisher": publisher["id"], "publisherRevision": publisher["sha"],
        "ggufPublisher": gguf_publisher["id"], "ggufPublisherRevision": gguf_publisher["sha"],
        "components": records, "originalTransformerConfigurationSha256": config_digest,
        "transformerConfigurationChanges": ["replace serialized NF4 metadata with the declared GGUF component", "remove publisher-local path"],
        "weightChanges": False, "localTextEncoder": "Mistral3ForConditionalGeneration NF4",
    }
    (output / "provenance.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    print(json.dumps({"prepared": str(output), "checkpointSha256": digest}), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    for name in ("checkpoint", "components", "publisher", "gguf-publisher", "licenses", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    arguments = parser.parse_args()
    prepare(arguments.checkpoint, arguments.components, arguments.publisher, arguments.gguf_publisher, arguments.licenses, arguments.output)


if __name__ == "__main__":
    main()
