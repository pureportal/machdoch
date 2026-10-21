from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import urllib.error
import urllib.request


evidence = Path(__file__).resolve().parent
repos = {"publisher": "stabilityai/stable-diffusion-3.5-medium", "mirror": "adamo1139/stable-diffusion-3.5-medium-ungated"}
metadata = {}
for role, repo in repos.items():
    request = urllib.request.Request(f"https://huggingface.co/api/models/{repo}?blobs=true", headers={"User-Agent": "machdoch-image-engine-verification/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = json.load(response)
    assert data["id"] == repo
    (evidence / f"sd35-medium-{role}-metadata.json").write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    metadata[role] = data
original = {file["rfilename"]: file for file in metadata["publisher"]["siblings"]}
mirror = {file["rfilename"]: file for file in metadata["mirror"]["siblings"]}
selected = [name for name in mirror if name.startswith("transformer/")]
assert selected
for name in selected:
    assert original[name]["blobId"] == mirror[name]["blobId"], name
    assert original[name]["size"] == mirror[name]["size"], name
    assert original[name].get("lfs", {}).get("sha256") == mirror[name].get("lfs", {}).get("sha256"), name
checkpoint = original["sd3.5_medium.safetensors"]
url = "https://civitai.com/api/v1/model-versions/by-hash/" + checkpoint["lfs"]["sha256"]
try:
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "machdoch-image-engine-verification/1.0"}), timeout=60) as response:
        civitai = {"url": url, "status": response.status, "result": json.load(response)}
except urllib.error.HTTPError as error:
    civitai = {"url": url, "status": error.code}
report = {"checkedAt": datetime.now(timezone.utc).isoformat(), "publisherRevision": metadata["publisher"]["sha"], "mirrorRevision": metadata["mirror"]["sha"], "exactTransformerFiles": selected, "transformerBytes": sum(mirror[name]["size"] for name in selected if name.endswith(".safetensors")), "civitaiPublisherCheckpoint": civitai, "downloadStarted": False}
(evidence / "sd35-medium-source-research.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(json.dumps({k: v for k, v in report.items() if k != "civitaiPublisherCheckpoint"}))
print(json.dumps({"civitaiStatus": civitai["status"], "civitaiVersion": civitai.get("result", {}).get("id")}))
