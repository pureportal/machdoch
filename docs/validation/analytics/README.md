# Analytics verification — 10 October 2026

Application version: 30.1.0. Shared analytics package: 1.0.0.

| Check                                                                     | Result               |
| ------------------------------------------------------------------------- | -------------------- |
| Analytics privacy, payload validation, observers, consent, and operations | 32 tests passed      |
| Media Studio                                                              | 798 tests passed     |
| Fleet manager                                                             | 201 tests passed     |
| Shared product UI                                                         | 119 DOM tests passed |
| Targeted CLI, session lifecycle, and settings logic                       | 59 tests passed      |
| Desktop update controls and lifecycle                                     | 15 tests passed      |
| Licensing scripts                                                         | 34 tests passed      |
| Changed application/package lint and type checks                          | Passed               |
| Landing, desktop UI, embedded fleet tools, and Next production builds     | Passed               |
| TypeScript CLI and bundled CLI build/help                                 | Passed               |
| API-key scan of changed source and browser bundles                        | No matches           |

`browser.json` records a production landing build exercised in headless Edge through Playwright static routing. Real ingestion ran in a temporary private Swetrix project, which was deleted afterward. The checks cover no requests before consent, remembered consent with complete navigation timings, feature/download events, scrubbed errors, withdrawal, Global Privacy Control, and actual traffic/performance/custom-event statistics. CLI collection was accepted with basic bot protection, and the numeric duration metric was read back as 123 ms. The CLI telemetry sample is synthetic; the smoke test also executes the real built CLI's help command.

`projects.json` records reads of the three private configured projects, their saved views and funnels, and custom-event charts. The production projects have no initial performance data: their performance endpoint correctly reports an empty period. The temporary verification project's performance data was ingested and queried successfully.

The Swetrix partial-deletion endpoint returned HTTP 500 for historical ranges. Automatic 90-day retention is not enforced or scheduled. The linked company policy still needs Machdoch's application scope and verified retention details. Both issues are recorded in `../../analytics.md`.

Native Windows/Linux webview collection, connected-device fleet workflows, Docker images, production deployment domains, ClickHouse TTLs, and server/log/backup deletion were not verified. No development server was started, and no production application was deployed.
