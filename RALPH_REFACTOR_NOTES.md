# Ralph Refactor Notes

## src-tauri pass 1

- Extracted Mission Control raw HTTP parsing and response writers from `src-tauri/src/remote_control.rs` into `src-tauri/src/remote_control/http.rs`.
- Public Tauri commands, IPC payload structs, route paths, response headers, cookies, and authorization checks were left unchanged.
- `src-tauri/src/remote_control.rs` remains over the 500-line policy after this bounded pass because it still owns state, authorization, pairing, SSE, command normalization, config persistence, and snapshot construction. Splitting those areas safely should be handled in follow-up passes with targeted tests around auth and session lifecycle.

## src-tauri pass 2

- Extracted Mission Control bearer, web-session, pairing-token, state-changing header, cookie, token-hash, and constant-time comparison helpers from `src-tauri/src/remote_control.rs` into `src-tauri/src/remote_control/auth.rs`.
- Preserved the public Tauri command surface, route paths, cookie format, serialized payloads, and existing authorization semantics for both Axum routes and the raw HTTP fallback.
- `src-tauri/src/remote_control.rs` remains over the 500-line policy after this bounded pass because it still owns server lifecycle, pairing creation, SSE streaming, command normalization, config persistence, and snapshot construction. Further reductions should split session lifecycle and config persistence with focused tests.

## src-tauri pass 3

- Extracted Mission Control config defaults, port validation, config load/save, normalization, Unix permission hardening, and expired paired-device pruning from `src-tauri/src/remote_control.rs` into `src-tauri/src/remote_control/config.rs`.
- Added focused tests for config normalization ordering/filtering and reserved-port validation.
- Preserved config file name, JSON shape, default port/version values, enabled semantics, public Tauri commands, route paths, and serialized IPC payloads.
- `src-tauri/src/remote_control.rs` remains over the 500-line policy after this bounded pass because it still owns server lifecycle, pairing creation, SSE streaming, command normalization, session state, and snapshot construction. Further reductions should split session lifecycle and command normalization with focused tests.

## src-tauri pass 4

- Extracted Mission Control web-session token creation, paired-device insertion, stale paired-device eviction, device ID creation, and device-name normalization from `src-tauri/src/remote_control.rs` into `src-tauri/src/remote_control/session.rs`.
- Added focused tests for device-name normalization, paired-device token hashing/session expiry fields, stale-device eviction at capacity, and no-op behavior below capacity.
- Preserved pairing-token rotation, session cookie format, paired-device JSON shape, route paths, public Tauri commands, and event/update notification behavior.
- `src-tauri/src/remote_control.rs` remains over the 500-line policy after this bounded pass because it still owns server lifecycle, SSE streaming, command normalization, progress snapshot construction, and raw HTTP fallback routing. Further reductions should target command normalization or progress snapshot helpers in separate passes with focused tests.

## src-tauri pass 5

- Extracted desktop task CLI argument construction, conversation-context temp files, Ralph payload rewriting, and UI-control context enrichment from `src-tauri/src/desktop_task.rs` into `src-tauri/src/desktop_task/payload.rs`.
- Extracted structured progress parsing, bridge progress creation, timestamps, and event emission into `src-tauri/src/desktop_task/progress.rs`.
- Extracted shared CLI stdout/stderr readers, worker joining with temp-file cleanup, child-process termination, hidden-window setup, and detached system-shell opening into `src-tauri/src/desktop_task/process.rs`.
- Extracted long-running desktop/Ralph command execution into `src-tauri/src/desktop_task/commands.rs` and one-shot scheduler/MCP/instruction command execution into `src-tauri/src/desktop_task/cli_commands.rs`.
- Kept public Tauri command names, serialized request/response structs, task IDs, event names, timeout values, cancellation semantics, and command-line arguments unchanged.
- Added focused tests for structured progress parsing, bridge progress defaults, Ralph payload file rewriting, and Ralph flow scope normalization. Existing attachment, temp-file cleanup, timeout-format, and registry tests continue to cover moved behavior.
- `src-tauri/src/desktop_task.rs` and all `src-tauri/src/desktop_task/*` modules are now under the 500-line policy. Remaining over-limit `src-tauri` follow-ups are `src-tauri/src/remote_control.rs`, `src-tauri/src/runtime_snapshot.rs`, and `src-tauri/src/runtime_snapshot/model_catalog.rs`.

