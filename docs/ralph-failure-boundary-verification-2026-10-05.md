# RALPH failure boundaries — 2026-10-05

This continuation reproduced additional failures, corrected stop/resume paths and transient probe caching, and checked the native application with Playwright and real Codex CLI `gpt-6.1-sol` agents. The full historical recovery requirement remains incomplete: the original September instruction-adaptation diagnostic is truncated. A present-day enrollment failure is reproducible, but it cannot establish the missing historical cause.

## Changes

- An exhausted ERROR or recoverable invalid result without a route now stops as blocked with its original cause and a retry checkpoint, rather than reporting a graph crash. Invalid structured output and its validation evidence remain in the journal.
- The repeated-failure guard also retains a retry checkpoint. Previously, native resume reconciled the same failed operation, incremented its repeated-failure count, and stopped again without another agent invocation. A controlled stop now emits a blocked end event.
- Completed capability probes remain cached for 30 minutes and concurrent probes remain coalesced. Failed or incomplete probes are removed from the cache immediately. A restored executable can be checked on the next attempt instead of spending the remaining retry budget on cached failure evidence.
- The Windows persistence test uses a compiled file-lock fixture. Compilation happens before the persistence fault starts, so shell/compiler startup does not consume the storage recovery deadline. The test recognizes the actual transient Windows lock error codes.

The changes concern RALPH and its verification fixtures. Concurrent work elsewhere in the workspace was preserved. No development server was started.

## Native instruction enrollment and exhausted recovery

Evidence: [campaign log](../.tmp/ralph-gap-resume-control-final-campaign.log), [exhausted snapshot](../.tmp/ralph-gap-serial-evidence-20261005/exhausted.json), [resume response](../.tmp/ralph-gap-serial-evidence-20261005/adaptation-resumed.response.json), [independent acceptance](../.tmp/ralph-gap-serial-evidence-20261005/independent-acceptance.txt), [native campaign](../.tmp/ralph-gap-native.mjs).

The authentication fault uses an isolated test enrollment path, not the user's credential file. A committed append precedes the fault. The invalid path is a directory where enrollment requires an authentication file. Restoring the test link makes the original authentication usable again without copying or exposing credentials.

| Scenario                                                    | Observation                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enrollment failure followed by restoration                  | The earlier native run `2026-10-05T07-19-17-465Z` recorded ERROR, then a real Sol implementation succeeded. Independent totals acceptance passed. The later verification-instance collision invalidated the rest of that campaign.                                      |
| Capability probing fails and retries repeat the failure     | Run `2026-10-05T07-32-14-163Z` stopped after three actual failed attempts. A pre-fix resume reused the last failed operation and stopped with a repeated-failure count of four, without another provider call.                                                          |
| Resume after fixing the repeated-failure checkpoint         | The first resume reconciled the already persisted failed boundary and wrote the corrected checkpoint. The next resume made a real fourth implementation attempt, completed in 145,309 ms, and passed independent acceptance. Start, append, and wait were not repeated. |
| Authentication enrollment remains invalid until retries end | Run `2026-10-05T07-55-41-040Z` stopped as blocked after two failures in 29,768 ms. It retained the full authentication-path cause, attempt counts, progress, and healthy durability.                                                                                    |
| Restore enrollment and retry that exhausted run             | The same run completed in 89,837 ms. The failed block had three total attempts, including one new real Sol attempt. The earlier append remained exactly `once\n`.                                                                                                       |

The two-file feature preserves the original totals call, adds discounts, validates item fields and rates, and rounds to cents. The checker is outside the agent's two-file edit scope. It covers ordinary totals, empty totals, decimal rounding, discounts, and invalid numeric fields/rates. Extreme finite-number overflow is outside this fixture's acceptance contract.

Run `2026-10-05T08-13-33-467Z` exercised another real boundary. The first Sol attempt returned a model-capacity error; the configured retry made a new provider call. That agent honestly returned an error because the test specifically required a Machdoch search tool that was not exposed to this native agent. Its response failed the required research schema. The run stopped as blocked in 55,013 ms, retained its checkpoint and raw response, and emitted no crash event. The current full-feature template permits native search, which the successful research flow below exercises. Native resume of this particular unavailable-tool fixture was not claimed; a durable regression verifies that corrected structured output makes a new attempt on resume.

Evidence: [invalid-output snapshot](../.tmp/ralph-gap-serial-evidence-20261005/invalid-structured-snapshot.json), [structured-output regression](../apps/client/src/core/__test__/ralph-failure-exhaustion.spec.ts), [final native audit](../.tmp/ralph-gap-serial-evidence-20261005/final-audit.json).

## Actual control POST timeout

