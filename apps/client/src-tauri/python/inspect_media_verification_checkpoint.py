import argparse
import json
from pathlib import Path
import struct
import urllib.request

from download_media_verification_models import ModelDownloadRedirects


def inspect(model_id: int, version_id: int, filename: str, output: Path) -> None:
    credentials = Path.home() / "AppData" / "Roaming" / "machdoch" / "civitai.json"
    key = json.loads(credentials.read_text(encoding="utf-8")).get("apiKey") if credentials.exists() else None
    headers = {"User-Agent": "machdoch-media-studio/1.0"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    opener = urllib.request.build_opener(ModelDownloadRedirects())
    request = urllib.request.Request(f"https://civitai.com/api/v1/models/{model_id}", headers=headers)
    with opener.open(request, timeout=60) as response:
        model = json.load(response)
    version = next((item for item in model["modelVersions"] if item["id"] == version_id), None)
    if version is None:
        raise ValueError("The requested Civitai version is missing")
    file = next((item for item in version["files"] if item["name"] == filename), None)
    if file is None:
        raise ValueError("The requested Civitai filename changed; inspect the current version file list")
    if not file["downloadUrl"].startswith("https://civitai.com/api/download/models/"):
        raise ValueError("Unexpected Civitai checkpoint URL")

    request = urllib.request.Request(file["downloadUrl"], headers=headers)
    with opener.open(request, timeout=120) as response:
        size_bytes = response.read(8)
        if len(size_bytes) != 8:
            raise ValueError("The checkpoint header size is incomplete")
        header_size = struct.unpack("<Q", size_bytes)[0]
        if not 2 <= header_size <= 64 * 1024 ** 2:
            raise ValueError("Invalid safetensors header size")
        content = response.read(header_size)
        if len(content) != header_size:
            raise ValueError("The checkpoint header is incomplete")
    header = json.loads(content)
    tensors = {name: value for name, value in header.items() if name != "__metadata__"}
    record = {
        "modelId": model_id, "versionId": version_id, "filename": filename,
        "sha256": file["hashes"]["SHA256"].lower(), "header": header,
        "headerOnly": True, "weightDigestVerified": False,
        "sourceUrl": f"https://civitai.com/models/{model_id}?modelVersionId={version_id}",
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(record, indent=2), encoding="utf-8")
    quantization = [name for name in tensors if any(term in name.lower() for term in ("quant", "scale", "absmax"))]
    print(json.dumps({"tensors": len(tensors), "dtypes": sorted({value["dtype"] for value in tensors.values()}),
                      "quantizationKeys": quantization[:20], "firstKeys": list(tensors)[:8], "output": str(output)}), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-id", type=int, required=True)
    parser.add_argument("--version-id", type=int, required=True)
    parser.add_argument("--filename", required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    inspect(arguments.model_id, arguments.version_id, arguments.filename, arguments.output)


if __name__ == "__main__":
    main()