## src-tauri pass 6

- Converted `src-tauri/src/runtime_snapshot/model_catalog.rs` into a small facade that preserves `create_provider_model_http_client` and `fetch_provider_model_catalog` for the existing runtime snapshot call path.
- Extracted provider API parsing/fetching into `src-tauri/src/runtime_snapshot/model_catalog/provider_api.rs`, shared model normalization helpers into `normalize.rs`, CLI process execution into `command.rs`, Codex CLI catalog parsing into `codex_cli.rs`, Copilot CLI help parsing into `copilot_cli.rs`, and parser tests into `tests.rs`.
- Preserved provider names, source labels, error strings, model sorting, serde-facing `ProviderRuntimeModel` shapes, CLI command arguments, timeout values, and public Tauri command behavior.
- Ran `cargo fmt` and `cargo test model_catalog`; both parser tests passed.
- `src-tauri/src/runtime_snapshot/model_catalog.rs` and all `src-tauri/src/runtime_snapshot/model_catalog/*` modules are now under the 500-line policy. Remaining over-limit `src-tauri` follow-ups are `src-tauri/src/remote_control.rs` and `src-tauri/src/runtime_snapshot.rs`.

## src-tauri pass 7

- Extracted runtime snapshot collection, provider availability, active provider resolution, compatibility resolution, and agent-limit resolution from `src-tauri/src/runtime_snapshot.rs` into `src-tauri/src/runtime_snapshot/collect.rs`.
- Extracted user config directory resolution, workspace root resolution, workspace config loading, and workspace default mode/reasoning persistence into `src-tauri/src/runtime_snapshot/workspace.rs`.
- Kept public Tauri command names, serialized `RuntimeSnapshot` and settings payload shapes, workspace config JSON keys, environment precedence, default mode/reasoning behavior, and provider fallback behavior unchanged.
- Ran `cargo fmt` and `cargo test runtime_snapshot`; all 12 focused runtime snapshot tests passed.
- `src-tauri/src/runtime_snapshot/collect.rs` and `src-tauri/src/runtime_snapshot/workspace.rs` are under the 500-line policy. `src-tauri/src/runtime_snapshot.rs` remains over the 500-line policy after this bounded pass because it still owns public serde structs, Tauri command wrappers, and user settings load/save command helpers. Remaining over-limit `src-tauri` follow-ups are `src-tauri/src/remote_control.rs` and `src-tauri/src/runtime_snapshot.rs`.

## src-tauri pass 8

- Extracted Ralph-specific command response parsing, flow-scope normalization, long-running CLI execution, cancellation/timeout handling, payload cleanup, and flow-path resolution from `src-tauri/src/desktop_task/commands.rs` into `src-tauri/src/desktop_task/ralph.rs`.
- Kept public Tauri command names, serialized request/response structs, Ralph CLI arguments, timeout values, progress events, cancellation semantics, and temporary payload cleanup behavior unchanged.
- Ran `cargo fmt` and `cargo test desktop_task`; all 23 focused desktop task tests passed.
- `src-tauri/src/desktop_task/commands.rs` is now below the 500-line policy at 213 lines, and `src-tauri/src/desktop_task/ralph.rs` is below the policy at 276 lines. Remaining over-limit `src-tauri` follow-ups are `src-tauri/src/remote_control.rs` and `src-tauri/src/runtime_snapshot.rs`.

## src-tauri pass 9

