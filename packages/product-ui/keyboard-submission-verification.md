# Composer submission guard verification

Task: `guard-composer-keyboard-submission`.

Baseline: engine snapshot at `f4b3cf6`, captured 2026-09-09T22:23:03.110Z. Existing workspace changes are retained. The starting composer test SHA-256 matches the snapshot: `02263293af7a9b586313421a6ce2dda8c85719cea0d7df16fa86939facba8ca0`. Production `composer.tsx` has no baseline diff.

Before production edits, freeze the new `composer submission guards` cases and these commands from `packages/product-ui`:

- Baseline and candidate: `pnpm test:dom -- src/composer.dom.spec.tsx`
- Candidate static checks: `pnpm typecheck`, `pnpm lint`, `git diff --check -- .`

Cases cover composition start/update/end, native composing and key-code signals, pending keyboard/button activation, ordinary and repeated Enter before rerender, new drafts and repeated activation while a submission waits on an earlier draft write, recovery after false/rejected submissions, pending submission across session switches, modified Enter, and empty/whitespace/disallowed drafts. The sixteen existing draft regressions remain unchanged apart from optional harness parameters.

Composition is simulated in jsdom. Shift+Enter checks that the key remains uncancelled and that a subsequent newline edit is retained; jsdom does not perform native keyboard default editing. Native IME and browser newline insertion are not tested. No servers are started.

Frozen test file SHA-256: `4f7362ab6392c32a0dc50fce359ea6d4b473fb5376c47442cdf040d9bb277af3`.

Baseline result: 5 failed, 29 passed (34 tests), exit 1. Active composition Enter was cancelled; pending keyboard Enter emitted `submit-message`; keyboard and button activation consumed the second draft while the first submission was queued; switching sessions allowed the pending submission to consume B's draft. The existing native IME signal checks and all sixteen draft regressions passed.

The first candidate run exposed a test setup error after the session-switch guard assertions: returning to untouched B supplied an empty snapshot instead of its original `Draft B`. Corrected that snapshot without changing assertions. Final test SHA-256: `5d149f23d3dce05779e654ad36984c5af0db999a7bf486fd0ab429fabcb34561`.

Repeated the baseline comparison using `git show f4b3cf6:packages/product-ui/src/composer.tsx` in a temporary sibling module and the final test file with only its composer import redirected. `pnpm test:dom -- src/composer.keyboard-baseline.dom.spec.tsx` again produced the same five failures and 29 passes (exit 1). Temporary baseline files were removed after execution; the working candidate was never replaced.

Final candidate: `pnpm test:dom -- src/composer.dom.spec.tsx` passed all 34 tests (exit 0), including all sixteen prerequisite draft regressions. Keyboard and button actions share eligibility checks, and a synchronous ref locks submission before React rerenders. The lock lasts through queued draft writes, submission, and revision-aware recovery, and clears in `finally`. Composition events supplement the existing native IME signals. The existing disabled-reason copy remains conditional on `composer.canSend` so temporary pending state does not surface an unrelated reason.

Scope: only `src/composer.tsx`, additions to `src/composer.dom.spec.tsx`, and this record. All other files listed in the engine snapshot retain their supplied hashes. No dependency, schema, public API, draft-hook, or lifecycle field changes.

Final static verification: `pnpm typecheck`, `pnpm lint`, and `git diff --check -- .` passed (exit 0). No unresolved behavioral failures remain in the simulated cases; native IME confirmation and native newline insertion remain unverified.
