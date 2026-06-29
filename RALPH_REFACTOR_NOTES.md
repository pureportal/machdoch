# Ralph Refactor Notes

## Src Tauri

- `src-tauri/src/remote_control.rs` remains over the 500-line target after these passes. The embedded Mission Control HTML/script and the Remote Shell snapshot model/sanitizer now live in private child modules. Auth, session, cookie, CSRF, SSE, and command-routing logic remains in the parent file to avoid mixing security-sensitive routing changes into this extraction.
- `src-tauri/Cargo.lock`, `src-tauri/src/runtime_contract_generated.rs`, `src-tauri/gen/**`, and platform icon assets remain excluded from line-count refactor pressure because they are lockfile, generated, or binary/asset boundaries.
- Public IPC and Tauri boundaries were left unchanged: command names, serde payload shapes, event names, cookie names, security headers, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, and `src-tauri/src/lib.rs` invoke wiring were not modified.

Verification for this pass:

- `rustfmt --edition 2021 src-tauri/src/remote_control.rs src-tauri/src/remote_control/mission_control_html.rs src-tauri/src/remote_control/mission_control_script_render.rs src-tauri/src/remote_control/mission_control_script_events.rs --check`
- `rustfmt --edition 2021 src-tauri/src/remote_control.rs src-tauri/src/remote_control/shell.rs src-tauri/src/remote_control/sanitize.rs --check`
- `cargo test --manifest-path src-tauri/Cargo.toml`
