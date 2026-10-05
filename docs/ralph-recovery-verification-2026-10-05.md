# RALPH recovery and native verification — 2026-10-05

The native recovery campaign, substantial previous-goal feature, traced web research, six starter workflows, and saved node workflow passed. The campaigns used real Codex CLI agents with `gpt-6.1-sol`; Playwright controlled the native Tauri WebView. This closes the specific verification gaps in the [earlier report](ralph-goal-verification-2026-10-05.md), within the limits below.

## Changes

- An exited run owner no longer holds an otherwise valid two-minute lease until expiry. The current owner format is checked against the operating system; a live or indeterminate owner remains protected. Recovery retains the checkpoint, operation IDs, attempts, and consumed budgets.
- Independent task reviews assess the product work assigned to that stage. They no longer demand evidence from later workflow stages or require a new diff when reviewing retained implementation. The runtime contract also applies when resuming the same pinned flow revision. Actual defects and unavailable required evidence still prevent acceptance.
- A later successful retry supersedes an earlier failure of the same block in the completion diagnostic. Other unresolved failures and journal boundaries remain significant. Historical execution records remain intact.
- Full-feature research explicitly permits the provider's native search and page-opening tools. References and previous-goal context continue through implementation, repair, and independent reviews.
- Every current starter has four named phase groups. A shared layout validates exact membership and preserves execution routes and settings. Collapsed overviews use a compact layout; expanding restores the stored child layout. Collapse changes invalidate cached canvas coordinates, and expanded graphs can fit below the former minimum zoom. A collapsed phase represents the active child in the node mapping.
- Phase titles remain readable and clickable. Collapsed groups cannot resize the stored expanded geometry. The full-feature parameters put the feature request, previous goal, acceptance criteria, and verification command first, with typed controls throughout the starters.
- Native accessibility findings were corrected: the application version contrast and redundant low-contrast group footer text. The footer retains actionable state and missing-route information.

The work preserves unrelated concurrent Media and Fleet changes. No development server was started. Native test instances used isolated preferences and workspaces; the installed desktop instance was left running.

## Native failure recovery

Primary run: `2026-10-05T05-08-46-072Z`.

Evidence: [result](../.tmp/ralph-recovery-final-evidence-20261005/result.json), [checkpoint and provider audit](../.tmp/ralph-recovery-final-evidence-20261005/final-audit.json), [recovered native screen](../.tmp/ralph-recovery-final-evidence-20261005/native-recovered.png), [campaign script](../.tmp/ralph-recovery-final-native.mjs), [audit script](../.tmp/ralph-final-recovery-audit.mjs).

The verification proxy forwarded real Codex arguments, input, and output to the installed official CLI. It recorded traces and deliberately held the final output stream open after the real child exited. The MCP server was a real stdio SDK server, with a controlled first-process disconnect and a distinct nonce returned after reconnection. These were fault injections around the actual provider, not replacement model responses.

| Failure exercised | Observed result |
| --- | --- |
| MCP process exits with connection closed | A new real provider attempt connected to the restored server and returned `recovered-mcp-6105`. Recovery took 36,729 ms. Structured response attempts were 2, within the limit of 3. |
| Real provider finishes, but its output stream stays open for 120 seconds | The existing 10-second exit grace recovered the terminal output. The run recorded `providerShutdownRecovered: true`; it did not wait for the injected 120-second hold. |
| `run.json` held without delete sharing for 6.5 seconds | Required persistence recovered and the completed run reported healthy durability. |
| Native app killed after completed AI work, during a 30-second wait | Relaunch and retry resumed the same run. Completed append and AI work were not repeated. The committed append occurred exactly once. |
| Unexpired lease belongs to the killed native process | Generation 2 acquired the lease at `05:10:44.530Z`, before generation 1 expired at `05:11:53.359Z`. Recovery did not wait for lease expiry. |

The probe operation ID and completed-block attempt counts were unchanged. There were two real Sol calls before the restart and zero afterward. Transitions advanced from 2 to 5, with six recorded block results. Total campaign time was 138,580 ms. Restart recovery was 57,648 ms, including the intentional 30,000 ms wait. The native page reported no errors.

