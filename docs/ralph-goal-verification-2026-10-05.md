# RALPH verification — 2026-10-05

A real RALPH feature run completed through the rebuilt Tauri backend with provider `codex-cli`, model `gpt-6.1-sol`, outcome `succeeded`, `verified: true`, and healthy durability. Independent Playwright acceptance and native editor checks passed. This report records the tested coverage and remaining limits; it does not establish that every future run will be crash-free.

## Changes in this pass

Successful provider capability probes are reused when the executable fingerprint, provider, working directory, and PATH match. Verified evidence lasts 30 minutes so a six-minute agent operation does not discard its preflight evidence. Enrollment still requires the same delivery-plan identity and forces fresh probes after a mismatch. Incomplete version/help evidence expires after 15 seconds instead of being treated as successful evidence. This removes redundant probing without accepting an unverified instruction route.

The real native review exposed additional cold-start failures after the first cache change. Probe deadlines are now 12 seconds initially and 30 seconds on retry, replacing 4 and 12 seconds. Successful probes still finish immediately. The number of commands and concurrent probes remain bounded.

A later independent library query succeeded in 34.6 seconds, exceeding the native 30-second query deadline. The native deadline for snapshot, list, and runs is now 60 seconds. This prevents that measured successful query from being stopped prematurely while retaining a finite limit.

The recovered real-provider review exposed two checkpoint defects. Deferred selected work now resumes its recorded phase in the pinned graph, renewing ownership and rerunning verification without repeating successful implementation. Deferred work cannot transition directly to completed. The feature template retains invalid outcomes instead of archiving their checklist, and the archive operation refuses to remove unfinished selected work. A missing canonical journal can be recovered from this run's recorded archive operation after checking task ownership; recovery preserves the exact bytes and archive and refuses to overwrite a reappearing journal.

Historical deferrals no longer override a completed, journaled outcome that passes all existing verification, scope, and reporting gates. Explicit deferrals and missing evidence still prevent success. Completed selected work resumes through its recorded task assessment and full-feature checks. Retry checkpoints preserve consumed transition totals even when their retry position precedes later reporting work; a spent total budget prevents further execution. Historical failures and implementation/review counters remain retained.

Collapsed groups now show deduplicated connections between phases, including nested groups, while internal routes remain hidden. Expanding restores the original routes. Overview connections render behind group cards so the headers remain clickable. Summary ports do not create executable connections, collapsed headings scale for their container, and redundant collapsed-state copy was removed.

The run form puts required fields first, then the feature request, previous goal, acceptance criteria, verification command, scope, research/review controls, and pass limits. Other fields remain accessible. Redundant type badges and discovery copy were removed; the controls retain their actual types, defaults, and validation.

The Windows file-lock regression harness now allows bounded process startup and kills its own child on startup timeout. Its transient and persistent lock tests passed on Windows. Two module imports in concurrent Fleet work needed explicit `.js` extensions for the repository's TypeScript configuration; no Fleet behavior was changed by this pass.

Existing RALPH work was retained and verified together: previous-goal and reference retention, exact request matching, complete-feature verification and bounded repair, scope-change enforcement, durable operation replay, stopped-run recovery, grouped graph layout, typed parameters, native query handling, and run-summary caching. Unrelated Media Studio and Fleet work was preserved.

## Automated verification

