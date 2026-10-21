from __future__ import annotations

import copy
import json
from pathlib import Path


evidence = Path(__file__).resolve().parent
store = Path("D:/Models/machdoch")
root = store / "verification/2026-10-13/image-engines"
imports = json.loads((evidence / "native-concept-addons/native-imports.json").read_text())
assert len(imports) == 5
batches = []
recipes = [
    ("stable-diffusion-xl", 0, 0.9, "dpmpp-2m-karras", 35, 5, "double exposure, adult woman, black hair, looking down, arms raised overhead, blue jeans, dark belt, Alpine valley and straight road inside torso, thin white shirt outlines, pink sunset sky, photographic collage, detailed mountains, grass meadows"),
    ("stable-diffusion-1", 1, 0.75, "deis", 25, 4.5, "w0rld, adult woman from behind, arms raised overhead, blue jeans, black hair, Alpine mountains and road filling her torso, double exposure, pink sunset sky, grass meadow, fine art photography"),
    ("illustrious-xl", 2, 1, "euler-ancestral", 28, 5, "double exposure, silhouette, 1girl, adult, arms up, black hair, looking down, jeans, belt, landscape inside body, mountain valley, road, pink sky, white shirt outlines, photographic collage, masterpiece, best quality"),
    ("pony", 3, 1, "dpmpp-2m-karras", 35, 5, "score_9, score_8_up, score_7_up, Jed-dblexpsre, double exposure, merged, adult woman, black hair, arms up, blue jeans, Alpine valley and road inside torso, white blouse outlines, pink sunset sky, photographic collage"),
    ("flux-1-dev", 4, 1, "flow-euler", 50, 3.5, "Surreal photographic double exposure of an adult woman looking down with black hair and both arms raised overhead. She wears blue jeans and a dark belt. An Alpine valley and a straight road continue through her torso. Delicate white lines outline an invisible buttoned shirt. Her face, hands and jeans remain photographic. Cliffs, green meadows and pastel pink sunset clouds surround her. Detailed editorial photography."),
    ("sdxl-turbo", 0, 0.8, "euler-ancestral", 4, 0, "double exposure, adult woman, black hair, looking down, arms overhead, blue jeans, Alpine valley and road filling torso, white shirt outlines, pink sky, photographic collage"),
]
for architecture, index, strength, sampler, steps, guidance, prompt in recipes:
    item = imports[index]
    imported, inspection = item["imported"], item["inspection"]
    assert inspection["canImport"] and inspection["architectureConfidence"] == "high"
    addon_path = store / imported["targetLabel"]
    assert addon_path.is_relative_to(store / "models/addons") and addon_path.is_file()
    template = json.loads((root / f"{architecture}-template.json").read_text())
    assert Path(template["model"]["path"]).exists()
    case = copy.deepcopy(next(case for case in json.loads((root / f"{architecture}-cases.json").read_text()) if case["id"] == 145095967))
    name = f"{architecture}-matched-concept-collage"
    prompt_path = root / f"{name}-prompt.txt"
    prompt_path.write_text(prompt + "\n", encoding="utf-8")
    case.update(promptFile=str(prompt_path), originalPrompt=False, adaptationPurpose="Native-imported base-family composition LoRA; photographic Alpine double exposure comparison pending.")
    case.pop("negativePromptFile", None)
    case["sampling"].update(sampler=sampler, numInferenceSteps=steps, guidanceScale=guidance)
    case["addons"] = [{
        "kind": "lora", "enabled": True,
        "addonId": imported["addonId"], "digest": imported["digest"],
        "path": str(addon_path), "architecture": imported["architecture"],
        "targetComponents": inspection["targetComponents"],
        "loraProfile": inspection["loraProfile"], "modelStrength": strength,
        "triggerWords": [],
    }]
    template["sampling"] = {"sampler": sampler, "numInferenceSteps": steps, "guidanceScale": guidance}
    batch = {"name": name, "template": str(root / f"{name}-template.json"), "cases": str(root / f"{name}-cases.json"), "outputRoot": str(root / name)}
    for path, value in ((Path(batch["template"]), template), (Path(batch["cases"]), [case])):
        if path.exists() and json.loads(path.read_text()) != value:
            raise ValueError(f"Existing preparation differs: {path}")
        path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    batches.append(batch)
manifest = root / "concept-quality-batches-108.json"
manifest.write_text(json.dumps(batches, indent=2) + "\n", encoding="utf-8")
progress_path = evidence / "flux2-dev-progress.json"
progress = json.loads(progress_path.read_text())
progress["conceptAddons"].update(nativeImportVerified=True, nativeImportRecord=str(evidence / "native-concept-addons/native-imports.json"), preparedCases=len(batches), manifest=str(manifest))
progress_path.write_text(json.dumps(progress, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"nativeImportsVerified": len(imports), "casesPrepared": len(batches), "generationStarted": False}))
