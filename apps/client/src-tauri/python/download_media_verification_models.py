from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import urllib.parse
import urllib.request


CHECKPOINT_RANGE_BYTES = 512 * 1024 ** 2


class ModelDownloadRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        target = urllib.parse.urlsplit(url)
        host = target.hostname or ""
        if target.scheme != "https" or not (
            host in {"civitai.com", "civitai.red", "b2.civitai.com"}
            or host.startswith("civitai-delivery-worker-prod.") and host.endswith(".r2.cloudflarestorage.com")
        ):
            raise ValueError("The model download redirected to an unexpected host")
        redirected = super().redirect_request(request, response, code, message, headers, url)
        if host not in {"civitai.com", "civitai.red"}:
            redirected.remove_header("Authorization")
        return redirected


def download(root: Path, model_id: int, version_id: int, filename: str, api_key: str | None) -> None:
    headers = {"User-Agent": "machdoch-media-studio/1.0"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    opener = urllib.request.build_opener(ModelDownloadRedirects())
    request = urllib.request.Request(f"https://civitai.com/api/v1/models/{model_id}", headers=headers)
    with opener.open(request, timeout=60) as response:
        model = json.load(response)
    version = next((version for version in model["modelVersions"] if version["id"] == version_id), None)
    if version is None:
        raise ValueError("The requested Civitai model version is missing")
    file = next((file for file in version["files"] if file["name"] == filename), None)
    if file is None:
        raise ValueError("The requested Civitai file is missing; check the current version file list")
    expected_digest = file["hashes"]["SHA256"].lower()
    expected_bytes = round(file["sizeKB"] * 1024)
    if expected_bytes <= 0:
        raise ValueError("The Civitai file has an invalid size")
    directory = root.resolve() / str(model_id) / str(version_id)
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / Path(filename).name
    partial = destination.with_suffix(destination.suffix + ".part")
    if destination.exists():
        with destination.open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual != expected_digest or destination.stat().st_size != expected_bytes:
            raise ValueError("Existing model weights have an unexpected digest")
        print(json.dumps({"verified": str(destination), "sha256": actual}), flush=True)
        return
    download_url = urllib.parse.urlsplit(file["downloadUrl"])
    if download_url.scheme != "https" or download_url.hostname not in {"civitai.com", "civitai.red"} or download_url.username is not None:
        raise ValueError("The model file has an unexpected download URL")
    request = urllib.request.Request(file["downloadUrl"], headers=headers)
    digest = hashlib.sha256()
    received = 0
    if partial.exists():
        with partial.open("rb") as stream:
            while chunk := stream.read(4 * 1024 ** 2):
                digest.update(chunk)
                received += len(chunk)
        if received > expected_bytes:
            raise ValueError("The partial checkpoint exceeds the publisher byte count")
        print(json.dumps({"resuming": str(partial), "bytes": received}), flush=True)
    if received < expected_bytes:
        with opener.open(request, timeout=120) as response:
            delivery_url = response.geturl()
    with partial.open("ab") as stream:
        while received < expected_bytes:
            end = min(received + CHECKPOINT_RANGE_BYTES, expected_bytes) - 1
            range_request = urllib.request.Request(delivery_url, headers={
                "User-Agent": headers["User-Agent"], "Range": f"bytes={received}-{end}",
            })
            with opener.open(range_request, timeout=120) as response:
                if response.status != 206 or response.headers.get("Content-Range") != f"bytes {received}-{end}/{expected_bytes}":
                    raise ValueError("The checkpoint server did not return the requested byte range")
                while received <= end:
                    chunk = response.read(min(4 * 1024 ** 2, end + 1 - received))
                    if not chunk:
                        raise ValueError(f"Downloaded model weights are incomplete: received {received} of {expected_bytes} bytes")
                    stream.write(chunk)
                    digest.update(chunk)
                    received += len(chunk)
            print(json.dumps({"modelId": model_id, "versionId": version_id, "bytes": received}), flush=True)
    if digest.hexdigest() != expected_digest:
        raise ValueError("Downloaded model weights have an unexpected digest")
    partial.replace(destination)
    provenance = {"modelId": model_id, "versionId": version_id, "filename": filename,
                  "sha256": expected_digest, "bytes": received,
                  "sourceUrl": f"https://civitai.com/models/{model_id}?modelVersionId={version_id}",
                  "model": model["name"], "baseModel": version["baseModel"]}
    destination.with_suffix(".provenance.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    print(json.dumps({"downloaded": str(destination), "bytes": received, "sha256": expected_digest}), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--model-id", type=int, required=True)
    parser.add_argument("--version-id", type=int, required=True)
    parser.add_argument("--filename", required=True)
    arguments = parser.parse_args()
    credentials = Path.home() / "AppData" / "Roaming" / "machdoch" / "civitai.json"
    api_key = json.loads(credentials.read_text(encoding="utf-8")).get("apiKey") if credentials.exists() else None
    download(arguments.root, arguments.model_id, arguments.version_id, arguments.filename, api_key)


if __name__ == "__main__":
    main()
