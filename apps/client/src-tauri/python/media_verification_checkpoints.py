from __future__ import annotations

import hashlib
from pathlib import Path
import shutil


def stage_checkpoint(checkpoint: Path, directory: Path, expected_digest: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    staged = directory / (expected_digest + ".safetensors")
    if staged.exists():
        with staged.open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual != expected_digest or staged.stat().st_size != checkpoint.stat().st_size:
            raise ValueError("The staged checkpoint failed verification")
        return staged
    if shutil.disk_usage(directory).free < checkpoint.stat().st_size + 5 * 1024 ** 3:
        raise ValueError("The staging drive needs room for the checkpoint and 5 GiB free space")
    partial = staged.with_suffix(".part")
    digest = hashlib.sha256()
    with checkpoint.open("rb") as source, partial.open("xb") as destination:
        while chunk := source.read(4 * 1024 ** 2):
            destination.write(chunk)
            digest.update(chunk)
    if digest.hexdigest() != expected_digest:
        raise ValueError("The Civitai checkpoint digest changed during staging")
    partial.replace(staged)
    return staged
