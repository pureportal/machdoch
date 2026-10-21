from __future__ import annotations

import copy
import json
from pathlib import Path


evidence = Path(__file__).resolve().parent
store = Path("D:/Models/machdoch")
root = store / "verification/2026-10-13/image-engines"
imports = json.loads((evidence / "native-style-addons/native-imports.json").read_text())
coverage = json.loads((evidence / "requested-engine-coverage.json").read_text())
pending = {entry["engine"]: set(entry["remainingReferenceAssessments"]) for entry in coverage["matrix"]}
batches = []


def save(path, value):
    text = json.dumps(value, indent=2) + "\n"
    if path.exists() and json.loads(path.read_text()) != value:
        raise ValueError(f"Existing preparation differs: {path}")
    path.write_text(text, encoding="utf-8")


def add_batch(name, template, cases):
    template_path = root / f"{name}-template.json"
    cases_path = root / f"{name}-cases.json"
    save(template_path, template)
    save(cases_path, cases)
    batches.append({
        "name": name,
        "template": str(template_path),
        "cases": str(cases_path),
        "outputRoot": str(root / name),
    })


dev = json.loads((evidence / "flux2-dev-progress.json").read_text())["nativeImport"]
assert dev["state"] == "passed"
result = dev["result"]
package = store / result["targetLabel"]
assert package.is_relative_to(store / "models/packages")
assert (package / "model_index.json").is_file()
template = json.loads((root / "flux-2-template.json").read_text())
template["model"] = {
    "id": result["modelId"],
    "architecture": "flux-2-dev",
    "packageKind": "diffusers-directory",
    "path": str(package),
    "configPath": None,
    "revision": result["revision"],
    "digest": result["digest"],
}
template["sampling"] = {"sampler": "flow-euler", "numInferenceSteps": 50, "guidanceScale": 4}
cases = json.loads((root / "flux-2-cases.json").read_text())
cases.sort(key=lambda case: case["id"] != 145095967)
for case in cases:
    case["modelName"] = result["displayName"]
    case["sampling"].update(template["sampling"])
    case["addons"] = []
    case.pop("negativePromptFile", None)
add_batch("flux-2-dev-full-six", template, cases)

for architecture, engine, imported_index in (("illustrious-xl", "Illustrious XL", 0), ("noobai-xl", "NoobAI XL", 1), ("pony", "Pony", 2)):
    imported = imports[imported_index]["imported"]
    inspection = imports[imported_index]["inspection"]
    assert inspection["canImport"] and inspection["architectureConfidence"] == "high"
    path = store / imported["targetLabel"]
    assert path.is_relative_to(store / "models/addons") and path.is_file()
    addon = {
        "kind": "lora",
        "enabled": True,
        "addonId": imported["addonId"],
        "digest": imported["digest"],
        "path": str(path),
        "architecture": imported["architecture"],
        "targetComponents": inspection["targetComponents"],
        "loraProfile": inspection["loraProfile"],
        "modelStrength": 1.0,
        "triggerWords": ["masterpiece", "best quality", "very aesthetic"],
    }
    template = json.loads((root / f"{architecture}-template.json").read_text())
    source_cases = root / f"{architecture}-{'style-retry' if architecture == 'pony' else 'tag'}-cases.json"
    cases = json.loads(source_cases.read_text())
    if architecture == "pony":
        cases_by_id = {case["id"]: case for case in json.loads((root / "pony-cases.json").read_text())}
        cases_by_id.update({case["id"]: case for case in cases})
        cases = list(cases_by_id.values())
    cases = [case for case in cases if case["id"] in pending[engine]]
    for case in cases:
        source = Path(case["promptFile"])
        prompt = source.read_text(encoding="utf-8").strip()
        tags = [tag.strip() for tag in prompt.split(",")]
        quality = {"masterpiece", "best quality", "very aesthetic"}
        prompt = ", ".join(tag for tag in tags if tag.casefold() not in quality)
        prompt_path = root / f"{architecture}-masterpiece-prompt-{case['id']}.txt"
        prompt_path.write_text(prompt.rstrip(" ,.") + ", masterpiece, best quality, very aesthetic\n", encoding="utf-8")
        case["promptFile"] = str(prompt_path)
        case["originalPrompt"] = False
        case["adaptationPurpose"] = "Publisher-matched motimalu aesthetic-quality LoRA and trailing quality tags; comparison pending."
        case["addons"] = [*case.get("addons", []), copy.deepcopy(addon)]
    add_batch(f"{architecture}-masterpiece-quality", template, cases)

template = json.loads((root / "stable-diffusion-3-template.json").read_text())
template["sampling"] = {"sampler": "flow-heun", "numInferenceSteps": 50, "guidanceScale": 5}
cases = json.loads((root / "stable-diffusion-3-cases.json").read_text())
for case in cases:
    case["sampling"].update(template["sampling"])
    case["adaptationPurpose"] = "Higher-order flow sampling for the publisher's early-alpha checkpoint; same subject conditioning."
add_batch("sd35-medium-heun-quality", template, cases)
save(root / "next-quality-batches-107.json", batches)
print(json.dumps({"batches": len(batches), "cases": sum(len(json.loads(Path(batch['cases']).read_text())) for batch in batches), "manifest": str(root / 'next-quality-batches-107.json'), "generationStarted": False}))
