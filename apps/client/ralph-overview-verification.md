# RALPH overview verification

Verified on Windows on 2026-09-10.

The desktop RALPH view opens with running activity across workspaces, followed by expanded workspace flow libraries and one global library. Workspace paths distinguish matching project names. Activity rows open the matching flow or recorded run. Returning to the overview preserves an edited draft.

Loading uses up to three independent snapshot requests. Global storage is read once per refresh. Desktop activity is checked separately every two seconds; lifecycle events request a refresh after a 200 ms debounce. Snapshots refresh every 15 seconds and after activity changes, returning to the view, or manual refresh. Hidden-window polling stops. Superseded responses cannot replace newer results, and failed reads retain data with an error state.

Flow and run files are read with eight workers per directory. Snapshots retain running records beyond the 50-entry history limit and continue checking independent leases. Global run workspace attribution uses desktop task ownership or stored repository context; it is left unknown when neither exists.

## Loading comparison

Run from the repository root:

```sh
pnpm exec oxnode apps/client/scripts/benchmark-ralph-loading.ts
```

The same fixture shape was used before and after the storage changes: six workspaces, each with 24 flows and 128 run records, plus a global library of the same size. Each round loads all six workspace snapshots sequentially, including both scopes. Records contain about 14 KB of result text. Setup and CLI startup are outside the measurement.

| Round  |    Before |    After |
| ------ | --------: | -------: |
| 1      | 29,173 ms | 3,926 ms |
| 2      | 33,863 ms | 5,555 ms |
| 3      | 33,863 ms | 6,242 ms |
| 4      | 39,847 ms | 7,824 ms |
| Median | 33,863 ms | 5,899 ms |

Median storage loading improved by about 83%. These are synthetic local measurements on a shared machine, not full desktop startup timings. The overview additionally avoids repeated global reads and displays native activity before snapshots finish. Its activity polling interval is two seconds compared with the editor's existing five seconds; event and timer behavior is verified with controlled clocks.

## Checks

- Client core, UI, and test TypeScript checks, focused lint, production UI build, and the changed-file whitespace check pass.
- Model and hook tests cover identical flow IDs across workspaces and scopes, alias and resume matching, native and CLI activity, undiscovered active workspaces, independent completion, limited concurrency, Strict Mode, stale successes and failures, refresh coalescing, error recovery, and visibility changes.
- Storage tests cover old active runs outside the history limit, lease release between reads, independent scope errors, and existing RALPH storage and summary behavior. CLI and runtime tests verify scope forwarding and the read-only snapshot path.
- DOM tests cover running and inactive workspaces, unavailable and empty data, correct flow/run navigation, and retaining unsaved drafts.
- Headless Chrome tests pass at 1440, 768, 390, and 320 pixels. Both running workspace rows remain visible, content stays within the viewport, keyboard selection targets the correct workspace, and a completion updates the list without navigation. Desktop and narrow screenshots were visually inspected. The browser harness bundles the real overview component in memory; it starts no server.

## Limits

The full Tauri application and real provider executions were not launched. Browser checks use fixture state, while native calls and event delivery are covered through mocks. Embedded WebView, screen-reader behavior, remote Fleet Manager presentation, and network-mounted workspace timings were not verified.

The overview covers selected/recent workspaces and workspaces discovered through desktop activity. It does not scan arbitrary folders. External file and CLI changes can take the 15-second snapshot interval plus query time to appear. Very large histories still require reading their records, and CLI process startup remains part of real query latency. Global runs without recorded workspace context cannot be attributed to a workspace reliably. A resumed run whose flow identity has not loaded yet stays visible; opening its editor becomes available when that identity arrives.
