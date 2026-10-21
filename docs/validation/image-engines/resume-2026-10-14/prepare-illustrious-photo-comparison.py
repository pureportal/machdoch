from __future__ import annotations

import json
import sqlite3
from pathlib import Path


evidence = Path(__file__).resolve().parent
store = Path("D:/Models/machdoch")
root = store / "verification/2026-10-13/image-engines"
digest = "5de851376608d77ac5fca529ba727897860d187ad66108dd15da3c800cbd1a2f"
model_id = f"local:user:{digest}"
catalog = json.loads((evidence / "native-sampling-108/native-catalog.json").read_text())
model = next(model for model in catalog["models"] if model["id"] == model_id)
assert model["architecture"] == "illustrious-xl" and model["installationStatus"] == "installed"
with sqlite3.connect((store / "media.sqlite3").as_uri() + "?mode=ro", uri=True) as connection:
    revision, relative_path = connection.execute("SELECT revision, relative_path FROM media_model_installations WHERE model_id=? AND status='installed'", (model_id,)).fetchone()
package = store / "models" / relative_path
assert package.is_relative_to(store / "models/packages")
assert (package / "checkpoint.safetensors").is_file()
assert (package / "config/model_index.json").is_file()
template = json.loads((root / "illustrious-xl-template.json").read_text())
template["model"] = {"id": model_id, "architecture": "illustrious-xl", "packageKind": "single-file", "path": str(package / "checkpoint.safetensors"), "configPath": str(package / "config"), "revision": revision, "digest": digest}
template["sampling"] = {"sampler": "euler-ancestral", "numInferenceSteps": 30, "guidanceScale": 5}
cases = [case for case in json.loads((root / "illustrious-xl-cases.json").read_text()) if case["id"] in (144594528, 144599398)]
for case in cases:
    prompt = Path(case["promptFile"]).read_text().strip()
    prompt_path = root / f"illustrious-unnamed-photo-{case['id']}.txt"
    prompt_path.write_text("realistic, " + prompt + "\n", encoding="utf-8")
    case.update(modelName=model["displayName"], promptFile=str(prompt_path), originalPrompt=False, addons=[], adaptationPurpose="Installed Illustrious-derived photographic fine-tune; Euler ancestral comparison at 30 steps and CFG 5. SGM Uniform spacing is not claimed.")
    case["sampling"].update(template["sampling"])
name = "illustrious-unnamed-photographic-comparison"
batch = {"name": name, "template": str(root / f"{name}-template.json"), "cases": str(root / f"{name}-cases.json"), "outputRoot": str(root / name)}
for path, value in ((Path(batch["template"]), template), (Path(batch["cases"]), cases), (root / "illustrious-photo-quality-batches-108.json", [batch])):
    if path.exists() and json.loads(path.read_text()) != value:
        raise ValueError(f"Existing preparation differs: {path}")
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"installedModel": model_id, "casesPrepared": len(cases), "generationStarted": False}))
