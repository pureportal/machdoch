import argparse
import hashlib
import json
import os
import fnmatch
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--root", type=Path, required=True)
parser.add_argument("--model", choices=["moss-base", "moss-sft", "flux3", "flux3-gguf", "flux3-vae", "qwen3vl4b", "sd15"], required=True)
args = parser.parse_args()
root = args.root.resolve()
os.environ["HF_HOME"] = str(root / "cache" / "huggingface")
os.environ["HF_HUB_CACHE"] = str(root / "cache" / "huggingface" / "hub")
os.environ["TORCH_HOME"] = str(root / "cache" / "torch")
os.environ["HF_HUB_DISABLE_XET"] = "1"
os.environ["TMP"] = str(root / "cache" / "tmp")
Path(os.environ["TMP"]).mkdir(parents=True, exist_ok=True)

from huggingface_hub import HfApi

models = {
    "moss-base": ("OpenMOSS-Team/MOSS-Image-Base", "85975793d8b3d432f1b6e27f352abaa4c2a4c0d3"),
    "moss-sft": ("OpenMOSS-Team/MOSS-Image-SFT", "f972bd4b4b9e3852133cc5da954d87bc32cd8fb9"),
    "flux3": ("black-forest-labs/flux-3-image-klein", "337337621b8526e120f2275d250242f4a6bedd75"),
    "flux3-gguf": ("unsloth/flux-3-image-klein-GGUF", "12ef13ce920d53f45fe805093910c899668b9e76"),
    "flux3-vae": ("Comfy-Org/flux2-dev", "ed33133cd56476eac818c0943b6f9419b3e4a3a1"),
    "qwen3vl4b": ("Qwen/Qwen3-VL-4B-Instruct", "ebb281ec70b05090aa6165b016eac8ec08e71b17"),
    "sd15": ("stable-diffusion-v1-5/stable-diffusion-v1-5", "451f4fe16113bff5a5d2269ed5ad43b0592e9a14"),
}
repo, revision = models[args.model]
destination = root / "models" / "layout" / args.model / revision
info = HfApi().model_info(repo, revision=revision, files_metadata=True)
patterns = ["*.json", "tokenizer/*", "text_encoder/*", "transformer/*", "vae/*", "scheduler/*", "LICENSE*", "NOTICE*"]
if args.model == "qwen3vl4b":
    patterns += ["*.txt", "*.jinja", "model-*.safetensors"]
if args.model == "sd15":
    patterns += ["unet/*", "safety_checker/*", "feature_extractor/*"]
if args.model == "flux3-gguf":
    patterns += ["flux-3-image-klein-UD-Q4_K_XL.gguf"]
if args.model == "flux3-vae":
    patterns = ["split_files/vae/flux2-vae.safetensors", "LICENSE*"]
print(json.dumps({"model": repo, "revision": revision, "destination": str(destination)}), flush=True)
verified_sources = {}
for manifest in (root / "layout-control/evidence").glob("*-files.json"):
    existing = json.loads(manifest.read_text(encoding="utf-8"))
    if "repo" not in existing:
        continue
    for entry in existing["files"]:
        verified_sources[entry["sha256"]] = (Path(existing["path"]) / entry["path"], entry["bytes"])
def acquire(item):
    name = item.rfilename
    if not any(fnmatch.fnmatch(name, pattern) for pattern in patterns) or any(fnmatch.fnmatch(name, pattern) for pattern in ["*.py", "*.bin", "*.msgpack", "*.fp16.safetensors", "*.non_ema.safetensors", "assets/*", "variants/*", "model.safetensors", "ae.safetensors"]):
        return
    path = destination / name
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file() and path.stat().st_size == item.size:
        return
    if item.lfs and item.lfs.sha256 in verified_sources:
        source, size = verified_sources[item.lfs.sha256]
        if source.is_file() and source.stat().st_size == size == item.size:
            if hashlib.file_digest(source.open("rb"), "sha256").hexdigest() != item.lfs.sha256:
                raise ValueError(f"Existing component failed verification: {source}")
            os.link(source, path)
            print(json.dumps({"reused": name, "bytes": size}), flush=True)
            return
    partial = path.with_suffix(path.suffix + ".partial")
    if not partial.exists() and item.lfs:
        candidates = list(destination.glob(f".cache/huggingface/download/**/*{item.lfs.sha256}*.incomplete"))
        if candidates:
            candidate = max(candidates, key=lambda entry: entry.stat().st_size)
            if candidate.stat().st_size <= item.size:
                candidate.rename(partial)
    total = item.size
    offset = partial.stat().st_size if partial.exists() else 0
    with partial.open("ab") as output:
        while offset < total:
            end = min(total - 1, offset + 16 * 1024 * 1024 - 1)
            url = f"https://huggingface.co/{repo}/resolve/{revision}/{name}?download=true&offset={offset}"
            for attempt in range(3):
                try:
                    request = urllib.request.Request(url, headers={"Range": f"bytes={offset}-{end}"})
                    with urllib.request.urlopen(request, timeout=45) as response:
                        if response.status == 206 and response.headers.get("Content-Range") != f"bytes {offset}-{end}/{total}":
                            raise ValueError(f"Unexpected byte range for {name}")
                        if response.status != 206 and not (offset == 0 and end + 1 == total):
                            raise ValueError(f"Server ignored byte range for {name}")
                        data = response.read(end - offset + 2)
                    if len(data) != end - offset + 1:
                        raise ValueError(f"Incomplete byte range for {name}")
                    break
                except Exception:
                    if attempt == 2:
                        raise
            output.write(data)
            output.flush()
            offset += len(data)
            if offset == total or offset // (512 * 1024 * 1024) != (offset - len(data)) // (512 * 1024 * 1024):
                print(json.dumps({"file": name, "downloaded": offset, "total": total}), flush=True)
    partial.replace(path)

with ThreadPoolExecutor(max_workers=3) as executor:
    list(executor.map(acquire, info.siblings))
files = []
for item in info.siblings:
    path = destination / item.rfilename
    if not path.is_file():
        continue
    digest = hashlib.file_digest(path.open("rb"), "sha256").hexdigest()
    if item.lfs and digest != item.lfs.sha256:
        raise ValueError(f"Checksum mismatch: {item.rfilename}")
    if item.size is not None and path.stat().st_size != item.size:
        raise ValueError(f"Size mismatch: {item.rfilename}")
    files.append({"path": item.rfilename, "bytes": path.stat().st_size, "sha256": digest})
evidence = {"repo": repo, "revision": revision, "path": str(destination), "files": files}
evidence_dir = root / "layout-control" / "evidence"
evidence_dir.mkdir(parents=True, exist_ok=True)
(evidence_dir / f"{args.model}-files.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
print(json.dumps({"verifiedFiles": len(files), "bytes": sum(item["bytes"] for item in files)}), flush=True)
