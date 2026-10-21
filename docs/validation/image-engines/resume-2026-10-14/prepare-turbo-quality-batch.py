from __future__ import annotations

import copy
import json
from pathlib import Path


evidence = Path(__file__).resolve().parent
store = Path("D:/Models/machdoch")
root = store / "verification/2026-10-13/image-engines"
execution = json.loads((evidence / "sd35-large-turbo-native-import-result.json").read_text())
assert execution["exitCode"] == 0
records = [json.loads(line) for line in (evidence / "sd35-large-turbo-native-import.log").read_text().splitlines() if line.startswith('{"schemaVersion"')]
assert len(records) == 1
result = records[0]
package = store / result["targetLabel"]
assert package.is_relative_to(store / "models/packages")
assert (package / "model_index.json").is_file()
assert json.loads((package / "transformer/config.json").read_text())["num_layers"] == 38
template = json.loads((root / "stable-diffusion-3-template.json").read_text())
template["model"] = {
    "id": result["modelId"],
    "architecture": "stable-diffusion-3.5-large-turbo",
    "packageKind": "diffusers-directory",
    "path": str(package),
    "configPath": None,
    "revision": result["revision"],
    "digest": result["digest"],
}
template["sampling"] = {"sampler": "flow-euler", "numInferenceSteps": 4, "guidanceScale": 0}
cases = json.loads((root / "stable-diffusion-3-cases.json").read_text())
for case in cases:
    case["modelName"] = result["displayName"]
    case["sampling"].update(copy.deepcopy(template["sampling"]))
    case["addons"] = []
    case.pop("negativePromptFile", None)
    case["adaptationPurpose"] = "Publisher-matched SD3.5 Large Turbo, distilled four-step recipe; visual assessment pending."
name = "sd35-large-turbo-publisher-quality"
batch = {"name": name, "template": str(root / f"{name}-template.json"), "cases": str(root / f"{name}-cases.json"), "outputRoot": str(root / name)}
for path, value in ((Path(batch["template"]), template), (Path(batch["cases"]), cases), (root / "sd35-large-turbo-quality-batches-108.json", [batch])):
    if path.exists() and json.loads(path.read_text()) != value:
        raise ValueError(f"Existing preparation differs: {path}")
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
progress_path = evidence / "flux2-dev-progress.json"
progress = json.loads(progress_path.read_text())
progress["sd35TurboAcquisition"].update(nativeImportVerified=True, nativeImportState="passed", nativeImportResult=result, nativeImportSeconds=execution["seconds"])
progress["preparedTurboComparisons"] = {"manifest": str(root / "sd35-large-turbo-quality-batches-108.json"), "cases": 6, "started": False}
progress_path.write_text(json.dumps(progress, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"nativeImportVerified": True, "modelId": result["modelId"], "casesPrepared": 6, "generationStarted": False}))
