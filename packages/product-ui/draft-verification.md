# Composer draft verification

Task: `preserve-session-composer-drafts`.

Baseline: `0d005e6`. Before production edits, `git diff 0d005e6 -- src/composer.tsx package.json` was empty. The package had no pre-existing changes.

The package-local command frozen before implementation was `pnpm test:dom`, which runs `vitest run --config vitest.config.ts` with the workspace's existing Vitest, Testing Library, and jsdom installations. No dependencies or wire contracts were changed.

The ten frozen cases cover distinct session drafts, session identity and exact whitespace in draft writes, delayed failure with an empty or populated destination session, edits during successful and failed submissions, deliberate deletion during submission, delayed snapshots after success, retyping identical text as a new revision, and delayed write ordering around submission.

Baseline result: all ten cases failed (exit 1). The failures included A's draft disappearing after switching, A's failed prompt appearing in B, deliberately deleted text being restored, stale submitted text returning after switching, and missing `update-draft` commands.

Two additional candidate checks cover rejected submission and draft-write promises, including recovery, session-scoped errors, and subsequent writes.

Candidate verification commands, run from `packages/product-ui`:

- `pnpm test:dom`
- `pnpm typecheck`
- `pnpm lint`
- `git diff --check -- .`

Candidate results: all twelve DOM tests passed (exit 0), including the original ten cases without behavioral changes to their expectations. Typecheck, lint, and `git diff --check -- .` passed (exit 0). The first candidate DOM run reported a Vitest shutdown timeout after its successful test results. The diagnostic rerun, `pnpm test:dom --reporter=default --reporter=hanging-process`, also passed all twelve tests and exited 0, but repeated the shutdown warning and reported 17 `FILEHANDLE` handles with unknown stack traces. The source of those handles remains unverified; there are no unresolved behavioral test failures.

The contract has no draft revision field. Once edited or submitted locally, a session's draft remains locally authoritative for the mounted composer's lifetime; snapshots cannot replace it. Per-session command ordering protects persisted text from this composer's older writes. Cross-client concurrent draft merging is not provided by the existing contract. DOM checks use jsdom; no browser or development server was started.

## Resumed verification: 2026-09-09

The engine-supplied baseline is `f4b3cf6256ecd1e25ebbd1c0c01d8bfc11433aee`, with a clean working tree. It already contains the implementation, package-local DOM command, and twelve regressions described above. The earlier ten failing baseline results belong to `0d005e6`, not this run's baseline.

The focused command recorded before edits was `pnpm test:dom -- src/composer.dom.spec.tsx`, run from `packages/product-ui`. All twelve existing regressions passed against the supplied baseline (exit 0).

Four additional controlled-promise cases cover saving B while A's submission is pending (success and failure), editing A after switching away and back before failure, and editing while the successful submission's final clear remains pending. The same focused command passed all sixteen cases (exit 0) against the unchanged baseline production implementation. This candidate adds tests and this verification record only; no production, dependency, schema, public API, or task lifecycle changes were needed.

`pnpm typecheck`, `pnpm lint`, and `git diff --check -- .` passed (exit 0). Both DOM runs exited without the historical shutdown warning. The production files, package manifest, and Vitest configuration have no diff against the engine baseline. No behavioral failure remains in these cases. Browser-native behavior and cross-client draft merging were not verified; the mounted-lifetime and existing-contract limits described above still apply.
