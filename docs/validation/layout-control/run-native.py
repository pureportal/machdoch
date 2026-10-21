import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import traceback

parser = argparse.ArgumentParser()
parser.add_argument("--root", type=Path, required=True)
parser.add_argument("--model", choices=["moss-base", "moss-sft", "flux3"], required=True)
parser.add_argument("--scene", type=Path, required=True)
parser.add_argument("--name", required=True)
args = parser.parse_args()
root = args.root.resolve()
for name, folder in {"HF_HOME": "cache/huggingface", "HF_HUB_CACHE": "cache/huggingface/hub", "TORCH_HOME": "cache/torch", "TMP": "cache/tmp", "TEMP": "cache/tmp",
                     "MIOPEN_CUSTOM_CACHE_DIR": "cache/miopen/kernels", "MIOPEN_USER_DB_PATH": "cache/miopen/db", "TORCHINDUCTOR_CACHE_DIR": "cache/inductor", "TRITON_CACHE_DIR": "cache/triton"}.items():
    (root / folder).mkdir(parents=True, exist_ok=True)
    os.environ[name] = str(root / folder)
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "apps/client/src-tauri/python"))
import media_diffusers_worker as worker

files = json.loads((root / "layout-control/evidence" / f"{args.model}-files.json").read_text())
scene = json.loads(args.scene.read_text(encoding="utf-8"))
architecture = {"moss-base": "moss-image-base", "moss-sft": "moss-image-sft", "flux3": "flux-3-image-klein"}[args.model]
destination = root / "layout-control/runs" / args.name
destination.mkdir(parents=True, exist_ok=False)
(destination / "output").mkdir()
request = {"schemaVersion": worker.SCHEMA_VERSION, "model": {"id": f"local:{architecture}", "architecture": architecture,
    "packageKind": "diffusers-directory", "path": files["path"], "revision": files["revision"],
    "digest": hashlib.sha256(json.dumps(files["files"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()},
    "prompt": scene["caption"], "negativePrompt": "", "imageLayout": scene, "layoutMethod": "native",
    "outputCount": 1, "outputFormat": "png", "modelPolicy": "quality", "aspectRatio": "1:1", "seed": 713,
    "sampling": {"numInferenceSteps": 16 if args.model == "flux3" else 50, "guidanceScale": 1 if args.model == "flux3" else 3, "sampler": "flow-euler"},
    "outputDirectory": str(destination / "output"), "modelCacheDirectory": str(root / "cache/image-models"), "addons": [],
    "referenceImages": [], "requireChromaBackground": False, "memoryProfile": "memory-saver"}
(destination / "request.json").write_text(json.dumps(request, ensure_ascii=False, indent=2), encoding="utf-8")
started = time.perf_counter()
try:
    import torch
    worker._device(torch)
    torch.cuda.reset_peak_memory_stats()
    response = worker.generate(request)
    torch.cuda.synchronize()
    response["measurement"] = {"elapsedSeconds": time.perf_counter() - started, "peakAllocatedBytes": torch.cuda.max_memory_allocated(),
        "peakReservedBytes": torch.cuda.max_memory_reserved(), "gpu": torch.cuda.get_device_name(), "torch": torch.__version__, "hip": torch.version.hip}
    (destination / "response.json").write_text(json.dumps(response, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(response["measurement"]), flush=True)
except Exception:
    (destination / "failure.txt").write_text(traceback.format_exc(), encoding="utf-8")
    raise
