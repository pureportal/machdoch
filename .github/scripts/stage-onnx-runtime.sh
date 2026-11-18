#!/usr/bin/env bash
set -euo pipefail

case "${1:?missing runner architecture}" in
  X64)
    runtime_identifier=linux-x64
    ;;
  ARM64)
    runtime_identifier=linux-arm64
    ;;
  *)
    echo "Unsupported ONNX Runtime architecture: $1" >&2
    exit 1
    ;;
esac

version=1.24.2
checksum=782564d3d68e87269ea1812cc94710ad06fe014faf093f01a6f89d0bd58719d3
staging_directory=apps/client/src-tauri/target/onnxruntime
archive="$(mktemp)"
trap 'rm -f "$archive"' EXIT

curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error \
  --output "$archive" \
  "https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/${version}/microsoft.ml.onnxruntime.${version}.nupkg"
printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status
python3 -I - "$archive" "$staging_directory" "$runtime_identifier" <<'PYTHON'
import shutil
import sys
import zipfile
from pathlib import Path

archive, staging_directory, runtime_identifier = sys.argv[1:]
staging = Path(staging_directory)
members = {
    f"runtimes/{runtime_identifier}/native/libonnxruntime.so": staging / "libonnxruntime.so.1",
    "LICENSE": staging / "legal" / "LICENSE",
    "ThirdPartyNotices.txt": staging / "legal" / "ThirdPartyNotices.txt",
}
with zipfile.ZipFile(archive) as package:
    for member, destination in members.items():
        destination.parent.mkdir(parents=True, exist_ok=True)
        with package.open(member) as source, destination.open("wb") as target:
            shutil.copyfileobj(source, target)
PYTHON
chmod 755 "$staging_directory/libonnxruntime.so.1"
chmod 644 "$staging_directory/legal/LICENSE" "$staging_directory/legal/ThirdPartyNotices.txt"
ln -sfn libonnxruntime.so.1 "$staging_directory/libonnxruntime.so"