The fault server delays acknowledgement of a real server-to-client MCP ping reply POST by 8.5 seconds. It processes that reply and returns independently generated tool nonces. The official Codex client emits the actual rmcp timeout; neither model responses nor stderr are fabricated. The [rmcp transport source](https://docs.rs/rmcp/latest/src/rmcp/transport/streamable_http_client.rs.html) distinguishes these control POST acknowledgements from ordinary request responses.

First correlated replay: run `2026-10-05T07-57-52-680Z`, real provider trace `codex-27040.jsonl`, HTTP session `74d188ad-cdae-4f5d-aace-e14006e49fe6`.

| Event                                   | UTC timestamp |
| --------------------------------------- | ------------- |
| First reply POST received               | 08:00:45.219  |
| Actual Codex `Control POST timed out`   | 08:00:50.216  |
| First tool result received by Codex     | 08:00:52.243  |
| Second tool call in the same session    | 08:00:56.218  |
| Second actual timeout                   | 08:01:01.233  |
| Second tool result received by Codex    | 08:01:03.258  |
| Real Sol returns the exact second proof | 08:01:07.054  |

The first result arrived approximately 2.03 seconds after its timeout. A later tool call remained usable in the same session. The final downstream file contains the exact second server nonce. The run completed with healthy durability and one committed append; full run elapsed time was 218,667 ms, including preflight and provider startup.

Evidence: [actual provider stderr](../.tmp/ralph-gap-serial-evidence-20261005/codex-27040.jsonl.stderr), [timestamped real provider events](../.tmp/ralph-gap-serial-evidence-20261005/codex-27040.jsonl.events.jsonl), [HTTP requests and proofs](../.tmp/ralph-gap-serial-evidence-20261005/http.jsonl), [control server](../.tmp/ralph-gap-control-server.mjs).

Two further real-agent runs also completed, in 134,979 ms and 81,562 ms. Both recorded two delayed control replies, retained their MCP session through the calls, saved the exact second proof, and preserved the append exactly once with healthy durability. The different whole-run timings include changing host startup costs; they are not direct AI decision timings.

## Search provenance and actual change timings

Fresh native run `2026-10-05T08-15-59-381Z` completed in 54,896 ms with healthy durability. Real Sol research made two native search operations. The returned URL and title pairs for the WHATWG Web Storage standard and W3C modal-dialog pattern exactly match the structured research output. A separate real Sol invocation received those pairs, returned the same JSON, and the downstream file matches both steps exactly. The audit checks the real provider arguments, search results, consumer input, both schema-valid outputs, and the saved file.

The provider also exported one batch containing two matching page-view records. That batch is labelled `action.type = "other"`; per-URL open arguments are not present in this export. The evidence therefore establishes actual returned search results and page-view records, without claiming an exported `open_page` action.

Evidence: [fresh research and control audit](../.tmp/ralph-gap-serial-evidence-20261005/final-audit.json), [raw research events](../.tmp/ralph-gap-serial-evidence-20261005/codex-23504.jsonl.events.jsonl), [separate consumer input](../.tmp/ralph-gap-serial-evidence-20261005/codex-30888.jsonl.input.txt), [downstream JSON](../.tmp/ralph-gap-serial-workspace-20261005/research-downstream.json), [audit script](../.tmp/ralph-gap-final-audit.mjs).

The historical feature audit also reads the raw official Codex research trace, not only its final Markdown links. Seven references match exact URLs in actual returned search results. Those same URLs occur in nine later implementation, repair, task-review, and final-review invocation inputs. The other five propagated references are not classified as exact search-result matches by this audit.

Evidence: [raw-result and downstream audit](../.tmp/ralph-gap-evidence-20261005/existing-provenance-and-decision-audit.json), [audit script](../.tmp/ralph-gap-existing-provenance-audit.mjs).

The recorded real two-file Sol change completed inspection at 34,129 ms and began its first edit at 64,834 ms after official provider launch. The interval from completed inspection to the first edit was 30,705 ms. The later restored-run trace completed inspection at 59,929 ms and began editing at 89,018 ms, a 29,089 ms interval. Both changes passed independent acceptance. These are wall-clock bounds on observable decision and tool work, not measurements of hidden reasoning or local graph routing. Host startup and provider preflight were noticeably slower than the change decision itself.

## Substantial previous-goal feature

The external Playwright checker was rerun against the existing seven-file feature workspace. All five acceptance groups passed again at `2026-10-05T06:25:10.280Z`, with no page errors. Checks include retained task behavior, editing and filters, exact Undo, transactional backup/import validation, safe text rendering, persistence, keyboard behavior, and 320 px layout.

The earlier native journal for `2026-10-05T03-39-36-861Z` retains failed acceptance, real Sol repair in 97,578 ms, successful repeated acceptance in 23,085 ms, and an independent final Sol review in 167,520 ms before DONE. Earlier review-contract failures and transition exhaustion are retained in the evidence; resume preserved the consumed budget and did not repeat the three completed implementation calls. This continuation rechecked acceptance rather than rerunning that entire feature implementation.

The checker remains outside the product workspace. The product workspace has its own Git root; the seven product changes are two modified baseline files and five new product files. These are distinct from the test's `.machdoch` data and parameter fixture.

Evidence: [fresh independent acceptance](../.tmp/ralph-gap-evidence-20261005/feature/acceptance.jsonl), [original checker](../.tmp/ralph-large-acceptance.mjs), [historical feature trace and acceptance audit](../.tmp/ralph-large-evidence-20261005/final-context-audit.json), [earlier detailed recovery report](ralph-recovery-verification-2026-10-05.md).

## Native templates and visual assessment

The sequential native Playwright campaign passed all six starter workflows at `http://tauri.localhost/`. Every template opened with four named phase groups, expanded to its stored nodes, and returned with Undo. Typed controls were inspected for every starter; previous-goal input and research settings were edited. Ten node types were created and undone, with Redo checked. Design and Setup each had zero axe violations.

| Starter            | Expanded nodes | Visible overview connections |
| ------------------ | -------------: | ---------------------------: |
| Feature generation |             55 |                            7 |
| Code improvement   |             77 |                            7 |
| UI improvement     |             63 |                            7 |
| Refactoring        |             51 |                            7 |
| Full feature       |             52 |                            6 |
| Security fix       |             43 |                            9 |

Screenshots were visually inspected separately from accessibility checks. The collapsed phases have readable titles, consistent colors, visible routes, and room around the nodes. The parameter screen puts the feature request, previous goal, acceptance criteria, and verification command first. Several return routes share corridors; the entire expanded graph requires zoom to read individual nodes. This is a concrete assessment of the exercised layouts, not a universal claim of visual polish.

Evidence: [native workflow results](../.tmp/ralph-gap-ui-serial-evidence-20261005/template-workflows.json), [phase overview](../.tmp/ralph-gap-ui-serial-evidence-20261005/full-feature-implementation-overview.png), [parameters](../.tmp/ralph-gap-ui-serial-evidence-20261005/feature-parameters.png), [expanded graph](../.tmp/ralph-gap-ui-serial-evidence-20261005/full-feature-implementation-expanded.png), [Design accessibility](../.tmp/ralph-gap-ui-serial-evidence-20261005/axe-feature-design.json), [Setup accessibility](../.tmp/ralph-gap-ui-serial-evidence-20261005/axe-feature-setup.json).

A fresh custom-node workflow then connected Start → Prompt → End and Prompt ERROR → Failed End using handle dragging. It replaced the original Start → End route, edited the prompt and failed-end status, moved a node through Undo/Redo, deleted and restored the prompt with all three routes, and saved the exact graph to disk. It completed in 11,003 ms without page errors. The screenshot was visually inspected: titles and output handles are readable, success/error routes are distinguishable, and the inspector is usable. This manually arranged graph contains route crossings and is not evidence that arbitrary graphs auto-layout perfectly.

The first node harness dragged during canvas movement and missed a connection. Waiting for all nodes to be inside the canvas before dragging resolved the harness race. The failed assertion and screenshot are retained.

Evidence: [fresh node actions and persisted routes](../.tmp/ralph-gap-ui-serial-evidence-20261005/node-workflows.json), [native node screenshot](../.tmp/ralph-gap-ui-serial-evidence-20261005/native-custom-nodes.png), [node workflow log](../.tmp/ralph-gap-node-workflow-bounded-campaign.log).

## Checks and limits

- Recovery and persistence suite: eight tests passed, including a real Windows file lock.
- Capability registry, real Windows command wrapper, and the initial exhaustion regression: 20 tests passed.
- Final structured-output, finite/repeated failure, and routing selection: 24 passed; 117 unrelated cases were outside the selection.
- Core and test typechecks, scoped lint, formatting, Git whitespace check, and the rebuilt CLI bundle passed. The production UI build also passed earlier in this continuation.
- Native verification used the existing debug native backend with its embedded frontend and the rebuilt source CLI runtime. A complete fresh native packaging build was not completed: a cold build and a later shared Cargo build encountered prolonged compilation/build-lock contention. This is not evidence for a rebuilt release package.
- The two accidentally overlapping verification instances shared CDP port 9338. Their page crash/navigation failures are retained as failed harness evidence; their affected results are not counted as successful product checks. Subsequent native campaigns ran sequentially.
- This continuation's native and fault-server instances were closed. The installed application and another agent's verification application were left running.
- The original truncated September adaptation failure cannot be reconstructed from the available record. Long-duration crash freedom, arbitrary future feature quality, and universal model latency remain unproven.