| Check | Result | Evidence |
| --- | --- | --- |
| Feature completion and scope, references, persistence, reliability, templates, layout, stopped-run recovery, CLI and Fleet contracts | 147 tests passed in 13 files | `.tmp/ralph-sol-regressions-2026-10-05.log` |
| Provider capability probing, enrollment, and external-agent execution | 141 tests passed in 3 files | `.tmp/ralph-sol-provider-hardening-tests-final-2026-10-05.log` |
| Windows transient and persistent exclusive-file locks | 2 passed; 30 unrelated tests skipped | `.tmp/ralph-sol-provider-lock-tests-final-2026-10-05.log` |
| Capability registry after increasing bounded startup deadlines | 17 tests passed | `.tmp/ralph-sol-provider-startup-budget-tests-2026-10-05.log` |
| Capability registry after retaining verified evidence across long operations | 18 tests passed | `.tmp/ralph-sol-provider-long-operation-tests-2026-10-05.log` |
| Core and UI TypeScript | Passed | `.tmp/ralph-sol-core-typecheck-2026-10-05.log`, `.tmp/ralph-sol-ui-typecheck-2026-10-05.log` |
| Core TypeScript after provider changes | Passed | `.tmp/ralph-sol-provider-core-typecheck-2026-10-05.log` |
| Core and UI-logic test TypeScript | Passed after fixing module extensions | `.tmp/ralph-sol-provider-test-typecheck-final-2026-10-05.log` |
| Current CLI bundle | Built | `.tmp/ralph-sol-provider-cli-bundle-2026-10-05.log` |
| Scoped provider formatting | Passed on all five changed provider files | `.tmp/ralph-sol-provider-format-scoped-2026-10-05.log` |
| Template and checkpoint/archive recovery | 54 passed in 4 files | `.tmp/ralph-sol-archive-final-tests-2026-10-05.log` |
| Final journal preservation and archive ownership checks | 5 passed in 2 files | `.tmp/ralph-sol-journal-final-tests-2026-10-05.log` |
| Recovery phase, state, and portfolio checks | 18 passed; remaining portfolio test passed in isolation | `.tmp/ralph-sol-deferred-phase-final-tests-2026-10-05.log`, `.tmp/ralph-sol-portfolio-final-tests-2026-10-05.log` |
| Final recovery TypeScript | Passed | `.tmp/ralph-sol-recovery-complete-typecheck-2026-10-05.log` |
| Recovery helper lint | Passed | `.tmp/ralph-sol-recovery-lint-final-2026-10-05.log` |
| Recovered outcome classification | 18 passed, including missing-evidence and explicit-deferral checks | `.tmp/ralph-sol-recovered-outcome-tests-2026-10-05.log` |
| Consumed transition budget | Passed; a resume at the spent total budget starts no block | `.tmp/ralph-sol-transition-budget-tests-2026-10-05.log` |
| Collapsed group routing | 6 passed, including nesting, deduplication, expansion, distinct outputs, and connections behind groups | `.tmp/ralph-sol-collapsed-graph-final-tests-2026-10-05.log` |
| Final UI and logic-test TypeScript | Passed | `.tmp/ralph-sol-collapsed-graph-final-ui-typecheck-2026-10-05.log`, `.tmp/ralph-sol-collapsed-graph-final-logic-typecheck-2026-10-05.log` |
| Final transition-budget TypeScript | Passed | `.tmp/ralph-sol-transition-budget-typecheck-2026-10-05.log` |
| Frontend production build | Passed | `.tmp/ralph-sol-polished-ui-final-build-2026-10-05.log` |
| Final checkpoint, reference, and scope regressions | 9 passed in 3 files | `.tmp/ralph-sol-final-checkpoint-regressions-2026-10-05.log` |
| Final scoped recovery/graph formatting and lint | Passed | `.tmp/ralph-sol-final-recovery-graph-format-2026-10-05.log`, `.tmp/ralph-sol-final-recovery-graph-lint-2026-10-05.log` |
| Final graph formatting and lint after header correction | Passed | `.tmp/ralph-sol-collapsed-graph-final-format-2026-10-05.log`, `.tmp/ralph-sol-collapsed-graph-final-lint-2026-10-05.log` |
| Final complete TypeScript check | Passed | `.tmp/ralph-sol-final-complete-typecheck-2026-10-05.log` |
| Final CLI and packaged-frontend native builds | Passed | `.tmp/ralph-sol-final-cli-build-2026-10-05.log`, `.tmp/ralph-sol-native-polished-final-build-2026-10-05.log` |
| Native rebuild after correcting group-header overlap | Passed | `.tmp/ralph-sol-native-header-final-build-2026-10-05.log` |
| Final goal-first form TypeScript, lint, and formatting | Passed | `.tmp/ralph-sol-goal-input-order-ui-typecheck-2026-10-05.log`, `.tmp/ralph-sol-goal-input-order-lint-2026-10-05.log`, `.tmp/ralph-sol-goal-input-order-format-2026-10-05.log` |
| Final goal-first frontend and packaged native builds | Passed | `.tmp/ralph-sol-goal-input-order-ui-build-2026-10-05.log`, `.tmp/ralph-sol-native-goal-inputs-final-build-2026-10-05.log` |

The two principal runs covered 288 distinct tests; the long-operation regression adds one, for 289 distinct passing tests. The lock and capability checks include reruns. The last Vitest run reported a bounded 10-second shutdown warning, then exited zero; this is not evidence of clean teardown in every environment. The whole repository suite was not run.

