import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess

import numpy as np
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument("--root", type=Path, required=True)
parser.add_argument("--run", required=True)
parser.add_argument("--renderer", type=Path)
parser.add_argument("--store", type=Path)
args = parser.parse_args()
directory = args.root / "layout-control/runs" / args.run
response = json.loads((directory / "response.json").read_text(encoding="utf-8"))
run = response["result"]
assert run["status"] == "completed", run.get("error")
asset = next(asset for asset in run["assets"] if asset.get("operation", {}).get("details", {}).get("provenance", {}).get("imageLayout"))
provenance = asset["operation"]["details"]["provenance"]
evidence = provenance["imageLayout"]
layout = evidence["layout"]
store = args.store or args.root / "layout-control/desktop-store"
connection = sqlite3.connect(store / "media.sqlite3")


def blob(asset_id):
    digest, relative = connection.execute("SELECT b.digest,b.relative_path FROM assets a JOIN blobs b ON b.digest=a.blob_digest WHERE a.id=?", (asset_id,)).fetchone()
    source = store / "blobs/sha256" / relative
    content = source.read_bytes()
    assert hashlib.sha256(content).hexdigest() == digest
    return source


def pixels(asset_id):
    return np.asarray(Image.open(blob(asset_id)).convert("RGBA"))


final = pixels(asset["id"])
assert final.shape[:2] == (layout["canvas"]["height"], layout["canvas"]["width"])
Image.fromarray(final).save(directory / "output.png")
result = {"method": evidence["method"], "modelId": asset["operation"]["details"]["modelId"], "revision": provenance["modelRevision"],
          "assetPipeline": evidence.get("assetPipeline"),
          "layoutDigest": evidence["digest"], "workerVersion": provenance["workerVersion"], "device": provenance["deviceLabel"],
          "elapsedSeconds": response["elapsedSeconds"], "performance": provenance.get("performance"),
          "decodedRgbaSha256": hashlib.sha256(final.tobytes()).hexdigest(), "dimensions": list(final.shape[:2][::-1]),
          "visualInspection": "pending", "literalTextSource": [element["text"] for element in layout["elements"] if element["kind"] == "text"]}
if evidence["method"] != "native":
    variant = evidence["variants"][0]
    by_id = {element["id"]: element for element in layout["elements"]}
    rendering = variant["refinement"]["guidance"]["composition"] if evidence["method"] == "reference" else variant["composition"]
    assert evidence["assetPipeline"] == "raw-assets-cutout-v2"
    assert rendering["renderer"] == "machdoch-layout/resvg-0.47/alpha4"
    for rendered in rendering["elements"]:
        element = by_id[rendered["id"]]
        assert rendered["box"] == element["box"]
        if rendered["visibleBox"]:
            x0, y0, x1, y1 = rendered["visibleBox"]
            left, top, right, bottom = element["box"]
            assert left <= x0 < x1 <= right and top <= y0 < y1 <= bottom
        if element["kind"] == "text":
            assert rendered["font"]["text"] == element["text"]
            assert rendered["font"]["family"] == element["font"] and len(rendered["font"]["sha256"]) == 64
    sources = {}
    generated_sources = []
    layers = directory / "layers"
    layers.mkdir(exist_ok=True)
    for entry in variant["inputs"]:
        prepared = entry.get("preparedAsset") or entry["source"]
        source = blob(prepared["assetId"])
        destination = layers / f"{entry['id']}.png"
        destination.write_bytes(source.read_bytes())
        sources[entry["id"]] = str(destination)
        created_at, origin_run, operation = connection.execute("SELECT created_at,run_id,operation_json FROM assets WHERE id=?", (entry["source"]["assetId"],)).fetchone()
        origin = json.loads(operation).get("generation", {}).get("generation")
        if origin:
            generated_sources.append({"id": entry["id"], "assetId": entry["source"]["assetId"], "originRunId": origin_run,
                                      "createdDuringThisRun": origin_run == run["id"], "createdAt": created_at,
                                      "modelRevision": origin["modelRevision"], "performance": origin.get("performance"), "outputs": origin["outputs"]})
    if evidence["method"] == "reference":
        for entry in variant["refinement"]["guidance"]["inputs"]:
            destination = layers / f"{entry['id']}-guided.png"
            destination.write_bytes(blob(entry["assetId"]).read_bytes())
            sources[entry["id"]] = str(destination)
        result["guidance"] = variant["refinement"]["guidance"]
    (directory / "layout.json").write_text(json.dumps(layout, ensure_ascii=False, indent=2), encoding="utf-8")
    (directory / "layers.json").write_text(json.dumps(sources, indent=2), encoding="utf-8")
    result["composition"] = variant["composition"]
    result["inputs"] = variant["inputs"]
    result["generatedLayerSources"] = generated_sources
    if args.renderer:
        rendered = directory / "reproduced.png"
        subprocess.run([str(args.renderer), str(directory / "layout.json"), str(directory / "layers.json"), str(rendered)], check=True)
        expected = np.asarray(Image.open(rendered).convert("RGBA"))
        if evidence["method"] in ["composition", "reference"]:
            changed = np.any(final != expected, axis=2)
            assert not changed.any()
            result["reproducedChangedPixels"] = int(changed.sum())
        elif evidence["method"] == "masked":
            base = pixels(variant["refinement"]["steps"][0]["baseAssetId"])
            assert np.array_equal(base, expected)
            result["reproducedBaseChangedPixels"] = 0
    if evidence["method"] == "masked":
        steps = variant["refinement"]["steps"]
        measurements = []
        editable = np.zeros(final.shape[:2], dtype=bool)
        for index, step in enumerate(steps):
            source = pixels(step["baseAssetId"])
            mask = pixels(step["maskAssetId"])[:, :, 0]
            assert set(np.unique(mask)).issubset({0, 255})
            output = pixels(step["outputAssetId"])
            following = pixels(steps[index + 1]["baseAssetId"]) if index + 1 < len(steps) else final
            assert np.array_equal(output, following)
            changed = np.any(source != output, axis=2)
            outside = int((changed & (mask == 0)).sum())
            assert outside == 0
            editable |= mask == 255
            measurements.append({"pass": step["pass"], "maskPixels": int((mask == 255).sum()), "outsideMaskChangedPixels": outside,
                                 "insideMaskChangedPixels": int((changed & (mask == 255)).sum())})
        result["maskMeasurements"] = measurements
        text_pixels = np.zeros(final.shape[:2], dtype=bool)
        for element in layout["elements"]:
            if element["kind"] == "text":
                left, top, right, bottom = element["box"]
                text_pixels[top:bottom, left:right] = True
        protected_text = text_pixels & ~editable
        original = pixels(steps[0]["baseAssetId"])
        text_changes = int((np.any(final != original, axis=2) & protected_text).sum())
        assert text_changes == 0
        result["protectedTextRegionPixels"] = int(protected_text.sum())
        result["protectedTextChangedPixels"] = text_changes
(directory / "measured-review.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({key: value for key, value in result.items() if key not in ["composition", "inputs", "literalTextSource"]}))
