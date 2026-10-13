import hashlib
from pathlib import Path


def verify_component(path: Path, metadata: dict) -> str:
    if path.stat().st_size != metadata["size"]:
        raise ValueError(f"Unexpected component size: {metadata['rfilename']}")
    if metadata.get("lfs"):
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if digest != metadata["lfs"]["sha256"]:
            raise ValueError(f"Unexpected component digest: {metadata['rfilename']}")
        return digest
    data = path.read_bytes()
    blob = b"blob " + str(len(data)).encode("ascii") + b"\0" + data
    if hashlib.sha1(blob).hexdigest() != metadata["blobId"]:
        raise ValueError(f"Unexpected configuration digest: {metadata['rfilename']}")
    return hashlib.sha256(data).hexdigest()
