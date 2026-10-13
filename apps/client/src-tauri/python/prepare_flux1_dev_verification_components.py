import argparse
import json
import os
from pathlib import Path, PurePosixPath
import urllib.parse
import urllib.request

from media_verification_components import verify_component


def prepare(root: Path, shared: Path, output: Path) -> None:
    publisher = json.loads((root / "flux-1-dev-publisher-current.json").read_text(encoding="utf-8"))
    mirror = json.loads((root / "flux-1-dev-public-component-mirror.json").read_text(encoding="utf-8"))
    schnell = json.loads((root / "flux-1-schnell-publisher-current.json").read_text(encoding="utf-8"))
    if publisher["id"] != "black-forest-labs/FLUX.1-dev" or mirror["gated"]:
        raise ValueError("Choose the reviewed publisher and public component mirror")
    if output.exists():
        raise ValueError("Choose a new component directory")
    original_files = {file["rfilename"]: file for file in schnell["siblings"]}
    mirror_files = {file["rfilename"]: file for file in mirror["siblings"]}
    selected = [file for file in publisher["siblings"] if (
        file["rfilename"] in {"LICENSE.md", "README.md", "model_index.json", "transformer/config.json"}
        or file["rfilename"].startswith(("scheduler/", "tokenizer/", "tokenizer_2/", "text_encoder/", "text_encoder_2/", "vae/"))
    )]
    output.mkdir(parents=True)
    records = []
    for metadata in selected:
        filename = metadata["rfilename"]
        relative = PurePosixPath(filename)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Unsafe publisher component path")
        destination = output.joinpath(*relative.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        original = original_files.get(filename)
        if original is not None and original["blobId"] == metadata["blobId"]:
            origin = shared.joinpath(*relative.parts)
            digest = verify_component(origin, metadata)
            os.link(origin, destination)
            source = "verified-schnell-component"
        elif filename == "LICENSE.md":
            origin = root / "flux-1-dev-primary-configs" / filename
            digest = verify_component(origin, metadata)
            destination.write_bytes(origin.read_bytes())
            source = "original-publisher"
        else:
            mirrored = mirror_files.get(filename)
            if mirrored is None or mirrored["blobId"] != metadata["blobId"]:
                raise ValueError(f"The public mirror differs from the publisher: {filename}")
            url = f"https://huggingface.co/{mirror['id']}/resolve/{mirror['sha']}/{urllib.parse.quote(filename)}"
            with urllib.request.urlopen(url, timeout=45) as response:
                destination.write_bytes(response.read())
            digest = verify_component(destination, metadata)
            source = "publisher-identical-public-mirror"
        record = {"path": filename, "bytes": metadata["size"], "sha256": digest, "source": source}
        records.append(record)
        print(json.dumps(record), flush=True)
    result = {"publisher": publisher["id"], "revision": publisher["sha"],
              "mirror": mirror["id"], "mirrorRevision": mirror["sha"], "components": records}
    (output / "component-provenance.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({"preparedComponents": str(output), "files": len(records)}), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    for name in ("root", "shared", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    arguments = parser.parse_args()
    prepare(arguments.root, arguments.shared, arguments.output)


if __name__ == "__main__":
    main()