- Extracted runtime environment dotenv parsing and process-environment overrides from `src-tauri/src/runtime_snapshot/env.rs` into `src-tauri/src/runtime_snapshot/env_dotenv.rs`.
- Extracted PATH, PATHEXT, home-directory, default install-location, and executable file-name helpers into `src-tauri/src/runtime_snapshot/env_paths.rs`.
- Extracted configured binary validation, command-on-PATH resolution, packaged Windows app alias filtering, and agent CLI binary resolution into `src-tauri/src/runtime_snapshot/env_commands.rs`.
- Kept `load_global_env`, `load_workspace_env`, `has_configured_value`, and `resolve_agent_cli_binary` available through the existing `env` module facade, preserving current callers and public Tauri command behavior.
- Added focused tests for quoted dotenv values, PATHEXT command expansion, and configured binary fallback while preserving the existing CLI resolution coverage.
- Ran `cargo fmt` and `cargo test runtime_snapshot`; all 15 focused runtime snapshot tests passed.
- `src-tauri/src/runtime_snapshot/env.rs` is now below the 500-line policy at 62 lines, with extracted modules also below policy. Remaining over-limit `src-tauri` follow-ups are `src-tauri/src/remote_control.rs` and `src-tauri/src/runtime_snapshot.rs`.

## src-tauri pass 10

- Extracted Mission Control command request/event/record structs, command normalization, command ID creation, target-preview generation, optional text helpers, and truncation into `src-tauri/src/remote_control/commands.rs`.
- Kept the `remote_control::RemoteControlCommandEvent` type path re-exported, preserved serde camelCase fields, accepted command names, validation messages, command history payload shape, route paths, and Tauri event emission behavior.
- Added focused tests for invalid command kinds, follow-up prompt validation, session-mode validation, prompt truncation, command target previews, and Unicode-safe truncation.
- Ran `cargo fmt` and `cargo test remote_control`; all 22 focused Mission Control tests passed.
- `src-tauri/src/remote_control/commands.rs` is below the 500-line policy at 405 lines. `src-tauri/src/remote_control.rs` remains over policy at 1400 lines because it still owns server lifecycle, Axum/SSE routing, raw HTTP fallback dispatch, state snapshot construction, progress recording, pairing URLs, and QR/network helpers. Remaining over-limit `src-tauri` follow-ups are `src-tauri/src/remote_control.rs` and `src-tauri/src/runtime_snapshot.rs`.

## src-tauri pass 11

- Extracted runtime snapshot user settings load/save helpers, user API-key persistence, user web-search settings, voice and speech-to-text settings, memory settings, review model settings, desktop settings, and environment merge helpers into `src-tauri/src/runtime_snapshot/settings_commands.rs`.
- Kept public Tauri command names, invoke handler entries, serialized settings payloads, config file paths, JSON keys, provider validation, default values, clamp behavior, autostart behavior, and environment merge precedence unchanged.
- Reused the existing user-config writer for provider and web-search settings writes to keep directory creation, pretty JSON, trailing newline, and write error handling consistent.
- Ran `cargo fmt` and `cargo test runtime_snapshot`; all 15 focused runtime snapshot tests passed.
- `src-tauri/src/runtime_snapshot.rs` is now below the 500-line policy at 433 lines, and `src-tauri/src/runtime_snapshot/settings_commands.rs` is below policy at 498 lines. Remaining over-limit `src-tauri` follow-up is `src-tauri/src/remote_control.rs`.

## src-tauri pass 12

- Extracted Mission Control Axum router setup, web-session creation route, status route, SSE event stream route, command post route, not-found route, JSON/no-store/security header helpers, and graceful shutdown waiter from `src-tauri/src/remote_control.rs` into `src-tauri/src/remote_control/web.rs`.
- Kept raw HTTP fallback routing in `src-tauri/src/remote_control.rs`, preserving its low-level request parsing and response behavior separately from the Axum transport.
- Preserved Mission Control route paths, cookie/header names, auth checks, state-changing request checks, SSE event name/payload, command event emission, cancel forwarding, response status codes, and public Tauri command registrations.
- Ran `cargo fmt` and `cargo test remote_control`; all 19 focused Mission Control tests passed.
- `src-tauri/src/remote_control/web.rs` is below the 500-line policy at 299 lines. `src-tauri/src/remote_control.rs` remains over policy at 1323 lines because it still owns state lifecycle, progress recording, raw HTTP fallback dispatch, snapshot/status construction, pairing URL refresh, QR generation, and LAN/open-browser helpers. The next bounded split should target state/snapshot lifecycle helpers or the raw HTTP fallback.

