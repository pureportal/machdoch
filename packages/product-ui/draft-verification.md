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
