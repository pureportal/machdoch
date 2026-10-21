from __future__ import annotations

import copy
import json
from pathlib import Path


evidence = Path(__file__).resolve().parent
root = Path("D:/Models/machdoch/verification/2026-10-13/image-engines")
audit = json.loads((evidence / "audit/engine-coverage-audit-current.json").read_text())
profiles = json.loads((evidence.parents[3] / "apps/client/src-tauri/python/image_sampling_profiles.json").read_text())
batches = []


def save(path, data):
    if path.exists() and json.loads(path.read_text()) != data:
        raise ValueError(f"Existing preparation differs: {path}")
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def add(name, template, cases):
    template_path = root / (name + "-template.json")
    cases_path = root / (name + "-cases.json")
    save(template_path, template)
    save(cases_path, cases)
    batches.append({"name": name, "template": str(template_path), "cases": str(cases_path), "outputRoot": str(root / name)})


template = json.loads((root / "sd-turbo-template.json").read_text())
source = next(case for case in json.loads((root / "sd-turbo-cases.json").read_text()) if case["id"] == 144655944)
prompt = root / "sd-turbo-watercolor-hand-144655944.txt"
prompt.write_text("Anime painting of an adult red-haired woman with glowing amber eyes, white button-down shirt and black tie, leaning through a dark doorway. Her open hand reaches toward the camera, large foreshortened fingers and dark nails. Dramatic golden rim light, deep shadows, rich painterly detail, fisheye perspective.\n", encoding="utf-8")
supported = next(profile for profile in profiles if profile["architecture"] == "sd-turbo")["samplers"]
cases = []
for sampler, steps in (("euler", 1), ("euler", 2), ("euler-ancestral", 4), ("dpmpp-2m-karras", 4)):
    assert sampler in supported
    case = copy.deepcopy(source)
    case.update(promptFile=str(prompt), originalPrompt=False, width=512, height=768, addons=[])
    case.pop("negativePromptFile", None)
    case["sampling"] = {"sampler": sampler, "numInferenceSteps": steps, "guidanceScale": 0, "width": 512, "height": 768}
    cases.append(case)
add("sd-turbo-short-sampler-comparison", template, cases)

coverage = next(item for item in audit["coverage"] if item["architecture"] == "hidream-i1-full")
run = next(item for item in reversed(coverage["realRuns"]) if item["referenceId"] == 145095967 and item["validEvidence"])
request = json.loads((Path(run["directory"]) / "request.json").read_text())
assert request["model"]["id"] in {item["id"] for item in coverage["installedModels"]}
request.pop("outputDirectory", None)
request["prompt"] = ""
request["addons"] = []
request["negativePrompt"] = ""
prompt = root / "hidream-landscape-silhouette-145095967.txt"
prompt.write_text("Surreal photographic double exposure, centered adult woman with shoulder-length black hair looking down, both arms raised overhead with wrists crossed. She wears blue jeans and a dark belt. An Alpine mountain valley and a straight road continue seamlessly through the entire interior of her torso. Only delicate white linework outlines an otherwise invisible buttoned blouse and its rolled sleeves. Her face, hands and jeans remain photographic. Towering cliffs, green meadows, a small wooden chalet, snowy distant peaks and pastel pink sunset clouds fill the background. Elegant blended editorial photography, crisp fine detail, vertical composition.\n", encoding="utf-8")
case = next(case for case in json.loads((root / "flux-2-cases.json").read_text()) if case["id"] == 145095967)
case.update(promptFile=str(prompt), originalPrompt=False, addons=[], modelName=run["name"])
case.pop("negativePromptFile", None)
case["sampling"] = {"sampler": "unipc", "numInferenceSteps": 50, "guidanceScale": 5, "width": case["width"], "height": case["height"]}
add("hidream-landscape-silhouette-refinement", request, [case])
save(root / "short-quality-preflight-108.json", batches)
print(json.dumps({"batches": len(batches), "cases": 5, "generationStarted": False}))