## src pass 1

- Extracted Ralph active-run progress state, block progress snapshots, metadata readers, event tone/progress labels, timestamp formatting, and block-detail sorting from `src/tauri/ui/ralph/ralph-flow-editor.tsx` into `src/tauri/ui/ralph/_helpers/ralph-active-run-progress.helper.ts`.
- Kept the `RalphFlowEditor` component as the React composition boundary for state wiring, progress subscription handling, and rendered run panels; no public component props, runtime bridge payloads, flow formats, or saved state shapes were changed.
- Added focused helper coverage in `src/tauri/ui/ralph/_helpers/ralph-active-run-progress.helper.spec.ts` for timeline metadata snapshots, active-run event updates, streamed block progress, and block detail ordering.
- `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains over the 500-line policy after this bounded pass because it still owns the flow library, canvas editing, inspector, generation, run setup, live run, history/detail/log panels, and dialog composition. Further splits should target one of those UI responsibilities at a time.

## src pass 2

- Extracted Ralph inspector width bounds, local-storage load/save behavior, and scroll epsilon constants from `src/tauri/ui/ralph/ralph-flow-editor.tsx` into `src/tauri/ui/ralph/_helpers/ralph-inspector-width.helper.ts`.
- Added focused coverage in `src/tauri/ui/ralph/_helpers/ralph-inspector-width.helper.spec.ts` for width clamping, viewport caps, invalid stored values, valid stored values, and preference writes.
- Kept `RalphFlowEditor` responsible for the inspector UI, drag handlers, scroll state, and visible section composition; no component props, persisted key names, or runtime bridge payloads were changed.

## src pass 3

- Extracted Ralph flow editor block creation, copied-block creation, edge ID generation, and default utility config construction from `src/tauri/ui/ralph/ralph-flow-editor.tsx` into `src/tauri/ui/ralph/_helpers/ralph-block-factory.helper.ts`.
- Preserved the exported `RalphFlowEditor` component, editor props, DOM labels, command names, flow JSON shapes, block defaults, edge ID formats, and existing UI call sites.
- Added focused helper tests for block ID allocation, edge ID collision handling, duplicate START copy rejection, copied block positioning, utility block defaults, and UI analysis defaults.
- `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains over the 500-line policy after this bounded pass because it still owns the full editor composition, dialogs, inspector panels, run panels, canvas menus, and keyboard handlers. Follow-up passes should split presentational panels and dialogs without changing accessible labels.

## src pass 4

- Extracted Ralph flow editor JSON draft parsing, provider/model fallback selection, create-flow/run message formatting, prompt-block generation prompt assembly, generation interview prompt formatting, and generation status/error label helpers into `src/tauri/ui/ralph/_helpers/ralph-generation-formatting.helper.ts`.
- Preserved the exported `RalphFlowEditor` component, editor props, runtime command payloads, provider option behavior, prompt text, run/create summary text, clipboard error text, and visible generation labels.
- Added focused helper tests for JSON draft parsing, provider fallback behavior, prompt-block prompt assembly, interview answer comment trimming, status/phase labels, error clipboard text, and run/create summaries.
- `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains over the 500-line policy after this bounded pass because it still owns the full editor composition, dialogs, inspector panels, run panels, canvas menus, and keyboard handlers. Follow-up passes should split presentational panels and dialogs without changing accessible labels.

## src pass 5

- Extracted Ralph flow row run labels, flow status presentation, run status presentation, and block output chip class mapping from `src/tauri/ui/ralph/ralph-flow-editor.tsx` into `src/tauri/ui/ralph/_helpers/ralph-run-presentation.helper.ts`.
- Preserved visible labels, icons, tone class names, chip class names, active-run status precedence, and editor call sites.
- Added focused helper tests for active run labels, flow status presentation, run status presentation, and output chip classes.
- `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains over the 500-line policy after this bounded pass because it still owns the full editor composition, dialogs, inspector panels, run panels, canvas menus, and keyboard handlers. Follow-up passes should continue extracting presentational panels and interaction helpers without changing accessible labels.

