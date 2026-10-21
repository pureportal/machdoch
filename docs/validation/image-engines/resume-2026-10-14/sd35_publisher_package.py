from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import sys


workspace = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(workspace / "apps/client/src-tauri/python"))
from download_media_verification_components import download
from media_verification_components import verify_component


def prepare(*, evidence_prefix, model_name, architecture, display_name, publisher_revision, mirror_revision, provenance_details):
    evidence = Path(__file__).resolve().parent
    publisher = json.loads((evidence / f"{evidence_prefix}-publisher-metadata.json").read_text())
    mirror_path = evidence / f"{evidence_prefix}-mirror-metadata.json"
    mirror = json.loads(mirror_path.read_text())
    assert publisher["id"] == f"stabilityai/{model_name}"
    assert publisher["sha"] == publisher_revision
    assert mirror["id"] == f"adamo1139/{model_name}-ungated"
    assert mirror["sha"] == mirror_revision
    original_files = {file["rfilename"]: file for file in publisher["siblings"]}
    mirror_files = {file["rfilename"]: file for file in mirror["siblings"]}
    components = ("scheduler", "transformer", "vae", "text_encoder", "text_encoder_2", "text_encoder_3", "tokenizer", "tokenizer_2", "tokenizer_3")
    selected = []
    for name, file in mirror_files.items():
        if not name.startswith("LICENSE") and name != "model_index.json" and not name.startswith(tuple(component + "/" for component in components)):
            continue
        if name.endswith((".bin", ".pt", ".pth", ".ckpt", ".py")):
            raise ValueError(f"Unexpected executable or unsafe serialization: {name}")
        if name.endswith(".safetensors") and not name.startswith("transformer/"):
            continue
        if name.startswith("text_encoder_3/") and name.endswith(".index.json"):
            continue
        original = original_files[name]
        assert original["size"] == file["size"], name
        assert original.get("lfs", {}).get("sha256") == file.get("lfs", {}).get("sha256"), name
        assert original["blobId"] == file["blobId"], name
        selected.append(name)
    assert any(name.startswith("LICENSE") for name in selected)
    store = Path("D:/Models/machdoch")
    destination = store / f"downloads/{evidence_prefix}-publisher-matched"
    existing = store / "models/packages/user-62d1eb3e10df764cfeff0163b5aaab2e/revisions/62d1eb3e10df764cfeff0163b5aaab2e5775aac3987632f6428dd2bad1074e30"
    reused = []
    for name, official_name in (
        ("text_encoder/model.safetensors", "text_encoder/model.safetensors"),
        ("text_encoder_2/model.safetensors", "text_encoder_2/model.safetensors"),
        ("text_encoder_3/model.safetensors", "text_encoders/t5xxl_fp16.safetensors"),
        ("vae/diffusion_pytorch_model.safetensors", "vae/diffusion_pytorch_model.safetensors"),
    ):
        source = existing / name
        digest = verify_component(source, original_files[official_name])
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            assert os.path.samefile(source, target), name
        else:
            target.hardlink_to(source)
        reused.append({"path": name, "publisherPath": official_name, "sha256": digest, "bytes": target.stat().st_size})
        print(json.dumps({"reusedPublisherMatchedWeight": reused[-1]}), flush=True)
    download(mirror_path, selected, destination)
    for name in ("LICENSE-OpenAI-CLIP.txt", "LICENSE-OpenCLIP.txt", "LICENSE-T5.txt"):
        shutil.copyfile(existing / name, destination / name)
    notice = f"This Stability AI Model is licensed under the Stability AI Community License, Copyright © Stability AI Ltd. All Rights Reserved\n\nPowered by Stability AI\n\n{display_name}.\nPublic redistribution by adamo1139; all downloaded files match the publisher's pinned hashes.\nThe complete transformer is unchanged. CLIP, OpenCLIP and T5 weights are unchanged and verified against the publisher's hashes; T5 uses the publisher's monolithic encoder serialization.\n"
    (destination / "NOTICE").write_text(notice, encoding="utf-8")
    provenance = {"architecture": architecture, **provenance_details, "publisher": {"id": publisher["id"], "revision": publisher["sha"]}, "redistributor": {"id": mirror["id"], "revision": mirror["sha"]}, "downloaded": json.loads((destination / "component-provenance.json").read_text()), "reusedWeights": reused, "weightChanges": False}
    (destination / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
    request = {"sourcePath": str(destination), "architecture": architecture, "displayName": display_name, "sourceUrl": f"https://huggingface.co/stabilityai/{model_name}", "commercialUse": "review-required", "licenseName": "Stability AI Community License", "reviewToken": ""}
    (evidence / f"{evidence_prefix}-import.json").write_text(json.dumps(request, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"prepared": str(destination), "weightChanges": False, "generationVerified": False}), flush=True)
