from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import urllib.request

from media_verification_components import verify_component

SOURCES = {
    "qwen-image": ("Qwen/Qwen-Image", "75e0b4be04f60ec59a75f475837eced720f823b6"),
    "qwen-image-2512": ("Qwen/Qwen-Image-2512", "25468b98e3276ca6700de15c6628e51b7de54a26"),
    "qwen-image-2.1": ("Qwen/Qwen-Image-2.1", "d26bb61231c349cf6b7896fa83353113880e1ba3"),
    "qwen-image-2.1-turbo": ("Qwen/Qwen-Image-2.1-Turbo", "d65dbc9a7e8f6b5479e33dee6030eaab2a906509"),
}


def prepare(root: Path, checkpoint: Path, architecture: str) -> None:
    repository, revision = SOURCES[architecture]
    root.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(f"https://huggingface.co/api/models/{repository}/revision/{revision}?blobs=true", timeout=60) as response:
        specification = json.load(response)
    if specification["sha"] != revision:
        raise ValueError("The Qwen source revision changed")
    files = [file for file in specification["siblings"] if (
        file["rfilename"] in ("model_index.json", "LICENSE", "NOTICE", "transformer/config.json")
        or file["rfilename"].startswith(("processor/", "tokenizer/", "scheduler/", "text_encoder/", "vae/"))
    )]
    files.sort(key=lambda file: file["size"])
    provenance = []
    for file in files:
        relative = Path(file["rfilename"])
        if relative.is_absolute() or ".." in relative.parts or relative.suffix in (".py", ".bin", ".pt", ".pth"):
            raise ValueError("The Qwen package contains an unsupported file")
        destination = root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        expected = file.get("lfs", {}).get("sha256")
        if destination.exists():
            actual = verify_component(destination, file)
            provenance.append({"path": relative.as_posix(), "bytes": file["size"], "sha256": actual})
            continue
        partial = destination.with_suffix(destination.suffix + ".part")
        digest = hashlib.sha256()
        git_digest = hashlib.sha1(f"blob {file['size']}\0".encode())
        received = 0
        next_progress = 1024 ** 3
        with urllib.request.urlopen(f"https://huggingface.co/{repository}/resolve/{revision}/{relative.as_posix()}", timeout=120) as response, partial.open("wb") as stream:
            while chunk := response.read(4 * 1024 ** 2):
                stream.write(chunk)
                digest.update(chunk)
                git_digest.update(chunk)
                received += len(chunk)
                if received >= next_progress:
                    print(json.dumps({"file": relative.as_posix(), "bytes": received}), flush=True)
                    next_progress += 1024 ** 3
        actual = digest.hexdigest()
        if received != file["size"] or (expected and actual != expected) or (not expected and git_digest.hexdigest() != file["blobId"]):
            raise ValueError(f"The Qwen component digest is incorrect: {relative}")
        partial.replace(destination)
        provenance.append({"path": relative.as_posix(), "bytes": received, "sha256": actual})
        print(json.dumps({"verified": relative.as_posix(), "bytes": received}), flush=True)
    generated_notices = []
    if architecture in ("qwen-image-2.1", "qwen-image-2.1-turbo"):
        notice = (
            "Qwen is licensed under the Qwen RESEARCH LICENSE AGREEMENT, Copyright (c) 2026 "
            "Hangzhou Tongyi Laboratory Technology Co., Ltd. All Rights Reserved."
        )
        license_text = (root / "LICENSE").read_text(encoding="utf-8")
        if notice not in license_text:
            raise ValueError("The pinned Qwen research licence does not contain the expected attribution")
        notice_path = root / "NOTICE"
        existing_notice = notice_path.read_text(encoding="utf-8") if notice_path.is_file() else ""
        if notice not in existing_notice:
            notice_path.write_text(existing_notice.rstrip() + ("\n\n" if existing_notice else "") + notice + "\n", encoding="utf-8")
            generated_notices.append({"path": "NOTICE", "sha256": hashlib.sha256(notice_path.read_bytes()).hexdigest(),
                                      "source": "Required attribution from the publisher's LICENSE"})
    index_path = root / "model_index.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    index["machdoch_quantization"] = {"transformer": {"format": "gguf", "file": "transformer/model.gguf"}}
    index["_machdoch_modifications"] = "Machdoch added GGUF checkpoint routing metadata; publisher component weights are unchanged."
    index_path.write_text(json.dumps(index, indent=2), encoding="utf-8")
    os.link(checkpoint, root / "transformer" / "model.gguf")
    manifest = {"repository": repository, "revision": revision, "components": provenance}
    if generated_notices:
        manifest["generatedNotices"] = generated_notices
    (root / "source-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({"package": str(root), "revision": revision}), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--architecture", required=True, choices=tuple(SOURCES))
    arguments = parser.parse_args()
    prepare(arguments.root.resolve(), arguments.checkpoint.resolve(strict=True), arguments.architecture)


if __name__ == "__main__":
    main()