## src pass 6

- Extracted Ralph generation activity event normalization, result-event normalization, deduplicated activity appending, and job activity application from `src/tauri/ui/ralph/ralph-flow-editor.tsx` into `src/tauri/ui/ralph/_helpers/ralph-generation-activity.helper.ts`.
- Preserved generation event IDs, timestamp fallback behavior, metadata keys, activity history limit, job status field updates, and editor call sites.
- Added focused helper tests for progress metadata handling, result-event handling, invalid timestamp fallback, deduplication/history limiting, and applying activity details to job state.
- `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains over the 500-line policy after this bounded pass because it still owns the full editor composition, dialogs, inspector panels, run panels, canvas menus, and keyboard handlers. Follow-up passes should continue extracting presentational panels and interaction helpers without changing accessible labels.

## src pass 7

- Extracted Ralph starter-flow summary construction, starter lookup, imported-starter update detection, import ID creation, subtitle formatting, and starter icon mapping from `src/tauri/ui/ralph/ralph-flow-editor.tsx` into `src/tauri/ui/ralph/_helpers/ralph-starter-flow-presentation.helper.ts`.
- Preserved bundled starter flow IDs, update badge logic, import ID fallback behavior, visible subtitle text, emoji labels, and editor call sites.
- Added focused helper tests for bundled starter lookup, update detection, subtitle/icon formatting, and UUID-based import ID creation.
- `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains over the 500-line policy after this bounded pass because it still owns the full editor composition, dialogs, inspector panels, run panels, canvas menus, and keyboard handlers. Follow-up passes should continue extracting presentational panels and interaction helpers without changing accessible labels.

## src pass 8

- Extracted Ralph run record block cards, active run block detail cards, streamed progress rows, and output-section details from `src/tauri/ui/ralph/ralph-flow-editor.tsx` into `src/tauri/ui/ralph/components/ralph-run-detail-cards.tsx`.
- Preserved visible run detail labels, expandable sections, block output chip classes, progress timestamps, progress tone labels, and existing editor call sites.
- Verified the extracted render path with `pnpm typecheck:ui` and `pnpm test:ui src/tauri/ui/ralph/ralph-flow-editor.spec.tsx`.
- `src/tauri/ui/ralph/components/ralph-run-detail-cards.tsx` is below the 500-line policy at 316 lines. `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains over policy because it still owns editor state wiring, canvas interactions, inspector forms, generation dialogs, and run panel composition.

## src pass 9

- Extracted the starter-flow import dialog and expanded field editor dialog from `src/tauri/ui/ralph/ralph-flow-editor.tsx` into `src/tauri/ui/ralph/components/ralph-editor-dialogs.tsx`.
- Preserved dialog open/close behavior, starter import scope toggles, starter card labels, import button labels, expanded editor variable snippet buttons, copy/apply/cancel actions, textarea labels, and wrap-line controls.
- Kept `RalphFlowEditor` as the state and command wiring boundary; the extracted dialog module receives existing callbacks and does not change exported editor props or runtime payloads.
- Verified the extracted render path with `pnpm typecheck:ui` and `pnpm test:ui src/tauri/ui/ralph/ralph-flow-editor.spec.tsx`.
- `src/tauri/ui/ralph/components/ralph-editor-dialogs.tsx` is below the 500-line policy at 307 lines. `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains over policy because it still owns editor state wiring, canvas interactions, inspector forms, generation interview composition, and run panel composition.

## src pass 10

