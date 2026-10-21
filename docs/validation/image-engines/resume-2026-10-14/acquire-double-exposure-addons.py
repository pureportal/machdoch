from __future__ import annotations

import json
from pathlib import Path
import sys


workspace = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(workspace / "apps/client/src-tauri/python"))
from download_media_verification_models import download


evidence = Path(__file__).resolve().parent
models = json.loads((evidence / "double-exposure-civitai-lora-research.json").read_text())["response"]["items"]
credentials = json.loads((workspace / ".cache/image-engine-native/user-config/civitai.json").read_text())
root = Path("D:/Models/machdoch/downloads/civitai")
assets = []
for model_id, version_id, architecture, label in (
    (187387, 210432, "stable-diffusion-xl", "Double Exposure SDXL - runew0lf"),
    (132494, 145734, "stable-diffusion-1", "World Inside Body SD1.5 - BixBit11"),
    (1253670, 1413362, "stable-diffusion-xl", "Environment Inside Silhouette Illustrious - App1e17"),
    (678461, 760260, "stable-diffusion-xl", "Double Exposure Pony - Jedas"),
    (685432, 767128, "flux-1", "Double Exposure FLUX.1 - Ethanar"),
):
    model = next(item for item in models if item["id"] == model_id)
    version = next(item for item in model["modelVersions"] if item["id"] == version_id)
    file = next(item for item in version["files"] if item["primary"] and item["name"].endswith(".safetensors"))
    download(root, model_id, version_id, file["name"], credentials["apiKey"])
    folder = root / str(model_id) / str(version_id)
    path = folder / file["name"]
    source_url = f"https://civitai.com/models/{model_id}?modelVersionId={version_id}"
    (folder / "civitai-model-metadata.json").write_text(json.dumps(model, indent=2) + "\n", encoding="utf-8")
    (folder / "NOTICE-Attribution.txt").write_text(f"{model['name']} by {model['creator']['username']}\n{source_url}\nUnmodified weights. Publisher permissions are recorded in civitai-model-metadata.json.\n", encoding="utf-8")
    assets.append({
        "sourcePath": str(path), "reviewToken": "", "displayName": label,
        "kind": "lora", "architecture": architecture, "triggerWords": version.get("trainedWords", []),
        "token": None, "sourceUrl": source_url, "licenseName": None, "commercialUse": "review-required",
    })
fixture = {
    "database": "D:/Models/machdoch/media.sqlite3", "blobs": "D:/Models/machdoch/blobs/sha256",
    "outputDirectory": str(evidence / "native-concept-addons"), "assets": assets,
}
(evidence / "concept-addon-import-fixture.json").write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"downloaded": len(assets), "nativeImportVerified": False, "qualityVerified": False}), flush=True)
