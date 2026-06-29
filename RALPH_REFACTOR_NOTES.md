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
