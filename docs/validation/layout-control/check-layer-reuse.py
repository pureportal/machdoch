import argparse
import copy
import json
from pathlib import Path

import numpy as np
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument("--root", type=Path, required=True)
parser.add_argument("--source", required=True)
parser.add_argument("--changed")
args = parser.parse_args()
runs = args.root / "layout-control/runs"
source_directory = runs / args.source


def generated(directory):
    run = json.loads((directory / "response.json").read_text(encoding="utf-8"))["result"]
    assert run["status"] == "completed"
    return next(asset["operation"]["details"]["provenance"]["imageLayout"] for asset in run["assets"]
                if asset.get("operation", {}).get("details", {}).get("provenance", {}).get("imageLayout"))


source = generated(source_directory)
inputs = {entry["id"]: entry for entry in source["variants"][0]["inputs"]}
if args.changed:
    changed_directory = runs / args.changed
    changed = generated(changed_directory)
    updated = {entry["id"]: entry for entry in changed["variants"][0]["inputs"]}
    assert set(updated) == set(inputs) - {"cube_1"}
    for element_id, entry in updated.items():
        previous = inputs[element_id].get("preparedAsset") or inputs[element_id]["source"]
        retained = entry.get("preparedAsset") or entry["source"]
        assert retained["assetId"] == previous["assetId"]
        assert retained["digest"] == previous["digest"]
    old_pixels = np.asarray(Image.open(source_directory / "output.png").convert("RGBA"))
    new_pixels = np.asarray(Image.open(changed_directory / "output.png").convert("RGBA"))
    allowed = np.zeros(old_pixels.shape[:2], dtype=bool)
    for layout in [source["layout"], changed["layout"]]:
        for element in layout["elements"]:
            if element["id"] not in ["robot_1", "cube_1"]:
                continue
            left, top, right, bottom = element["box"]
            allowed[top:bottom, left:right] = True
    difference = np.any(old_pixels != new_pixels, axis=2)
    assert difference.any()
    assert not (difference & ~allowed).any()
    result = {"reusedLayers": sorted(updated), "removedLayers": ["cube_1"], "changedPixels": int(difference.sum()),
              "outsideOldAndNewBoxesChangedPixels": int((difference & ~allowed).sum()), "sourceRun": args.source, "changedRun": args.changed}
    (changed_directory / "reuse-measurement.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result))
else:
    changed = copy.deepcopy(source["layout"])
    changed["elements"] = [element for element in changed["elements"] if element["id"] != "cube_1"]
    for element in changed["elements"]:
        if element["id"] == "robot_1":
            element["box"][0] += 48
            element["box"][2] += 48
    if "relations" in changed:
        changed["relations"] = [relation for relation in changed["relations"] if "cube_1" not in [relation["subjectId"], relation["objectId"]]]
    (source_directory / "move-remove.json").write_text(json.dumps(changed, ensure_ascii=False, indent=2), encoding="utf-8")
    fixture = Path(__file__).resolve().parents[2] / "artifacts/layout-control-2026-10-18/dense-infographic.json"
    dense = json.loads(fixture.read_text(encoding="utf-8"))
    for element in dense["elements"]:
        if element["kind"] == "object":
            source_id = {"robot_image": "robot_1", "cube_image": "cube_1", "plant_image": "plant_1"}[element["id"]]
            entry = inputs[source_id]
            element["assetId"] = (entry.get("preparedAsset") or entry["source"])["assetId"]
            element["cutout"] = False
    (source_directory / "dense-reuse.json").write_text(json.dumps(dense, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"prepared": [str(source_directory / "move-remove.json"), str(source_directory / "dense-reuse.json")]}))
