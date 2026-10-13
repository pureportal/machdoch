import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image


def runtime_digest(root: Path) -> str:
    files = [*root.glob("media_*.py"), *root.glob("fizgig/**/*.py"),
             root / "open_media_models.json", root / "image_sampling_profiles.json",
             root / "media_diffusers_requirements.txt"]
    digest = hashlib.sha256()
    for path in sorted(set(files)):
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def save_results(path: Path, results: dict) -> None:
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(results, indent=2), encoding="utf-8")
    temporary.replace(path)


def validate_response(request: dict, response: dict) -> dict:
    for field in ("schemaVersion", "prompt", "negativePrompt", "modelPolicy", "aspectRatio"):
        if response.get(field) != request[field]:
            raise ValueError(f"Generation response changed {field}")
    if len(response["outputs"]) != 1:
        raise ValueError("Generation returned an unexpected output count")
    output = response["outputs"][0]
    if output["seed"] != request["seed"]:
        raise ValueError("Generation returned an unexpected seed")
    for field in ("sampler", "numInferenceSteps"):
        if response[field] != request["sampling"][field]:
            raise ValueError(f"Generation returned unexpected {field}")
    for field in ("width", "height"):
        expected = request["sampling"].get(field)
        if expected is not None and output[field] != expected:
            raise ValueError(f"Generation returned unexpected {field}")
    filename = output["fileName"]
    if not isinstance(filename, str) or not filename or "/" in filename or "\\" in filename or Path(filename).name != filename:
        raise ValueError("Generation returned an unsafe image filename")
    directory = Path(request["outputDirectory"]).resolve()
    image_path = (directory / filename).resolve()
    if image_path.parent != directory:
        raise ValueError("Generation image is outside its output directory")
    with Image.open(image_path) as image:
        image.load()
        if image.size != (output["width"], output["height"]):
            raise ValueError("Output dimensions do not match decoded pixels")
        if np.asarray(image.convert("RGB"), dtype=np.float32).std(axis=(0, 1)).max() <= 1:
            raise ValueError("Generation returned blank pixels")
    return {
        "passed": True,
        "image": str(image_path),
        "width": output["width"],
        "height": output["height"],
        "numInferenceSteps": response["numInferenceSteps"],
        "workerVersion": response["workerVersion"],
        "deviceLabel": response["deviceLabel"],
        "sampler": response["sampler"],
        "schedulerClass": response["schedulerClass"],
        "guidanceScale": request["sampling"].get("guidanceScale"),
        "sha256": hashlib.sha256(image_path.read_bytes()).hexdigest(),
    }


def completed_case(records: list[dict], reference_id: int, request: dict, runtime_sha256: str,
                   capture_latents: bool, output_root: Path) -> dict | None:
    for record in reversed(records):
        if not record.get("passed") or record.get("referenceId") != reference_id:
            continue
        if record.get("runtimeSha256") != runtime_sha256:
            continue
        directory = Path(record["directory"]).resolve()
        if directory.parent != output_root.resolve():
            raise ValueError("Saved reference evidence is outside its batch directory")
        saved = json.loads((directory / "request.json").read_text(encoding="utf-8"))
        expected = {**request, "outputDirectory": str(directory / "images")}
        if saved != expected:
            continue
        if capture_latents and not (directory / "decoder-latents.safetensors").is_file():
            continue
        response = json.loads((directory / "response.json").read_text(encoding="utf-8"))
        actual = validate_response(saved, response)
        if any(record.get(field) != value for field, value in actual.items()):
            raise ValueError("Saved reference evidence no longer matches its image or response")
        return record
    return None
