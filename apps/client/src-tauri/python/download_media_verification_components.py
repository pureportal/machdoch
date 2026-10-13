import argparse
import json
from pathlib import Path, PurePosixPath
import re
import urllib.parse
import urllib.request

from media_verification_components import verify_component


def download(publisher_path: Path, selected_files: list[str], output: Path) -> None:
    publisher = json.loads(publisher_path.read_text(encoding="utf-8"))
    repository = publisher["id"]
    revision = publisher["sha"]
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repository) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Choose pinned publisher metadata")
    files = {file["rfilename"]: file for file in publisher["siblings"]}
    records = []
    for filename in selected_files:
        relative = PurePosixPath(filename)
        if relative.is_absolute() or ".." in relative.parts or "\\" in filename or filename not in files:
            raise ValueError("Choose a publisher component path")
        destination = output.joinpath(*relative.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            url = f"https://huggingface.co/{repository}/resolve/{revision}/{urllib.parse.quote(filename)}"
            request = urllib.request.Request(url, headers={"User-Agent": "machdoch-media-studio/1.0"})
            partial = destination.with_suffix(destination.suffix + ".part")
            with urllib.request.urlopen(request, timeout=90) as response, partial.open("wb") as stream:
                while chunk := response.read(4 * 1024**2):
                    stream.write(chunk)
            digest = verify_component(partial, files[filename])
            partial.replace(destination)
        else:
            digest = verify_component(destination, files[filename])
        record = {"path": filename, "sha256": digest, "bytes": destination.stat().st_size}
        records.append(record)
        print(json.dumps(record), flush=True)
    provenance = {"publisher": repository, "revision": revision, "components": records}
    (output / "component-provenance.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--publisher", type=Path, required=True)
    parser.add_argument("--file", action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    download(arguments.publisher, arguments.file, arguments.output)


if __name__ == "__main__":
    main()