- Extracted shared Ralph inspector field and details primitives from `src/tauri/ui/ralph/ralph-flow-editor.tsx` into `src/tauri/ui/ralph/components/ralph-inspector-primitives.tsx`.
- Preserved inspector labels, help text placement, details expand/collapse behavior, class names, action slots, and all existing editor call sites.
- Kept `RalphFlowEditor` as the inspector state and form wiring boundary; the extracted primitives remain presentational and do not change exported editor props or runtime payloads.
- Verified the extracted render path with targeted ESLint, `pnpm typecheck:ui`, and `pnpm test:ui src/tauri/ui/ralph/ralph-flow-editor.spec.tsx`.
- `src/tauri/ui/ralph/components/ralph-inspector-primitives.tsx` is below the 500-line policy. `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains over policy because it still owns editor state wiring, canvas interactions, inspector forms, generation interview composition, and run panel composition.

## src pass 11

- Extracted Ralph flow editor mode types, option lists, provider option construction, UI limits, context-menu sizing, and React Flow pro options from `src/tauri/ui/ralph/ralph-flow-editor.tsx` into `src/tauri/ui/ralph/_helpers/ralph-flow-editor-options.helper.ts`.
- Preserved option ordering, labels, variable snippets, provider fallback behavior, context-menu sizing constants, editor props, runtime payloads, and visible UI text.
- Added focused helper coverage for editor/inspector ordering, provider option de-duplication, runtime provider defaults, and variable snippet availability.
- `src/tauri/ui/ralph/_helpers/ralph-flow-editor-options.helper.ts` is below the 500-line policy. `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains over policy because it still owns editor state wiring, canvas interactions, inspector forms, generation interview composition, and run panel composition.

## src pass 12

- Extracted the Ralph generation interview dialog from `src/tauri/ui/ralph/ralph-flow-editor.tsx` into `src/tauri/ui/ralph/components/ralph-generation-interview-dialog.tsx`.
- Preserved dialog titles, badges, loading/blocked/ready states, question labels, comment toggles, skip controls, cancel/generate/continue actions, and the editor-owned state/callback flow.
- Kept `RalphFlowEditor` as the generation state and command wiring boundary; the extracted dialog receives the existing input renderer and callbacks without changing exported editor props or runtime payloads.
- Verified the extracted render path with `pnpm typecheck:ui`, `pnpm lint`, and `pnpm test:ui src/tauri/ui/ralph/ralph-flow-editor.spec.tsx`.
- `src/tauri/ui/ralph/components/ralph-generation-interview-dialog.tsx` is below the 500-line policy at 355 lines. `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains over policy because it still owns editor state wiring, canvas interactions, inspector forms, generation setup, and run panel composition.

## src pass 13

- Extracted Ralph flow editor state utilities, input-field ID creation, context-menu placement, save/revision message formatting, prompt-like block text updates, utility-title sync detection, history limits, flow snapshots, layout keys, canvas position comparisons, and locked-node change filtering from `src/tauri/ui/ralph/ralph-flow-editor.tsx` into `src/tauri/ui/ralph/_helpers/ralph-flow-editor-state.helper.ts`.
- Preserved the exported `RalphFlowEditor` component, editor props, runtime command payloads, visible labels, save messages, revision date fallback behavior, context-menu placement behavior, undo/redo history limit, prompt-like block updates, and canvas drag locking behavior.
- Added focused helper coverage in `src/tauri/ui/ralph/_helpers/ralph-flow-editor-state.helper.spec.ts` for field IDs/defaults, save messages, prompt-like updates, utility title syncing, flow snapshots/layout keys, position/size comparisons, locked position changes, non-browser menu placement, and missing-DOM shortcut targets.
- `src/tauri/ui/ralph/_helpers/ralph-flow-editor-state.helper.ts` is below the 500-line policy at 197 lines. `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains over policy at 11542 lines because it still owns editor state wiring, canvas interactions, inspector forms, generation setup, and run panel composition.

## src pass 14