The later recovery runs overlap these checks. One portfolio test exceeded its existing 30-second harness limit during concurrent native compilation, then passed in 14.1 seconds in isolation with a finite two-minute harness limit. The full checkpoint regression passed with its own finite three-minute limit. Production operation deadlines were not increased for these test runs.

All 11 native transport Rust tests passed against the current source, including the 60-second read-only query deadline. Evidence: `.tmp/ralph-sol-native-query-budget-tests-wrapper-2026-10-05.log`. The successful invocation used `node ../scripts/run-cargo.mjs test --offline --lib desktop_task::ralph::tests`, which prepares the installed Windows native and Vulkan toolchains. Earlier direct Cargo invocations omitted that setup and failed; those invocation errors are resolved.

## Real provider delivery

Workspace: `.tmp/ralph-sol-feature-2026-10-05`. Run: `2026-10-04T22-16-03-195Z`. The actual bundled CLI used provider `codex-cli` and model `gpt-6.1-sol`; this was not a mocked provider.

The baseline was an existing browser-local task app. The requested addition combined task search, status filtering, completing visible tasks, and UTF-8 CSV export while preserving existing add, completion, delete, keyboard, and persistence behavior. Scope was limited to `index.html` and `app.js`, with no dependency, schema, or public API change. The request included a previous goal, online research, visual review, and a finite completion budget.

An immutable acceptance script outside the agent workspace used Playwright with the actual browser and file-based app, without a development server. The original app preserved its existing behavior and failed the new feature acceptance. The candidate passed every independent check:

- Previous-goal behavior, including add with Enter, individual completion, deletion, and retained tasks.
- Combined search/status filtering and bulk completion restricted to visible tasks.
- CSV containing all tasks, completion status, Unicode, and escaped commas/quotes.
- Persistence across reload.
- Keyboard access and a 390-pixel viewport with no horizontal overflow.
- No browser page errors.

Evidence: `.tmp/ralph-sol-evidence-2026-10-05/baseline.json`, `acceptance.json`, `desktop.png`, `mobile.png`, and `tasks.csv`. These checks establish this fixture's behavior; they do not establish the quality of arbitrary large features.

The run was cancelled after the successful implementation operation was durably recorded. The checkpoint remained healthy. A native continuation correctly paused when its instruction environment differed from the CLI environment. The canonical instruction digest was unchanged; the test then explicitly selected the current instruction boundary. That transition preserves the objective, prior work, and consumed budgets while recording a new segment. Evidence: `.tmp/ralph-sol-evidence-2026-10-05/boundary-comparison.json` and the persisted run trace.

The persisted-data audit confirms all seven research source links and the exact previous goal reached implementation and both task/full-feature review inputs. Every observed provider model call used Codex 6.1 Sol. The research answer reports using Codex's available web tool because the named `search_web` and `fetch_url` tools were unavailable. Machdoch's external-provider record identifies the adapter as `shell`; it does not independently expose those native web calls. Reference retention is verified, while exact native search/fetch call provenance remains unverified. Evidence: `.tmp/ralph-sol-evidence-2026-10-05/context-audit.json`.

## Native Playwright checks

Playwright connected to a test-owned Tauri WebView2 at `http://tauri.localhost/` over CDP. The installed desktop application was not restarted. No development server was started.

The current feature flow rendered 52 nodes, including the scope guard and four expanded groups: Plan, Implement, Verify, and Record outcome. The editor reported no local validation issues or page errors. The final fresh native library opened in 6.9 seconds; the preceding graph check took 4.2 seconds and the actual-provider continuation's earlier editor check took 14.1 seconds. Native parameter checks confirmed a textarea for the previous goal, a number input for implementation passes, and a select for online research. Playwright verified that the first four inputs are the feature request, previous goal, acceptance criteria, and verification command. Screenshot and node inventory: `.tmp/ralph-sol-evidence-2026-10-05/native-current-feature.png`, `native-current-feature.json`, `native-provider-editor-feature.json`, `native-current-parameters.png`, and `native-current-parameters.json`.

Native Playwright collapsed all four phases through normal clicks, confirmed four visible nodes and six visible phase connections, and expanded back to all 52 nodes without page errors. A previous check found a summary connection intercepting a group-header click; putting overview connections behind the cards resolved that failure. Evidence: `.tmp/ralph-sol-evidence-2026-10-05/native-current-phase-overview.png`, `native-current-phase-overview.json`, `header-overlap-before.json`, and `.tmp/ralph-sol-native-polished-current-2026-10-05.log`.

