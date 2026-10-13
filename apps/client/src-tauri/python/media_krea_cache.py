from pathlib import Path
import shutil
from typing import Callable


def select_cache_directory(signature: str, primary_root: Path, storage_root: Path, required_bytes: int,
                           validate: Callable[[Path, str], bool]) -> Path:
    roots = list(dict.fromkeys([primary_root, storage_root]))
    if any(not root.is_absolute() for root in roots):
        raise ValueError("The image cache directory must be an absolute path")
    for root in roots:
        candidate = root / signature
        if validate(candidate, signature):
            return candidate
    for root in roots:
        existing_parent = next((path for path in (root, *root.parents) if path.is_dir()), None)
        if existing_parent is not None and shutil.disk_usage(existing_parent).free >= required_bytes:
            return root / signature
    raise ValueError(f"The image cache needs {required_bytes / 1024**3:.1f} GiB free. Free space on the system or Media Studio storage drive.")