- Extracted the main Ralph flow editor canvas toolbar from `src/tauri/ui/ralph/ralph-flow-editor.tsx` into `src/tauri/ui/ralph/components/ralph-flow-editor-toolbar.tsx`.
- Preserved toolbar button labels, accessible names, disabled states, tooltips, block action ordering, MCP menu entries, flow scope badge styling, and editor-owned callback behavior.
- Kept `RalphFlowEditor` as the state and command wiring boundary; the extracted toolbar is presentational and does not change exported editor props, runtime payloads, saved flow shapes, or public imports.
- `src/tauri/ui/ralph/components/ralph-flow-editor-toolbar.tsx` is below the 500-line policy. `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains over policy because it still owns editor state wiring, canvas interactions, inspector forms, generation setup, and run panel composition.

## src pass 15

- Extracted Ralph flow-list and canvas context menus from `src/tauri/ui/ralph/ralph-flow-editor.tsx` into `src/tauri/ui/ralph/components/ralph-flow-context-menus.tsx` and `src/tauri/ui/ralph/components/ralph-node-context-menu-content.tsx`.
- Preserved context-menu labels, roles, submenu placement behavior, disabled states, block action ordering, MCP entries, copy/move/delete flow actions, node lock/copy/duplicate/delete actions, route removal, paste behavior, and editor-owned callbacks.
- Kept `RalphFlowEditor` as the state and command wiring boundary; the extracted components are presentational and do not change exported editor props, runtime payloads, saved flow shapes, or public imports.

## src pass 16

- Extracted Ralph prompt placeholder highlighting from `src/tauri/ui/ralph/ralph-flow-editor.tsx` into `src/tauri/ui/ralph/components/ralph-prompt-highlight.tsx`.
- Preserved highlighted placeholder text, surrounding prompt text, class names, editor props, runtime payloads, saved flow shapes, and public imports.
- Added focused component coverage in `src/tauri/ui/ralph/components/ralph-prompt-highlight.spec.tsx` for plain prompt text and multiple Ralph placeholders.
- Verified with `pnpm exec vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/components/ralph-prompt-highlight.spec.tsx`, `pnpm exec vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/ralph-flow-editor.spec.tsx`, `pnpm typecheck`, `pnpm lint`, and `pnpm test`.
- `src/tauri/ui/ralph/components/ralph-prompt-highlight.tsx` is below the 500-line policy at 39 lines. `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains over policy at 11683 lines because it still owns editor state wiring, canvas interactions, inspector forms, generation setup, and run panel composition.
- Both new context-menu component files are below the 500-line policy. `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains over policy because it still owns editor state wiring, canvas interactions, inspector forms, generation setup, and run panel composition.

## src pass 17

- Extracted Ralph inspector section tabs and selected route summary rendering from `src/tauri/ui/ralph/ralph-flow-editor.tsx` into `src/tauri/ui/ralph/components/ralph-inspector-navigation.tsx`.
- Preserved tab labels, route badge text, active-tab styling, route summary text, connected/missing/unconnected route target labels, data attributes, and editor-owned scroll callbacks.
- Added focused component coverage in `src/tauri/ui/ralph/components/ralph-inspector-navigation.spec.tsx` for hidden single-section tabs, route badge selection callbacks, route summary labels, and route summary open callbacks.
- Verified with `pnpm exec vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/components/ralph-inspector-navigation.spec.tsx`, `pnpm exec vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/ralph-flow-editor.spec.tsx`, `pnpm typecheck`, `pnpm lint`, and `pnpm test`.
- `src/tauri/ui/ralph/components/ralph-inspector-navigation.tsx` is below the 500-line policy at 144 lines. `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains over policy at 11597 lines because it still owns editor state wiring, canvas interactions, inspector forms, generation setup, and run panel composition.

## src pass 18

