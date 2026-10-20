# Template validation — 2026-10-19

The template implementation adds a native store, native regression tests, and the Text to Speech Templates component.

## Implemented behavior

- Native operations follow the runtime contract: `listTemplates({ search? })`, `saveTemplate({ template, expectedRevisionId })`, and `deleteTemplate({ id, expectedRevisionId })`.
- Template validation uses the store's scalar helpers, a synthesized project for cast validation, and the shared export preset validator. Referenced profiles and reference assets must exist.
- Each operation runs in an immediate SQLite transaction. Saves use revision comparisons, assign server revisions and timestamps, and retain the original creation timestamp.
- Every successful save appends a complete snapshot and its content hash to `template_revisions`. Database triggers reject revision updates and deletion.
- Deletion checks the expected revision and retains revision history. Deleted template IDs cannot be reused.
- Name search treats wildcard characters literally and compares Unicode lowercase names.
- The Templates component saves and reopens named templates, collects variables using the existing parser, and resolves them using the existing injection checks.
- Apply stays unavailable until a resolved preview succeeds. Applying replaces only source, cast, profile, and export settings; the current project's identity and other fields remain intact.

## Verification evidence

The scoped Machdoch tools confirmed creation of:

- `apps/client/src-tauri/src/speech/template_store.rs`
- `apps/client/src-tauri/src/speech/template_store_tests.rs`
- `packages/text-to-speech/src/templates.tsx`

Nine native regression tests cover revision ancestry, reopen results, stale writes and deletion, history retention, immutable history, transaction rollback, literal and Unicode search, field validation, and referenced records.

The following commands were attempted and rejected by the execution policy before starting:

```text
cargo test --manifest-path apps/client/src-tauri/Cargo.toml template_store --lib
pnpm exec tsc --noEmit -p packages/text-to-speech/tsconfig.json
```

No compile, native test, TypeScript, or browser pass is claimed. No server was started.

## Integration boundary

Existing-file module declarations, dispatch routing, and mounting the component belong to the parent task. The component exports `Templates` and `TemplatesProps`; its preview callback accepts resolved source and may return a promise.

The native wrapper currently assumes `SpeechStore::connection(&self) -> Result<Connection, String>` and `validate_project(&Value) -> Result<(), String>`. Those declarations were outside the assigned source ranges and remain unconfirmed. The parent must confirm these signatures while wiring the module, then run the focused checks above and the template interaction check in the assembled application.

The module owns the `templates` and `template_revisions` schema. No migration, compatibility path, provider request, or inference asset is introduced.
