# Refactor Audit Notes

Audit date: 2026-06-20

Scope: full repository audit for aggressive autonomous refactoring. Excluded generated/vendor/build outputs and lockfile-generated artifacts: `node_modules/`, `dist/`, `build/`, `coverage/`, `target/`, `.next/`, `.nuxt/`, `.turbo/`, `.cache/`, `vendor/`, `generated/`, `pnpm-lock.yaml`, and `src-tauri/Cargo.lock`. Tauri-generated schemas/icons under `src-tauri/gen/` and `src-tauri/icons/`, generated runtime-contract files, and local Machdoch runtime state under `.machdoch/ralph/` were treated as non-refactor targets.

Inventory method: PowerShell traversal with explicit directory pruning because `rg` is unavailable in this environment. Current included inventory after pruning runtime state and generated Tauri icon/schema output: 417 files, 416 non-binary/source-or-config-like files, 139 Vitest specs, 311 `.ts` files, 77 `.tsx` files, and 12 Rust `.rs` files.

## Repository Shape

- Primary stack: strict TypeScript Node CLI, React/Vite desktop UI, and Tauri 2 Rust shell.
- Source roots: `src/cli`, `src/core`, `src/helpers`, `src/common`, `src/tauri/ui`, `scripts`, and Rust crate `src-tauri`.
- Shared helper root: `src/helpers`.
- UI entry/root files: `src/tauri/ui/preview/index.html`, `src/tauri/ui/preview/main.tsx`, `src/tauri/ui/preview/app.tsx`, `vite.ui.config.ts`.
- Rust crate: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`, and module files under `src-tauri/src`.
- Test convention: Vitest specs use `*.spec.ts` and `*.spec.tsx`; current inventory found no `*.test.ts(x)` source tests.
- Node Vitest config includes `src/**/*.spec.ts`; UI Vitest config includes `src/tauri/ui/**/*.spec.ts` and `src/tauri/ui/**/*.spec.tsx`.

## Package Scripts

- Build/check: `build`, `build:cli-bundle`, `build:ui`, `generate:runtime-contract`, `lint`, `typecheck`, `typecheck:ui`.
- Test: `test`, `test:ui`, `test:watch`, `coverage`.
- Runtime/dev scripts exist but should not be used during this refactor audit because the app/server/frontend are assumed already running: `dev`, `dev:ui`, `preview:ui`, `start`, `tauri:dev`.
- Release/utility: `version:bump`, `inspect`, `tauri`, `tauri:build`.

## Framework And Convention Filename Exceptions

Unavoidable or conventional non-kebab filenames:

- Root/config: `README.md`, `package.json`, `components.json`, `tsconfig*.json`, `eslint.config.mjs`, `vite.ui.config.ts`, `vitest.config.ts`, `vitest.ui.config.ts`.
- Vitest suffix convention: `*.spec.ts` and `*.spec.tsx`.
- Current helper suffix convention: `*.helper.ts` and `*.helper.spec.ts`. This is not framework-required, but it is already widespread and should be changed only as a coordinated naming migration.
- Tauri/Rust: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, and Rust snake_case module filenames.
- Web entry and styles: `src/tauri/ui/preview/index.html`, `src/tauri/ui/preview/main.tsx`, `src/tauri/ui/preview/app.tsx`, `src/tauri/ui/styles.css`, and `src/shared/runtime-config.schema.json`.
- Generated outputs, not refactor targets: `src/core/runtime-contract.generated.ts`, `src/core/runtime-contract.generated.spec.ts`, `src-tauri/src/runtime_contract_generated.rs`, `src-tauri/gen/**`, `src-tauri/icons/**`.

Rust snake_case module filenames are conventional for Rust but violate a language-agnostic kebab-only filename rule: `desktop_shell.rs`, `desktop_task.rs`, `remote_control.rs`, `runtime_contract_generated.rs`, `runtime_snapshot.rs`, `shared_cli.rs`, and `ui_control.rs`.

## Available And Unavailable Validation

Available through `package.json`:

- `pnpm test`
- `pnpm test:ui`
- `pnpm typecheck`
- `pnpm typecheck:ui`
- `pnpm lint`
- `pnpm build`
- `pnpm build:ui`
- `pnpm coverage`

Unavailable as package scripts:

- Rust validation is not exposed through `package.json`; use direct Cargo commands from `src-tauri` when needed, such as `cargo test`, `cargo check`, and `cargo clippy`.
- UI coverage is configured in `vitest.ui.config.ts`, but there is no dedicated package script for UI coverage. `coverage` uses `vitest.config.ts`, whose coverage include is limited to `src/core/**/*.ts`.

## Prioritized Violations

### P0 - Very large orchestration files block safe autonomous refactors

Files over 500 lines are widespread. Highest-risk files:

- `src/tauri/ui/ralph/ralph-flow-editor.tsx` - 11,672 lines
- `src/core/ralph.ts` - 5,318 lines
- `src/tauri/ui/runtime.ts` - 4,107 lines
- `src/tauri/ui/chat-session.spec.tsx` - 3,830 lines
- `src/core/ralph-generation.ts` - 3,535 lines
- `src-tauri/src/remote_control.rs` - 3,434 lines
- `src-tauri/src/runtime_snapshot.rs` - 3,390 lines
- `src/core/scheduler.ts` - 3,076 lines
- `src/tauri/ui/chat-session/_helpers/use-chat-session-controller.ts` - 2,457 lines
- `src/cli/_helpers/cli-args.ts` - 2,288 lines
- `src/tauri/ui/marketplace/mcp-marketplace.tsx` - 2,198 lines
- `src/core/_helpers/utility-tool-definitions.ts` - 1,989 lines
- `src/core/__test__/ralph-run.spec.ts` - 1,989 lines
- `src/tauri/ui/chat-session.model.ts` - 1,949 lines
- `src/tauri/ui/chat-session/_helpers/use-chat-session-runtime.ts` - 1,914 lines
- `src/core/_helpers/package-tool-definitions.ts` - 1,886 lines
- `src-tauri/src/desktop_task.rs` - 1,832 lines
- `src/core/mcp/client.ts` - 1,820 lines
- `src/tauri/ui/ralph/ralph-flow-editor.spec.tsx` - 1,807 lines
- `src/core/mcp/tool-definitions.ts` - 1,758 lines
- `src/core/_helpers/scheduler-tool-definitions.ts` - 1,748 lines
- `src/core/_helpers/browser-tool-definitions.ts` - 1,707 lines
- `src/core/agent-runtime.ts` - 1,647 lines
- `src/tauri/ui/chat-session/components/scheduler-panel.tsx` - 1,597 lines

Refactor action: split by stable responsibilities, preserving public exports first. Start with pure helper/view-model extraction before moving runtime IPC, filesystem behavior, persisted JSON handling, or cross-process contracts.

### P1 - Module-local business logic should be split into smaller helpers

Conservative candidates where business logic is embedded in broad modules instead of narrow helper modules:

- `src/core/ralph.ts`: type surface, storage paths, flow persistence, validation re-exports, execution transitions, utility execution, browser analysis, interview/input normalization, run logging, and persisted record handling are mixed.
- `src/core/ralph-generation.ts`: generation state, validation loop, prompt construction, interview normalization, persistence, event logging, and layout/defaulting are mixed.
- `src/core/scheduler.ts`: schedule/trigger types, state locking, migration, cron/time parsing, trigger filtering, queue dedupe, persistence, retry policy, event matching, and execution dispatch are mixed.
- `src/cli/_helpers/cli-args.ts`: command definitions, validation sets, help text, aliases, and parsing are mixed.
- `src/tauri/ui/runtime.ts`: UI-facing contract types, Tauri invoke wrappers, runtime config normalization, preview fixture fallback, event listeners, scheduler/Ralph/MCP APIs, and API-shape validation are mixed.
- `src/tauri/ui/chat-session/_helpers/use-chat-session-controller.ts`: React wiring, instruction registry mutations, attachment handling, speech input, session lifecycle, remote mission control, and task submission are mixed.
- `src/tauri/ui/marketplace/mcp-marketplace.tsx`: marketplace loading, filtering, selection, install state, enrichment, and rendering are mixed.
- `src-tauri/src/remote_control.rs`: config persistence, pairing/token logic, Axum/manual HTTP routes, SSE state, HTML rendering, shell sessions, command normalization, sanitization, and dispatch are mixed.
- `src-tauri/src/runtime_snapshot.rs`: config loading, provider availability, runtime serialization, user settings, MCP state, scheduler state, and snapshot construction are mixed.

Refactor action: extract pure domain helpers adjacent to the owning module first. Promote cross-module helpers to `src/helpers` only when reused outside the owning feature and behavior is identical.

### P1 - Shared helper duplication belongs in `src/helpers`

Repeated normalizers/sorters appear across modules despite `src/helpers` existing:

- `normalizeStringList` exists in `src/helpers/normalize-string-list.helper.ts` and is used by `src/core/instructions.ts`; `src/core/ralph-watches.ts` still has local list/path normalization behavior that should be compared before extraction.
- `normalizeText`, `normalizeTrimmedText`, and `normalizeMultilineText` in `src/core/scheduler.ts` overlap with `normalizeOptionalString` semantics but preserve different whitespace behavior; consolidate only if exact behavior can be preserved.
- `normalizeModelId` is centralized in `src/helpers/normalize-model-id.helper.ts`, but model normalization still appears locally in `src/core/model-capabilities.ts` with subtly different matching behavior.
- UI-specific `normalize-chat-session-optional-string.helper.ts` duplicates the general optional-string helper pattern and should be justified by UI-specific semantics or consolidated.
- Positive-number/integer normalization recurs in `src/core/env.ts`, `src/core/execution.ts`, `src/core/ralph-watches.ts`, and `src/core/scheduler.ts`.

Refactor action: add narrowly named helpers under `src/helpers` only when behavior is identical. Avoid merging superficially similar normalizers that intentionally preserve different whitespace, nullability, casing, or defaulting behavior.

### P1 - Missing or indirect Vitest coverage for business logic

Business-logic source files with no direct same-name spec, only broad scenario coverage, or coverage risk during extraction include:

- `src/core/ralph.ts` and `src/core/ralph-generation.ts` rely heavily on `src/core/__test__` scenario coverage instead of same-name specs. Keep those scenario tests while extracting smaller helpers with direct specs.
- `src/core/ralph-layout.ts`, `src/core/ralph-watches.ts`, `src/core/memory.ts`, `src/core/review-model.ts`, `src/core/mcp/presets.ts`, and `src/core/mcp/types.ts` have no direct same-name specs.
- `src/cli/_helpers/cli-args.ts`, `src/cli/_helpers/cli-mcp-commands.ts`, `src/cli/_helpers/cli-output.ts`, `src/cli/_helpers/cli-ralph-commands.ts`, and `src/cli/_helpers/cli-summary-commands.ts` have no direct same-name specs, though broader CLI specs cover some command behavior.
- UI business/model modules without direct same-name specs include `src/tauri/ui/task-panel.model.ts`, `src/tauri/ui/task-timeline-data.ts`, `src/tauri/ui/lib/shell-store.ts`, `src/tauri/ui/marketplace/mcp-marketplace-cache.ts`, `src/tauri/ui/marketplace/mcp-marketplace.tsx`, and several chat-session hooks under `src/tauri/ui/chat-session/_helpers`.
- Rust source has no Rust unit/integration tests visible under `src-tauri/src` for `remote_control`, `runtime_snapshot`, `desktop_task`, `ui_control`, or `voice`.

Refactor action: add focused specs when extracting pure helpers from the listed modules. Do not treat broad integration specs as sufficient for small helper behavior unless assertions already cover the exact branch being moved.

### P2 - Non-kebab filename violations outside documented exceptions

Actual source filename violations after excluding generated/vendor/build artifacts and documented framework/convention exceptions:

- Rust conventional snake_case modules: `src-tauri/src/desktop_shell.rs`, `src-tauri/src/desktop_task.rs`, `src-tauri/src/remote_control.rs`, `src-tauri/src/runtime_snapshot.rs`, `src-tauri/src/shared_cli.rs`, `src-tauri/src/ui_control.rs`.
- Generated Rust contract file: `src-tauri/src/runtime_contract_generated.rs`.
- Generated TypeScript contract files: `src/core/runtime-contract.generated.ts` and `src/core/runtime-contract.generated.spec.ts`.
- Framework/schema exceptions that are non-kebab by policy but should remain stable: `src-tauri/tauri.conf.json` and `src/shared/runtime-config.schema.json`.
- Dot-suffixed helper/model/spec convention is widespread: `*.helper.ts`, `*.model.ts`, `*.helper.spec.ts`, `*.model.spec.ts`, and `*.spec.ts(x)`. Renaming these would be a repository-wide convention migration and may not be worth the churn until module splits stabilize.

Refactor action: do not rename Rust modules unless the repository explicitly chooses to violate Rust naming conventions. Do not rename framework/config files. Keep generated contract names stable. Consider a later, mechanical naming migration only after high-risk module splits land.

### P2 - Duplicated or hard-to-maintain code shapes

- Tool definition modules (`utility-tool-definitions.ts`, `package-tool-definitions.ts`, `scheduler-tool-definitions.ts`, `browser-tool-definitions.ts`, `desktop-ui-tool-definitions.ts`, `macro-recorder-tool-definitions.ts`, `filesystem-tool-definitions.ts`, `memory-tool-definitions.ts`) are large and likely repeat input validation, result shaping, and description construction.
- Provider adapters under `src/core/_helpers/provider-adapters/` share stream-event, request, schema, and usage-normalization mechanics; retain provider-specific protocol differences while extracting only identical mechanics.
- UI runtime and shell state modules repeat persisted-setting, event-listener, fallback, and IPC result-shaping patterns.
- Long settings panels repeat form field, status, validation, and mutation-state patterns under `src/tauri/ui/chat-session/components/settings-dialog-panels/`.
- Ralph UI/editor files repeat block option rendering, handle wiring, canvas-state derivation, and summary formatting patterns.

Refactor action: extract primitives only after two or more call sites prove identical behavior. Avoid broad abstractions across provider SDKs or UI panels with subtly different state semantics.

### P2 - Risky public API and contract-change areas

Treat the following as public or cross-process contracts and refactor with compatibility tests:

- CLI argument surface in `src/cli/_helpers/cli-args.ts`, `src/cli/app.ts`, and package binary entry `dist/cli/main.js` generated from `src/cli/main.ts`.
- Runtime contract files: `src/core/runtime-contract.generated.ts`, `src/shared/runtime-config.schema.json`, `src-tauri/src/runtime_contract_generated.rs`, and `scripts/generate-runtime-contract.mjs`.
- Tauri command/API bridge in `src/tauri/ui/runtime.ts` and Rust `src-tauri/src/*`.
- Ralph persisted JSON formats under `.machdoch/ralph/**`, flow schema/version constants, and `src/core/ralph.ts` storage helpers.
- Scheduler persisted JSON at `.machdoch/scheduler.json` and scheduler schema/version constants in `src/core/scheduler.ts`.
- MCP config/cache types under `src/core/mcp/**`.
- Marketplace cache/enrichment/model shapes under `src/tauri/ui/marketplace/**`.

Refactor action: keep exported names, Tauri command names, JSON shapes, and persisted schema defaults stable unless paired with migration/compatibility tests and generated-contract regeneration.
