from __future__ import annotations

import json
from pathlib import Path


evidence = Path(__file__).resolve().parent
store = Path("D:/Models/machdoch")
root = store / "verification/2026-10-13/image-engines"
execution = json.loads((evidence / "sd35-medium-native-import-result.json").read_text())
assert execution["exitCode"] == 0
records = [json.loads(line) for line in (evidence / "sd35-medium-native-import.log").read_text().splitlines() if line.startswith('{"schemaVersion"')]
assert len(records) == 1
result = records[0]
package = store / result["targetLabel"]
assert package.is_relative_to(store / "models/packages")
assert json.loads((package / "transformer/config.json").read_text())["num_layers"] == 24
template = json.loads((root / "stable-diffusion-3-template.json").read_text())
template["model"] = {"id": result["modelId"], "architecture": "stable-diffusion-3", "packageKind": "diffusers-directory", "path": str(package), "configPath": None, "revision": result["revision"], "digest": result["digest"]}
template["sampling"] = {"sampler": "flow-euler", "numInferenceSteps": 40, "guidanceScale": 4.5}
cases = json.loads((root / "stable-diffusion-3-cases.json").read_text())
for case in cases:
    case["modelName"] = result["displayName"]
    case["sampling"].update(template["sampling"])
    case["addons"] = []
    case["adaptationPurpose"] = "Publisher-matched SD3.5 Medium baseline at 40 steps and CFG 4.5; visual assessment pending."
name = "sd35-medium-publisher-quality"
batch = {"name": name, "template": str(root / f"{name}-template.json"), "cases": str(root / f"{name}-cases.json"), "outputRoot": str(root / name), "stopOnFailure": True, "captureDecoderLatents": True}
for path, value in ((Path(batch["template"]), template), (Path(batch["cases"]), cases), (root / "sd35-medium-quality-batches-111.json", [batch])):
    if path.exists() and json.loads(path.read_text()) != value:
        raise ValueError(f"Existing preparation differs: {path}")
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
progress_path = evidence / "flux2-dev-progress.json"
progress = json.loads(progress_path.read_text())
progress["sd35MediumAcquisition"].update(nativeImportVerified=True, nativeImportState="passed", nativeImportResult=result, nativeImportSeconds=execution["seconds"], preparedQualityCases=6)
progress_path.write_text(json.dumps(progress, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"nativeImportVerified": True, "modelId": result["modelId"], "qualityCasesPrepared": 6, "generationStarted": False}))
