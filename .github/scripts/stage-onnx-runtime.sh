#!/usr/bin/env bash
set -euo pipefail

case "${1:?missing runner architecture}" in
  X64)
    architecture=x64
    checksum=43725474ba5663642e17684717946693850e2005efbd724ac72da278fead25e6
    ;;
  ARM64)
    architecture=aarch64
    checksum=6715b3d19965a2a6981e78ed4ba24f17a8c30d2d26420dbed10aac7ceca0085e
    ;;
  *)
    echo "Unsupported ONNX Runtime architecture: $1" >&2
    exit 1
    ;;
esac

version=1.24.2
archive="$(mktemp)"
extraction_directory="$(mktemp -d)"
trap 'rm -rf "$archive" "$extraction_directory"' EXIT

curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error \
  --output "$archive" \
  "https://github.com/microsoft/onnxruntime/releases/download/v${version}/onnxruntime-linux-${architecture}-${version}.tgz"
printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status
tar -xzf "$archive" --directory "$extraction_directory" --strip-components=1
install -Dm755 \
  "$extraction_directory/lib/libonnxruntime.so.1.24.2" \
  apps/client/src-tauri/target/onnxruntime/libonnxruntime.so.1
ln -sfn libonnxruntime.so.1 \
  apps/client/src-tauri/target/onnxruntime/libonnxruntime.so
