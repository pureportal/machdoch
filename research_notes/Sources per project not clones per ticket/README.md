# Research notes: sources per project, not clones per ticket

Supports [the report](../../reports/Sources%20per%20project%2C%20not%20clones%20per%20ticket.md).

## Fetch-size measurement

Run on 15 November 2026 with Git 2.53.0.windows.2 against this workspace at commit `44488a6c` (6,450 files at `HEAD`, 403.2 MiB of blobs, 343.5 MiB of packs). The source was served over `file://` with filters and arbitrary SHA requests allowed:

```sh
UP='git -c uploadpack.allowFilter=true -c uploadpack.allowAnySHA1InWant=true upload-pack'
SRC=file:///c/Development/machdoch

git clone -q --no-checkout --depth=1 --upload-pack="$UP" "$SRC" full

git clone -q --no-checkout --depth=1 --filter=blob:none --sparse --upload-pack="$UP" "$SRC" sparse
cd sparse
git sparse-checkout set packages/recurrence
git checkout -q
```

| Fetch | Objects on disk | Wall time |
|---|---|---|
| `--depth=1`, full tree | 276 MiB | 48,250 ms |
| `--depth=1 --filter=blob:none --sparse`, cone `packages/recurrence` | 406 KiB | 3,463 ms |

The sparse checkout fetched its blobs lazily over the local transport. The in-guest gateway would reject that pattern (one transfer at a time, 128 per run), so the report recommends one batched `git backfill --sparse` instead. Timings reflect a loaded Windows laptop and local process cost; only the byte counts carry over to the sandbox. The scratch clones were deleted afterwards.

## Code facts used

- Single `repository` and `baseCommit` per profile: `packages/fleet-protocol/src/cloud-execution.ts`.
- Hand-typed base SHA: `apps/cloud/src/components/cloud/execution-settings.tsx`.
- Pull-request runs are the only ones that replace `baseCommit`: `apps/cloud/src/server/cloud/execution/admission.ts`.
- Broker limits and in-memory buffering: `apps/cloud/src/server/cloud/execution/repositories.ts`, `packages/fleet-protocol/src/cloud-repository.ts`.
- Validation and repair VMs fetch the base again: `packages/cloud-client/src/worker/task-environments.ts` (`restore` calls `start`, which calls `prepare_repository`).
- Guest resources and missing network adapter: `packages/cloud-client/src/worker/sandbox/machine-launch.ts`, `apps/cloud-runner/guest/boot.sh`.
- Server image has no Git binary: `apps/cloud/Dockerfile` (`node:24.22.1-bookworm-slim`, only `ffmpeg` installed via apt).
- Push webhooks already parsed: `apps/cloud/src/server/cloud/git/github-webhooks.ts`.
