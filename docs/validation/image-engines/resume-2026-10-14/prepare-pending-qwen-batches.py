from __future__ import annotations

import json
import copy
from pathlib import Path


evidence = Path(__file__).resolve().parent
root = Path("D:/Models/machdoch/verification/2026-10-13/image-engines")
checkpoint = json.loads((evidence / "qwen-baseline-checkpoint.json").read_text())
assert checkpoint["stoppedOwnedWorker"]
assert checkpoint["imageCompleted"] or checkpoint["case"].get("error")
assert checkpoint["case"]["referenceId"] == 144655944
source = json.loads((root / "missing-current-batches.json").read_text())
batches = []
for batch in source:
    template = json.loads(Path(batch["template"]).read_text())
    architecture = template["model"]["architecture"]
    if architecture not in ("qwen-image", "qwen-image-2.1"):
        continue
    cases = json.loads(Path(batch["cases"]).read_text())
    if architecture == "qwen-image":
        comparison_cases = [case for case in cases if case["id"] == 144655944]
        assert len(comparison_cases) == 1
        smoke = copy.deepcopy(comparison_cases[0])
        smoke["sampling"]["numInferenceSteps"] = 2
        smoke["modelName"] += " · full-canvas decoder smoke"
        smoke["adaptationPurpose"] = "Two-step decoder smoke; no visual acceptance."
        comparison_cases.insert(0, smoke)
        comparison_path = root / "qwen-image-nf4-baseline-cases.json"
        comparison_path.write_text(json.dumps(comparison_cases, indent=2) + "\n", encoding="utf-8")
        comparison = {**batch, "name": "qwen-image-nf4-encoder-baseline", "cases": str(comparison_path), "outputRoot": str(root / "qwen-image-nf4-encoder-baseline"), "stopOnFailure": True, "captureDecoderLatents": True}
        (root / "qwen-image-nf4-baseline-batches.json").write_text(json.dumps([comparison], indent=2) + "\n", encoding="utf-8")
        if checkpoint["imageCompleted"]:
            cases = [case for case in cases if case["id"] != 144655944]
    cases_path = root / f"{architecture}-pending-after-baseline-cases.json"
    cases_path.write_text(json.dumps(cases, indent=2) + "\n", encoding="utf-8")
    batches.append({**batch, "cases": str(cases_path)})
remaining = sum(len(json.loads(Path(batch["cases"]).read_text())) for batch in batches)
assert remaining == (8 if checkpoint["imageCompleted"] else 9)
manifest = root / "qwen-pending-after-baseline-batches.json"
manifest.write_text(json.dumps(batches, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"manifest": str(manifest), "remainingCases": remaining, "generationStarted": False}))
