import argparse
import hashlib
import json
import os
from pathlib import Path
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--root", type=Path, required=True)
args = parser.parse_args()
root = args.root.resolve()
evidence = root / "layout-control/evidence"
receipts = {name: json.loads((evidence / f"{name}-files.json").read_text(encoding="utf-8")) for name in ("flux3-gguf", "qwen3vl4b", "flux3-vae")}
package = root / "models/layout/flux3-klein-ud-q4-k-xl"
package.mkdir(parents=True, exist_ok=True)
files = []

def link(name, source_name, relative):
    receipt = receipts[name]
    entry = next(entry for entry in receipt["files"] if entry["path"] == source_name)
    source = Path(receipt["path"]) / source_name
    target = package / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.stat().st_size != entry["bytes"]:
        raise ValueError(f"Source changed: {source}")
    if target.exists():
        if not os.path.samefile(source, target):
            raise ValueError(f"Existing package file differs: {target}")
    else:
        os.link(source, target)
    files.append({"path": relative, "bytes": entry["bytes"], "sha256": entry["sha256"], "source": {"repo": receipt["repo"], "revision": receipt["revision"], "file": source_name}})

def write(relative, data, source):
    target = package / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.read_bytes() != data:
        raise ValueError(f"Existing package configuration differs: {target}")
    target.write_bytes(data)
    files.append({"path": relative, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "source": source})

link("flux3-gguf", "flux-3-image-klein-UD-Q4_K_XL.gguf", "transformer/model.gguf")
for name in ("LICENSE.md", "NOTICE.md"):
    link("flux3-gguf", name, name)
for entry in receipts["qwen3vl4b"]["files"]:
    link("qwen3vl4b", entry["path"], "text_encoder/" + entry["path"])
vae_file = next(entry for entry in receipts["flux3-vae"]["files"] if entry["path"].endswith("flux2-vae.safetensors"))
assert vae_file["sha256"] == "d64f3a68e1cc4f9f4e29b6e0da38a0204fe9a49f2d4053f0ec1fa1ca02f9c4b5"
link("flux3-vae", vae_file["path"], "vae/diffusion_pytorch_model.safetensors")
url = "https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/resolve/e7b7dc27f91deacad38e78976d1f2b499d76a294/vae/config.json"
with urllib.request.urlopen(url, timeout=30) as response:
    vae_config = response.read()
write("vae/config.json", vae_config, {"url": url, "architectureVerifiedAgainst": "https://github.com/black-forest-labs/flux-3-image-klein/blob/bfc8889a4497f846416f253a3972a1941ac698b9/src/flux3/autoencoder.py"})
config = {"_class_name": "Flux3Transformer2DModel", "in_channels": 128, "cond_in_channels": 128, "num_layers": 5, "num_single_layers": 28,
          "attention_head_dim": 128, "num_attention_heads": 24, "joint_attention_dim": 20480, "timestep_channels": 256,
          "mlp_ratio": 3.0, "axes_dims_rope": [32, 32, 32, 32], "rope_theta": 10000, "eps": 1e-6, "flow_map": True}
write("transformer/config.json", json.dumps(config, indent=2).encode(), {"definition": "https://github.com/black-forest-labs/flux-3-image-klein/blob/bfc8889a4497f846416f253a3972a1941ac698b9/src/flux3/dit.py", "format": "pinned-diffusers-Flux3Transformer2DModel"})
index = {"_class_name": "Flux3DistilledModularPipeline", "machdoch_quantization": {"transformer": {"format": "gguf", "file": "transformer/model.gguf"}}}
for name, library, cls, folder in [("transformer", "diffusers", "Flux3Transformer2DModel", "transformer"), ("text_encoder", "transformers", "Qwen3VLForConditionalGeneration", "text_encoder"),
                                  ("tokenizer", "transformers", "AutoProcessor", "text_encoder"), ("vae", "diffusers", "AutoencoderKLFlux2", "vae")]:
    index[name] = [library, cls, {"type_hint": [library, cls], "pretrained_model_name_or_path": "black-forest-labs/flux-3-image-klein", "subfolder": folder, "revision": None, "variant": None}]
write("modular_model_index.json", json.dumps(index, indent=2).encode(), {"format": "pinned-diffusers-modular-pipeline", "caption": "immutable-layout"})
revision = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
receipt = {"repo": receipts["flux3-gguf"]["repo"], "revision": revision, "path": str(package), "files": files,
           "quantization": "Unsloth UD-Q4_K_XL transformer; NF4 Qwen3-VL encoder; FP32 VAE", "upstreamSources": {name: entry["revision"] for name, entry in receipts.items()}}
(evidence / "flux3-files.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"path": str(package), "revision": revision, "files": len(files), "bytes": sum(entry["bytes"] for entry in files)}))
