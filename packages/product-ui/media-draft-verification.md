# Media draft reconciliation verification

Task: `preserve-media-drafts-during-snapshot-updates`.

Baseline is the supplied engine snapshot at `f4b3cf6` (2026-09-10T04:20:24.500Z), including existing workspace edits. Production `src/media-studio.tsx` is unchanged from HEAD before this task; SHA-256: `20a1e771da7943f3d1a82f5b8cb0f9074c0920e7de386b539ea665150e098da5`.

Frozen before production changes:

- Reconciliation policy: initial generation inputs populate the draft. A change to any upstream generation input replaces the whole draft, retaining the existing policy. Availability and reason metadata never trigger replacement. Equivalent input snapshots retain local edits.
- Availability controls continue to use the existing model catalog and loading/error/busy/pending checks. Removing all models disables generation and model selection and shows the upstream reason when the draft target matches. Restoring the catalog restores the edited model selection.
- Eighteen DOM cases cover initial inputs, all edited image/SVG inputs across availability and reason-only transitions, repeated equivalent snapshots, model removal/recovery and reason updates, seven upstream input change cases, and exact submitted image/SVG commands compared with displayed drafts.
- Exact baseline and candidate command from `C:\Development\machdoch\packages\product-ui`: `pnpm test:dom -- src/media-studio.dom.spec.tsx --reporter=verbose`.
- Frozen test SHA-256: `9d9ab166fceafe46b7c2503bb4d87a68b459674d90229c9bb341c9b83934de7d`.
- Existing `vitest.config.ts` SHA-256: `f9733ae6822f4532a36b3ee5e768a2175e9477854d7716e7695e809cbfa926fb`; no configuration or dependency changes are needed.
- Candidate static checks: `pnpm typecheck`, `pnpm lint`, and `git diff --check -- src/media-studio.tsx`.

The available Machdoch tool interface exposes shell execution but no verification-plan freeze or baseline/candidate comparison operation. This record freezes the local cases; Machdoch shell results provide runtime observations. Engine acceptance of the frozen plan and comparison remains a separate completion requirement if those observations are not ingested automatically. Task lifecycle fields are untouched.

Preliminary baseline execution reproduced five failures with nine passing cases. Before production edits, corrected test-only TypeScript issues and split availability directions and reason-only transitions into independent cases so each produces a baseline result. The final eighteen-case matrix supersedes the preliminary test hash above. No production file has changed. Machdoch shell execution returned an error without a terminal test summary; use the package-script tool with an explicit timeout for the final baseline and candidate.

Final pre-production test SHA-256: `9fb14c7cc07cbc75584080eb238842c235bb3fb1b1fdd2307c1b6332a733e3fb`. The exact baseline and candidate command remains unchanged. Test TypeScript checks pass.

Machdoch package-script execution with `packagePath: "."` and `timeoutMs: 180000` is blocked by `spawn npm ENOENT`. The workspace for that tool is already the package directory. Engine verification cannot be claimed from this failed invocation. Preserve the local baseline/candidate output for engine ingestion or rerun after fixing the runner environment.

Final baseline: both the local tracked process and a subsequent Machdoch shell invocation completed with 9 failed and 9 passed (18 cases, exit 1). Each availability direction and reason-only update reset the edited image/SVG draft. Catalog removal also reset the draft, and image/SVG submissions used the reset snapshot values. Initial inputs, equivalent snapshots, and all seven intentional upstream changes passed.

Production change: serialize `draftFromMedia(media)` as the reconciliation key. The same projection initializes and reconciles the draft, excluding availability metadata. No availability, model selection, modal, or submission behavior was otherwise changed.

Final candidate: the identical Machdoch shell command passed all 18 cases (exit 0). The frozen test SHA-256 is unchanged. Candidate production SHA-256: `0f230fd5f0f3d37bb949d25c7065c5577fb392b6b05f2461e9c4bc02b552b595`.

Machdoch shell `pnpm typecheck` and `pnpm lint` both passed (exit 0); lint reports zero warnings/errors on 34 files. `git diff --check -- src/media-studio.tsx` passed. Raw tool observations are retained at `.machdoch/ralph/runs/2026-09-09T23-30-29-571Z/code-improvements/media-draft-tool-observations.json` relative to the repository root. The initial runner failures are superseded by completed shell observations; the package-script runner still lacks npm.

Resumable engine checkpoint: implementation and the frozen DOM matrix pass, but this invocation has no engine verification-plan freeze/comparison operation. Ingest the retained baseline/candidate observations and the pre-production policy/hash record through the engine before lifecycle completion. This document and tool observations do not assert engine attestation. No task lifecycle fields were modified.

Scope is `src/media-studio.tsx`, the new DOM suite, this record, and the tool-observation artifact. All 64 pre-existing changed/untracked files in the supplied snapshot retain their recorded SHA-256 hashes. No dependencies, schemas, or public APIs changed. No servers were started. Real-browser interaction and provider execution are unverified; submission is checked at the command-handler boundary. Rollback should remove only this task's key change and added test/evidence files, preserving existing changes and any subsequent modal work.

Validation-fix checkpoint (2026-09-10): the review finding remains blocked on engine-owned behavioral verification. Inspected the callable tool catalog; it exposes shell/package execution and workflow management, but no operation to ingest verification evidence, freeze a verification plan, or record an engine baseline/candidate comparison. Rechecked SHA-256 hashes of the candidate source, final eighteen-case test suite, and Vitest configuration; all match the values recorded above. Read the retained observations and confirmed their explicit agent-recorded provenance. The supplied engine comparison covers only typecheck/lint and cannot attest to the DOM cases. No source, tests, task state, or retained observations were changed, and no servers were started. Tests were not rerun because unchanged inputs and another agent shell result would not resolve this finding.

Resume through the owning engine: ingest and validate this frozen policy, the recorded source/test/configuration hashes, and the retained baseline/candidate observations, or execute the identical eighteen-case command against isolated baseline and candidate snapshots. Record the engine-owned behavioral comparison before completion. This checkpoint does not claim that the review finding is fixed.
