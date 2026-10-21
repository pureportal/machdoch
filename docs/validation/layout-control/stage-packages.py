import argparse
import hashlib
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--root", type=Path, required=True)
parser.add_argument("--models-root", type=Path)
parser.add_argument("--model", choices=["moss-base", "moss-sft", "flux3"], action="append", required=True)
args = parser.parse_args()
root = args.root.resolve()
for name in args.model:
    receipt = json.loads((root / "layout-control/evidence" / f"{name}-files.json").read_text())
    slug = "flux-3-image-klein" if name == "flux3" else name.replace("moss-", "moss-image-")
    target = (args.models_root or root / "models") / "packages" / slug / "revisions" / receipt["revision"]
    for item in receipt["files"]:
        source = Path(receipt["path"]) / item["path"]
        destination = target / item["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            os.link(source, destination)
        elif not os.path.samefile(source, destination):
            with destination.open("rb") as handle:
                if hashlib.file_digest(handle, "sha256").hexdigest() != item["sha256"]:
                    raise ValueError(f"Conflicting model file: {destination}")
        if destination.stat().st_size != item["bytes"]:
            raise ValueError(f"Model size mismatch: {destination}")
    print(json.dumps({"model": slug, "files": len(receipt["files"]), "path": str(target)}))