The fault campaign used the current native backend and CLI runtime. The final UI campaign below used the subsequently rebuilt native executable containing the final canvas and contrast changes.

## Substantial feature and acceptance recovery

Primary run: `2026-10-05T03-39-36-861Z`. Original repository baseline: `55effdf727d25db67cb14e56d0742227455978c1`.

The real agents extended an existing task application across seven product files: `index.html`, `app.js`, `styles.css`, `storage.js`, `task-model.js`, `task-backup.js`, and `task-editor.js`. The previous goal required preserving existing task entry, Enter submission, completion, deletion, search, status filtering, bulk behavior, persistence, and CSV export. The extension added metadata editing, combined filters, exact one-level Undo, and validated JSON backup/import without adding a dependency, backend, or server.

The independent acceptance checker lived outside that workspace. Its SHA-256 remained `ea428037d9901e2344f526fbfb77201c1edf6715d1a9a884b0ba1d5602c67be3`. The initial application passed the previous behavior and failed the new requirements. At the first complete-feature check, the checker first verified the implemented product, then injected a real broken Undo label into the product and asserted the required control after reload. This produced a genuine acceptance failure.

| Stage | Result | Duration |
| --- | --- | --- |
| First complete-feature acceptance | FAILED | 42,880 ms |
| Real Sol repair agent | SUCCESS | 97,578 ms |
| Repeated complete-feature acceptance | SUCCESS | 23,085 ms |
| Independent real Sol full-feature review | DONE | 167,520 ms |
| Final external checker, after workflow completion | Passed all five acceptance groups; no page errors | Recorded at `04:41:16.429Z` |

The scope guard retained seven changed product files. The durable journal recorded DONE, the report completed, and final archive/persistence was healthy. Acceptance covered:

- Previous behavior, combined filters, visible bulk scope, CSV escaping/Unicode/all records, and persisted records.
- Metadata edits, invalid blank titles, Escape cancellation, and restored focus.
- Exact Undo for edits, completion, deletion, import, and bulk changes.
- Backup round trips and transactional rejection of malformed JSON, duplicate IDs, wrong types, invalid calendar dates, and invalid priorities; safe text rendering and import persistence.
- A 320 px layout and modal, keyboard focus, and absence of horizontal overflow.

Desktop and mobile screenshots were inspected. This is evidence for one substantial feature with a concrete acceptance contract; it does not establish the quality of arbitrary future features.

### Review-loop defect found and repaired

The first task reviews incorrectly demanded later full-feature/process verification and sent an already passing implementation back through two extra implementation calls. The run stopped safely at its 60-transition budget. The review contract was corrected, then the same pinned run resumed from verification without editing its journal or granting a fresh budget. Implementation calls stayed at three before and after resume. The implementation counter remained 3 of 4; the feature-review counter advanced from 1 to 2 of 4, with `reset: false`. Total transitions advanced from 60 to 85.

The original completed snapshot still contains an earlier failed acceptance diagnostic, since completion preceded the diagnostic fix. Applying the current production outcome helper to those unchanged real block results now derives verified success without the superseded failure. The audit checks that the historical snapshot bytes are unchanged.

Evidence: [final feature/context audit](../.tmp/ralph-large-evidence-20261005/final-context-audit.json), [current outcome audit](../.tmp/ralph-large-evidence-20261005/current-outcome-audit.json), [unchanged external checker](../.tmp/ralph-large-acceptance.mjs), [context audit script](../.tmp/ralph-large-final-audit.mjs), [outcome audit script](../.tmp/ralph-current-outcome-audit.mjs).

### Search provenance and propagation

Raw official Codex JSON traces contain completed native `web_search` events for both search and page opening, plus the research stage's Machdoch URL fetching. The audit identifies each invocation from its primary block header and actual `--model` argument. It found 12 real feature-campaign calls, all using `gpt-6.1-sol`.

