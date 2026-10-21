import hashlib
import json
import os
import struct
from datetime import datetime, timezone
from pathlib import Path

from accelerate import init_empty_weights
from diffusers import AutoencoderKL, SD3Transformer2DModel
from transformers import CLIPTextModelWithProjection, T5EncoderModel


workspace = Path(__file__).resolve().parents[4]
package = workspace / ".cache/prepared-sd35-nekofantasia-package-current"
components = workspace / ".cache/sd35-verification-components-current"
downloads = Path("D:/Models/machdoch/downloads/nekofantasia-alpha-civitai-linked-f612455c9032")
checks = Path(__file__).parent
verification = Path("D:/Models/machdoch/verification/2026-10-11/image-engines")


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def header(path):
    with path.open("rb") as stream:
        size = struct.unpack("<Q", stream.read(8))[0]
        values = json.loads(stream.read(size))
    return {key: value for key, value in values.items() if key != "__metadata__"}


def inspect_component(name, model_class, storage_dtype):
    folder = package / name
    configuration = model_class.load_config(folder) if name in {"transformer", "vae"} else model_class.config_class.from_pretrained(folder, local_files_only=True)
    with init_empty_weights():
        model = model_class.from_config(configuration) if name in {"transformer", "vae"} else model_class(configuration)
    expected = {name: list(value.shape) for name, value in model.state_dict().items()}
    tensors = {}
    locations = {}
    for path in sorted(folder.glob("*.safetensors")):
        for key, value in header(path).items():
            if key in tensors:
                raise ValueError(f"Duplicate tensor: {name}/{key}")
            tensors[key] = value
            locations[key] = path.name
    if set(tensors) != set(expected):
        raise ValueError(f"Tensor names differ: {name}: missing={set(expected) - set(tensors)}, extra={set(tensors) - set(expected)}")
    for key, shape in expected.items():
        if tensors[key]["shape"] != shape or tensors[key]["dtype"] != storage_dtype:
            raise ValueError(f"Tensor shape or precision differs: {name}/{key}")
    for path in folder.glob("*.index.json"):
        index = json.loads(path.read_text(encoding="utf-8"))
        if index["weight_map"] != locations:
            raise ValueError(f"Shard index differs: {name}")
    return {"component": name, "tensors": len(tensors), "allTensorNamesShapesAndDtypesMatch": True, "dtype": storage_dtype}


index = json.loads((package / "model_index.json").read_text(encoding="utf-8"))
if index["_class_name"] != "StableDiffusion3Pipeline":
    raise ValueError("Wrong pipeline")
inspections = [
    inspect_component("transformer", SD3Transformer2DModel, "BF16"),
    inspect_component("vae", AutoencoderKL, "BF16"),
    inspect_component("text_encoder", CLIPTextModelWithProjection, "F16"),
    inspect_component("text_encoder_2", CLIPTextModelWithProjection, "F16"),
    inspect_component("text_encoder_3", T5EncoderModel, "F16"),
]
for name in ("tokenizer", "tokenizer_2", "tokenizer_3", "scheduler"):
    for source in (components / name).iterdir():
        if source.is_file() and digest(source) != digest(package / name / source.name):
            raise ValueError(f"Publisher component changed: {name}/{source.name}")
if digest(package / "LICENSE") != "9b60b9d0411f54d4087484ad4acf28ca6fd9f6a84c30ddacb04de2c623254749":
    raise ValueError("Publisher agreement changed")
notice = (package / "NOTICE").read_text(encoding="utf-8")
for required in ("This Stability AI Model is licensed under the Stability AI Community License", "Copyright © Stability AI Ltd. All Rights Reserved", "Powered by Stability AI", "identity projection"):
    if required not in notice:
        raise ValueError("Required attribution is missing")
for name in ("LICENSE-OpenAI-CLIP.txt", "LICENSE-OpenCLIP.txt", "LICENSE-T5.txt"):
    if digest(package / name) != digest(checks / ("sd35-" + name)):
        raise ValueError(f"Component licence changed: {name}")
records = []
for path in sorted(package.rglob("*")):
    if not path.is_file() or path.name == "provenance.json":
        continue
    record = {"path": path.relative_to(package).as_posix(), "bytes": path.stat().st_size, "sha256": digest(path)}
    records.append(record)
    print(json.dumps(record), flush=True)
t5 = next(value for value in records if value["path"] == "text_encoder_3/model.safetensors")
if t5["sha256"] != "6e480b09fae049a72d2a8c5fbccb8d3e92febeb233bbe9dfe7256958a9167635":
    raise ValueError("Copied T5 weights changed")
publisher = json.loads((downloads / "component-provenance.json").read_text(encoding="utf-8"))
if publisher["revision"] != "f612455c90326409330d5fc9578fc2bcafe979bc" or len(publisher["components"]) != 7:
    raise ValueError("Publisher download is incomplete")
provenance = {
    "architecture": "stable-diffusion-3",
    "pipeline": "StableDiffusion3Pipeline",
    "discoveryUrl": "https://civitai.com/models/2460560?modelVersionId=2766595",
    "civitaiResourceType": "Workflows",
    "weightHost": "huggingface.co",
    "publisher": publisher,
    "configuration": json.loads((checks / "sd35-component-source-validation-current.json").read_text(encoding="utf-8")),
    "conversion": "Diffusers single-file transformer/VAE conversion; strict CLIP state loading with publisher SD3 identity projection; unchanged T5 weights",
    "tensorInspections": inspections,
    "packageFiles": records,
    "license": "Stability AI Community License",
    "commercialUse": "review-required",
    "fullPipelineInferenceVerified": False,
}
(package / "provenance.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
result = {"checkedAtUtc": datetime.now(timezone.utc).isoformat(), "processId": os.getpid(), "package": str(package), "bytesBeforeProvenance": sum(value["bytes"] for value in records), "filesBeforeProvenance": len(records), "tensorInspections": inspections, "allHashesVerified": True, "t5PublisherDigestMatches": True, "licensesAndNoticeVerified": True, "nativeImportVerified": False, "fullPipelineInferenceVerified": False}
(checks / "sd35-nekofantasia-package-validation-current.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
request = {"sourcePath": str(package), "reviewToken": "", "displayName": "Nekofantasia Alpha · SD3.5 Medium", "architecture": "stable-diffusion-3", "sourceUrl": provenance["discoveryUrl"], "licenseName": "Stability AI Community License", "commercialUse": "review-required"}
(verification / "sd35-nekofantasia-import-request-current.json").write_text(json.dumps(request, indent=2), encoding="utf-8")
print(json.dumps(result), flush=True)
