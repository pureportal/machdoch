# RALPH verification — 2026-10-04

Later native recovery and real Codex 6.1 Sol evidence is recorded in [the October 5 report](ralph-goal-verification-2026-10-05.md). This document retains the earlier outcome.

The full goal is not yet verified. Feature completion and checkpoint recovery are stronger, and the bundled CLI passes a real cancellation/resume check. Playwright verified the native graph and parameter controls, but the debug desktop instance became unavailable twice before a complete UI recovery test could finish. The exits cannot be attributed to a crash or a restart from the available evidence.

## Changes

- The feature template retains the previous goal and research in its checklist, passes them to implementation and review, and matches resume context against the complete request identity.
- Task schemas require acceptance criteria and priority. A missing request identity cannot match another missing identity.
- Completed tasks now lead to fresh full-feature checks and a whole-feature review. Missing work leads to bounded repair and another check, retaining the configured dependency, schema, and public API limits. Exhausted review budgets and unavailable prerequisites lead to deferred outcomes, never completed outcomes. Checkpoints retain the consumed review budget.
- The graph uses four expanded phases: Plan, Implement, Verify, and Record outcome. Every executable node belongs to one phase.
- Text parameters accept multiline input; numbers and booleans retain dedicated controls.
- Cancellation exposed a real recovery defect: the CLI rejected a stopped run despite its healthy checkpoint and a recovery instruction. One shared status rule now permits checkpoint recovery for stopped runs in the CLI, run summaries, desktop editor, and Fleet. Active runs and completed runs remain excluded.

The previous-goal, reference-retention, layout, parameter, and browser-runtime work was already present when this task resumed. This pass completed the feature review gate, fixed stopped-run recovery, and verified the relevant combined changes. Unrelated Media Studio changes were preserved.

## Automated checks

171 tests passed across 17 files:

| Area | Result | Local evidence |
| --- | --- | --- |
| Feature completion, retained references, starter contracts, request identity, layout | 54 tests in 5 files | `.tmp/ralph-goal-completion-2026-10-04.log` |
| Persistence, ownership, cancellation, continuation, finite recovery, verification, starter upgrades | 62 tests in 8 files | `.tmp/ralph-goal-recovery-2026-10-04.log` |
| Stopped-run eligibility, checkpoint summaries, CLI contracts, Fleet recovery | 55 tests in 4 files | `.tmp/ralph-goal-stopped-recovery-tests-2026-10-04.log` |
| Core, UI, and core-test TypeScript checks | Passed | `.tmp/ralph-goal-{core,ui,test}-typecheck-2026-10-04.log` |
| Client build, CLI bundle, production UI build | Passed | `.tmp/ralph-goal-client-build-2026-10-04.log`, `.tmp/ralph-goal-cli-bundle-2026-10-04.log`, `.tmp/ralph-goal-ui-build-2026-10-04.log` |
| Formatting, scoped lint, scoped Git whitespace checks | Passed | `.tmp/ralph-goal-recovery-lint-2026-10-04.log`; command output |

The whole repository test suite and the separate UI logic-test TypeScript project were not verified. Native Rust/browser-extraction tests were not verified; an earlier native test attempt ended at `link.exe`. Successful JavaScript/browser checks do not establish native packaging correctness.

The review tests mock the model and execute real utility nodes and verification commands. They prove routing, bounded repair, preserved budgets, and absence of premature completion; they do not prove that a model will deliver a high-quality feature.

A final rerun passed all 47 starter contract tests, but one completion integration test exceeded the default 30-second test limit while builds were running. These tests now have a 120-second limit and cap each child verification command at 30 seconds. Both passed in the final run, taking about seven seconds each. Results are retained in `.tmp/ralph-goal-final-template-2026-10-04.log` and `.tmp/ralph-goal-final-completion-retry-2026-10-04.log`. This does not establish a performance guarantee under concurrent load.

## Bundled CLI recovery

The current production CLI bundle executed a disposable workspace flow:

1. A missing JSON file routed through its explicit recovery edge.
2. A JSON read supplied references to a downstream file write together with a multiline previous goal.
3. A cancellation request stopped the run after the write, with a healthy durable checkpoint.
4. After fixing the stopped-run guard, `ralph resume --retry-current` completed the same run.
5. The final file contained the exact goal and references once. The retained operation ledger prevented a repeated append.