All 12 complete primary-source URLs, including fragments containing parentheses, and the exact previous goal appear in every implementation, repair, selected-task review, and final-feature review input. This remains true after recovery. Sources include WHATWG HTML and Web Storage, W3C dialog/accessibility guidance, TC39 JSON parsing, and OWASP safe DOM rendering. The [context audit](../.tmp/ralph-large-evidence-20261005/final-context-audit.json) records the URLs, native search actions, and downstream invocation matches.

There were 14 real Sol calls across the two primary campaigns: 12 for the feature and two for the clean recovery campaign.

### Decision timings

Local branch decisions in the feature run took 3–70 ms. Brief preparation took 105,265 ms, online research 92,790 ms, and checklist creation 208,123 ms. The first substantial implementation took 725,883 ms; independent task review after the fix took 112,204 ms.

The feature's full elapsed run time was 3,477,210 ms, approximately 58 minutes, including the discovered review loop, bounded stop, fix/build interval, and recovery. Recovery after the contract fix took approximately 9 minutes 47 seconds, with no repeated main implementation. These measurements demonstrate fast local routing and removal of the observed no-progress review loop; provider work and compilation still take time. They are not a universal latency guarantee.

## Native templates, parameters, and nodes

Playwright attached through CDP to the actual embedded native frontend at `http://tauri.localhost/`. It used normal UI clicks and handle dragging. Each starter was imported through the library, validated without local issues, expanded through clickable headers, and returned to four collapsed groups with Undo. Phase headers stayed inside the canvas after expansion. Typed parameter controls were inspected in the native Run setup screen.

| Starter | Expanded nodes, including groups | Collapsed groups | Visible phase connections | Workflow time |
| --- | ---: | ---: | ---: | ---: |
| Feature generation | 55 | 4 | 7 | 17,422 ms |
| Code improvement | 77 | 4 | 7 | 15,216 ms |
| UI improvement | 63 | 4 | 7 | 11,002 ms |
| Refactor | 51 | 4 | 7 | 12,291 ms |
| Full feature | 52 | 4 | 6 | 27,932 ms |
| Security | 43 | 4 | 9 | 16,309 ms |

The full-feature workflow also exercised adding ten block types and undoing/redoing those additions. Parameter controls used numeric inputs, boolean selects, URL inputs, and multiline fields as appropriate. Its first four inputs were the feature request, previous goal, acceptance criteria, and verification command; multiline previous-goal editing and the research selector were exercised.

A separate blank-flow workflow created and edited a Prompt, replaced the original Start-to-End route by normal handle dragging, added a typed failed End, connected explicit success and error routes, moved the Prompt with Undo/Redo, deleted it, and restored all three routes and its content with Undo. The final four-node/three-route graph was read back from the durable flow file. The UI subsequently showed Ready, No local issues, and Ready to run. This workflow took 20,292 ms and had no page errors.

Native axe checks against WCAG 2 A/AA and 2.1 AA returned zero violations on the full-feature Design screen (24 passing checks) and Setup screen (23 passing checks). This is a sampled automated accessibility check, not an accessibility certification. The collapsed overview, parameter screen, and saved custom graph were visually inspected.

Evidence: [six template workflows](../.tmp/ralph-final-ui-evidence-20261005/template-workflows.json), [saved node workflow](../.tmp/ralph-final-ui-evidence-20261005/node-workflows.json), [Design axe result](../.tmp/ralph-final-ui-evidence-20261005/axe-feature-design.json), [Setup axe result](../.tmp/ralph-final-ui-evidence-20261005/axe-feature-setup.json), [full-feature overview](../.tmp/ralph-final-ui-evidence-20261005/full-feature-implementation-overview.png), [parameters](../.tmp/ralph-final-ui-evidence-20261005/feature-parameters.png), [saved custom graph](../.tmp/ralph-final-ui-evidence-20261005/native-custom-nodes-saved.png).

## Historical failure coverage and automated checks

The earlier failure investigation and hardening diagnostics were reviewed as evidence. The current checks distinguish replayed failures from regression coverage:

