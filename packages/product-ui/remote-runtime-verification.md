# Remote runtime refresh verification

Baseline: `f4b3cf6`. The supplied baseline already includes `SnapshotRefreshCoordinator`, queued command refreshes, snapshot cancellation, and command lifecycle checks. Preserve the unrelated composer test and draft verification edits recorded by the engine.

Frozen before production edits: `src/remote-product-app.dom.spec.tsx` uses controlled snapshot and command promises with a transport that deliberately ignores cancellation. Cases cover a command completing during a poll; concurrent and staggered command completions; late snapshot and command success/failure after replacement; unmount during a command refresh or unfinished command; refresh rejection and recovery; active command errors; retained callbacks after replacement, including reuse of the original runtime; and StrictMode cleanup.

Exact baseline and candidate command, from `packages/product-ui`:

```powershell
pnpm test:dom src/remote-product-app.dom.spec.tsx
```

Additional candidate checks: `pnpm test:dom`, `pnpm typecheck`, `pnpm lint`, and `git diff --check`. The package test configuration now includes the existing coordinator tests alongside DOM tests.

Baseline result: 13 passed, 2 failed. The overlapping-poll and stale snapshot publication cases already pass at the engine-captured baseline; their historical failures cannot be reproduced at this revision. Both failures are retained command callbacks executing against the obsolete lifecycle, including after switching A → B → A. Production files were unchanged for this run. Frozen test SHA-256: `3b7ccf988df1964aa31302661ba7c0c8de7f80ad133d590f1902ae940d297e8e`.

The candidate keeps the existing refresh coordinator and binds callbacks, cancellation, and publication to one runtime lifecycle. Retained callbacks cannot borrow a newer lifecycle, even when the same runtime object is reused. Command refreshes explicitly receive the originating lifecycle's signal.

Candidate results: the unchanged focused suite passed all 15 cases. `pnpm test:dom` passed all 37 tests (15 runtime, 6 coordinator, 16 composer). `pnpm typecheck`, `pnpm lint`, and `git diff --check` exited 0. The frozen test hash is unchanged. The pre-existing `draft-verification.md` and `src/composer.dom.spec.tsx` hashes still match the supplied baseline. No dependencies, schemas, public APIs, or task lifecycle fields changed.

Verification uses jsdom with a mocked ProductShell boundary. No servers, browser-native checks, or real network transport are involved.
