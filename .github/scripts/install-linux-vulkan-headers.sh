#!/usr/bin/env bash
set -euo pipefail

version=1.4.341
checksum=8876aad926b2e72bdefddc34885472d5332e2d20aa3ed57313466f0bc982cf3f
archive="$(mktemp)"
source_directory="$(mktemp -d)"
trap 'rm -rf "$archive" "$source_directory"' EXIT

curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error \
  --output "$archive" \
  "https://github.com/KhronosGroup/Vulkan-Headers/archive/refs/tags/v${version}.tar.gz"
printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status
tar -xzf "$archive" --directory "$source_directory" --strip-components=1
cmake -S "$source_directory" -B "$source_directory/build" \
  -DCMAKE_INSTALL_PREFIX=/usr/local \
  -DVULKAN_HEADERS_ENABLE_TESTS=OFF \
  -DVULKAN_HEADERS_ENABLE_MODULE=OFF
cmake --install "$source_directory/build"