| Recorded failure family | Current evidence |
| --- | --- |
| App restart, abandoned/unexpired lease, duplicated work | Native kill/relaunch replay; operation ID, attempts, lease generation, exact-once effect, and no repeated AI work audited. |
| MCP connection closed and invalid/unavailable structured response | Real stdio disconnect/reconnect replay and bounded schema attempts. |
| Provider shutdown timeout after final output | Real child completion plus held output-stream replay; bounded exit recovery recorded. |
| Windows projection replacement/locking failures | Native 6.5-second file lock replay; healthy required durability; storage/reliability regressions. |
| Deferred verification, exhausted budgets, retrying retained work, lost/archive-invalid journals | Targeted deferred-phase, retry, autonomy, scope, storage, registry, and verification regressions. The substantial run retained counters and journals across its real bounded stop and resume. |
| Earlier native libclang/Vulkan/toolchain failures and inappropriate platform workarounds | Current offline native builds succeeded with the actual installed Windows toolchain. Native/Vulkan script tests passed; inappropriate workaround rejection was checked. |
| Incorrect final status after repaired failure | Execution-cause/outcome regressions and the current helper applied to unchanged real feature history. |
| Original instruction-adaptation crash | Its original diagnostic is truncated, so its precise root cause cannot be reconstructed or claimed replayed. Current boundary behavior is regression-covered; native restart used an explicit new instruction boundary. |

Passing check logs, with overlapping test cases deliberately not summed:

| Check | Result | Log |
| --- | --- | --- |
| Lease, store, reliability, storage, starter regressions | 94 passed, 5 files | [log](../.tmp/ralph-recovery-final-regressions-20261005.log) |
| Retry, autonomy, scope/registry, verification, provider regressions | 133 passed, 5 files | [log](../.tmp/ralph-recovery-historical-final-tests-20261005.log) |
| Phase membership/layout and completion diagnostics | 77 passed, 5 files | [log](../.tmp/ralph-phase-recovery-final-tests-20261005.log) |
| Final UI and outcome regressions | 30 passed, 4 files | [log](../.tmp/ralph-final-ui-outcome-tests-20261005.log) |
| Canvas fitting, cached layout, active phase mapping | 9 passed, 2 files | [log](../.tmp/ralph-final-fit-layout-tests-20261005.log) |
| Editor DOM workflows | 8 passed, 2 files | [log](../.tmp/ralph-final-editor-workflow-dom-tests-20261005.log) |
| Targeted review contract/deferred-phase recovery | 2 passed, 139 outside the selected cases skipped | [log](../.tmp/ralph-review-contract-regressions-20261005.log) |
| Windows native/Vulkan toolchain scripts | 12 passed, 2 skipped, no failures | [log](../.tmp/ralph-final-native-toolchain-tests-20261005.log) |

Core, UI, logic-test, and DOM-test TypeScript checks passed. Scoped oxlint and formatting checks passed. The CLI bundle, production UI build, and final native custom-protocol build passed. The final native build took 5 minutes 17 seconds and retained unrelated existing compiler warnings. No new Rust implementation was changed in this recovery pass; earlier Rust transport results are recorded separately in the prior report.

Build evidence: [CLI](../.tmp/ralph-final-cli-build-20261005.log), [UI](../.tmp/ralph-final-accessibility-ui-build-20261005.log), [native](../.tmp/ralph-final-accessibility-native-build-20261005.log).

## Limits

The tested fault cases recover without losing committed progress or silently resetting budgets. A permanently unavailable provider, an unrecoverable filesystem, or exhausted configured budgets can still stop work with an actionable failure; they cannot be made universally successful by retrying.

This campaign does not establish indefinite crash freedom, every possible historical failure, arbitrary large-feature quality, or a latency guarantee. It does not rerun the entire unrelated repository suite or execute every tool-specific node integration. Active-child representation in collapsed groups is covered by the mapping regression rather than a live running-phase screenshot. The truncated original instruction-adaptation diagnostic remains an explicit evidence gap.

The raw provider traces, isolated profiles, and verification workspaces remain local under `.tmp`; they are not intended as published product content. Earlier harness selector/save-timing failures are retained beside the clean final evidence. The report uses the successful final runs and independently audited snapshots, and does not rewrite their history.
