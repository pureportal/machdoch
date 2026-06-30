# Ralph Code Improvement Notes

## 2026-06-30 - Clipboard image attachment filename collision

- Behavior change: clipboard image attachment paths now append a per-process atomic counter after the existing sanitized stem, millisecond timestamp, and process id components, so repeated same-name saves cannot overwrite each other when they occur in the same process and millisecond.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml` passed with 79 Rust tests, including focused coverage for identical timestamp/process path generation and repeated same-name saves; `cargo check --manifest-path src-tauri/Cargo.toml` passed.
- Remaining risks: callers or tests that assert an exact temporary filename shape may need to accept the added counter component; extension handling, sanitization, storage directory, and file contents are unchanged.

## 2026-06-30 - Agent CLI model discovery pipe draining

- Behavior change: `run_agent_cli_command` now starts stdout and stderr reader workers immediately after spawning the agent CLI, so model discovery keeps draining both pipes while the child is still running and large CLI output cannot block process exit on pipe backpressure.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml runtime_snapshot::model_catalog` passed with 6 focused model catalog tests, including large concurrent stdout/stderr output coverage and nonzero exit output-shape coverage; `cargo check --manifest-path src-tauri/Cargo.toml` passed.
- Remaining risks: timeout behavior still returns the existing timeout error after killing and waiting on the child, but detached reader workers are not joined on timeout to preserve prompt timeout return behavior.

## 2026-06-30 - UI control input cleanup on automation errors

- Behavior change: drag automation now releases the pressed mouse button if the post-press pointer move fails, and shortcut automation now tracks successfully pressed keys so later press or release failures still release remaining keys in reverse order before returning an error.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml ui_control::input -- --nocapture` passed with 3 focused cleanup-order tests; `cargo check --manifest-path src-tauri/Cargo.toml` passed.
- Remaining risks: cleanup release failures are reported with the original automation error where possible, but an OS-level release failure can still leave physical input state stuck because the release request itself did not succeed.

## 2026-06-30 - User config API key file permissions

- Behavior change: `write_user_config_file` now applies the existing Unix-style local hardening pattern to `user-config.json`, setting the user config directory to `0700` and the file to `0600` after creating/writing them; non-Unix behavior remains a no-op beyond the existing write.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml runtime_snapshot::user_config` passed on Windows with the existing write/newline coverage; `cargo check --manifest-path src-tauri/Cargo.toml` passed. Unix-only test coverage was added for restrictive directory and file permissions but was not executed on this Windows host.
- Remaining risks: permission hardening can now cause a save error on Unix if the process cannot inspect or update permissions for the config directory or file; JSON shape, location, and public settings commands are unchanged.

## 2026-06-30 - User MCP config file permissions

- Behavior change: user-scope MCP config saves now apply the same Unix-only local hardening pattern as adjacent sensitive config files, setting the user config directory to `0700` and `mcp.json` to `0600`; workspace-scope `.machdoch/mcp/mcp.json` saves keep the existing permission behavior.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml runtime_snapshot::mcp_config` passed on Windows with 3 focused MCP config tests; `cargo check --manifest-path src-tauri/Cargo.toml` passed. Unix-only permission tests were added for user-scope hardening and workspace permission preservation but were not executed on this Windows host.
- Remaining risks: permission hardening can now cause user MCP config saves to fail on Unix if the process cannot inspect or update permissions; JSON normalization, trailing newline output, command shapes, and non-Unix behavior are unchanged.

## 2026-06-30 - Speech transcription base64 upload preflight

- Behavior change: speech transcription now validates the provider before audio payload handling and rejects base64 payloads whose encoded length cannot fit the selected provider's upload limit before allocating the decoded audio buffer; OpenAI and Google decoded-size checks remain in place.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml voice` passed with 14 focused voice tests; `cargo check --manifest-path src-tauri/Cargo.toml` passed.
- Remaining risks: valid base64 strings near the encoded-size boundary can still decode to a payload over the provider limit and are intentionally caught by the existing decoded-size validation after decode; API key loading, request shapes, MIME normalization, and successful transcription behavior are unchanged.

## 2026-06-30 - Auxiliary desktop CLI command timeouts

- Behavior change: scheduler, MCP, and instruction desktop bridge commands now run through a bounded process runner that pipes stdout/stderr, hides the child window, uses a process group/tree for termination, and stops the shared CLI when it exceeds the desktop safety timeout while preserving existing JSON parsing and nonzero-exit diagnostics.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml desktop_task::cli_commands`, `cargo test --manifest-path src-tauri/Cargo.toml desktop_task`, and `cargo check --manifest-path src-tauri/Cargo.toml` passed.
- Remaining risks: timeout handling waits for child termination and stream reader joins after requesting process-tree termination; a platform-level process termination failure could still delay the timeout response until the child exits.
