#!/usr/bin/env bash
set -euo pipefail

for attempt in 1 2 3; do
  echo "Building RPM (attempt $attempt of 3)"
  if timeout --signal=TERM --kill-after=10s 20m \
    pnpm --filter @machdoch/client tauri bundle --bundles rpm; then
    exit 0
  else
    status=$?
  fi

  if [[ "$status" -ne 124 && "$status" -ne 137 ]]; then
    exit "$status"
  fi

  if [[ "$attempt" -eq 3 ]]; then
    echo "RPM bundling timed out after three attempts" >&2
    exit "$status"
  fi
done
