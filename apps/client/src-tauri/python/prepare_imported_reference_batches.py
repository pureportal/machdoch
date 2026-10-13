import argparse
import json
from pathlib import Path, PurePosixPath
import re


ARCHITECTURES = (
    "stable-diffusion-3",
    "flux-2", "flux-2-klein-base-4b",
    "flux-1-dev", "flux-1-schnell", "qwen-image", "qwen-image-2512",
)


def write_verified_json(path: Path, value: dict | list) -> None:
    if path.exists():
        if json.loads(path.read_text(encoding="utf-8")) != value:
            raise ValueError(f"Existing preparation differs from the requested native imports: {path}")
        return
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    temporary.replace(path)


def prepare(root: Path, model_root: Path, checks: Path, output: Path, architectures: list[str]) -> None:
    template = json.loads((root / "qwen-image-2.1-refined-request-template.json").read_text(encoding="utf-8"))
    batches = []
    requests = []
    for architecture in architectures:
        log = (checks / f"{architecture}-native-import-current.log").read_text(encoding="utf-8-sig")
        if "test result: ok. 1 passed; 0 failed" not in log:
            raise ValueError(f"Native import has not passed: {architecture}")
        records = [json.loads(line) for line in log.splitlines() if line.startswith('{"schemaVersion":1,"modelId":')]
        if len(records) != 1:
            raise ValueError(f"Expected one native import result: {architecture}")
        imported = records[0]
        digest = imported["digest"]
        if re.fullmatch(r"[0-9a-f]{64}", digest) is None or imported["modelId"] != f"local:user:{digest}":
            raise ValueError(f"Invalid imported model identity: {architecture}")
        relative = PurePosixPath(imported["targetLabel"])
        if relative.is_absolute() or ".." in relative.parts or relative.parts[0] != "models":
            raise ValueError(f"Unsafe imported package path: {architecture}")
        package = model_root.joinpath(*relative.parts).resolve()
        if not package.is_relative_to((model_root / "models").resolve()) or not (package / "model_index.json").is_file():
            raise ValueError(f"Imported package is missing: {architecture}")
        cases = root / f"{architecture}-six-reference-cases.json"
        if len(json.loads(cases.read_text(encoding="utf-8"))) != 6:
            raise ValueError(f"Expected six reference cases: {architecture}")
        request = {
            **template,
            "model": {
                "id": imported["modelId"], "architecture": architecture,
                "packageKind": "diffusers-directory", "path": str(package),
                "configPath": None, "revision": imported["revision"], "digest": digest,
            },
            "addons": [], "referenceImages": [], "negativePrompt": "",
        }
        request_path = root / f"{architecture}-imported-reference-template.json"
        requests.append((request_path, request))
        batches.append({
            "name": f"{architecture}: six imported-engine references",
            "template": str(request_path), "cases": str(cases),
            "outputRoot": str(root / f"{architecture}-imported-six-reference-sweep"),
        })
    for request_path, request in requests:
        write_verified_json(request_path, request)
    write_verified_json(output, batches)
    print(json.dumps({"manifest": str(output), "batches": len(batches), "newEngines": len(architectures)}), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--checks", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--architecture", action="append", choices=ARCHITECTURES)
    arguments = parser.parse_args()
    prepare(arguments.root, arguments.model_root, arguments.checks, arguments.output,
            list(dict.fromkeys(arguments.architecture or ARCHITECTURES)))


if __name__ == "__main__":
    main()
