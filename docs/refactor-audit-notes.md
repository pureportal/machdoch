# Refactor Audit Notes

Audit date: 2026-06-20

Scope: full repository audit for aggressive autonomous refactoring. Excluded generated/vendor/build outputs and lockfile-generated artifacts: `node_modules/`, `dist/`, `build/`, `coverage/`, `target/`, `.next/`, `.nuxt/`, `.turbo/`, `.cache/`, `vendor/`, `generated/`, `.git/`, `pnpm-lock.yaml`, and Cargo lock output. Tauri-generated schemas/icons under `src-tauri/gen/` and `src-tauri/icons/`, generated runtime-contract files, and local Machdoch runtime state under `.machdoch/ralph/` were treated as non-refactor targets.

Inventory method: PowerShell and Node filesystem traversal with explicit directory pruning because `rg` is unavailable in this environment. Current included inventory after pruning runtime state and generated Tauri icon/schema output: 549 files, 520 source files, 182 Vitest specs, 404 `.ts` files, 77 `.tsx` files, and 12 Rust `.rs` files.

## Repository Shape

- Primary stack: strict TypeScript Node CLI, React/Vite desktop UI, and Tauri 2 Rust shell.
- Source roots: `src/cli`, `src/core`, `src/helpers`, `src/common`, `src/tauri/ui`, `scripts`, and Rust crate `src-tauri`.
- Shared helper root: `src/helpers`.
- UI entry/root files: `src/tauri/ui/preview/index.html`, `src/tauri/ui/preview/main.tsx`, `src/tauri/ui/preview/app.tsx`, `vite.ui.config.ts`.
- Rust crate: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`, and module files under `src-tauri/src`.
- Test convention: Vitest specs use `*.spec.ts` and `*.spec.tsx`; current inventory found no source `*.test.ts(x)` files.
- Node Vitest config includes `src/**/*.spec.ts`; UI Vitest config includes `src/tauri/ui/**/*.spec.ts` and `src/tauri/ui/**/*.spec.tsx`.

## Package Scripts

- Build/check: `build`, `build:cli-bundle`, `build:ui`, `generate:runtime-contract`, `lint`, `typecheck`, `typecheck:ui`.
- Test: `test`, `test:ui`, `test:watch`, `coverage`.
- Runtime/dev scripts exist but should not be used during this audit because the app/server/frontend are assumed already running: `dev`, `dev:ui`, `preview:ui`, `start`, `tauri:dev`.
- Release/utility: `version:bump`, `inspect`, `tauri`, `tauri:build`.

## Framework And Convention Filename Exceptions

Unavoidable or conventional non-kebab filenames:

- Root/config: `README.md`, `package.json`, `components.json`, `tsconfig*.json`, `eslint.config.mjs`, `vite.ui.config.ts`, `vitest.config.ts`, `vitest.ui.config.ts`.
- Vitest suffix convention: `*.spec.ts` and `*.spec.tsx`.
- Current helper/model suffix convention: `*.helper.ts`, `*.model.ts`, `*.helper.spec.ts`, and `*.model.spec.ts`. This is not framework-required, but it is widespread and should be changed only as a coordinated naming migration.
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

There are 87 source or test files over 500 lines. Highest-risk files:

- `src/tauri/ui/ralph/ralph-flow-editor.tsx` - 12,379 lines
- `src/core/ralph.ts` - 4,890 lines after the interview-generation normalization extraction
- `src/tauri/ui/runtime.ts` - 4,679 lines
- `src/tauri/ui/chat-session.spec.tsx` - 4,379 lines
- `src-tauri/src/runtime_snapshot.rs` - 3,935 lines
- `src-tauri/src/remote_control.rs` - 3,870 lines
- `src/core/ralph-generation.ts` - 3,214 lines
- `src/core/scheduler.ts` - 3,073 lines after scheduler event-trigger matching extraction
- `src/tauri/ui/chat-session/_helpers/use-chat-session-controller.ts` - 2,707 lines
- `src/tauri/ui/marketplace/mcp-marketplace.tsx` - 2,383 lines
- `src/tauri/ui/chat-session.model.ts` - 2,281 lines
- `src/core/_helpers/utility-tool-definitions.ts` - 2,226 lines
- `src-tauri/src/desktop_task.rs` - 2,163 lines
- `src/tauri/ui/chat-session/_helpers/use-chat-session-runtime.ts` - 2,155 lines
- `src/core/mcp/client.ts` - 2,107 lines
- `src/core/_helpers/package-tool-definitions.ts` - 2,107 lines
- `src/core/__test__/ralph-run.spec.ts` - 2,087 lines
- `src/tauri/ui/ralph/ralph-flow-editor.spec.tsx` - 2,043 lines
- `src/core/_helpers/scheduler-tool-definitions.ts` - 1,944 lines
- `src/core/mcp/tool-definitions.ts` - 1,924 lines
- `src/core/_helpers/browser-tool-definitions.ts` - 1,855 lines
- `src/core/agent-runtime.ts` - 1,817 lines
- `src/cli/_helpers/cli-args.ts` - 1,739 lines
- `src/tauri/ui/chat-session/components/scheduler-panel.tsx` - 1,710 lines

Refactor action: split by stable responsibilities, preserving public exports first. Start with pure helper/view-model extraction before moving runtime IPC, filesystem behavior, persisted JSON handling, or cross-process contracts.

2026-06-20 refactor-pass update: extracted Ralph interview-generation response normalization from `src/core/ralph.ts` into `src/core/_helpers/normalize-ralph-interview-generation.helper.ts` with direct Vitest coverage in `src/core/_helpers/normalize-ralph-interview-generation.helper.spec.ts`. The remaining `src/core/ralph.ts` responsibilities still include interview execution, prompt construction, run persistence, utility execution, and cross-process behavior, so the file remains a P0 split target.

2026-06-20 refactor-pass update: extracted Ralph storage path construction and run/revision artifact path generation from `src/core/ralph.ts` into `src/core/_helpers/create-ralph-storage-paths.helper.ts`, while preserving the existing public exports from `src/core/ralph.ts`. Added direct coverage in `src/core/_helpers/create-ralph-storage-paths.spec.ts` for workspace/user scope paths, flow/revision normalization, invalid empty inputs, timestamp fallback names, preferred run ids, and collision suffix behavior. Updated Ralph generation/watch helpers to import storage-path behavior from the module-local helper instead of the broad orchestration file. `src/core/ralph.ts` remains a P0 split target because flow persistence, run logging, utility execution, browser analysis, and execution orchestration remain colocated.

2026-06-20 refactor-pass update: extracted Ralph interview execution support logic from `src/core/ralph.ts` into module-local helpers: `src/core/_helpers/get-ralph-interview-output-variable-name.helper.ts`, `src/core/_helpers/create-ralph-interview-transcript-markdown.helper.ts`, `src/core/_helpers/create-ralph-interview-question-task.helper.ts`, `src/core/_helpers/extract-ralph-interview-json-object.helper.ts`, and `src/core/_helpers/append-ralph-interview-answers.helper.ts`. Added direct Vitest coverage for configured/default output variable names, empty and populated transcripts, default/configured interview prompt text, JSON/fenced/surrounded/malformed AI responses, and nullish/missing answer transcript handling. `src/core/ralph.ts` remains a P0 split target at 4,702 lines because persistence, run logging, utility execution, MCP execution, UI analysis, and flow execution orchestration remain colocated.

2026-06-20 refactor-pass update: extracted Ralph generation interview contract parsing, max-turn clamping, and transcript line merging from `src/core/ralph-generation.ts` into `src/core/_helpers/read-ralph-generation-interview-submission.helper.ts`, `src/core/_helpers/clamp-ralph-generation-interview-max-turns.helper.ts`, and `src/core/_helpers/merge-ralph-generation-interview-lines.helper.ts`. Added direct `file-name.spec.ts` Vitest coverage for normal, invalid, empty, null/default, fallback parsing, duplicate, and boundary behavior. `src/core/ralph-generation.ts` remains a P0 split target at 3,213 lines because prompt construction, validation loops, workspace hints, actor execution, persistence, and generated-flow parsing are still colocated.

2026-06-20 refactor-pass update: extracted Ralph generation attempt path construction and generated-flow response/file parsing from `src/core/ralph-generation.ts` into `src/core/_helpers/create-generation-attempt-flow-path.helper.ts` and `src/core/_helpers/read-generated-ralph-flow.helper.ts`. Added direct `file-name.spec.ts` Vitest coverage for extension handling, tagged/fenced/raw response JSON, duplicate invalid candidates, generated-file fallback, invalid file JSON, and missing-output errors. `src/core/ralph-generation.ts` remains a P0 split target at 2,884 lines because prompt construction, validation loops, workspace hints, actor execution, persistence, and generated-flow validation are still colocated.

2026-06-20 refactor-pass update: extracted Ralph generated-flow structural validation, local validator result shaping, generation feedback excerpting, actor result message formatting, non-execution feedback, and did-not-converge summary creation from `src/core/ralph-generation.ts` into module-local helpers: `src/core/_helpers/validate-generated-ralph-flow-structure.helper.ts`, `src/core/_helpers/create-local-generation-validator-result.helper.ts`, `src/core/_helpers/create-generation-feedback-excerpt.helper.ts`, `src/core/_helpers/create-generation-actor-result-message.helper.ts`, `src/core/_helpers/create-task-did-not-execute-feedback.helper.ts`, and `src/core/_helpers/create-generation-did-not-converge-summary.helper.ts`. Added direct `file-name.spec.ts` coverage for acyclic and cyclic generated flows, cycle boundary behavior with `settings.maxTransitions`, small visual-block warnings, schema-example id warnings, local validator result formatting, empty/whitespace/long feedback, non-executed actor summaries, and convergence summary error/feedback branches. `src/core/ralph-generation.ts` remains a P0 split target at 2,914 lines because prompt construction, tool contracts, workspace hints, actor execution, persistence, and the generation loop remain colocated.

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

2026-06-20 refactor-pass update: extracted scheduler prompt/task text assembly into `src/core/_helpers/create-scheduled-job-task-text.helper.ts`, scheduler context path collection into `src/core/_helpers/get-scheduled-job-context-paths.helper.ts`, and prompt frontmatter coercion into `src/core/_helpers/get-scheduler-frontmatter-{string,boolean,number,string-list}.helper.ts`. Added direct Vitest coverage with `file-name.spec.ts` tests for normal, empty, invalid, duplicate, and branch behavior. `src/core/scheduler.ts` still remains a P0/P1 split target because persistence, queue execution, trigger matching, state locking, and scheduler job normalization are still colocated.

2026-06-20 refactor-pass update 2: extracted scheduler event trigger matching, filter evaluation, stateful/cooldown/rate-limit skip decisions, event payload normalization, and event dedupe suffix rendering into `src/core/_helpers/scheduler-event-trigger-matching.helper.ts`. Added direct coverage in `src/core/_helpers/scheduler-event-trigger-matching.helper.spec.ts` for wildcard event matching, nested filters, numeric/string/existence filter expressions, invalid filters, dedupe templates, state repeat buckets, recovery filters, cooldown boundaries, rate-limit boundaries, and payload normalization. `src/core/scheduler.ts` still remains over 500 lines and still contains persistence, trigger normalization, queue execution, retry handling, and run lifecycle orchestration.

2026-06-20 refactor-pass update 2 also fixed the partially extracted Ralph interview submission boundary by importing `RalphGenerationInterviewSubmission` from `src/core/_helpers/read-ralph-generation-interview-submission.helper.ts` and preserving legacy `default: null` handling without changing the existing `defaultValue: null` omission behavior. This unblocked `pnpm typecheck` and restored the direct helper spec.

2026-06-20 refactor-pass update: moved Ralph generation interview-submission business logic out of the broad orchestration module and into module-local `_helpers`. The extracted helpers preserve the existing public API and runtime behavior, including the existing nullish fallback behavior where `defaultValue: null` is omitted while `default: null` is preserved.

### P1 - Shared helper duplication belongs in `src/helpers`

Repeated normalizers/sorters appear across modules despite `src/helpers` existing:

- `normalizeStringList` exists in `src/helpers/normalize-string-list.helper.ts` and is used by `src/core/instructions.ts`; `src/core/ralph-watches.ts` still has local list/path normalization behavior that should be compared before extraction.
- `normalizeText`, `normalizeTrimmedText`, and `normalizeMultilineText` in `src/core/scheduler.ts` overlap with `normalizeOptionalString` semantics but preserve different whitespace behavior; consolidate only if exact behavior can be preserved.
- `normalizeModelId` is centralized in `src/helpers/normalize-model-id.helper.ts`, but model normalization still appears locally in `src/core/model-capabilities.ts` with subtly different matching behavior.
- UI-specific `normalize-chat-session-optional-string.helper.ts` duplicates the general optional-string helper pattern and should be justified by UI-specific semantics or consolidated.
- Positive-number/integer normalization recurs in `src/core/env.ts`, `src/core/execution.ts`, `src/core/ralph-watches.ts`, and `src/core/scheduler.ts`.

Refactor action: add narrowly named helpers under `src/helpers` only when behavior is identical. Avoid merging superficially similar normalizers that intentionally preserve different whitespace, nullability, casing, or defaulting behavior.

### P1 - Missing or indirect Vitest coverage for business logic

There are 140 TypeScript/TSX source files without a direct same-name spec. The main business-logic risks are:

- `src/core/ralph.ts` and `src/core/ralph-generation.ts` rely heavily on `src/core/__test__` scenario coverage instead of same-name specs. Keep those scenario tests while extracting smaller helpers with direct specs.
- `src/core/ralph-layout.ts`, `src/core/ralph-watches.ts`, `src/core/mcp/presets.ts`, and `src/core/mcp/types.ts` have no direct same-name specs.
- `src/cli/_helpers/cli-mcp-commands.ts`, `src/cli/_helpers/cli-output.ts`, `src/cli/_helpers/cli-ralph-commands.ts`, `src/cli/_helpers/cli-summary-commands.ts`, and `src/cli/_helpers/create-parsed-cli-args.helper.ts` have no direct same-name specs, though broader CLI specs cover some command behavior.
- UI business/model modules without direct same-name specs include `src/tauri/ui/lib/shell-store.ts`, `src/tauri/ui/marketplace/mcp-marketplace-cache.ts`, `src/tauri/ui/marketplace/mcp-marketplace.tsx`, `src/tauri/ui/marketplace/mcp-marketplace-ui.tsx`, and several chat-session hooks under `src/tauri/ui/chat-session/_helpers`.
- Rust source has no Rust unit/integration tests visible under `src-tauri/src` for `remote_control`, `runtime_snapshot`, `desktop_task`, `ui_control`, or `voice`.

Refactor action: add focused specs when extracting pure helpers from the listed modules. Do not treat broad integration specs as sufficient for small helper behavior unless assertions already cover the exact branch being moved.

### P2 - Non-kebab filename violations outside documented exceptions

Actual source filename violations after excluding generated/vendor/build artifacts and documented framework/convention exceptions:

- Rust conventional snake_case modules: `src-tauri/src/desktop_shell.rs`, `src-tauri/src/desktop_task.rs`, `src-tauri/src/remote_control.rs`, `src-tauri/src/runtime_snapshot.rs`, `src-tauri/src/shared_cli.rs`, `src-tauri/src/ui_control.rs`.
- Generated Rust contract file: `src-tauri/src/runtime_contract_generated.rs`.
- Generated TypeScript contract files: `src/core/runtime-contract.generated.ts` and `src/core/runtime-contract.generated.spec.ts`.
- Framework/schema exceptions that are non-kebab by policy but should remain stable: `src-tauri/tauri.conf.json` and `src/shared/runtime-config.schema.json`.
- Dot-suffixed helper/model/spec convention is widespread: `*.helper.ts`, `*.model.ts`, `*.helper.spec.ts`, `*.model.spec.ts`, and `*.spec.ts(x)`. Renaming these would be a repository-wide convention migration and should wait until module splits stabilize.

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