Run: `2026-10-04T18-09-53-537Z`, under `.tmp/ralph-native-workspace-2026-10-04`.

Evidence: `.tmp/ralph-native-2026-10-04/cli-stopped.json`, `cli-resumed.json`, `cli-results.json`, and `.tmp/ralph-goal-cli-recovery-results-2026-10-04.log`.

This was a deterministic recovery and data-piping check. Its references were fixture data; it did not call an AI provider or perform web search.

## Playwright evidence

Playwright connected to the actual Tauri WebView2 at `http://tauri.localhost/` through CDP. No development server was started.

- Opened the native RALPH library and loaded the feature template from the current catalog in a disposable workspace.
- Inspected 51 graph nodes, including four phase groups. All phases were expanded and the flow had no local validation errors.
- Opened the native Run setup panel for a disposable flow. Its text field was a textarea, its number field was a number input, and its boolean field was a select. Missing values correctly prevented running that flow.
- A separate browser harness exercised the production parameter component with multiline input, typed controls, and a 390-pixel viewport. It reported no page errors or horizontal overflow. It also launched the packaged Playwright runtime successfully.

Native screenshots and snapshots:

- `.tmp/ralph-native-2026-10-04/library.png`
- `.tmp/ralph-native-2026-10-04/feature-template.png`
- `.tmp/ralph-native-2026-10-04/recheck-parameters.png`
- `.tmp/ralph-native-2026-10-04/recheck-parameters.json`

Component harness results: `.tmp/ralph-playwright-2026-10-04/results.json`, `parameters-desktop.png`, and `parameters-narrow.png`.

Library requests hit the native 30-second query timeout during testing. Refresh recovered the library during the first session, and the second session remained editable after a timeout. This does not establish that query delays are resolved.

The first native feature run left a startup trace without a checkpoint when the debug instance disappeared. The second instance also lost its CDP endpoint before the cancellation test. There is no completed native UI cancellation/resume sequence or fresh, compiled desktop verification of the stopped-run button change. The installed desktop instance was not stopped or restarted. Test-owned processes were stopped, and RALPH workspace preferences were restored after both sessions.

## Goal coverage

| Requirement | Evidence | Remaining limit |
| --- | --- | --- |
| Crash resistance | Recovery and storage regressions pass; CLI cancellation/resume completes | Debug desktop exits remain unexplained; no long-duration crash-free claim |
| No indefinite blocking | Finite recovery and review budgets pass; explicit failed/inconclusive routing | Native library query timeouts still occurred |
| Sensible templates | Starter validation and upgrade tests pass; completed tasks require full-feature review | No large feature completed with a real provider |
| Understandable grouped graph | Native Playwright screenshot and containment/layout tests | Only the feature template received this visual review |
| Previous logged failures | Windows held-file rename, degraded persistence, ownership and cancellation cases pass | No claim that every historical Machdoch error has been reproduced and eliminated |
| Polished, usable UI | Native library/editor/Run setup inspected; narrow parameter harness passes | Full usability and complete recovery UI remain unverified |
| Typed, understandable parameters | Native textarea/number/select inspected; component editing checks pass | Native submission of all field types did not complete |
| Previous goal and strict completion | Persisted goal/research, request matching, fresh checks, complete-feature review and bounded repairs | Model judgment and actual feature quality still require a real end-to-end delivery |
| Information piping | Exact references and multiline goal survive durable CLI recovery without duplicate writes | Real web-search results were not tested end to end |
| Node system | Native nodes render; phase membership and canonical outputs validate; new review nodes execute in tests | Broad interaction review of every node type was not performed |
| Fast decisions | Targeted changes and bounded execution rather than unbounded retry | No decision-speed benchmark or provider latency claim |

Historical evidence reviewed: `docs/ralph-failure-investigation-2026-09-30.md`, `docs/ralph-reliability-repairs-2026-09-30.md`, `.machdoch/ralph/diagnostics/ralph-hardening-2026-10-02.md`, and recent persisted repository runs. The Oct 2 Windows `EPERM` rename/degraded-durability case and Oct 1 provider cancellation informed the targeted recovery checks. Historical records were retained.

The remaining full-outcome verification requires a stable native test session, a complete UI cancellation/resume cycle using the rebuilt frontend, and a real provider-backed feature delivery with web references and product-level acceptance evidence.