The final check confirmed the graph round-trip and read back the restored RALPH preferences before closing the test-owned application. The installed desktop remained running. Evidence: `.tmp/ralph-sol-evidence-2026-10-05/native-current-graph-roundtrip.json` and `native-current-cleanup.json`. The test-owned application's Quick Voice registration warning reflected the installed application's existing shortcut; it did not crash or block the RALPH checks.

Earlier native evidence from the same rebuilt desktop also completed a deterministic cancellation/resume sequence through the UI, retaining typed parameters, a multiline previous goal, and references. Its output was written exactly once. Evidence: `.tmp/ralph-native-polished/final-recovery.json`, `final-parameters.png`, `final-cancelled.png`, and `final-resumed.png`. This supersedes the incomplete native recovery result recorded in the October 4 report.

The graph-open measurements include startup and library loading, so they are not a pure RPC latency benchmark. Earlier native queries completed in roughly 6–12 seconds. A later bundled-CLI query completed in 34,608 ms with exit code zero and no diagnostics, exceeding the old native deadline. The new 60-second deadline has current-source unit coverage and fresh native editor verification. Evidence: `.tmp/ralph-sol-evidence-2026-10-05/query-timing.json`, `native-current-feature.json`, and `.tmp/ralph-sol-native-query-budget-tests-wrapper-2026-10-05.log`. There is no latency guarantee under concurrent load.

Direct diagnostics observed intermittent Codex startup under load: one valid probe took 96.7 seconds, followed by three direct commands with no output within their 30-second budgets. Later fresh probes succeeded in 688 ms and 5.8 seconds with Codex CLI 0.159.1 and both required flags. The real reviews then completed. Evidence: `.tmp/ralph-sol-evidence-2026-10-05/probe-diagnostic.json` and `provider-readiness.json`. The executable's future responsiveness remains outside Machdoch's control; failure remains bounded and recoverable.

After the initial provider deferrals, the recovered run exposed and verified repairs to phase restoration, archived journal recovery, and historical-deferral classification. The final native continuation reran the complete immutable checker and real full-feature review, passed the scope guard against the original baseline, wrote DONE and the final report, and completed with healthy durability. Implementation ran once; the implementation counter remained one and the full-feature review counter advanced from one to two within its four-pass budget. Evidence: `.tmp/ralph-sol-evidence-2026-10-05/native-provider-outcome.json`, `native-provider-resumed.json`, `.tmp/ralph-sol-native-current-2026-10-05.log`, and the persisted run. The test-owned desktop was closed and its original RALPH preferences restored. No provider retry is running.

## Goal coverage and limits

| Goal | Evidence | Limit |
| --- | --- | --- |
| Crash resistance and failure recovery | Healthy durable checkpoint; exact-once native cancellation/resume; transport and storage regressions | No long-duration or all-future-crashes guarantee |
| No blocking | Finite repair/retry budgets, explicit deferred outcomes, bounded native queries, stopped-run continuation, consumed-budget retention, and completed native recovery | Provider and host latency remain variable |
| Sensible templates and strict completion | Starter contracts, full-feature review and scope guard tests, real candidate acceptance, and verified native completion | One bounded fixture does not prove arbitrary large-feature quality |
| Understandable graph and node system | Native 52-node graph; four collapsed phase groups with six visible connections; normal-click collapse/expansion; containment, outputs, and layout tests | Every node type was not individually reviewed for usability |
| Previous logged errors | Windows rename/lock, degraded durability, cancellation, replay, ownership, oversized responses, timeout, and completion regressions | Every historical log error has not been reproduced |
| Polished UI and typed parameters | Native graph and parameter screenshots; real UI recovery; narrow-screen parameter checks | No exhaustive usability study |
| Previous goal | Retained request context and regression tests; independently preserved baseline app behavior | One bounded feature fixture cannot establish arbitrary large-feature quality |
| Reference piping | All seven source links and previous goal reached implementation and both reviews; deterministic reference recovery | Exact native web-call provenance remains unverified |
| Fast decisions | Targeted probe reuse, short incomplete-evidence retention, bounded recovery, summary caching | Provider and host latency remain variable |

Historical evidence reviewed by the combined work includes `docs/ralph-failure-investigation-2026-09-30.md`, `docs/ralph-reliability-repairs-2026-09-30.md`, and `.machdoch/ralph/diagnostics/ralph-hardening-2026-10-02.md`. Historical records were preserved.