- Extracted Ralph pending input controls and setup variable controls from `src/tauri/ui/ralph/ralph-flow-editor.tsx` into `src/tauri/ui/ralph/components/ralph-input-controls.tsx`.
- Preserved input labels, placeholders, file-list normalization, number/null conversion, boolean variable normalization, setup variable error accessibility attributes, and editor-owned state update callbacks.
- Added focused component coverage in `src/tauri/ui/ralph/components/ralph-input-controls.spec.tsx` for file, number, boolean variable, and error attribute behavior.
- Verified with `pnpm exec vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/components/ralph-input-controls.spec.tsx`, `pnpm exec vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/ralph-flow-editor.spec.tsx`, `pnpm typecheck`, `pnpm typecheck:ui`, `pnpm lint`, and `pnpm test`.
- `src/tauri/ui/ralph/components/ralph-input-controls.tsx` is below the 500-line policy at 240 lines. `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains over policy at 11397 lines because it still owns editor state wiring, canvas interactions, inspector forms, generation setup, and run panel composition.

## src pass 19

- Extracted the Ralph flow library sidebar from `src/tauri/ui/ralph/ralph-flow-editor.tsx` into `src/tauri/ui/ralph/components/ralph-flow-library-panel.tsx`.
- Preserved flow library mode labels, refresh/collapse/open controls, new/starter/save actions, empty/loading messages, flow row status precedence, starter update labels, selection behavior, and editor-owned callback wiring.
- Added focused component coverage in `src/tauri/ui/ralph/components/ralph-flow-library-panel.spec.tsx` for active run status labels, starter update labels, draft status labels, empty workspace disabled actions, library mode callbacks, and collapsed open behavior.
- Verified with `pnpm exec vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/components/ralph-flow-library-panel.spec.tsx` and `pnpm exec vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/ralph-flow-editor.spec.tsx` before broad checks.
- `src/tauri/ui/ralph/components/ralph-flow-library-panel.tsx` is below the 500-line policy at 448 lines. `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains over policy at 11174 lines because it still owns editor state wiring, canvas interactions, inspector forms, generation setup, and run panel composition.

## src pass 20

- Extracted Ralph AI prompt history ArrowUp/ArrowDown navigation state into `src/tauri/ui/ralph/_helpers/normalize-ralph-ai-prompt-history.helper.ts`.
- Preserved prompt history ordering, draft restoration, boundary clamping, editor props, visible UI, and keyboard-triggered draft updates.
- Added focused helper coverage for newest-entry navigation, oldest-entry clamping, forward navigation, draft restoration, and no-op history states.
- Verified with `pnpm exec vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/_helpers/normalize-ralph-ai-prompt-history.helper.spec.ts`, `pnpm exec vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/ralph-flow-editor.spec.tsx`, `pnpm typecheck:ui`, and targeted ESLint for the touched Ralph editor/history files.
- `src/tauri/ui/ralph/_helpers/normalize-ralph-ai-prompt-history.helper.ts` is below the 500-line policy at 83 lines. `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains over policy at 10494 lines because it still owns editor state wiring, canvas interactions, inspector forms, generation setup, and run panel composition.

## src pass 21

- Extracted Ralph utility condition form rendering from `src/tauri/ui/ralph/ralph-flow-editor.tsx` into `src/tauri/ui/ralph/components/ralph-utility-condition-fields.tsx`.
- Preserved utility condition labels, default simple condition behavior, JSON-path operator choices, expression placeholders, editor-owned selected utility updates, and condition payload shape.
- Added focused component coverage in `src/tauri/ui/ralph/components/ralph-utility-condition-fields.spec.tsx` for default simple rendering, expression updates, and JSON-path operator updates.
- Verified with `pnpm exec vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/components/ralph-utility-condition-fields.spec.tsx`, `pnpm exec vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/ralph-flow-editor.spec.tsx`, `pnpm typecheck:ui`, and targeted ESLint for the touched Ralph files.
- `src/tauri/ui/ralph/components/ralph-utility-condition-fields.tsx` is below the 500-line policy at 158 lines. `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains over policy at 11045 lines because it still owns editor state wiring, canvas interactions, inspector forms, generation setup, and run panel composition.
