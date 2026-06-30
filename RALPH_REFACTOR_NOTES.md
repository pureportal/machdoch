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
