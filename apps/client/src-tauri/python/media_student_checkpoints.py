"""Identity validation for released diffusion students."""

import hashlib
from pathlib import Path


def checkpoint_path(root: Path, student: dict) -> Path:
    relative = Path(student["checkpointFile"])
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("Invalid student checkpoint path")
    path = root / relative
    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"Import the student checkpoint at {relative.as_posix()}")
    if path.stat().st_size != student["checkpointByteSize"]:
        raise ValueError("The student checkpoint is incomplete. Download the published checkpoint again.")
    with path.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != student["checkpointSha256"]:
        raise ValueError("The student checkpoint does not match the selected model. Import the published checkpoint.")
    return path
