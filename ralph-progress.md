# Ralph Refactoring Progress

## Inspect Repository Block - Current Snapshot

Date: 2026-06-19

### Active Instructions

- No `AGENTS.md` files were found in the workspace outside ignored/generated directories.
- Workspace instructions are in `.machdoch/instructions.md`: use the smallest safe step, inspect read-only before edits, keep a short plan for multi-step work, continue until complete or concretely blocked, and verify before declaring completion.
- Security defaults are in `.machdoch/instructions/security.instructions.md`: avoid printing secrets, prefer read-only checks before package/system changes, and treat package installation as risky.
- This Ralph block explicitly forbids starting or restarting backend/frontend/dev servers.

### Package and Scripts

- Package: `machdoch` `0.17.0`, private ESM package.
- Package manager: `pnpm@11.6.0`; Node engine `>=20.10`.
- CLI binary: `machdoch` -> `./dist/cli/main.js`.
- Refactor-relevant scripts:
  - `pnpm build`: `tsc -p tsconfig.json`
  - `pnpm build:ui`: `vite build --config vite.ui.config.ts`
  - `pnpm lint`: `eslint src vite.ui.config.ts vitest.config.ts vitest.ui.config.ts`
  - `pnpm typecheck`: `tsc --noEmit -p tsconfig.json`
  - `pnpm typecheck:ui`: `tsc -p tsconfig.ui.json --noEmit`
  - `pnpm test`: `vitest run`
  - `pnpm test:ui`: `vitest run --config vitest.ui.config.ts`
  - `pnpm coverage`: `vitest run --coverage`
  - `pnpm generate:runtime-contract`: `node scripts/generate-runtime-contract.mjs`
- Server/runtime scripts exist but must not be used for this block: `dev`, `dev:ui`, `preview:ui`, `start`, `tauri:dev`.
- Repository scripts live in `scripts/`: `build-cli-bundle.mjs`, `bump-version.mjs`, and `generate-runtime-contract.mjs`.

### TypeScript and Lint Conventions

- Main `tsconfig.json` targets `ES2022`, uses `NodeNext` modules/resolution, emits declarations and source maps to `dist`, and enables strict flags including `noImplicitOverride`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.
- Main build includes `src/**/*.ts` but excludes specs/tests and `src/tauri/ui/**/*.ts(x)`.
- Node test typing is in `tsconfig.spec.json`, includes `src/**/*.spec.ts`, excludes UI tests, and enables `vitest/globals`.
- UI typing is in `tsconfig.ui.json`, uses `ESNext` plus Bundler resolution, `react-jsx`, DOM libs, `vitest/globals`, and `@/*` -> `./src/*`.
- ESLint flat config applies to `src/**/*.{ts,tsx}` and root `*.ts`; `@typescript-eslint/no-explicit-any` is an error. Test files and Vitest configs receive Vitest globals.

### Vitest Usage

- Node Vitest config is `vitest.config.ts`.
  - Environment: `node`.
  - Globals enabled.
  - Include: `src/**/*.spec.ts`.
  - `restoreMocks: true`; `unstubEnvs: true`.
  - Coverage uses V8, includes `src/core/**/*.ts`, and excludes `src/**/__test__/**/*.ts` plus specs.
- UI Vitest config is `vitest.ui.config.ts`.
  - Environment: `jsdom`.
  - Globals enabled.
  - Current include: `src/tauri/ui/**/*.spec.ts`.
  - `fileParallelism: false`; `passWithNoTests: true`; `restoreMocks: true`.
  - Tauri API/plugin imports are aliased to `src/tauri/ui/test/tauri-test-mocks.ts`.
- Actual UI test files use both `.spec.ts` and `.test.ts/.test.tsx`; with the current config, `pnpm test:ui` only includes UI `.spec.ts` files unless the config is changed.

### Source Layout

- `src/cli`: CLI entrypoints plus `_helpers` for CLI commands, IO, Ralph, scheduler, and task-run behavior.
- `src/core`: core runtime, Ralph flow/generation/layout/watch logic, scheduler, task inspection/running, provider adapters, tools, MCP, config, env, and memory.
- `src/core/__test__`: Ralph-focused integration-style specs and `ralph-test-helpers.ts`.
- `src/core/_helpers`: narrowly named core helpers and provider adapter helpers.
- `src/helpers`: small repository-wide helper utilities.
- `src/common`: shared UI-facing components such as `status-badge.tsx`.
- `src/shared`: shared schema assets, currently including `runtime-config.schema.json`.
- `src/tauri/ui`: React/Tauri desktop UI, app shell, chat session, components, marketplace, Ralph UI, preview, lib, `_helpers`, and `test` mocks.
- `src-tauri`: native Tauri/Rust side.

### Naming and Import Patterns

- Feature helper directories are named `_helpers`.
- Helper filenames commonly use kebab case plus `.helper.ts`, for example `parse-ralph-decision.helper.ts`.
- Tests are generally colocated with implementation files.
- Node/core/CLI tests usually use `.spec.ts`; UI tests currently mix `.spec.ts`, `.test.ts`, and `.test.tsx`.
- Node/core implementation imports compiled-relative paths with `.js` extensions under `NodeNext`; colocated specs commonly import local TypeScript source with `.ts` extensions.
- UI code uses the `@` alias and Bundler resolution; Tauri API calls should go through the configured mocks in UI tests.

## Inspect Repository Block

Date: 2026-06-19

### Active Instructions

- No `AGENTS.md` files were found in the workspace.
- Workspace instructions are in `.machdoch/instructions.md`.
  - Start with the smallest safe step.
  - Prefer read-only inspection before changes.
  - Keep a short plan for multi-step work.
  - Verify outcomes before declaring completion.
- Security defaults apply from `.machdoch/instructions/security.instructions.md`.
  - Avoid printing secrets.
  - Prefer read-only checks before package installation or system changes.
  - Treat package installation as risky.
- Do not start or restart backend/frontend/dev servers for this flow.

### Package and Tooling

- Package: `machdoch` version `0.17.0`, private ESM package.
- Runtime engine: Node `>=20.10`.
- Package manager: `pnpm@11.6.0`.
- CLI binary maps `machdoch` to `./dist/cli/main.js`.
- Main scripts:
  - `pnpm build`: `tsc -p tsconfig.json`
  - `pnpm build:cli-bundle`: `node scripts/build-cli-bundle.mjs`
  - `pnpm build:ui`: `vite build --config vite.ui.config.ts`
  - `pnpm generate:runtime-contract`: `node scripts/generate-runtime-contract.mjs`
  - `pnpm lint`: `eslint src vite.ui.config.ts vitest.config.ts vitest.ui.config.ts`
  - `pnpm typecheck`: `tsc --noEmit -p tsconfig.json`
  - `pnpm typecheck:ui`: `tsc -p tsconfig.ui.json --noEmit`
  - `pnpm test`: `vitest run`
  - `pnpm test:ui`: `vitest run --config vitest.ui.config.ts`
  - `pnpm coverage`: `vitest run --coverage`
- Server-starting scripts exist but should not be used for this flow unless explicitly allowed:
  - `dev`, `dev:ui`, `preview:ui`, `start`, `tauri:dev`.

### TypeScript Conventions

- Main TypeScript config uses:
  - `target: ES2022`
  - `module: NodeNext`
  - `moduleResolution: NodeNext`
  - `strict: true`
  - `noImplicitOverride: true`
  - `noUncheckedIndexedAccess: true`
  - `exactOptionalPropertyTypes: true`
  - `rootDir: src`
  - `outDir: dist`
  - declarations and source maps enabled.
- Main `tsconfig.json` includes `src/**/*.ts` and excludes tests plus Tauri UI files.
- Node tests use `tsconfig.spec.json`, include `src/**/*.spec.ts`, and enable `vitest/globals`.
- UI TypeScript uses `tsconfig.ui.json` with:
  - `module: ESNext`
  - `moduleResolution: Bundler`
  - `jsx: react-jsx`
  - DOM libs
  - path alias `@/*` to `./src/*`.

### Lint Conventions

- ESLint config is flat config in `eslint.config.mjs`.
- Applies to `src/**/*.{ts,tsx}` and root `*.ts` files.
- Extends recommended JavaScript and TypeScript ESLint configs.
- `@typescript-eslint/no-explicit-any` is an error.
- Test files and Vitest configs receive Vitest globals.
- Ignored paths include `coverage/**`, `dist/**`, `node_modules/**`, and `src-tauri/target/**`.

### Vitest Usage

- Node Vitest config: `vitest.config.ts`.
  - Environment: `node`.
  - Globals enabled.
  - Include: `src/**/*.spec.ts`.
  - `restoreMocks: true`.
  - `unstubEnvs: true`.
  - Coverage provider: `v8`.
  - Coverage includes `src/core/**/*.ts`, excludes tests.
- UI Vitest config: `vitest.ui.config.ts`.
  - Environment: `jsdom`.
  - Globals enabled.
  - Include: `src/tauri/ui/**/*.test.ts` and `src/tauri/ui/**/*.test.tsx`.
  - `fileParallelism: false`.
  - `passWithNoTests: true`.
  - `restoreMocks: true`.
  - Aliases Tauri APIs and plugins to `src/tauri/ui/test/tauri-test-mocks.ts`.

### Source Layout

- Top-level source directories:
  - `src/cli`: CLI entrypoints, argument parsing, and CLI helper modules.
  - `src/common`: shared UI components such as `status-badge.tsx`.
  - `src/core`: core runtime, Ralph, scheduler, task, provider, MCP, and tool logic.
  - `src/helpers`: repository-wide small helper utilities.
  - `src/shared`: shared schemas such as `runtime-config.schema.json`.
  - `src/tauri/ui`: Tauri desktop UI, React components, UI helpers, models, and UI tests.
- Rust/Tauri native side is under `src-tauri`.
- Build scripts are under `scripts`.

### Naming and Organization Patterns

- Helper folders are named `_helpers` inside feature areas, for example:
  - `src/cli/_helpers`
  - `src/core/_helpers`
  - `src/tauri/ui/chat-session/_helpers`
  - `src/tauri/ui/_helpers`
- Small helper files commonly use `*.helper.ts`, for example:
  - `normalize-optional-string.helper.ts`
  - `parse-ralph-decision.helper.ts`
  - `validate-ralph-flow.helper.ts`
- Tests are usually colocated next to implementation files.
  - Node/core/CLI tests typically use `.spec.ts`.
  - UI tests typically use `.test.ts` or `.test.tsx`.
  - Ralph integration-style core tests also appear in `src/core/__test__`.
- Imports in Node/core spec files commonly include TypeScript extensions for local modules, for example `./parse-ralph-decision.helper.ts`.
- Node/core implementation files commonly import emitted module paths with `.js` extensions, for example `../types.js`, because the main build uses `NodeNext`.
- UI helper tests sometimes omit the extension for local imports under bundler resolution.
- Test style uses global `describe`, `it`, `expect`, `it.each`, and `vi` where mocks are needed.

### Refactor Constraints for Next Blocks

- Keep changes narrow and consistent with the existing helper/module boundaries.
- Preserve the NodeNext import convention in runtime code.
- Prefer adding or updating focused `.spec.ts` tests for core/CLI changes and `.test.ts(x)` tests for UI changes.
- Use the existing `pnpm` scripts for verification; start with targeted Vitest runs or type checks when possible.
- Do not install packages or start dev servers as part of the refactor loop.

## Scan Violations Block

Date: 2026-06-19

### Scan Summary

- Scope inspected: all `src/**/*.ts` and `src/**/*.tsx` files.
- Inventory:
  - 338 TypeScript/TSX source files.
  - 222 production source files.
  - 116 Vitest test files.
  - 79 total source/test files over 500 lines.
  - 61 production files over 500 lines.
- Filename scan result:
  - No production or test files under `src` violate kebab-case when allowing documented suffixes: `.helper`, `.model`, `.generated`, `.spec`, and `.test`.
  - Documented framework/tooling exceptions:
    - `src-tauri/**` uses Rust/Tauri native conventions outside this TypeScript scan.
    - `src/tauri/ui/preview/index.html` and `src/tauri/ui/preview/favicon.png` are framework/static asset names.
    - `src/shared/runtime-config.schema.json` uses the established `.schema.json` suffix.
- Helper boundary scan:
  - Active helper roots found: `src/cli/_helpers`, `src/core/_helpers`, `src/tauri/ui/_helpers`, `src/tauri/ui/chat-session/_helpers`, and `src/helpers`.
  - `src/common/_helpers` exists but is currently empty.
  - `src/helpers` is correctly used for truly shared helpers such as `normalize-optional-string.helper.ts` and `sort-entry-names.helper.ts`.

### Highest-Priority Violations

1. `src/tauri/ui/ralph/ralph-flow-editor.tsx` is 12,157 lines.
   - Violations: oversized component file, colocated business logic, UI state orchestration, flow validation, canvas layout, attachment handling, node/edge conversion, local persistence formatting, and many presentational subcomponents in one file.
   - Concrete extraction tasks:
     - Move pure Ralph editor flow utilities into `src/tauri/ui/ralph/_helpers/ralph-flow-editor-model.ts` or smaller focused helpers: flow scope normalization, flow alias generation, blank flow creation, summary upsert, local validation, route labels, utility config defaults, block preview/chip formatting.
     - Move canvas geometry/layout helpers into `src/tauri/ui/ralph/_helpers/ralph-canvas-layout.ts`: block sizes, bounds, overlap checks, reserved bounds avoidance, derived group membership, node/edge conversion.
     - Move attachment/path helpers into `src/tauri/ui/ralph/_helpers/ralph-attachments.ts`.
     - Move local node components (`RalphNoteNode`, `RalphGroupNode`, `RalphBlockNode`, `RalphRouteEdge`) into `src/tauri/ui/ralph/components/`.
     - Add focused Vitest coverage for extracted validation, alias generation, layout/bounds, attachment merging, and preview formatting helpers.

2. `src/core/ralph.ts` is 4,724 lines.
   - Violations: oversized core runtime module, mixed storage, run logging, variable/template resolution, block execution, utility execution, MCP execution, UI analyze browser logic, artifact handling, and run orchestration.
   - Concrete extraction tasks:
     - Move storage and path operations into `src/core/_helpers/ralph-storage.ts`: flow/run/revision/artifact paths, read/write/list/delete/restore operations.
     - Move template and attachment resolution into `src/core/_helpers/ralph-resolution.ts`: variable resolution, placeholder resolution, block attachments, image inputs.
     - Move utility block executors into focused helpers under `src/core/_helpers/`: HTTP/fetch/poll/wait, command execution, file read/write/search, JSON transform/validation, git status.
     - Move UI analyze support into `src/core/_helpers/ralph-ui-analyze.ts`: readiness checks, browser launch, viewport capture, heuristic evaluation, artifact directory naming.
     - Keep `runRalphFlow` as the orchestration facade after extraction.
     - Add or preserve focused `.spec.ts` files for each extracted helper before reducing the orchestration file.

3. `src/tauri/ui/runtime.ts` is 4,516 lines.
   - Violations: oversized runtime bridge with mixed constants, validators, normalizers, settings defaults, Tauri command wrappers, event handling, MCP config document editing, scheduler normalization, file drop/clipboard handling, and task/runtime commands.
   - Concrete extraction tasks:
     - Move scheduler result normalization into `src/tauri/ui/_helpers/scheduler-runtime-normalizers.ts`.
     - Move user settings defaults and normalizers into `src/tauri/ui/_helpers/user-settings-normalizers.ts`.
     - Move MCP config document helpers into `src/tauri/ui/_helpers/mcp-config-document.ts`.
     - Move dropped path and clipboard image fallback helpers into `src/tauri/ui/_helpers/desktop-input-fallbacks.ts`.
     - Add Vitest coverage for normalizers and fallback helpers; the existing `runtime.test.ts` is too broad to remain the only coverage surface.

4. `src/core/scheduler.ts` is 3,615 lines.
   - Violations: oversized module with state storage, lock handling, migrations, trigger normalization, prompt discovery/parsing, task text rendering, event filtering, run deduplication, queue/retry policy, and execution loop in one file.
   - Concrete extraction tasks:
     - Move state file locking and atomic replace into `src/core/_helpers/scheduler-state-storage.ts`.
     - Move trigger/job normalization into `src/core/_helpers/scheduler-normalization.ts`.
     - Move prompt frontmatter discovery/parsing into `src/core/_helpers/scheduler-prompt-discovery.ts`.
     - Move event filter matching and dedupe template rendering into `src/core/_helpers/scheduler-events.ts`.
     - Keep public scheduler API in `scheduler.ts` and add focused tests for extracted helpers.

5. `src/cli/_helpers/cli-args.ts` is 2,445 lines.
   - Violations: oversized CLI parser with module-specific business logic for many command families.
   - Concrete extraction tasks:
     - Split by command family into `cli-ralph-args.ts`, `cli-scheduler-args.ts`, `cli-mcp-args.ts`, `cli-config-args.ts`, and shared parse primitives.
     - Add focused parser tests for error cases and defaulting behavior per command family.

### Secondary Oversized-File Tasks

- `src/tauri/ui/chat-session/_helpers/use-chat-session-controller.ts` (2,706 lines): split controller into lifecycle, submission, attachment, voice, settings, and remote-control hooks; test reducer-like pure logic after extraction.
- `src/core/ralph-generation.ts` (2,474 lines): separate flow generation prompt assembly, interview state, JSON parsing/repair, and persistence boundaries.
- `src/tauri/ui/marketplace/mcp-marketplace.tsx` (2,382 lines): split data/model interaction from UI sections; move reusable marketplace view-model logic under `src/tauri/ui/marketplace/_helpers/`.
- `src/tauri/ui/chat-session.model.ts` (2,280 lines): split timeline/message/task/status derivation into focused model helpers; preserve model-level tests.
- Tool definition modules over 1,000 lines should be split by tool family or schema group:
  - `src/core/_helpers/utility-tool-definitions.ts`
  - `src/core/_helpers/package-tool-definitions.ts`
  - `src/core/_helpers/scheduler-tool-definitions.ts`
  - `src/core/mcp/tool-definitions.ts`
  - `src/core/_helpers/browser-tool-definitions.ts`
  - `src/core/_helpers/macro-recorder-tool-definitions.ts`
  - `src/core/_helpers/desktop-ui-tool-definitions.ts`

### Coverage Gaps

- Many production files over 500 lines have no colocated test file. Highest priority unpaired files:
  - `src/core/ralph.ts`
  - `src/tauri/ui/chat-session/_helpers/use-chat-session-controller.ts`
  - `src/core/ralph-generation.ts`
  - `src/cli/_helpers/cli-args.ts`
  - `src/tauri/ui/marketplace/mcp-marketplace.tsx`
  - `src/core/agent-runtime.ts`
  - `src/tauri/ui/chat-session/components/scheduler-panel.tsx`
  - `src/tauri/ui/chat-session/components/settings-dialog-panels/instruction-settings-panel.tsx`
  - `src/tauri/ui/chat-session/_helpers/use-remote-mission-control.ts`
  - `src/core/_helpers/desktop-ui-tool-definitions.ts`
  - `src/cli/_helpers/cli-ralph-commands.ts`
  - `src/core/ralph-watches.ts`
  - `src/tauri/ui/chat-session/components/settings-dialog-panels/mcp-settings-panel.tsx`
- Some large files do have tests, but the coverage is likely too broad or integration-heavy to support refactoring safely:
  - `src/tauri/ui/ralph/ralph-flow-editor.tsx` has `ralph-flow-editor.test.tsx`, but pure validation/layout/attachment helpers should receive focused tests after extraction.
  - `src/tauri/ui/runtime.ts` has `runtime.test.ts`, but normalizer and config-editing helpers should receive targeted tests.
  - `src/core/scheduler.ts` has `scheduler.spec.ts`, but state locking, prompt discovery, event filtering, and normalization should be covered separately.

### Duplication and Shared Helper Candidates

- `src/helpers/normalize-optional-string.helper.ts` is reused across core modules and is correctly placed as shared.
- `src/tauri/ui/chat-session/_helpers/normalize-chat-session-optional-string.helper.ts` appears module-specific and should remain under the chat-session helper boundary unless another UI module starts importing it.
- `src/tauri/ui/_helpers/normalize-remote-control-status.helper.ts` appears UI-specific and is correctly outside `src/helpers`.
- Candidate shared or module helper extractions:
  - Repeated record/type guard helpers named `isRecord` or `isRecordValue` appear in multiple large modules; consolidate only if usage remains truly generic after nearby extractions.
  - Repeated nullable field and numeric clamping helpers in `src/tauri/ui/runtime.ts` should move to UI settings/runtime helper files first, not global `src/helpers`, because their types and defaults are UI-runtime specific.
  - Path basename/parent fallback helpers in `src/tauri/ui/runtime.ts` and Ralph editor attachment logic should be compared during extraction; if behavior is identical and independent of UI types, promote to `src/helpers`, otherwise keep module-local.

### Exceptions and Non-Issues

- `src/core/runtime-contract.generated.ts` and `src/core/runtime-contract.generated.spec.ts` are generated-contract files; do not hand-refactor unless the generator changes.
- UI primitive files under `src/tauri/ui/components/ui/` can exceed 500 lines only when generated or vendor-style component code requires it; currently `sidebar.tsx` is 721 lines and should be reviewed only after application-specific business logic files are addressed.
- Large test files over 500 lines are lower priority than production modules unless they block maintainability:
  - `src/tauri/ui/chat-session.test.tsx`
  - `src/core/__test__/ralph-run.spec.ts`
  - `src/tauri/ui/ralph/ralph-flow-editor.test.tsx`
  - `src/core/execution.spec.ts`
  - Other integration-style Ralph and scheduler specs.

### Prioritized Remaining-Work Checklist

- [ ] P0: Extract and test pure helper logic from `src/tauri/ui/ralph/ralph-flow-editor.tsx` before changing UI behavior.
- [ ] P0: Split `src/core/ralph.ts` into storage, resolution, utility execution, MCP execution, UI analyze, and run orchestration helpers with focused tests.
- [ ] P0: Split `src/tauri/ui/runtime.ts` normalizers/config helpers from Tauri command wrappers and add targeted tests.
- [ ] P1: Split `src/core/scheduler.ts` into state storage, normalization, prompt discovery, event filtering, and execution orchestration helpers.
- [ ] P1: Split `src/cli/_helpers/cli-args.ts` by command family and add parser coverage for each family.
- [ ] P1: Reduce `use-chat-session-controller.ts` by moving pure state transitions and side-effect clusters into tested chat-session helpers.
- [ ] P2: Split large tool-definition modules by tool family/schema group while preserving exported tool-definition arrays and tests.
- [ ] P2: Review marketplace and chat-session model files for view-model extraction and focused coverage.
- [ ] P2: Revisit large UI components over 500 lines after business-logic extraction, prioritizing components with form/state logic over purely presentational layout.
- [ ] P3: Decide whether `src/common/_helpers` should be removed as an empty placeholder or populated by future common UI-only helpers.

### Verification Performed

- Enumerated all source files with PowerShell because `rg` is not installed in this environment.
- Counted source/test files and all files over 500 lines.
- Checked `src` TypeScript/TSX filenames against kebab-case with documented suffix exceptions.
- Compared production files to colocated `.spec.ts`, `.spec.tsx`, `.test.ts`, and `.test.tsx` files to identify likely coverage gaps.
- Inspected exported/local function structure in the largest files to ground extraction tasks.

## Apply Focused Batch Block

Date: 2026-06-19

### Batch Applied

- Focused P0 Ralph editor sub-batch: extracted local flow validation and block output derivation from `src/tauri/ui/ralph/ralph-flow-editor.tsx`.
- Created module-specific helpers under `src/tauri/ui/ralph/_helpers/`:
  - `create-flow-alias.helper.ts`
    - Normalizes flow aliases and preserves the previous 80-character kebab-case behavior.
  - `get-block-outputs.helper.ts`
    - Derives utility/block route outputs and exports visual/executable block predicates.
  - `validate-flow-locally.helper.ts`
    - Holds local editor validation, reachability, cycle checks, alias collision checks, and note/group minimum sizes.
- Added focused Vitest coverage in `validate-flow-locally.helper.spec.ts`.
- Updated `vitest.ui.config.ts` so UI `.spec.ts` files are discovered and excluded from coverage instrumentation.
- Updated `src/tauri/ui/ralph/ralph-flow-editor.tsx` to import the extracted helpers and retain the editor as the integration point.
- No files were renamed, moved, or split by filesystem operation; logic was copied into new helpers and removed from the editor.

### Tests Added or Updated

- Created `src/tauri/ui/ralph/_helpers/validate-flow-locally.helper.spec.ts`.
- Coverage includes alias normalization, block output derivation, visual/executable block predicates, valid minimal flows, scoped alias collisions, structural errors, visual route errors, prompt/decision/validator validation, annotation minimum sizes, cycle/max-transition checks, and unavailable provider/model warnings.
- Updated `vitest.ui.config.ts` to include UI `.spec.ts` tests.

### Framework Filename Exceptions

- Existing documented exceptions still apply:
  - `src-tauri/**` Rust/Tauri native files.
  - `src/tauri/ui/preview/index.html` and `src/tauri/ui/preview/favicon.png`.
  - `src/shared/runtime-config.schema.json`.
- New files follow existing kebab-case helper and `.spec.ts` conventions; no new framework-required filename exceptions were introduced.

### Verification Performed

- `pnpm vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/_helpers/validate-flow-locally.helper.spec.ts` - passed.
- `pnpm typecheck:ui` - passed.
- `pnpm lint` - passed.

### Remaining Tasks

- Continue P0 extraction from `src/tauri/ui/ralph/ralph-flow-editor.tsx`; this batch only covered local validation, alias normalization, and route-output derivation.
- Next Ralph editor candidates: flow scope/summary helpers, canvas geometry/layout helpers, attachment/path helpers, preview/chip formatting, and local node/edge components.
- Keep the other P0/P1 checklist items open: `src/core/ralph.ts`, `src/tauri/ui/runtime.ts`, `src/core/scheduler.ts`, and `src/cli/_helpers/cli-args.ts`.

## Scan Violations Block Refresh

Date: 2026-06-19

### Current Scan Summary

- Scope inspected: all current `src/**/*.ts` and `src/**/*.tsx` files.
- Inventory from this scan:
  - 344 TypeScript/TSX files under `src`.
  - 226 production source files.
  - 118 Vitest or test-support files.
  - 70 total source/test files over 500 lines.
  - 54 production files over 500 lines.
  - 16 test files over 500 lines.
- Filename scan result:
  - No new production runtime filename violations were found after allowing documented suffix conventions: `.helper`, `.model`, `.generated`, `.schema`, `.spec`, `.test`, and `.d`.
  - Current filename exceptions remain documented and accepted:
    - `src-tauri/**` follows Rust/Tauri native conventions and is outside this TypeScript filename scan.
    - `src/tauri/ui/preview/index.html` and `src/tauri/ui/preview/favicon.png` are framework/static asset names.
    - `src/shared/runtime-config.schema.json` uses the established schema suffix.
    - `src/core/runtime-contract.generated.ts` and `src/core/runtime-contract.generated.spec.ts` are generated-contract files.
- Helper boundary scan:
  - Active module helper roots: `src/cli/_helpers`, `src/core/_helpers`, `src/tauri/ui/_helpers`, `src/tauri/ui/chat-session/_helpers`, and `src/tauri/ui/ralph/_helpers`.
  - Active shared helper root: `src/helpers`.
  - `src/common/_helpers` is still empty and should either be removed later or reserved only for common UI-specific helpers.

### P0 Refactoring Tasks

1. Continue reducing `src/tauri/ui/ralph/ralph-flow-editor.tsx` (10,713 lines).
   - Status: improved by the focused batch, but still the largest violation by a wide margin.
   - Remaining violations: component rendering, flow editor view model logic, canvas geometry, local persistence formatting, block chip/preview formatting, and node/edge component definitions still live in one file.
   - Next concrete tasks:
     - Extract flow summary/scope/default helpers to `src/tauri/ui/ralph/_helpers/`.
     - Extract canvas layout and bounds helpers to `src/tauri/ui/ralph/_helpers/ralph-canvas-layout.helper.ts`.
     - Continue shrinking attachment/path call sites now that `src/tauri/ui/ralph/_helpers/ralph-attachments.helper.ts` exists.
     - Move local React Flow node and edge components into `src/tauri/ui/ralph/components/`.
     - Add focused UI Vitest specs for each extracted pure helper.

2. Split `src/core/ralph.ts` (4,217 lines).
   - Violations: storage, path creation, revision/run persistence, placeholder/variable resolution, utility execution, MCP execution, UI analysis, artifact handling, and orchestration remain coupled.
   - Next concrete tasks:
     - Extract storage and path operations to `src/core/_helpers/ralph-storage.helper.ts`.
     - Extract placeholder, variable, and attachment resolution to `src/core/_helpers/ralph-resolution.helper.ts`.
     - Extract utility block execution families to smaller `src/core/_helpers/ralph-*-executor.helper.ts` modules.
     - Extract UI analyze/browser artifact logic to `src/core/_helpers/ralph-ui-analyze.helper.ts`.
     - Keep `runRalphFlow` as the orchestration facade and cover extracted helpers with `.spec.ts` files.

3. Split `src/tauri/ui/runtime.ts` (3,964 lines).
   - Violations: Tauri command wrappers, scheduler result normalization, settings defaults, MCP config editing, file-drop handling, clipboard fallback handling, and runtime event mapping remain mixed.
   - Next concrete tasks:
     - Move scheduler/runtime normalizers to `src/tauri/ui/_helpers/scheduler-runtime-normalizers.helper.ts`.
     - Move settings defaults and user-setting normalizers to `src/tauri/ui/_helpers/user-settings-normalizers.helper.ts`.
     - Move MCP config document editing helpers to `src/tauri/ui/_helpers/mcp-config-document.helper.ts`.
     - Move file drop and clipboard fallback helpers to `src/tauri/ui/_helpers/desktop-input-fallbacks.helper.ts`.
     - Add targeted `.spec.ts` coverage because `runtime.test.ts` is broad and too integration-shaped for safe extraction.

4. Split `src/core/scheduler.ts` (3,113 lines).
   - Violations: state file locking, migration/defaulting, trigger normalization, prompt discovery, event filtering, dedupe, retry policy, and execution loop are still in one module.
   - Next concrete tasks:
     - Extract state persistence/locking to `src/core/_helpers/scheduler-state-storage.helper.ts`.
     - Extract trigger/job normalization to `src/core/_helpers/scheduler-normalization.helper.ts`.
     - Extract prompt discovery/frontmatter parsing to `src/core/_helpers/scheduler-prompt-discovery.helper.ts`.
     - Extract event matching and dedupe rendering to `src/core/_helpers/scheduler-events.helper.ts`.

### P1 Refactoring Tasks

- Split `src/tauri/ui/chat-session/_helpers/use-chat-session-controller.ts` (2,457 lines) into lifecycle, submission, attachment, voice, settings, and remote-control hooks/helpers; prioritize pure state transitions for tests.
- Split `src/core/ralph-generation.ts` (2,274 lines) into prompt assembly, interview state, JSON parsing/repair, validation handoff, and persistence helpers.
- Split `src/cli/_helpers/cli-args.ts` (2,247 lines) by command family: Ralph, scheduler, MCP, config, and shared parse primitives.
- Split `src/tauri/ui/marketplace/mcp-marketplace.tsx` (2,198 lines) by moving marketplace view-model/data shaping logic under `src/tauri/ui/marketplace/_helpers/`.
- Split `src/tauri/ui/chat-session.model.ts` (1,949 lines) into message/timeline/task/status derivation helpers while preserving existing model tests.
- Review `src/core/mcp/client.ts` (1,820 lines), `src/core/mcp/tool-definitions.ts` (1,758 lines), and `src/core/mcp/marketplace.ts` (1,393 lines) for MCP client/config/marketplace boundary extraction.
- Split `src/tauri/ui/chat-session/_helpers/use-chat-session-runtime.ts` (1,914 lines) into command bridge, stream/event handling, session persistence, and shell/runtime adapters.
- Split `src/core/agent-runtime.ts` (1,647 lines) into prompt assembly, provider dispatch, tool-call loop, autopilot handling, and final-response shaping helpers.

### P2 Refactoring Tasks

- Split large tool definition modules by tool family or schema group while preserving exported arrays and public tool names:
  - `src/core/_helpers/utility-tool-definitions.ts` (1,989 lines)
  - `src/core/_helpers/package-tool-definitions.ts` (1,886 lines)
  - `src/core/_helpers/scheduler-tool-definitions.ts` (1,748 lines)
  - `src/core/_helpers/browser-tool-definitions.ts` (1,707 lines)
  - `src/core/_helpers/desktop-ui-tool-definitions.ts` (1,240 lines)
  - `src/core/_helpers/macro-recorder-tool-definitions.ts` (1,190 lines)
  - `src/core/_helpers/shell-network-tool-definitions.ts` (828 lines)
  - `src/core/_helpers/git-tool-definitions.ts` (663 lines)
  - `src/core/_helpers/filesystem-tool-definitions.ts` (613 lines)
- Reduce large UI panels after business logic is extracted:
  - `src/tauri/ui/chat-session/components/scheduler-panel.tsx` (1,597 lines)
  - `src/tauri/ui/chat-session/components/settings-dialog-panels/instruction-settings-panel.tsx` (1,273 lines)
  - `src/tauri/ui/chat-session/components/settings-dialog-panels/mcp-settings-panel.tsx` (925 lines)
  - `src/tauri/ui/chat-session/components/smart-context-packs.tsx` (833 lines)
  - `src/tauri/ui/ralph/ralph-app.tsx` (819 lines)
  - `src/tauri/ui/lib/shell-store.ts` (719 lines)
  - `src/tauri/ui/components/ui/sidebar.tsx` (667 lines)
  - `src/tauri/ui/chat-session/components/onboarding-wizard.tsx` (644 lines)
  - `src/tauri/ui/task-thinking-panel.tsx` (586 lines)
  - `src/tauri/ui/chat-session/components/sessions-sidebar.tsx` (515 lines)

### Coverage Gaps and Weak Coverage

- Highest-priority production files over 500 lines without an obvious colocated test file:
  - `src/core/ralph.ts`
  - `src/tauri/ui/chat-session/_helpers/use-chat-session-controller.ts`
  - `src/core/ralph-generation.ts`
  - `src/cli/_helpers/cli-args.ts`
  - `src/tauri/ui/marketplace/mcp-marketplace.tsx`
  - `src/core/mcp/tool-definitions.ts`
  - `src/core/agent-runtime.ts`
  - `src/tauri/ui/chat-session/components/scheduler-panel.tsx`
  - `src/tauri/ui/chat-session/components/settings-dialog-panels/instruction-settings-panel.tsx`
  - `src/core/_helpers/desktop-ui-tool-definitions.ts`
  - `src/core/ralph-watches.ts`
  - `src/core/provider-model-registry.ts`
  - `src/cli/_helpers/cli-summary-commands.ts`
  - `src/tauri/ui/lib/shell-store.ts`
- Large files with existing broad tests still need focused helper coverage before extraction:
  - `src/tauri/ui/ralph/ralph-flow-editor.tsx` has editor tests plus new local-validation helper specs, but still needs layout, attachment, summary, and formatting helper specs.
  - `src/tauri/ui/runtime.ts` has `runtime.test.ts`, but extracted normalizers and desktop fallbacks should receive dedicated specs.
  - `src/core/scheduler.ts` has `scheduler.spec.ts`, but state locking, prompt discovery, event filtering, and normalization need separate helper specs.
  - `src/core/mcp/client.ts` has `client.spec.ts`, but smaller protocol/config helpers would make the test surface less brittle.
  - `src/core/ralph-generation.ts` has broad `src/core/__test__/ralph-generation.spec.ts`; extraction should add colocated parser/prompt/helper specs.
  - `src/core/ralph-watches.ts` has `src/core/__test__/ralph-watches.spec.ts`; watch parsing and state transitions still deserve focused helper coverage after extraction.

### Duplication and Helper Placement Notes

- Keep `normalizeOptionalString` in `src/helpers/normalize-optional-string.helper.ts`; it is genuinely shared across core modules.
- Keep `normalize-chat-session-optional-string.helper.ts` under `src/tauri/ui/chat-session/_helpers` unless another UI module begins importing it.
- Keep `normalize-remote-control-status.helper.ts` under `src/tauri/ui/_helpers`; it is UI-runtime specific, not global.
- Repeated `isRecord`/`isRecordValue` guards exist in large core modules such as Ralph generation, Ralph watches, Ralph runtime, and scheduler. Consolidate only when extraction reveals identical semantics; avoid creating a vague global helper too early.
- Path basename/dirname fallback logic appears in several core/UI areas. Promote to `src/helpers` only if the extracted helper is runtime-agnostic and has no Tauri, UI, or Ralph-specific types.
- Numeric clamp/defaulting helpers should initially stay near their module domain because web search, UI settings, and scheduler defaults have different business rules.
- Short names found during the scan are accepted local/framework conventions:
  - `cn` in `src/tauri/ui/lib/utils.ts` is the common Tailwind class merge helper.
  - `App` in `src/tauri/ui/preview/app.tsx` is the preview React component name.
- `src/common/_helpers` exists but is empty. Leave it unused until there is common UI-specific helper logic; shared runtime-agnostic helpers should continue going to `src/helpers`.

### Remaining-Work Checklist

- [ ] P0: Continue extracting pure helpers from `ralph-flow-editor.tsx`, starting with canvas layout, flow summary/scope/default helpers, and remaining preview formatting logic.
- [ ] P0: Split `core/ralph.ts` into storage, resolution, execution, UI analysis, and orchestration helpers.
- [ ] P0: Split `tauri/ui/runtime.ts` into runtime bridge wrappers plus tested normalizer/config/fallback helpers.
- [ ] P0: Split `core/scheduler.ts` into state storage, normalization, prompt discovery, event filtering, and orchestration helpers.
- [ ] P1: Split `cli/_helpers/cli-args.ts` by command family with parser coverage.
- [ ] P1: Split chat-session controller/runtime hooks into smaller hooks and pure state helpers.
- [ ] P1: Split Ralph generation into prompt/interview/parse/persistence helpers.
- [ ] P1: Split MCP client/config/marketplace modules into protocol, config, cache, and marketplace helper boundaries.
- [ ] P1: Split agent runtime into provider-loop, prompt, tool execution, autopilot, and final-response helpers.
- [ ] P2: Split tool-definition modules by family/schema group.
- [ ] P2: Reduce large UI panels after extracting business logic and view-model helpers.
- [ ] P3: Decide whether to remove or reserve the empty `src/common/_helpers` directory.

### Verification Performed

- Re-read the active TypeScript development skill and applied it to this scan.
- Enumerated current `src/**/*.ts` and `src/**/*.tsx` files with PowerShell.
- Counted production files, test files, and files over 500 lines.
- Checked current filenames against kebab-case plus documented suffix/framework exceptions.
- Enumerated helper roots and confirmed the newly added Ralph helper boundary exists.
- Inspected current line-count rankings and repeated-helper candidates.
- Checked `git status --short` to avoid treating existing uncommitted refactor changes as unrelated cleanup.
- No dev servers were started or restarted.

## Apply Focused Batch Block

Date: 2026-06-19

### Batch Applied

- Focused P0 Ralph editor sub-batch: extracted flow scope/default handling, flow summary selection/upsert logic, scoped alias collision handling, and blank flow creation from `src/tauri/ui/ralph/ralph-flow-editor.tsx`.
- Created module-specific helpers under `src/tauri/ui/ralph/_helpers/`:
  - `normalize-ralph-flow-scope.helper.ts`
    - Holds Ralph flow scope constants, labels, library modes, scope normalization, default creation scope, and library visibility checks.
  - `upsert-flow-summary.helper.ts`
    - Holds summary scope fallback, selection key helpers, sorting, summary conversion, upsert behavior, alias-use checks, and unique alias creation.
  - `create-blank-ralph-flow.helper.ts`
    - Holds blank start-to-end flow creation and flow alias fallback labeling.
- Updated `src/tauri/ui/ralph/ralph-flow-editor.tsx` to import those helpers and preserve the exported `RalphFlowLibraryMode` type from the editor module.
- No public editor props or runtime APIs were intentionally changed.

### Tests Added or Updated

- Created `src/tauri/ui/ralph/_helpers/ralph-flow-summaries.helper.spec.ts`.
- Coverage includes scope constants and normalization, default creation scope, library visibility, summary scope fallback, selection keys, scoped summary upsert, sorting, flow-to-summary counts, scoped alias collision checks, unique alias suffixing, blank flow defaults, empty alias fallback, and flow alias label fallback.

### Verification Performed

- `pnpm vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/_helpers/ralph-flow-summaries.helper.spec.ts`
  - Passed: 1 file, 18 tests.
- `pnpm typecheck:ui`
  - Passed.
- No dev servers were started or restarted.

### Remaining Ralph Editor Work

- `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains oversized and still needs future batches for remaining preview formatting helpers and local node/edge component extraction.
- The worktree had pre-existing modified and untracked files before this batch; this batch did not revert or normalize unrelated changes.

## Inspect Repository - 2026-06-19

### Scope

- Block: `inspect-repository` for the Ralph autonomous refactoring loop.
- Goal: read current repository state for all relevant refactor constraints before the next code changes.
- Constraint confirmed: do not start or restart backend/frontend/dev servers; use existing health checks or targeted tests only when verification is needed.

### Workspace Instructions

- `.machdoch/instructions.md` requires smallest safe steps, read-only inspection before edits/commands, maintaining a short checklist for multi-step work, and verifying outcomes before declaring completion.
- `.machdoch/instructions/security.instructions.md` applies globally and says to avoid printing secrets, prefer read-only checks before package installation/system changes, and treat package installation as risky.
- Repository-level `AGENTS.md` discovery with broad recursive PowerShell timed out in generated/dependency-heavy folders; bounded checks of the repository root and key source/script directories did not surface additional `AGENTS.md` files.

### Package and Scripts

- Package manager: `pnpm@11.6.0` from `package.json` and `pnpm-lock.yaml`; workspace file `pnpm-workspace.yaml` exists with `allowBuilds` entries for `@google/genai`, `esbuild`, and `protobufjs`.
- Runtime target: Node `>=20.10`, ESM package (`"type": "module"`), CLI binary `machdoch` points at `./dist/cli/main.js`.
- Build scripts:
  - `pnpm build` -> `tsc -p tsconfig.json`.
  - `pnpm build:cli-bundle` -> `node scripts/build-cli-bundle.mjs`.
  - `pnpm build:ui` -> `vite build --config vite.ui.config.ts`.
  - `pnpm generate:runtime-contract` -> `node scripts/generate-runtime-contract.mjs`.
- Verification scripts:
  - `pnpm lint` -> `eslint src vite.ui.config.ts vitest.config.ts vitest.ui.config.ts`.
  - `pnpm typecheck` -> `tsc --noEmit -p tsconfig.json`.
  - `pnpm typecheck:ui` -> `tsc -p tsconfig.ui.json --noEmit`.
  - `pnpm test` -> `vitest run`.
  - `pnpm test:ui` -> `vitest run --config vitest.ui.config.ts`.
  - `pnpm coverage` -> `vitest run --coverage`.
- Dev/server scripts exist but must not be used for this flow unless future repository instructions explicitly allow it: `dev`, `dev:ui`, `preview:ui`, `tauri:dev`, `start`.

### TypeScript, Lint, and Build Conventions

- Main `tsconfig.json` uses strict TypeScript with `NodeNext`, `ES2022`, declarations, source maps, incremental builds under `.cache`, and excludes UI files plus specs/tests from the CLI/core build.
- Strictness flags include `noImplicitOverride`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.
- `tsconfig.spec.json` is for non-UI specs, includes `src/**/*.spec.ts`, adds `vitest/globals`, and excludes UI tests.
- `tsconfig.ui.json` uses `ESNext`/`Bundler`, `react-jsx`, DOM libs, `@/* -> ./src/*`, and includes `src/core/types.ts` plus `src/tauri/ui/**/*.ts(x)`.
- ESLint applies `@eslint/js` plus `typescript-eslint` recommended configs to `src/**/*.{ts,tsx}` and root `*.ts`; `@typescript-eslint/no-explicit-any` is an error.

### Vitest Usage

- `vitest.config.ts` runs Node-environment tests with globals, includes `src/**/*.spec.ts`, restores mocks, unstubs envs, and collects V8 coverage for `src/core/**/*.ts` excluding `__test__` and specs.
- `vitest.ui.config.ts` runs jsdom UI tests with globals, includes `src/tauri/ui/**/*.spec.ts`, disables file parallelism, allows no tests, restores mocks, and aliases Tauri APIs/plugins to `src/tauri/ui/test/tauri-test-mocks.ts`.
- UI coverage includes `src/tauri/ui/**/*.ts(x)` and excludes `.test`/`.spec` files.
- Test naming is mixed but established: core/CLI mostly `.spec.ts`; UI uses both `.spec.ts`, `.test.ts`, and `.test.tsx` depending on area.

### Source Layout and Naming

- Top-level source roots: `src/cli`, `src/common`, `src/core`, `src/helpers`, `src/shared`, and `src/tauri`.
- Current file count from read-only scan: 274 `.ts` files and 76 `.tsx` files under `src`.
- Helper directories follow underscore naming and colocated ownership:
  - `src/cli/_helpers`
  - `src/common/_components`
  - `src/common/_helpers`
  - `src/core/_helpers`
  - `src/core/_helpers/provider-adapters`
  - `src/tauri/ui/_helpers`
  - `src/tauri/ui/chat-session/_helpers`
  - `src/tauri/ui/ralph/_helpers`
- Shared general helpers live in `src/helpers` and use `.helper.ts` naming, for example `normalize-optional-string.helper.ts` and `sort-entry-names.helper.ts`.
- Ralph helper extraction is already underway under `src/tauri/ui/ralph/_helpers` with names such as `ralph-attachments.helper.ts`, `ralph-canvas-layout.helper.ts`, `get-ralph-node-preview.helper.ts`, and `validate-flow-locally.helper.ts`.

### Refactor-Relevant Hotspots Observed

- `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains very large and already has broad `ralph-flow-editor.test.tsx` plus focused helper specs.
- `src/tauri/ui/runtime.ts` is large and has `runtime.test.ts`; future extraction should keep Tauri command wrappers separated from pure normalizers/config helpers.
- `src/core/ralph.ts`, `src/core/ralph-generation.ts`, and `src/core/scheduler.ts` remain large core modules with existing Ralph/scheduler spec coverage nearby.
- CLI command parsing and Ralph command logic are concentrated in `src/cli/_helpers/cli-args.ts` and `src/cli/_helpers/cli-ralph-commands.ts`.
- Existing dirty worktree before this note included modifications in CLI helpers, Ralph UI editor, runtime files, `vitest.ui.config.ts`, and an untracked `src/tauri/ui/ralph/_helpers/` directory. Do not overwrite or revert unrelated work.

### Verification Performed

- Read `package.json`, `pnpm-workspace.yaml`, TypeScript configs, ESLint config, Vite UI config, and both Vitest configs.
- Read active Machdoch workspace/security instructions.
- Enumerated source roots, helper roots, script files, and current test file layout with PowerShell.
- Checked `git status --short` before editing to preserve existing dirty worktree state.
- Appended this repository inspection note to `ralph-progress.md`.
- No dev servers were started or restarted.

## Inspect Repository Block

Date: 2026-06-19

### Workspace Instructions

- No `AGENTS.md` files were found under the workspace.
- Active workspace instructions are `.machdoch/instructions.md` plus `.machdoch/instructions/security.instructions.md`.
- Operational constraints for this refactor loop:
  - Prefer read-only inspection before edits.
  - Keep a short checklist for multi-step work and update it as progress is made.
  - Do not start or restart backend/frontend/dev servers.
  - Prefer read-only checks before package installation or system changes.
  - Avoid printing secrets to logs or terminal output.

### Package and Scripts

- Package manager: `pnpm@11.6.0`.
- Runtime/package shape: private ESM TypeScript package named `machdoch`, Node engine `>=20.10`, CLI bin points to `./dist/cli/main.js`.
- Useful scripts discovered in `package.json`:
  - `pnpm build` -> `tsc -p tsconfig.json`
  - `pnpm build:cli-bundle` -> `node scripts/build-cli-bundle.mjs`
  - `pnpm build:ui` -> `vite build --config vite.ui.config.ts`
  - `pnpm generate:runtime-contract` -> `node scripts/generate-runtime-contract.mjs`
  - `pnpm lint` -> `eslint src vite.ui.config.ts vitest.config.ts vitest.ui.config.ts`
  - `pnpm typecheck` -> `tsc --noEmit -p tsconfig.json`
  - `pnpm typecheck:ui` -> `tsc -p tsconfig.ui.json --noEmit`
  - `pnpm test` -> `vitest run`
  - `pnpm test:ui` -> `vitest run --config vitest.ui.config.ts`
  - `pnpm coverage` -> `vitest run --coverage`
- Server-starting scripts exist but must not be used for this block: `dev`, `dev:ui`, `preview:ui`, `start`, `tauri:dev`.
- Utility scripts in `scripts/`: `build-cli-bundle.mjs`, `bump-version.mjs`, `generate-runtime-contract.mjs`.

### TypeScript and Lint Conventions

- Main TS config uses `module`/`moduleResolution` `NodeNext`, target `ES2022`, strict mode, `noImplicitOverride`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.
- Main build includes `src/**/*.ts` and excludes tests, `__test__`, and Tauri UI files.
- UI TS config uses `module` `ESNext`, `moduleResolution` `Bundler`, `jsx` `react-jsx`, DOM libs, and `@/*` path alias to `src/*`.
- Spec TS config adds `vitest/globals` and includes `src/**/*.spec.ts` except UI specs/tests.
- ESLint applies TypeScript recommended rules to `src/**/*.{ts,tsx}` and root `*.ts`; `@typescript-eslint/no-explicit-any` is an error.
- ESLint ignores `coverage/**`, `dist/**`, `node_modules/**`, and `src-tauri/target/**`.

### Source Layout

- Top-level `src` areas:
  - `src/cli`: CLI entry and command parsing/execution helpers.
  - `src/core`: core runtime, Ralph, scheduler, MCP, provider, execution, and task logic.
  - `src/helpers`: small cross-cutting pure helpers with colocated specs.
  - `src/common`: shared UI-ish pieces such as `_components`.
  - `src/tauri/ui`: React/Tauri desktop UI, preview app, UI models, components, Ralph UI, marketplace UI, and Tauri test mocks.
  - `src/shared`: shared generated/static schemas, including `runtime-config.schema.json`.
- Native Tauri/Rust code is under `src-tauri`; do not apply frontend/Node naming assumptions there without inspecting native conventions.
- UI preview root is `src/tauri/ui/preview`; Vite aliases `@` to `src` and dedupes React/React DOM.

### Naming and Helper Conventions

- File names are generally kebab-case.
- Helper modules commonly use `.helper.ts` and have colocated `.helper.spec.ts`.
- Module-local helper folders are named `_helpers`; component folders may use `_components`.
- Ralph/core integration-style tests also use `src/core/__test__` with shared `ralph-test-helpers.ts`.
- Existing shared helper examples: `normalize-optional-string.helper.ts`, `sort-entry-names.helper.ts`.
- Existing UI/Tauri mocks live in `src/tauri/ui/test/tauri-test-mocks.ts` and are wired through Vitest UI aliases.
- Keep generated files such as `src/core/runtime-contract.generated.ts` tied to their generator instead of hand-editing generated output.

### Vitest Usage

- Main Vitest config (`vitest.config.ts`):
  - Node environment.
  - Globals enabled.
  - Includes `src/**/*.spec.ts`.
  - `restoreMocks` and `unstubEnvs` enabled.
  - Coverage uses V8, reports text/html, includes `src/core/**/*.ts`, excludes `src/**/__test__/**/*.ts` and `src/**/*.spec.ts`.
- UI Vitest config (`vitest.ui.config.ts`):
  - jsdom environment.
  - Globals enabled.
  - Includes `src/tauri/ui/**/*.spec.ts`.
  - `fileParallelism: false`, `passWithNoTests: true`, `restoreMocks: true`.
  - Aliases Tauri APIs/plugins to `src/tauri/ui/test/tauri-test-mocks.ts`.
  - Coverage uses V8 text reporter, includes `src/tauri/ui/**/*.ts` and `src/tauri/ui/**/*.tsx`, excludes UI `.test` and `.spec` files.
- Existing UI tests also include many `.test.ts` and `.test.tsx` files. Because the current UI config includes only `src/tauri/ui/**/*.spec.ts`, run targeted UI tests carefully and verify config inclusion before assuming `.test.*` files are covered by `pnpm test:ui`.

### Refactor Impact Notes

- Prefer focused extraction into nearby `_helpers` first, especially for Ralph editor, UI runtime, scheduler, CLI command parsing, and tool-definition modules already identified as large.
- Preserve public exports and script behavior; add focused specs next to extracted helpers.
- Use `pnpm typecheck`, `pnpm typecheck:ui`, `pnpm lint`, `pnpm test`, or targeted `pnpm vitest run ...` checks as appropriate; do not use server-starting scripts for verification.
- `rg` is not installed in this environment; repository inspection used PowerShell `Get-ChildItem` and `Select-String` instead.

### Current Worktree Observation

- Before this inspection note was appended, `git status --short` showed existing changes in `src/tauri/ui/ralph/ralph-flow-editor.tsx`, `vitest.ui.config.ts`, untracked `src/tauri/ui/ralph/_helpers/`, and untracked `ralph-progress.md`.
- These existing changes were not reverted or modified except for appending this inspection section to `ralph-progress.md`.

### Verification Performed

- Read `.machdoch/instructions.md` and `.machdoch/instructions/security.instructions.md`.
- Confirmed no workspace `AGENTS.md` files were present.
- Inspected `package.json`, `tsconfig.json`, `tsconfig.spec.json`, `tsconfig.ui.json`, `eslint.config.mjs`, `vite.ui.config.ts`, `vitest.config.ts`, and `vitest.ui.config.ts`.
- Enumerated source directories, helper/test directories, test files, and `scripts/` contents with PowerShell.
- No dev servers were started or restarted.

## Apply Focused Batch Block

Date: 2026-06-19

### Batch Applied

- Focused P0 Ralph editor sub-batch: extracted attachment and path preview helpers from `src/tauri/ui/ralph/ralph-flow-editor.tsx`.
- Created module-specific helper file:
  - `src/tauri/ui/ralph/_helpers/ralph-attachments.helper.ts`
    - Derives display names and parent paths for path attachments.
    - Normalizes Ralph attachment kinds, including image kind detection from supported image extensions.
    - Creates path attachment references from dropped paths.
    - Maps Ralph path attachments to chat attachment previews.
    - Builds variable attachment list items with stable fallback keys.
    - Merges path/variable attachments while preserving source-specific deduplication by normalized value.
- Updated `src/tauri/ui/ralph/ralph-flow-editor.tsx` to import the extracted helpers and retain UI orchestration only at the call sites.
- No public APIs were intentionally changed. The helper preserves the previous editor behavior, including UUID generation, fallback preview IDs, source-index fallback keys for variable attachments, and source-aware attachment deduplication.
- New files follow the existing kebab-case helper and `.spec.ts` conventions.

### Tests Added or Updated

- Created `src/tauri/ui/ralph/_helpers/ralph-attachments.helper.spec.ts`.
- Coverage includes:
  - Unix and Windows path name/parent derivation.
  - Empty path behavior.
  - Explicit, inferred image, `other`, unknown, and undefined attachment kind normalization.
  - Path attachment creation with generated IDs and image media types.
  - Path preview mapping with undefined attachment lists and variable attachment filtering.
  - Variable attachment item fallback keys.
  - Attachment merge deduplication across trimmed/case-normalized values while keeping different sources distinct.

### Verification Performed

- `pnpm vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/_helpers/ralph-attachments.helper.spec.ts` - passed.
- `pnpm vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/_helpers/ralph-attachments.helper.spec.ts src/tauri/ui/ralph/_helpers/validate-flow-locally.helper.spec.ts` - passed.
- `pnpm typecheck:ui` - passed.
- `pnpm lint` - passed.
- No dev servers were started or restarted.

### Remaining Tasks

- Continue P0 extraction from `src/tauri/ui/ralph/ralph-flow-editor.tsx`; this batch only covered attachment/path helpers.
- Next Ralph editor candidates remain canvas layout/bounds helpers, flow summary/scope helpers, preview/chip formatting, and local node/edge components.

## Update Progress Block

Date: 2026-06-19

### Current Validated Batch

- Validation passed for the focused Ralph editor attachment/path extraction batch.
- Changed `src/tauri/ui/ralph/ralph-flow-editor.tsx` to import attachment/path helpers instead of keeping that pure logic inline.
- Created `src/tauri/ui/ralph/_helpers/ralph-attachments.helper.ts` for path display/parent derivation, Ralph attachment kind normalization, path attachment creation, chat preview mapping, variable attachment item mapping, and attachment merge/deduplication.
- No files were renamed or moved. The batch split logic out of `ralph-flow-editor.tsx` by creating the new helper file.
- No dev servers were started or restarted.

### Tests Added or Updated

- Created `src/tauri/ui/ralph/_helpers/ralph-attachments.helper.spec.ts`.
- Tests cover Unix/Windows path parsing, empty paths, explicit and inferred attachment kinds, generated path attachment references, path preview mapping, variable attachment fallback keys, and source-aware attachment merge deduplication.
- Existing Ralph local-validation helper tests remained part of the focused verification batch.

### Validation Commands

- `pnpm vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/_helpers/ralph-attachments.helper.spec.ts` - passed.
- `pnpm vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/_helpers/ralph-attachments.helper.spec.ts src/tauri/ui/ralph/_helpers/validate-flow-locally.helper.spec.ts` - passed.
- `pnpm typecheck:ui` - passed.
- `pnpm lint` - passed.

### Filename Exceptions

- No new filename exceptions were introduced.
- Existing documented exceptions remain accepted:
  - `src-tauri/**` follows Rust/Tauri native conventions.
  - `src/tauri/ui/preview/index.html` and `src/tauri/ui/preview/favicon.png` are framework/static asset names.
  - `src/shared/runtime-config.schema.json` uses the established schema suffix.
  - `src/core/runtime-contract.generated.ts` and `src/core/runtime-contract.generated.spec.ts` are generated-contract files.

### Remaining Tasks

- Continue P0 extraction from `src/tauri/ui/ralph/ralph-flow-editor.tsx`; next best candidates are canvas layout/bounds helpers, flow summary/scope helpers, preview/chip formatting helpers, and local React Flow node/edge components.
- Keep adding focused UI Vitest specs for each extracted pure helper before reducing more editor orchestration.
- Larger P0 work remains for `src/core/ralph.ts`, `src/tauri/ui/runtime.ts`, and `src/core/scheduler.ts`.

## Inspect Repository Block - Current State

Date: 2026-06-19

### Workspace State

- Working tree was already dirty before this inspect update:
  - `src/tauri/ui/ralph/ralph-flow-editor.tsx`
  - `vitest.ui.config.ts`
  - `ralph-progress.md`
  - `src/tauri/ui/ralph/_helpers/`
- No `AGENTS.md` files were found outside ignored/generated dependency output.
- Active repository instructions:
  - `.machdoch/instructions.md`: prefer read-only inspection before edits, keep a short plan, verify outcomes, continue until complete or blocked.
  - `.machdoch/instructions/security.instructions.md`: avoid printing secrets, prefer read-only checks before package/system changes, treat installs as risky.
- Do not start or restart servers. Existing server/frontend scripts are considered off-limits for this inspect block unless a later explicit instruction allows them.

### Package Scripts

- Package is private ESM `machdoch@0.17.0`; CLI bin maps `machdoch` to `./dist/cli/main.js`.
- Package manager is `pnpm@11.6.0`; Node engine is `>=20.10`.
- Safe verification/build scripts:
  - `pnpm build`: `tsc -p tsconfig.json`
  - `pnpm build:ui`: `vite build --config vite.ui.config.ts`
  - `pnpm lint`: `eslint src vite.ui.config.ts vitest.config.ts vitest.ui.config.ts`
  - `pnpm typecheck`: `tsc --noEmit -p tsconfig.json`
  - `pnpm typecheck:ui`: `tsc -p tsconfig.ui.json --noEmit`
  - `pnpm test`: `vitest run`
  - `pnpm test:ui`: `vitest run --config vitest.ui.config.ts`
  - `pnpm coverage`: `vitest run --coverage`
- Generation/release scripts:
  - `pnpm generate:runtime-contract`: `node scripts/generate-runtime-contract.mjs`
  - `pnpm build:cli-bundle`: `node scripts/build-cli-bundle.mjs`
  - `pnpm version:bump`: `node scripts/bump-version.mjs`
- Server or app startup scripts to avoid during this flow:
  - `pnpm dev`, `pnpm dev:ui`, `pnpm preview:ui`, `pnpm start`, `pnpm tauri:dev`.

### Source Layout

- Top-level source areas under `src/`:
  - `cli`: CLI entrypoints and CLI helper tests.
  - `common`: shared common code.
  - `core`: Node-side domain/runtime logic, Ralph flow/runtime/scheduler logic, and core specs.
  - `helpers`: small shared helper modules with `.helper.ts` naming.
  - `shared`: shared schemas/config artifacts.
  - `tauri`: desktop UI and Tauri integration.
- Ralph UI area:
  - `src/tauri/ui/ralph/ralph-flow-editor.tsx` is the large active refactor target.
  - `src/tauri/ui/ralph/ralph-flow-editor.test.tsx` holds broad editor interaction coverage.
  - `src/tauri/ui/ralph/_helpers/` is the established extraction point for Ralph UI pure helpers.
- Existing Ralph UI helper files:
  - `create-flow-alias.helper.ts`
  - `get-block-outputs.helper.ts`
  - `ralph-attachments.helper.ts`
  - `validate-flow-locally.helper.ts`
- Existing Tauri UI test infrastructure:
  - `src/tauri/ui/test/tauri-test-mocks.ts` provides Vitest-backed Tauri API mocks used through UI Vitest aliases.

### Naming and Module Conventions

- File names are kebab-case.
- Focused pure helpers commonly use `.helper.ts` with matching `.helper.spec.ts`.
- Tests are colocated beside the module or helper under test.
- Core helper imports generally include `.js` extensions for NodeNext output compatibility.
- UI/Bundler modules commonly omit file extensions for local relative imports.
- Existing helper directories use `_helpers`; existing test utility directories use `test` or `__test__` depending on area.
- Avoid `any`; ESLint enforces `@typescript-eslint/no-explicit-any`.

### TypeScript and Lint Configuration

- Main `tsconfig.json`:
  - `target: ES2022`
  - `module: NodeNext`
  - `moduleResolution: NodeNext`
  - `strict: true`
  - `noImplicitOverride: true`
  - `noUncheckedIndexedAccess: true`
  - `exactOptionalPropertyTypes: true`
  - emits declarations and source maps to `dist`.
  - excludes tests and `src/tauri/ui/**/*`.
- `tsconfig.ui.json`:
  - extends the main config.
  - uses `module: ESNext`, `moduleResolution: Bundler`, `jsx: react-jsx`.
  - includes DOM libs and `vitest/globals`.
  - defines `@/*` as `./src/*`.
- `tsconfig.spec.json`:
  - includes `src/**/*.spec.ts`.
  - excludes Tauri UI tests.
  - enables `vitest/globals`.
- ESLint flat config:
  - covers `src/**/*.{ts,tsx}` and root `*.ts`.
  - ignores `coverage/**`, `dist/**`, `node_modules/**`, `src-tauri/target/**`.
  - gives Vitest globals to `src/**/*.spec.ts`, `src/**/*.test.{ts,tsx}`, and `vitest*.ts`.

### Vitest Usage

- Main `vitest.config.ts`:
  - `environment: "node"`
  - `globals: true`
  - includes `src/**/*.spec.ts`
  - `restoreMocks: true`
  - `unstubEnvs: true`
  - V8 coverage, including `src/core/**/*.ts` and excluding specs plus `src/**/__test__/**/*.ts`.
- UI `vitest.ui.config.ts`:
  - `environment: "jsdom"`
  - `globals: true`
  - includes `src/tauri/ui/**/*.spec.ts`
  - `fileParallelism: false`
  - `passWithNoTests: true`
  - `restoreMocks: true`
  - aliases Tauri modules to `src/tauri/ui/test/tauri-test-mocks.ts`
  - aliases `@` to `src`.
- Current UI tree also contains many `.test.ts`, `.test.tsx`, and `.spec.ts` files; targeted refactor tests should follow the nearest existing convention and can be run directly with `pnpm vitest run --config vitest.ui.config.ts <path>`.

### Refactor Implications

- Keep Ralph editor extractions narrow and behavior-preserving.
- Prefer pure helper extraction into `src/tauri/ui/ralph/_helpers/` when logic does not need React state or DOM effects.
- Add or update focused helper specs before relying on broad `ralph-flow-editor.test.tsx`.
- Use `pnpm typecheck:ui`, focused UI Vitest runs, and `pnpm lint` as the main verification path for UI refactor batches.
- Do not add dependencies, start dev servers, or run package install commands for this refactor loop unless a later task explicitly requires it.

## Apply Focused Batch Block

Date: 2026-06-19

### Batch Applied

- Focused P0 Ralph editor sub-batch: extracted canvas layout, bounds, derived group membership, and React Flow node/edge conversion helpers from `src/tauri/ui/ralph/ralph-flow-editor.tsx`.
- Created module-specific helper file:
  - `src/tauri/ui/ralph/_helpers/ralph-canvas-layout.helper.ts`
    - Owns Ralph canvas node/edge data types.
    - Provides default canvas positions, block fallback sizes, bounds math, overlap checks, and reserved visual-block avoidance for clean layout.
    - Derives group children from explicit membership, parent ids, and placed geometry.
    - Computes hidden descendants for collapsed groups and normalizes derived group membership before save/layout.
    - Converts Ralph flows into React Flow nodes and edges while preserving issue counts, selection/active state, collapsed-group hiding, route colors, and route selection classes.
- Updated `src/tauri/ui/ralph/ralph-flow-editor.tsx` to import the extracted canvas helpers and retain UI event/state orchestration.
- No public APIs were intentionally changed. No files were renamed. New files follow the established kebab-case `.helper.ts` and `.helper.spec.ts` naming.
- The extracted helper is 446 lines; `ralph-flow-editor.tsx` remains over 500 lines and should continue to be reduced in future focused batches.

### Tests Added or Updated

- Created `src/tauri/ui/ralph/_helpers/ralph-canvas-layout.helper.spec.ts`.
- Coverage includes:
  - Default canvas grid positions and fallback sizes.
  - Bounds, point inclusion, overlap boundary behavior, and translation.
  - Reserved visual-block avoidance for clean layout positions.
  - Derived group membership from geometry, parent ids, and explicit child ids.
  - Collapsed nested group hiding.
  - Flow-to-node conversion with issue counts, selected/active flags, collapsed group render height, and hidden child flags.
  - Flow-to-edge conversion with selected/connected class names, error stroke color, selected stroke width, and hidden collapsed-group edges.
  - Route target filtering and forced clean layout preserving visual block positions.

### Verification Performed

- `pnpm vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/_helpers/ralph-canvas-layout.helper.spec.ts` - passed.
- `pnpm vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/_helpers/ralph-canvas-layout.helper.spec.ts src/tauri/ui/ralph/_helpers/ralph-attachments.helper.spec.ts src/tauri/ui/ralph/_helpers/validate-flow-locally.helper.spec.ts` - passed.
- `pnpm typecheck:ui` - passed.
- `pnpm lint` - passed after removing one stale `LocalIssue` type import from the editor.
- No dev servers were started or restarted.

### Remaining Tasks

- Continue P0 extraction from `src/tauri/ui/ralph/ralph-flow-editor.tsx`; next candidates are flow summary/scope/default helpers, preview/chip formatting helpers, and local React Flow node/edge components.
- Larger P0 work remains for `src/core/ralph.ts`, `src/tauri/ui/runtime.ts`, and `src/core/scheduler.ts`.

## Update Progress Block - Current Batch

Date: 2026-06-19

### What Changed

- Validation passed for the focused Ralph editor canvas-layout extraction batch.
- Updated `src/tauri/ui/ralph/ralph-flow-editor.tsx` to import extracted canvas helpers instead of owning local bounds/layout/node-edge conversion logic.
- Created `src/tauri/ui/ralph/_helpers/ralph-canvas-layout.helper.ts`.
  - Owns Ralph canvas node/edge data types.
  - Provides default positions, fallback block sizes, bounds math, overlap checks, reserved visual-block avoidance, derived group membership, collapsed-group hiding, layout forcing, selectable route targets, and React Flow node/edge conversion.
- Removed one stale `LocalIssue` type import from the editor as part of lint cleanup.
- No files were renamed or moved. Logic was split out of `ralph-flow-editor.tsx` by creating the new helper file.
- No dev servers were started or restarted.

### Files Created

- `src/tauri/ui/ralph/_helpers/ralph-canvas-layout.helper.ts`
- `src/tauri/ui/ralph/_helpers/ralph-canvas-layout.helper.spec.ts`

### Tests Added or Updated

- Added focused coverage in `src/tauri/ui/ralph/_helpers/ralph-canvas-layout.helper.spec.ts`.
- Tests cover default canvas positions, fallback sizes, bounds/overlap behavior, clean-layout reserved bounds, derived group membership, collapsed nested group hiding, flow-to-node conversion, flow-to-edge conversion, route target filtering, and forced clean layout preserving visual block positions.
- Existing focused Ralph helper specs for attachments and local validation remained part of the combined validation batch.

### Validation Commands

- `pnpm vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/_helpers/ralph-canvas-layout.helper.spec.ts` - passed.
- `pnpm vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/_helpers/ralph-canvas-layout.helper.spec.ts src/tauri/ui/ralph/_helpers/ralph-attachments.helper.spec.ts src/tauri/ui/ralph/_helpers/validate-flow-locally.helper.spec.ts` - passed.
- `pnpm typecheck:ui` - passed.
- `pnpm lint` - passed.

### Filename Exceptions

- No new filename exceptions were introduced.
- Existing documented framework/tooling exceptions remain:
  - `src-tauri/**` follows Rust/Tauri native conventions.
  - `src/tauri/ui/preview/index.html` and `src/tauri/ui/preview/favicon.png` are framework/static asset names.
  - `src/shared/runtime-config.schema.json` uses the established schema suffix.
  - `src/core/runtime-contract.generated.ts` and `src/core/runtime-contract.generated.spec.ts` are generated-contract files.

### Remaining Tasks

- Continue P0 extraction from `src/tauri/ui/ralph/ralph-flow-editor.tsx`; next candidates are flow summary/scope/default helpers, preview/chip formatting helpers, and local React Flow node/edge components.
- Keep adding focused UI Vitest specs for each extracted pure helper before reducing more editor orchestration.
- Larger P0 work remains for `src/core/ralph.ts`, `src/tauri/ui/runtime.ts`, and `src/core/scheduler.ts`.

## Scan Violations Block - Current State

Date: 2026-06-19

### Scan Scope and Method

- Scope inspected: all current `src/**/*.ts` and `src/**/*.tsx` files.
- Runtime/build output and dependencies were not treated as refactor targets.
- Current inventory:
  - 346 TypeScript/TSX files under `src`.
  - 227 production source files.
  - 119 Vitest test files.
  - 70 total source/test files over 500 lines.
  - 54 production source files over 500 lines.
- Current naming result:
  - No TypeScript/TSX files under `src` violate kebab-case when allowing documented compound suffixes: `.helper`, `.model`, `.generated`, `.schema`, `.spec`, and `.test`.
  - The earlier apparent spec-file naming hits were false positives from treating `.helper.spec.ts` as only one suffix.

### Documented Filename and Refactor Exceptions

- `src-tauri/**` remains outside this TypeScript filename scan because Rust/Tauri native files use their own ecosystem conventions.
- `src/tauri/ui/preview/index.html` and `src/tauri/ui/preview/favicon.png` are framework/static asset names.
- `src/shared/runtime-config.schema.json` is an accepted schema artifact name.
- `src/core/runtime-contract.generated.ts` and `src/core/runtime-contract.generated.spec.ts` are generated-contract files; update the generator rather than hand-refactoring generated output.
- UI primitive/vendor-style component code is lower priority than application-specific business logic. `src/tauri/ui/components/ui/sidebar.tsx` is still over 500 lines, but should be addressed after runtime/Ralph/chat-session logic.

### Current Highest-Priority Violations

1. `src/tauri/ui/ralph/ralph-flow-editor.tsx` is now 10,303 lines.
   - Progress since earlier scan: local flow validation, block output derivation, attachment/path helpers, canvas layout, bounds math, group membership, and React Flow node/edge conversion have been extracted into `src/tauri/ui/ralph/_helpers/` with focused specs.
   - Remaining violations: still oversized; retains UI orchestration, inspector state, block editing, flow summary/default/scope logic, preview/chip formatting, persistence formatting, and local React Flow node/edge components.
   - Next concrete tasks:
     - Extract flow summary/default/scope helpers into `src/tauri/ui/ralph/_helpers/ralph-flow-summary.helper.ts`.
     - Extract preview/chip/label formatting into `src/tauri/ui/ralph/_helpers/ralph-flow-formatting.helper.ts`.
     - Move local node and edge components into `src/tauri/ui/ralph/components/` or a nearby `_components` folder if that matches local UI conventions.
     - Add focused UI Vitest specs for each new pure helper before relying on broad editor tests.

2. `src/core/ralph.ts` is 4,217 lines.
   - Violations: oversized orchestration module with storage, path/revision handling, run logging, template and variable resolution, utility execution, MCP/browser execution, artifact handling, and flow run orchestration mixed together.
   - Next concrete tasks:
     - Extract storage/path/revision operations to `src/core/_helpers/ralph-storage.helper.ts`.
     - Extract placeholder, variable, attachment, and image input resolution to `src/core/_helpers/ralph-resolution.helper.ts`.
     - Extract utility execution by family into focused helpers, starting with HTTP/fetch/poll/wait and file/search/JSON transforms.
     - Extract UI analyze browser readiness/capture/artifact handling to `src/core/_helpers/ralph-ui-analyze.helper.ts`.
     - Keep `runRalphFlow` as a thin facade and add helper specs before reducing orchestration.

3. `src/tauri/ui/runtime.ts` is 3,964 lines.
   - Violations: oversized Tauri runtime bridge mixing command wrappers, constants, validators, normalizers, scheduler result shaping, settings defaults, MCP config document editing, file drop/clipboard fallbacks, and event mapping.
   - Next concrete tasks:
     - Extract scheduler result normalization to `src/tauri/ui/_helpers/scheduler-runtime-normalizers.helper.ts`.
     - Extract user settings defaulting and numeric clamping to `src/tauri/ui/_helpers/user-settings-normalizers.helper.ts`.
     - Extract MCP config document editing helpers to `src/tauri/ui/_helpers/mcp-config-document.helper.ts`.
     - Extract dropped path and clipboard image fallback helpers to `src/tauri/ui/_helpers/desktop-input-fallbacks.helper.ts`.
     - Add focused specs; `runtime.test.ts` should remain integration coverage, not the only safety net.

4. `src/core/scheduler.ts` is 3,113 lines.
   - Violations: state storage, locking, migrations, trigger/job normalization, prompt discovery/frontmatter parsing, event filtering, dedupe rendering, queue/retry policy, and execution loop live in one module.
   - Next concrete tasks:
     - Extract state storage and atomic writes to `src/core/_helpers/scheduler-state-storage.helper.ts`.
     - Extract trigger/job normalization to `src/core/_helpers/scheduler-normalization.helper.ts`.
     - Extract prompt discovery/frontmatter parsing to `src/core/_helpers/scheduler-prompt-discovery.helper.ts`.
     - Extract event matching and dedupe template rendering to `src/core/_helpers/scheduler-events.helper.ts`.
     - Keep public scheduler APIs stable and add specs for extracted helpers.

5. `src/cli/_helpers/cli-args.ts` is 2,247 lines.
   - Violations: oversized parser with many command families and repeated option normalization/defaulting in one file.
   - Next concrete tasks:
     - Split by command family into focused helpers for Ralph, scheduler, MCP, config/instructions, and generic parse primitives.
     - Preserve current CLI result shapes and add parser specs for invalid combinations, defaulting, aliases, and positionals.

### Secondary Oversized-File Tasks

- `src/tauri/ui/chat-session/_helpers/use-chat-session-controller.ts` (2,457 lines): split lifecycle, submission, attachment, voice, settings, and remote-control concerns; extract reducer-like pure logic with tests.
- `src/core/ralph-generation.ts` (2,274 lines): split prompt assembly, interview state, JSON parsing/repair, ID generation, and persistence boundaries.
- `src/tauri/ui/marketplace/mcp-marketplace.tsx` (2,198 lines): move view-model/data interaction logic under `src/tauri/ui/marketplace/_helpers/` and keep the component focused on rendering.
- `src/tauri/ui/chat-session.model.ts` (1,949 lines): continue splitting timeline/message/task/status derivation into focused model helpers.
- `src/tauri/ui/chat-session/_helpers/use-chat-session-runtime.ts` (1,914 lines): separate runtime event normalization, task dispatching, and UI callback orchestration.
- `src/core/mcp/client.ts` (1,820 lines), `src/core/mcp/tool-definitions.ts` (1,758 lines), `src/core/mcp/marketplace.ts` (1,393 lines), and `src/core/mcp/config.ts` (1,135 lines): split MCP config, marketplace, client transport, and tool schema concerns only after P0 runtime/Ralph work.
- Tool definition modules over 1,000 lines should be split by family while preserving exported arrays:
  - `src/core/_helpers/utility-tool-definitions.ts` (1,989 lines).
  - `src/core/_helpers/package-tool-definitions.ts` (1,886 lines).
  - `src/core/_helpers/scheduler-tool-definitions.ts` (1,748 lines).
  - `src/core/_helpers/browser-tool-definitions.ts` (1,707 lines).
  - `src/core/_helpers/desktop-ui-tool-definitions.ts` (1,240 lines).
  - `src/core/_helpers/macro-recorder-tool-definitions.ts` (1,190 lines).

### Coverage Gaps and Weak Coverage

- Highest-priority production files over 500 lines with no colocated `.spec`/`.test` file:
  - `src/core/ralph.ts`
  - `src/tauri/ui/chat-session/_helpers/use-chat-session-controller.ts`
  - `src/core/ralph-generation.ts`
  - `src/cli/_helpers/cli-args.ts`
  - `src/tauri/ui/marketplace/mcp-marketplace.tsx`
  - `src/core/agent-runtime.ts`
  - `src/tauri/ui/chat-session/components/scheduler-panel.tsx`
  - `src/tauri/ui/chat-session/components/settings-dialog-panels/instruction-settings-panel.tsx`
  - `src/core/_helpers/desktop-ui-tool-definitions.ts`
  - `src/tauri/ui/chat-session/_helpers/use-remote-mission-control.ts`
  - `src/cli/_helpers/cli-ralph-commands.ts`
  - `src/core/ralph-watches.ts`
- Large files with colocated tests but coverage that is still too broad for safe refactoring:
  - `src/tauri/ui/ralph/ralph-flow-editor.tsx` has broad UI coverage plus new focused helper specs; continue adding helper specs as logic is extracted.
  - `src/tauri/ui/runtime.ts` has `runtime.test.ts`, but normalizers/config/fallback helpers need direct tests.
  - `src/core/scheduler.ts` has `scheduler.spec.ts`, but storage, prompt discovery, event filtering, and normalization need narrower tests.
  - `src/tauri/ui/chat-session.model.ts` has `chat-session.model.test.ts`, but the model remains too broad and should gain helper-level tests after extraction.

### Helper Boundary Findings

- Active helper roots:
  - `src/cli/_helpers`
  - `src/core/_helpers`
  - `src/tauri/ui/_helpers`
  - `src/tauri/ui/chat-session/_helpers`
  - `src/tauri/ui/ralph/_helpers`
  - `src/helpers`
- `src/common/_helpers` exists but is empty; keep it only if future common UI helpers need it, otherwise remove in a low-priority cleanup.
- `src/helpers` remains appropriate for truly shared helpers such as `normalize-optional-string.helper.ts` and `sort-entry-names.helper.ts`.
- Repeated `isRecord`/`isRecordValue` helpers appear in core, MCP, runtime, marketplace, shell-store, and UI settings files. Do not promote globally yet; first extract nearby module helpers, then consolidate only if the final semantics are identical.
- Repeated numeric clamping appears in UI runtime, chat-session model/settings, voice, and assistant surface code. These should stay module-local until settings/runtime extraction proves a shared UI helper is genuinely type-independent.
- Path display/name helpers now exist in `src/tauri/ui/ralph/_helpers/ralph-attachments.helper.ts`; compare with runtime dropped-path helpers during the `runtime.ts` extraction before considering promotion to `src/helpers`.

### Prioritized Remaining-Work Checklist

- [ ] P0: Continue reducing `src/tauri/ui/ralph/ralph-flow-editor.tsx` by extracting flow summary/default/scope helpers, preview formatting helpers, and local node/edge components.
- [ ] P0: Split `src/core/ralph.ts` into storage, resolution, utility execution, MCP/browser execution, UI analyze, artifact, and orchestration helpers with focused specs.
- [ ] P0: Split `src/tauri/ui/runtime.ts` normalizers/config/fallback helpers from Tauri command wrappers and add targeted UI specs.
- [ ] P1: Split `src/core/scheduler.ts` into state storage, normalization, prompt discovery, event filtering, and orchestration helpers.
- [ ] P1: Split `src/cli/_helpers/cli-args.ts` by command family and add parser coverage for each family.
- [ ] P1: Reduce chat-session controller/runtime/model files by extracting tested pure state transitions and side-effect clusters.
- [ ] P2: Split large tool-definition modules by tool family/schema group while preserving public exports.
- [ ] P2: Review MCP client/config/marketplace modules for smaller persistence, transport, and model helpers.
- [ ] P2: Review marketplace and settings-panel UI files for view-model extraction and component decomposition.
- [ ] P3: Decide whether to remove empty `src/common/_helpers` or reserve it for future common UI-only helpers.

### Verification Performed

- Re-read current repository instructions and confirmed no workspace `AGENTS.md` files outside ignored/generated output.
- Ran `git status --short` to avoid overwriting existing dirty work.
- Enumerated current `src/**/*.ts` and `src/**/*.tsx` files with PowerShell.
- Counted production/test files and all source/test files over 500 lines.
- Checked TypeScript/TSX filenames against kebab-case plus documented compound suffix exceptions.
- Compared production files over 500 lines against colocated `.spec.ts`, `.spec.tsx`, `.test.ts`, and `.test.tsx` files to identify likely coverage gaps.
- Scanned helper roots and repeated helper patterns such as `isRecord`, clamping, optional string normalization, and path display logic.
- No dev servers were started or restarted.

## Scan Violations Block - Refreshed Current State

Date: 2026-06-19

### Scan Scope and Method

- Scope inspected: all current `src/**/*.ts` and `src/**/*.tsx` files.
- Runtime output, dependencies, and `src-tauri/**` native Rust/Tauri files were not treated as TypeScript refactor targets.
- Current inventory:
  - 350 TypeScript/TSX files under `src`.
  - 230 production source files.
  - 120 Vitest test files.
  - 71 total source/test files over 500 lines.
  - 55 production source files over 500 lines.
- Current naming result:
  - No TypeScript/TSX files under `src` violate kebab-case when allowing documented compound suffixes: `.helper`, `.model`, `.generated`, `.schema`, `.spec`, and `.test`.
  - No new filename exceptions are needed.

### Documented Filename and Refactor Exceptions

- `src-tauri/**` remains outside this scan because Rust/Tauri native files use their own ecosystem conventions.
- `src/tauri/ui/preview/index.html` and `src/tauri/ui/preview/favicon.png` are framework/static asset names.
- `src/shared/runtime-config.schema.json` is an accepted schema artifact name.
- `src/core/runtime-contract.generated.ts` and `src/core/runtime-contract.generated.spec.ts` are generated-contract files; update the generator rather than hand-refactoring generated output.
- UI primitive or vendor-style component files, especially `src/tauri/ui/components/ui/sidebar.tsx`, are lower priority than application-specific business logic even when over 500 lines.

### Current Highest-Priority Violations

1. `src/tauri/ui/ralph/ralph-flow-editor.tsx` is 10,007 lines.
   - Violations: still massively oversized; retains UI orchestration, inspector state, block editing, persistence formatting, flow summary/default/scope logic, preview/chip formatting, and local React Flow node/edge components.
   - Progress already present: validation, block output derivation, attachment/path helpers, formatting helpers, canvas layout, bounds math, group membership, and React Flow conversion have started moving into `src/tauri/ui/ralph/_helpers/` with focused specs.
   - Next concrete tasks:
     - Continue extracting flow summary/default/scope helpers under `src/tauri/ui/ralph/_helpers/`.
     - Move remaining local formatting and label helpers into focused `.helper.ts` files if not already covered by `ralph-flow-formatting.helper.ts`.
     - Move local node and edge components into `src/tauri/ui/ralph/components/` or the nearest established local component boundary.
     - Keep adding focused UI Vitest specs for each extracted pure helper before relying on broad editor tests.

2. `src/core/ralph.ts` is 4,345 lines.
   - Violations: oversized orchestration module with storage, path/revision handling, run logging, template and variable resolution, utility execution, MCP/browser execution, artifact handling, and flow run orchestration mixed together.
   - Next concrete tasks:
     - Extract storage/path/revision operations to `src/core/_helpers/ralph-storage.helper.ts`.
     - Extract placeholder, variable, attachment, and image input resolution to `src/core/_helpers/ralph-resolution.helper.ts`.
     - Extract utility execution by family into focused helpers, starting with HTTP/fetch/poll/wait and file/search/JSON transforms.
     - Extract UI analyze browser readiness/capture/artifact handling to `src/core/_helpers/ralph-ui-analyze.helper.ts`.
     - Keep `runRalphFlow` as a thin facade and add helper specs before reducing orchestration.

3. `src/tauri/ui/runtime.ts` is 3,989 lines.
   - Violations: oversized Tauri runtime bridge mixing command wrappers, constants, validators, normalizers, scheduler result shaping, settings defaults, MCP config document editing, file drop/clipboard fallbacks, and event mapping.
   - Next concrete tasks:
     - Extract scheduler result normalization to `src/tauri/ui/_helpers/scheduler-runtime-normalizers.helper.ts`.
     - Extract user settings defaulting and numeric clamping to `src/tauri/ui/_helpers/user-settings-normalizers.helper.ts`.
     - Extract MCP config document editing helpers to `src/tauri/ui/_helpers/mcp-config-document.helper.ts`.
     - Extract dropped path and clipboard image fallback helpers to `src/tauri/ui/_helpers/desktop-input-fallbacks.helper.ts`.
     - Add focused specs; `runtime.test.ts` should remain integration coverage, not the only safety net.

4. `src/core/scheduler.ts` is 3,113 lines.
   - Violations: state storage, locking, migrations, trigger/job normalization, prompt discovery/frontmatter parsing, event filtering, dedupe rendering, queue/retry policy, and execution loop live in one module.
   - Next concrete tasks:
     - Extract state storage and atomic writes to `src/core/_helpers/scheduler-state-storage.helper.ts`.
     - Extract trigger/job normalization to `src/core/_helpers/scheduler-normalization.helper.ts`.
     - Extract prompt discovery/frontmatter parsing to `src/core/_helpers/scheduler-prompt-discovery.helper.ts`.
     - Extract event matching and dedupe template rendering to `src/core/_helpers/scheduler-events.helper.ts`.
     - Keep public scheduler APIs stable and add specs for extracted helpers.

5. `src/cli/_helpers/cli-args.ts` is 2,255 lines.
   - Violations: oversized parser with many command families and repeated option normalization/defaulting in one file.
   - Next concrete tasks:
     - Split by command family into focused helpers for Ralph, scheduler, MCP, config/instructions, and generic parse primitives.
     - Preserve current CLI result shapes and add parser specs for invalid combinations, defaulting, aliases, and positionals.

### Secondary Oversized-File Tasks

- `src/tauri/ui/chat-session/_helpers/use-chat-session-controller.ts` (2,457 lines): split lifecycle, submission, attachment, voice, settings, and remote-control concerns; extract reducer-like pure logic with tests.
- `src/core/ralph-generation.ts` (2,274 lines): split prompt assembly, interview state, JSON parsing/repair, ID generation, and persistence boundaries.
- `src/tauri/ui/marketplace/mcp-marketplace.tsx` (2,198 lines): move view-model/data interaction logic under `src/tauri/ui/marketplace/_helpers/` and keep the component focused on rendering.
- `src/tauri/ui/chat-session.model.ts` (1,949 lines): continue splitting timeline/message/task/status derivation into focused model helpers.
- `src/tauri/ui/chat-session/_helpers/use-chat-session-runtime.ts` (1,914 lines): separate runtime event normalization, task dispatching, and UI callback orchestration.
- `src/core/mcp/client.ts` (1,820 lines), `src/core/mcp/tool-definitions.ts` (1,758 lines), `src/core/mcp/marketplace.ts` (1,393 lines), and `src/core/mcp/config.ts` (1,135 lines): split MCP config, marketplace, client transport, and tool schema concerns after P0 runtime/Ralph work.
- Tool definition modules over 1,000 lines should be split by family while preserving public exports:
  - `src/core/_helpers/utility-tool-definitions.ts` (1,989 lines).
  - `src/core/_helpers/package-tool-definitions.ts` (1,886 lines).
  - `src/core/_helpers/scheduler-tool-definitions.ts` (1,748 lines).
  - `src/core/_helpers/browser-tool-definitions.ts` (1,707 lines).
  - `src/core/_helpers/desktop-ui-tool-definitions.ts` (1,240 lines).
  - `src/core/_helpers/macro-recorder-tool-definitions.ts` (1,190 lines).

### Coverage Gaps and Weak Coverage

- Direct colocated test-pair detection is not enough for this repository because several Ralph tests live in `src/core/__test__`; coverage quality should be judged by focused helper-level specs.
- Highest-priority production files over 500 lines that still need narrower business-logic coverage before aggressive refactoring:
  - `src/core/ralph.ts`
  - `src/tauri/ui/chat-session/_helpers/use-chat-session-controller.ts`
  - `src/core/ralph-generation.ts`
  - `src/cli/_helpers/cli-args.ts`
  - `src/tauri/ui/marketplace/mcp-marketplace.tsx`
  - `src/core/agent-runtime.ts`
  - `src/tauri/ui/chat-session/components/scheduler-panel.tsx`
  - `src/tauri/ui/chat-session/components/settings-dialog-panels/instruction-settings-panel.tsx`
  - `src/core/_helpers/desktop-ui-tool-definitions.ts`
  - `src/tauri/ui/chat-session/_helpers/use-remote-mission-control.ts`
  - `src/cli/_helpers/cli-ralph-commands.ts`
  - `src/core/ralph-watches.ts`
- Large files with existing tests but weak refactor safety:
  - `src/tauri/ui/ralph/ralph-flow-editor.tsx` has broad UI coverage plus focused helper specs; continue extracting pure helper coverage.
  - `src/tauri/ui/runtime.ts` has `runtime.test.ts`; normalizers, config editing, and fallback helpers need direct tests.
  - `src/core/scheduler.ts` has `scheduler.spec.ts`; storage, prompt discovery, event filtering, and normalization need narrower tests.
  - `src/tauri/ui/chat-session.model.ts` has `chat-session.model.test.ts`; helper-level tests should grow as timeline/message/status logic is split out.

### Helper Boundary Findings

- Active helper roots:
  - `src/cli/_helpers` (15 files)
  - `src/core/_helpers` (85 files)
  - `src/tauri/ui/_helpers` (3 files)
  - `src/tauri/ui/chat-session/_helpers` (45 files)
  - `src/tauri/ui/ralph/_helpers` (12 files)
  - `src/helpers` (2 shared helpers plus specs)
- `src/common/_helpers` exists but is empty; keep it only if future common UI helpers need it, otherwise remove in a low-priority cleanup.
- `src/helpers` remains appropriate for truly shared helpers such as `normalize-optional-string.helper.ts` and `sort-entry-names.helper.ts`.
- Repeated `isRecord`/`isRecordValue` helpers appear in CLI, core helpers, MCP, runtime, marketplace, shell-store, and UI settings files. Do not promote globally yet; first extract nearby module helpers, then consolidate only if the final semantics are identical.
- Repeated numeric clamping appears in UI runtime, chat-session model/settings, voice, and assistant surface code. These should stay module-local until settings/runtime extraction proves a shared UI helper is genuinely type-independent.
- `normalizeOptionalString` is already correctly global because it is used by CLI, core provider/runtime helpers, and shared helper specs.

### Prioritized Remaining-Work Checklist

- [ ] P0: Continue reducing `src/tauri/ui/ralph/ralph-flow-editor.tsx` by extracting flow summary/default/scope helpers, remaining preview formatting helpers, and local node/edge components.
- [ ] P0: Split `src/core/ralph.ts` into storage, resolution, utility execution, MCP/browser execution, UI analyze, artifact, and orchestration helpers with focused specs.
- [ ] P0: Split `src/tauri/ui/runtime.ts` normalizers/config/fallback helpers from Tauri command wrappers and add targeted UI specs.
- [ ] P1: Split `src/core/scheduler.ts` into state storage, normalization, prompt discovery, event filtering, and orchestration helpers.
- [ ] P1: Split `src/cli/_helpers/cli-args.ts` by command family and add parser coverage for each family.
- [ ] P1: Reduce chat-session controller/runtime/model files by extracting tested pure state transitions and side-effect clusters.
- [ ] P2: Split large tool-definition modules by tool family/schema group while preserving public exports.
- [ ] P2: Review MCP client/config/marketplace modules for smaller persistence, transport, and model helpers.
- [ ] P2: Review marketplace and settings-panel UI files for view-model extraction and component decomposition.
- [ ] P3: Decide whether to remove empty `src/common/_helpers` or reserve it for future common UI-only helpers.

## Fix Validation Failures Block - 2026-06-19

### Failed Command Result

- The reported validation chain failed at `pnpm lint` with `@typescript-eslint/no-unused-vars` for `questionsPerTurn` in `src/core/ralph.ts`.
- Earlier steps in that failed run had passed: `pnpm typecheck:ui`, `pnpm build:ui`, and `pnpm test:ui`.
- The Vite chunk-size message during `pnpm build:ui` is a warning, not a validation failure.

### Cause Assessment

- The unused `questionsPerTurn` local in `executeInterviewBlock` was caused by the current Ralph refactor batch. The question limit is now applied while normalizing interview generation fields, leaving the local assignment stale.
- After removing that lint failure, the chain advanced to `pnpm typecheck` and exposed current-batch strict TypeScript regressions in Ralph resume handling and exhaustive Ralph block handling.

### Fixes Applied

- Removed the stale `questionsPerTurn` assignment from `executeInterviewBlock` in `src/core/ralph.ts`.
- Tightened `machdoch ralph resume` checkpoint and pending-input guards in `src/cli/_helpers/cli-ralph-commands.ts` so strict optional property checks can prove the values are present before use.
- Removed unused Ralph editor input-field scaffold symbols, then restored the pending-input state/runtime wiring required by the already-rendered run-panel controls.
- Confirmed Ralph layout and generation contract handling includes the current `ASK_USER` and `INTERVIEW` block types.

### Verification Performed

- `pnpm typecheck` - passed after fixes.
- Full reported validation chain passed:
  - `pnpm typecheck:ui`
  - `pnpm build:ui`
  - `pnpm test:ui`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm build`
- No dev servers were started or restarted.
- No pre-existing validation failures remain. The Vite chunk-size warning remains non-blocking and unchanged in nature.

### Verification Performed

- Re-read repository and Machdoch instructions from the current workspace context.
- Ran `git status --short` before editing and observed existing modified/untracked work; only `ralph-progress.md` was edited by this scan update.
- Enumerated current TypeScript/TSX files under `src` with PowerShell because `rg` is not installed in this environment.
- Counted production/test files and all source/test files over 500 lines.
- Checked TypeScript/TSX filenames against kebab-case plus documented compound suffix exceptions.
- Listed current Vitest files and compared coverage shape against oversized production modules.
- Scanned helper roots and repeated helper patterns including `isRecord`, clamping, and optional string normalization.
- No dev servers were started or restarted.

## Update Progress Block - 2026-06-19

### What Changed

- Validation passed for the focused Ralph batch after fixing current-batch type/lint regressions.
- Ralph flow/editor support was expanded across CLI, core runtime, layout, generation, parsing, placeholders, validation, and Tauri UI runtime/editor code.
- Ralph input/interview handling is now represented through the CLI resume path, run records, block output derivation, flow parsing/validation, layout/generation contracts, runtime bridge, and editor/run-panel tests.
- Ralph editor refactoring continued by moving pure UI helper logic out of `src/tauri/ui/ralph/ralph-flow-editor.tsx` into `src/tauri/ui/ralph/_helpers/`.

### Files Renamed, Moved, Split, or Created

- No existing files were renamed or moved.
- New helper files created under `src/tauri/ui/ralph/_helpers/`:
  - `create-blank-ralph-flow.helper.ts`
  - `create-flow-alias.helper.ts`
  - `format-ralph-flow-labels.helper.ts`
  - `get-block-outputs.helper.ts`
  - `get-ralph-block-visual.helper.ts`
  - `get-ralph-node-preview.helper.ts`
  - `normalize-ralph-flow-scope.helper.ts`
  - `ralph-attachments.helper.ts`
  - `ralph-canvas-layout.helper.ts`
  - `upsert-flow-summary.helper.ts`
  - `validate-flow-locally.helper.ts`
- New focused UI helper specs created under `src/tauri/ui/ralph/_helpers/`:
  - `ralph-attachments.helper.spec.ts`
  - `ralph-canvas-layout.helper.spec.ts`
  - `ralph-flow-formatting.helper.spec.ts`
  - `ralph-flow-summaries.helper.spec.ts`
  - `validate-flow-locally.helper.spec.ts`
- Existing files updated in the focused batch:
  - `src/cli/_helpers/cli-args.ts`
  - `src/cli/_helpers/cli-ralph-commands.ts`
  - `src/cli/_helpers/cli-scheduler-commands.ts`
  - `src/core/__test__/ralph-run.spec.ts`
  - `src/core/_helpers/create-ralph-run-record.helper.ts`
  - `src/core/_helpers/get-ralph-block-outputs.helper.ts`
  - `src/core/_helpers/parse-ralph-flow-record.helper.ts`
  - `src/core/_helpers/ralph-placeholders.helper.ts`
  - `src/core/_helpers/validate-ralph-flow-blocks.helper.ts`
  - `src/core/ralph-generation.ts`
  - `src/core/ralph-layout.ts`
  - `src/core/ralph.ts`
  - `src/tauri/ui/ralph/ralph-flow-editor.test.tsx`
  - `src/tauri/ui/ralph/ralph-flow-editor.tsx`
  - `src/tauri/ui/runtime.test.ts`
  - `src/tauri/ui/runtime.ts`
  - `vitest.ui.config.ts`

### Tests Added or Updated

- Added focused specs for Ralph editor helpers covering attachment normalization, canvas/layout behavior, flow formatting, flow summaries/default/scope helpers, block output derivation, alias generation, and local flow validation.
- Updated `src/core/__test__/ralph-run.spec.ts` for Ralph runtime behavior.
- Updated `src/tauri/ui/ralph/ralph-flow-editor.test.tsx` for editor/run-panel behavior.
- Updated `src/tauri/ui/runtime.test.ts` for Tauri UI runtime bridge behavior.
- Updated `vitest.ui.config.ts` so UI `.spec.ts` files are discovered and excluded from coverage instrumentation.

### Validation Commands Run and Results

- `pnpm typecheck:ui` - passed.
- `pnpm build:ui` - passed; Vite chunk-size warning remains non-blocking.
- `pnpm test:ui` - passed.
- `pnpm lint` - passed after removing the stale `questionsPerTurn` lint failure.
- `pnpm typecheck` - passed after tightening Ralph resume guards and exhaustive block handling.
- `pnpm build` - passed.
- No dev servers were started or restarted.

### Framework-Required Filename Exceptions

- Existing exceptions remain valid:
  - `src-tauri/**` follows Rust/Tauri native naming conventions and remains outside TypeScript filename refactor scope.
  - `src/tauri/ui/preview/index.html` and `src/tauri/ui/preview/favicon.png` are framework/static asset names.
  - `src/shared/runtime-config.schema.json` is an accepted schema artifact name.
  - `src/core/runtime-contract.generated.ts` and `src/core/runtime-contract.generated.spec.ts` are generated-contract outputs.
- No new framework-required filename exceptions were introduced; new files follow kebab-case plus `.helper` and `.spec` conventions.

### Remaining Tasks

- P0: Continue reducing `src/tauri/ui/ralph/ralph-flow-editor.tsx` by extracting remaining flow summary/default/scope helpers, preview helpers, and local node/edge components.
- P0: Split `src/core/ralph.ts` into storage, resolution, utility execution, MCP/browser execution, UI analyze, artifact, and orchestration helpers with focused specs.
- P0: Split `src/tauri/ui/runtime.ts` normalizers/config/fallback helpers from Tauri command wrappers and add targeted UI specs.
- P1: Split `src/core/scheduler.ts` into state storage, normalization, prompt discovery, event filtering, and orchestration helpers.
- P1: Split `src/cli/_helpers/cli-args.ts` by command family and add parser coverage for invalid combinations, defaulting, aliases, and positionals.
- P1: Continue extracting tested pure state transitions and side-effect clusters from chat-session controller/runtime/model files.
- P2: Split large tool-definition modules by family while preserving public exports.

## Inspect Repository Block Refresh

Date: 2026-06-19

### Inspection Scope

- Inspected active workspace instructions, package metadata, TypeScript configs, Vitest configs, ESLint config, UI Vite config, workspace file layout, test/helper naming patterns, and the existing Ralph progress log.
- Did not start, restart, or preview any backend/frontend/Tauri servers.
- `rg` is not installed in this shell, so repository file discovery used `git ls-files` and targeted PowerShell `Get-ChildItem` reads.

### Active Instructions

- No tracked `AGENTS.md` files were found by `git ls-files AGENTS.md "**/AGENTS.md"`.
- Applicable repository instructions are `.machdoch/instructions.md` and `.machdoch/instructions/security.instructions.md`.
- Refactor-relevant instruction constraints:
  - Start with the smallest safe step and prefer read-only inspection before changes.
  - Maintain a short plan/checklist for multi-step work.
  - Verify outcomes before declaring completion.
  - Do not start or restart dev servers unless repository instructions explicitly allow it.
  - Avoid printing secrets and treat package installation as risky.

### Package Scripts and Tooling

- Package: `machdoch` `0.17.0`, private ESM package, Node engine `>=20.10`.
- Package manager is pinned to `pnpm@11.6.0`.
- CLI binary maps `machdoch` to `./dist/cli/main.js`.
- Refactor-safe validation scripts:
  - `pnpm lint`: `eslint src vite.ui.config.ts vitest.config.ts vitest.ui.config.ts`
  - `pnpm typecheck`: `tsc --noEmit -p tsconfig.json`
  - `pnpm typecheck:ui`: `tsc -p tsconfig.ui.json --noEmit`
  - `pnpm test`: `vitest run`
  - `pnpm test:ui`: `vitest run --config vitest.ui.config.ts`
  - `pnpm coverage`: `vitest run --coverage`
  - `pnpm build`: `tsc -p tsconfig.json`
  - `pnpm build:ui`: `vite build --config vite.ui.config.ts`
- Server/runtime scripts exist and should not be used during this flow unless explicitly allowed:
  - `pnpm dev`, `pnpm dev:ui`, `pnpm preview:ui`, `pnpm start`, `pnpm tauri:dev`.
- Utility/build-generation scripts:
  - `pnpm build:cli-bundle`
  - `pnpm generate:runtime-contract`
  - `pnpm version:bump`
  - `pnpm tauri`
  - `pnpm tauri:build`

### Source Layout and Naming Conventions

- Main TypeScript source roots under `src/`:
  - `src/cli`
  - `src/common`
  - `src/core`
  - `src/helpers`
  - `src/shared`
  - `src/tauri`
- Tauri Rust/native code lives under `src-tauri/` and follows Rust/Tauri naming conventions.
- Helper folders consistently use `_helpers`.
- General helper files commonly use kebab-case plus `.helper.ts`, with colocated `.helper.spec.ts` tests.
- Core and CLI tests commonly use `.spec.ts`.
- UI component/hook/model tests commonly use `.test.ts`, `.test.tsx`, and some `.spec.ts` for extracted helper/model logic.
- Ralph UI helper extraction is already established under `src/tauri/ui/ralph/_helpers/`.
- Shared UI conventions:
  - `components.json` configures shadcn `new-york`, TSX, Tailwind CSS at `src/tauri/ui/styles.css`, and aliases such as `@/tauri/ui/components/ui`.
  - UI imports can use the `@` alias to resolve to `src`.

### TypeScript and Lint Conventions

- Root `tsconfig.json` uses strict NodeNext TypeScript:
  - `strict`, `noImplicitOverride`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` are enabled.
  - Production build includes `src/**/*.ts` and excludes specs/tests, `src/**/__test__`, and Tauri UI files.
- `tsconfig.spec.json` extends root config for Node/core specs and includes `vitest/globals`.
- `tsconfig.ui.json` switches to `module: ESNext`, `moduleResolution: Bundler`, `jsx: react-jsx`, DOM libs, `@/*` path alias, and includes `src/core/types.ts` plus `src/tauri/ui/**/*.ts(x)`.
- ESLint applies to `src/**/*.{ts,tsx}` and top-level `*.ts`, ignores build artifacts and `src-tauri/target`, and errors on `@typescript-eslint/no-explicit-any`.

### Vitest Usage

- Root `vitest.config.ts`:
  - Node environment.
  - Globals enabled.
  - Includes `src/**/*.spec.ts`.
  - Restores mocks and unstubs envs.
  - Coverage uses V8, reports text/html, includes `src/core/**/*.ts`, and excludes specs plus `src/**/__test__/**/*.ts`.
- UI `vitest.ui.config.ts`:
  - jsdom environment.
  - Globals enabled.
  - Includes `src/tauri/ui/**/*.spec.ts`.
  - `fileParallelism: false`, `passWithNoTests: true`, `restoreMocks: true`.
  - Aliases Tauri APIs/plugins to `src/tauri/ui/test/tauri-test-mocks.ts`.
  - Coverage uses V8 text output and includes UI `.ts/.tsx` files while excluding `.test` and `.spec` files.
- Current tree also contains many UI `.test.ts`/`.test.tsx` files. When refactoring UI behavior, prefer existing local test naming in the touched area and verify with `pnpm test:ui`.

### Refactor Implications

- Prefer narrow extractions into existing `_helpers` folders with focused colocated specs.
- Preserve exported public behavior and existing CLI/core/UI boundaries.
- For core or CLI logic, use `pnpm test` and targeted typecheck/lint as relevant.
- For Tauri UI logic, use `pnpm test:ui` and `pnpm typecheck:ui`; avoid server-based verification.
- Avoid new dependencies unless clearly necessary and justified.

## Scan Violations Refresh - 2026-06-19

### Scan Scope and Current Inventory

- Scope inspected: tracked `src/**/*.ts` and `src/**/*.tsx` files in the current workspace.
- Current inventory:
  - 338 TypeScript/TSX files.
  - 221 production files.
  - 117 Vitest/test-support files.
  - 71 total files over 500 lines.
  - 55 production files over 500 lines.
  - 16 test files over 500 lines.
- Current helper roots:
  - `src/cli/_helpers` - 15 files.
  - `src/common/_helpers` - 0 files.
  - `src/core/_helpers` - 99 files.
  - `src/tauri/ui/_helpers` - 3 files.
  - `src/tauri/ui/chat-session/_helpers` - 45 files.
  - `src/tauri/ui/ralph/_helpers` - 16 files.
- Working-tree note: many Ralph-related implementation files and `src/tauri/ui/ralph/_helpers/` are already modified or untracked in this autonomous loop; this scan update only changes `ralph-progress.md`.

### Filename Violations and Exceptions

- No actionable TypeScript/TSX filename violations were found under `src` after allowing documented compound suffixes:
  - `.helper.ts`
  - `.helper.spec.ts`
  - `.model.ts`
  - `.model.test.ts`
  - `.generated.ts`
  - `.generated.spec.ts`
  - `.spec.ts`
  - `.test.ts`
  - `.test.tsx`
- Documented framework/tooling exceptions remain:
  - `src-tauri/**` follows Rust/Tauri native naming and is outside this TypeScript filename scan.
  - `src/tauri/ui/preview/index.html` and `src/tauri/ui/preview/favicon.png` are framework/static asset names.
  - `src/shared/runtime-config.schema.json` is an accepted schema artifact name.
  - `src/core/runtime-contract.generated.ts` and `src/core/runtime-contract.generated.spec.ts` are generated contract artifacts.
- `src/common/_helpers` is still empty. Treat it as a P3 cleanup candidate unless common UI-only helpers are introduced.

### Highest-Priority Refactoring Violations

1. `src/tauri/ui/ralph/ralph-flow-editor.tsx` is 11,268 lines.
   - Status: previous Ralph editor extraction helped, but this remains the largest source file.
   - Violations: oversized React component, mixed editor state orchestration, canvas behavior, local node/edge components, command wiring, flow persistence UI, and remaining presentation/model formatting.
   - Next concrete tasks:
     - Move remaining local node/edge components into `src/tauri/ui/ralph/components/`.
     - Continue extracting pure formatting and command/view-model helpers into `src/tauri/ui/ralph/_helpers/`.
     - Keep `ralph-flow-editor.tsx` as the integration shell and add focused helper specs before each extraction that changes behavior.

2. `src/core/ralph.ts` is 5,317 lines.
   - Violations: oversized core runtime module with storage, run logging, variable/template resolution, block execution, utility execution, MCP/browser execution, UI analyze, artifact handling, resume/input handling, and orchestration in one file.
   - Next concrete tasks:
     - Extract storage/path operations to `src/core/_helpers/ralph-storage.helper.ts`.
     - Extract variable, placeholder, attachment, and image-input resolution to `src/core/_helpers/ralph-resolution.helper.ts`.
     - Extract utility execution families to focused helpers under `src/core/_helpers/`.
     - Extract MCP/browser/UI-analyze support to focused helpers while keeping `runRalphFlow` as the facade.
     - Add or preserve `.spec.ts` coverage for each extracted helper before shrinking orchestration.

3. `src/tauri/ui/runtime.ts` is 4,035 lines.
   - Violations: oversized Tauri UI runtime bridge with constants, validators, normalizers, settings defaults, command wrappers, event mapping, MCP config document editing, scheduler normalization, file-drop fallback handling, clipboard fallback handling, and runtime/task commands.
   - Next concrete tasks:
     - Extract scheduler result normalization to `src/tauri/ui/_helpers/scheduler-runtime-normalizers.helper.ts`.
     - Extract user settings defaults/normalizers to `src/tauri/ui/_helpers/user-settings-normalizers.helper.ts`.
     - Extract MCP config document helpers to `src/tauri/ui/_helpers/mcp-config-document.helper.ts`.
     - Extract dropped-path and clipboard-image fallbacks to `src/tauri/ui/_helpers/desktop-input-fallbacks.helper.ts`.
     - Add targeted UI specs so `runtime.test.ts` is no longer the only refactor safety net.

4. `src/core/scheduler.ts` is 3,113 lines.
   - Violations: scheduler state storage, locking, migrations, trigger/job normalization, prompt discovery/parsing, task text rendering, event filters, dedupe rendering, retry policy, and execution loop remain coupled.
   - Next concrete tasks:
     - Extract state storage and atomic writes to `src/core/_helpers/scheduler-state-storage.helper.ts`.
     - Extract trigger/job normalization to `src/core/_helpers/scheduler-normalization.helper.ts`.
     - Extract prompt discovery/frontmatter parsing to `src/core/_helpers/scheduler-prompt-discovery.helper.ts`.
     - Extract event filtering and dedupe template rendering to `src/core/_helpers/scheduler-events.helper.ts`.
     - Keep public scheduler APIs stable and add helper-level specs.

5. `src/tauri/ui/chat-session/_helpers/use-chat-session-controller.ts` is 2,457 lines.
   - Violations: oversized hook with lifecycle, submission, attachment, voice, settings, remote-control, and side-effect orchestration in one helper.
   - Next concrete tasks:
     - Split lifecycle, task submission, attachment, voice, settings, and remote-control concerns into smaller hooks/helpers.
     - Move reducer-like pure state transitions into tested helper functions.
     - Preserve the existing chat-session shell/runtime contracts during extraction.

6. `src/core/ralph-generation.ts` is 2,318 lines.
   - Violations: prompt assembly, interview state, schema repair/parsing, ID generation, validation adaptation, and persistence boundaries live together.
   - Next concrete tasks:
     - Extract prompt assembly and generation contract helpers.
     - Extract interview-state and repair/parse helpers.
     - Add focused specs around malformed model output, ID stability, and persisted flow normalization.

7. `src/cli/_helpers/cli-args.ts` is 2,284 lines.
   - Violations: oversized parser with many command families and repeated option/default normalization.
   - Next concrete tasks:
     - Split Ralph, scheduler, MCP, config/instruction, and shared parse primitives into command-family helpers.
     - Add parser specs for invalid combinations, aliases, defaults, and positional handling.

8. `src/tauri/ui/marketplace/mcp-marketplace.tsx` is 2,198 lines.
   - Violations: UI rendering, marketplace data interaction, filtering, enrichment state, install/update commands, and view-model logic are mixed.
   - Next concrete tasks:
     - Move model/view-model logic under `src/tauri/ui/marketplace/_helpers/`.
     - Keep component files focused on rendering and interaction binding.
     - Add helper-level coverage for filtering, state transitions, and install/update eligibility.

### Secondary Oversized-File Tasks

- `src/core/_helpers/utility-tool-definitions.ts` (1,989 lines): split by utility family/schema group while preserving exported definitions and specs.
- `src/tauri/ui/chat-session.model.ts` (1,949 lines): continue extracting timeline/message/task/status derivation into focused model helpers.
- `src/tauri/ui/chat-session/_helpers/use-chat-session-runtime.ts` (1,914 lines): separate runtime event normalization, task dispatch, and UI callback orchestration.
- `src/core/_helpers/package-tool-definitions.ts` (1,886 lines): split package/file/system schemas by tool family.
- `src/core/mcp/client.ts` (1,820 lines): split transport, config normalization, cache/session behavior, and result conversion.
- `src/core/mcp/tool-definitions.ts` (1,758 lines): split MCP tool schema definitions by capability area.
- `src/core/_helpers/scheduler-tool-definitions.ts` (1,748 lines), `src/core/_helpers/browser-tool-definitions.ts` (1,707 lines), `src/core/_helpers/desktop-ui-tool-definitions.ts` (1,240 lines), and `src/core/_helpers/macro-recorder-tool-definitions.ts` (1,190 lines): split large tool-definition modules by family.
- `src/core/agent-runtime.ts` (1,647 lines): extract provider/session orchestration and autopilot/tool execution seams after Ralph P0 work.
- `src/tauri/ui/chat-session/components/scheduler-panel.tsx` (1,597 lines): move scheduler panel view-model, form normalization, and mutation helpers out of the component.
- `src/core/mcp/marketplace.ts` (1,393 lines) and `src/core/mcp/config.ts` (1,135 lines): split persistence, parsing, marketplace fetch/enrichment, and config mutation helpers.
- `src/cli/_helpers/cli-ralph-commands.ts` (1,236 lines) and `src/cli/_helpers/cli-scheduler-commands.ts` (1,032 lines): split command execution helpers after `cli-args.ts` is reduced.

### Coverage Gaps and Weak Coverage

- Production files over 500 lines with no direct colocated test pair remain high-risk for refactoring:
  - `src/core/ralph.ts`
  - `src/tauri/ui/chat-session/_helpers/use-chat-session-controller.ts`
  - `src/core/ralph-generation.ts`
  - `src/cli/_helpers/cli-args.ts`
  - `src/tauri/ui/marketplace/mcp-marketplace.tsx`
  - `src/core/agent-runtime.ts`
  - `src/tauri/ui/chat-session/components/scheduler-panel.tsx`
  - `src/tauri/ui/chat-session/components/settings-dialog-panels/instruction-settings-panel.tsx`
  - `src/core/_helpers/desktop-ui-tool-definitions.ts`
  - `src/cli/_helpers/cli-ralph-commands.ts`
  - `src/tauri/ui/chat-session/_helpers/use-remote-mission-control.ts`
  - `src/tauri/ui/chat-session/components/settings-dialog-panels/mcp-settings-panel.tsx`
  - `src/core/ralph-watches.ts`
- Large files with existing tests still need narrower refactor coverage:
  - `src/tauri/ui/ralph/ralph-flow-editor.tsx` has broad UI tests plus new helper specs, but remaining node/edge/view-model extraction needs focused tests.
  - `src/tauri/ui/runtime.ts` has `runtime.test.ts`; extracted normalizers and fallbacks need direct specs.
  - `src/core/scheduler.ts` has `scheduler.spec.ts`; storage, prompt discovery, event filtering, and normalization need helper-level specs.
  - `src/tauri/ui/chat-session.model.ts` has `chat-session.model.test.ts`; split timeline/message/status helpers need focused tests.
  - Tool-definition modules often have broad definition tests; split modules should keep schema export compatibility tests and add narrower tests for any nontrivial builders.

### Duplication and Helper Boundary Findings

- Repeated `isRecord` or `isRecordValue` type guards appear in CLI, core helpers, MCP modules, Ralph runtime/generation, scheduler, UI runtime, chat-session model, marketplace model/enrichment, and shell-store files.
  - Recommendation: do not blindly promote yet; consolidate only after nearby module extractions prove semantics are identical and truly shared.
- `normalizeOptionalString` remains correctly placed in `src/helpers` because it is already used across CLI/core/shared helper specs.
- Chat-session-specific normalization remains correctly module-local in `src/tauri/ui/chat-session/_helpers/normalize-chat-session-optional-string.helper.ts`.
- UI remote-control normalization remains correctly UI-local in `src/tauri/ui/_helpers/normalize-remote-control-status.helper.ts`.
- Numeric clamping/defaulting logic appears in UI runtime/settings/chat-session areas; extract to UI-specific helper files first, and only promote to `src/helpers` if it becomes type-independent and reused outside UI.
- Path basename/parent fallback logic in runtime and Ralph attachment/editor code should be compared during extraction. Promote to `src/helpers` only if behavior is identical and independent of UI/Ralph types.

### Prioritized Remaining-Work Checklist

- [ ] P0: Continue shrinking `src/tauri/ui/ralph/ralph-flow-editor.tsx` by extracting local node/edge components and remaining pure view-model/formatting helpers with focused UI specs.
- [ ] P0: Split `src/core/ralph.ts` into storage, resolution, utility execution, MCP/browser execution, UI analyze, artifact, resume/input, and orchestration helpers with focused core specs.
- [ ] P0: Split `src/tauri/ui/runtime.ts` normalizers, config document helpers, and desktop input fallbacks from Tauri command wrappers with targeted UI specs.
- [ ] P1: Split `src/core/scheduler.ts` into state storage, normalization, prompt discovery, event filtering, retry/dedupe, and orchestration helpers.
- [ ] P1: Split `src/cli/_helpers/cli-args.ts` by command family and add parser coverage for invalid combinations, defaults, aliases, and positionals.
- [ ] P1: Reduce chat-session controller/runtime/model files by extracting tested pure state transitions and smaller side-effect hooks.
- [ ] P2: Split large core tool-definition modules by family/schema group while preserving public exported arrays and compatibility tests.
- [ ] P2: Review MCP client/config/marketplace modules for smaller persistence, transport, marketplace fetch, and config mutation helpers.
- [ ] P2: Review marketplace and scheduler-panel UI files for view-model extraction and component decomposition.
- [ ] P3: Decide whether to remove empty `src/common/_helpers` or reserve it for future common UI-only helpers.

### Verification Performed

- Re-read applicable workspace instructions from the current task context and confirmed no tracked `AGENTS.md` exists.
- Read the TypeScript development guidelines skill because this scan targets TypeScript/React refactoring risks.
- Ran `git status --short` and observed existing modified/untracked Ralph loop work.
- Enumerated tracked `src/**/*.ts` and `src/**/*.tsx` files with `git ls-files`.
- Counted production/test files and files over 500 lines.
- Checked TypeScript/TSX filenames against kebab-case with documented compound suffix exceptions.
- Counted `_helpers` directories and current helper file totals.
- Compared oversized production files against direct colocated Vitest pairs to identify likely coverage gaps.
- Searched for repeated `isRecord`/`isRecordValue` helper patterns to identify duplication candidates.
- No dev servers were started or restarted.

## Apply Focused Batch Block - 2026-06-19

### Batch Applied

- Focused P0 Ralph editor sub-batch: extracted Ralph AI prompt history normalization, equality, and append behavior from `src/tauri/ui/ralph/ralph-flow-editor.tsx`.
- Created module-specific helper file:
  - `src/tauri/ui/ralph/_helpers/normalize-ralph-ai-prompt-history.helper.ts`
    - Owns the 40-entry history limit, empty history constant, trimming/empty filtering, exact history comparison, adjacent duplicate suppression, and bounded prompt append behavior.
- Updated `src/tauri/ui/ralph/ralph-flow-editor.tsx` to import the extracted helper and keep React state/navigation orchestration in the editor.
- No public props, runtime APIs, file moves, or filename exceptions were introduced.

### Tests Added

- Created `src/tauri/ui/ralph/_helpers/normalize-ralph-ai-prompt-history.helper.spec.ts`.
- Coverage includes null/undefined/empty history, whitespace-only entries, trimming, non-adjacent duplicates, exact equality checks, empty prompt handling, adjacent duplicate suppression, and the 40-entry boundary when normalizing or appending.

### Verification Performed

- `pnpm vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/_helpers/normalize-ralph-ai-prompt-history.helper.spec.ts` - passed: 1 file, 8 tests.
- `pnpm typecheck:ui` - passed.
- `pnpm lint` - passed.
- No dev servers were started or restarted.

### Remaining Tasks

- Continue P0 reduction of `src/tauri/ui/ralph/ralph-flow-editor.tsx` with future focused batches for local node/edge components and remaining pure view-model/formatting helpers.
- Larger P0 work remains for `src/core/ralph.ts` and `src/tauri/ui/runtime.ts`; P1 work remains for `src/core/scheduler.ts` and `src/cli/_helpers/cli-args.ts`.

## Update Progress Block - 2026-06-19

### What Changed

- Expanded Ralph flow support for user-input and interview-style blocks across core, CLI, and Tauri UI surfaces.
- Added run resume and structured run-detail support:
  - CLI parsing now accepts `machdoch ralph resume <run-id>` with `--input-json` or `--input-json-file`.
  - CLI parsing now accepts `machdoch ralph run-detail <run-id>`.
  - UI runtime now exposes `resumeRalphRun` and `showRalphRunDetail`.
  - Ralph editor can load run history, open structured run details, and keep active-run button state scoped to the selected flow.
- Continued shrinking `src/tauri/ui/ralph/ralph-flow-editor.tsx` by importing Ralph editor helper modules for layout, attachments, formatting, block visuals, node previews, scope normalization, flow summaries, blank-flow creation, validation, and AI prompt history.
- Core Ralph runtime now tracks input-required, input-submitted, and input-cancelled events, supports `waiting-for-input` runs, stores checkpoints, and resumes from submitted input responses.
- Ralph flow parsing, validation, generation, layout, block-output derivation, placeholders, run records, and run specs were updated for the new ASK_USER and INTERVIEW block behavior.

### Files Created, Moved, Split, or Renamed

- Created helper files under `src/tauri/ui/ralph/_helpers/`:
  - `create-blank-ralph-flow.helper.ts`
  - `format-ralph-flow-labels.helper.ts`
  - `get-ralph-block-visual.helper.ts`
  - `get-ralph-node-preview.helper.ts`
  - `normalize-ralph-flow-scope.helper.ts`
  - `ralph-attachments.helper.ts`
  - `ralph-canvas-layout.helper.ts`
  - `upsert-flow-summary.helper.ts`
- Created focused helper specs:
  - `normalize-ralph-ai-prompt-history.helper.spec.ts`
  - `ralph-attachments.helper.spec.ts`
  - `ralph-canvas-layout.helper.spec.ts`
  - `ralph-flow-formatting.helper.spec.ts`
  - `ralph-flow-summaries.helper.spec.ts`
- No filesystem renames or moves were performed in this batch. The split was implemented by creating helper modules and updating imports/call sites.

### Tests Added or Updated

- Updated `src/core/__test__/ralph-run.spec.ts` for input/interview run behavior, checkpointing, and resume coverage.
- Updated `src/tauri/ui/ralph/ralph-flow-editor.test.tsx` for run history/detail behavior and active-run button scoping.
- Updated `src/tauri/ui/runtime.test.ts` for new Ralph runtime commands and argument generation.
- Added/updated Ralph UI helper specs for attachments, canvas layout, flow formatting, flow summaries, validation, and AI prompt history.
- Updated `vitest.ui.config.ts` so UI `.spec.ts` helper tests are included and excluded from coverage instrumentation.

### Validation Commands and Results

- Focused validation passed for this batch.
- Recorded passing checks from the focused Ralph/UI batch:
  - `pnpm vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/_helpers/normalize-ralph-ai-prompt-history.helper.spec.ts` - passed, 1 file and 8 tests.
  - `pnpm typecheck:ui` - passed.
  - `pnpm lint` - passed.
- No dev servers were started or restarted.

### Framework Filename Exceptions

- Existing documented exceptions still apply:
  - `src-tauri/**` follows Rust/Tauri native naming conventions and is outside the TypeScript filename scan.
  - `src/tauri/ui/preview/index.html` and `src/tauri/ui/preview/favicon.png` are framework/static asset names.
  - `src/shared/runtime-config.schema.json` is an accepted schema artifact name.
  - `src/core/runtime-contract.generated.ts` and `src/core/runtime-contract.generated.spec.ts` are generated contract artifacts.
- No new framework-required filename exceptions were introduced.

### Remaining Tasks

- Continue P0 reduction of `src/tauri/ui/ralph/ralph-flow-editor.tsx`, prioritizing local node/edge component extraction and remaining pure view-model helpers.
- Continue P0 split of `src/core/ralph.ts`; input/resume logic increased the need to isolate storage, checkpoint/resume, execution, and UI-analyze helpers with focused specs.
- Continue P0 split of `src/tauri/ui/runtime.ts` by extracting command argument builders, normalizers, and desktop input/config helpers.
- Continue P1 split of `src/core/scheduler.ts` and `src/cli/_helpers/cli-args.ts` once the Ralph P0 surfaces are stable.

## Inspect Repository Block - 2026-06-19

### Scope Inspected

- Read active workspace instructions in `.machdoch/instructions.md` and `.machdoch/instructions/security.instructions.md`.
- Inspected root project files: `package.json`, `pnpm-workspace.yaml`, `eslint.config.mjs`, `tsconfig.json`, `tsconfig.spec.json`, `tsconfig.ui.json`, `vite.ui.config.ts`, `vitest.config.ts`, `vitest.ui.config.ts`, and `components.json`.
- Inspected source layout with tracked files from `git ls-files`, representative core/CLI/UI helper files, representative specs, and current Ralph helper split under `src/tauri/ui/ralph/_helpers/`.
- Checked current worktree state with `git status --short`.
- No servers were started, restarted, or previewed during this inspection.

### Repository State

- Package manager is pinned to `pnpm@11.6.0`; workspace allow-build policy in `pnpm-workspace.yaml` keeps `@google/genai`, `esbuild`, and `protobufjs` build scripts disabled.
- Project is private ESM TypeScript, Node engine `>=20.10`, package name `machdoch`, version `0.17.0`.
- The app has a TypeScript CLI/core layer, a Tauri/Rust native layer in `src-tauri`, and a React/Tauri UI under `src/tauri/ui`.
- Current worktree already contains unstaged refactor changes across Ralph/core/CLI/UI files and an untracked `src/tauri/ui/ralph/_helpers/` directory; do not revert or normalize unrelated existing changes.
- `ralph-progress.md` exists in the workspace but is currently untracked according to `git status --short`.

### Scripts

- Build scripts:
  - `pnpm build` runs `tsc -p tsconfig.json`.
  - `pnpm build:cli-bundle` runs `node scripts/build-cli-bundle.mjs`.
  - `pnpm build:ui` runs `vite build --config vite.ui.config.ts`.
  - `pnpm generate:runtime-contract` runs `node scripts/generate-runtime-contract.mjs`.
- Verification scripts:
  - `pnpm lint` runs ESLint over `src`, `vite.ui.config.ts`, `vitest.config.ts`, and `vitest.ui.config.ts`.
  - `pnpm typecheck` runs `tsc --noEmit -p tsconfig.json`.
  - `pnpm typecheck:ui` runs `tsc -p tsconfig.ui.json --noEmit`.
  - `pnpm test` runs `vitest run`.
  - `pnpm test:ui` runs `vitest run --config vitest.ui.config.ts`.
  - `pnpm coverage` runs `vitest run --coverage`.
- Server/start scripts exist but must not be used for this refactor loop unless explicitly allowed: `dev`, `dev:ui`, `preview:ui`, `start`, `tauri:dev`, and related Tauri launch scripts.

### Test and Vitest Conventions

- Node/core Vitest config is `vitest.config.ts`:
  - `environment: "node"`.
  - `globals: true`.
  - Includes `src/**/*.spec.ts`.
  - Restores mocks and unstubs envs between tests.
  - Coverage uses V8, reports text/html, includes `src/core/**/*.ts`, and excludes `src/**/__test__/**/*.ts` plus `src/**/*.spec.ts`.
- UI Vitest config is `vitest.ui.config.ts`:
  - `environment: "jsdom"`.
  - `globals: true`.
  - Includes `src/tauri/ui/**/*.spec.ts`.
  - `fileParallelism: false`.
  - `passWithNoTests: true`.
  - Restores mocks.
  - Aliases `@` to `src` and Tauri APIs/plugins to `src/tauri/ui/test/tauri-test-mocks.ts`.
  - UI coverage includes `src/tauri/ui/**/*.ts` and `src/tauri/ui/**/*.tsx`, excluding `.test.*` and `.spec.ts`.
- Existing test filenames use a mix of `.spec.ts` for core/helper tests and `.test.ts`/`.test.tsx` for many UI component/model tests. UI `.spec.ts` helper tests are now included by the UI Vitest config.
- Tests commonly define local factory helpers such as `createResult`, `createRuntimeSnapshot`, `createMemoryEntry`, and use `describe`/`it`/`expect` globals.

### TypeScript and Lint Conventions

- Root `tsconfig.json` is strict with `noImplicitOverride`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `forceConsistentCasingInFileNames`, `NodeNext` modules, ES2022 target, declarations, source maps, and incremental build info in `.cache`.
- Root production build includes `src/**/*.ts` but excludes tests, `src/**/__test__`, and UI TypeScript/TSX.
- `tsconfig.spec.json` includes non-UI `src/**/*.spec.ts` and enables Vitest globals.
- `tsconfig.ui.json` uses `moduleResolution: "Bundler"`, `jsx: "react-jsx"`, DOM libs, `@/*` path alias to `src/*`, and includes `src/core/types.ts` plus all UI TS/TSX.
- ESLint uses `@eslint/js` recommended and `typescript-eslint` recommended rules for `src/**/*.{ts,tsx}` and root `*.ts`; `@typescript-eslint/no-explicit-any` is an error.
- Test and Vitest config files add Vitest globals through ESLint.

### Source Layout and Naming

- Top-level `src` directories:
  - `src/cli` for CLI entrypoints and command helpers.
  - `src/core` for runtime, Ralph, scheduler, MCP, task, provider, and execution logic.
  - `src/common` for shared UI-ish components.
  - `src/helpers` for general non-domain helpers.
  - `src/shared` for generated/shared artifacts such as `runtime-config.schema.json`.
  - `src/tauri/ui` for React desktop UI.
- Native Tauri/Rust code lives in `src-tauri` and follows Rust/Tauri conventions outside the TypeScript filename pattern.
- Helper directories are named `_helpers`; helper files commonly use kebab-case plus `.helper.ts` when they expose focused pure functions, with adjacent `.helper.spec.ts` tests for core/UI helper behavior.
- Core imports compiled TypeScript modules with `.js` extensions. Tests often import sibling TypeScript files with `.ts` extensions, enabled by `tsconfig.spec.json`.
- UI uses extensionless relative imports and the `@` alias where configured for UI/Vite contexts.
- Current Ralph UI split uses `src/tauri/ui/ralph/_helpers/` for extracted pure helpers such as canvas layout, attachments, local validation, block outputs, flow labels, prompt history, node previews, and flow summaries.
- Shared UI utility class merging is centralized in `src/tauri/ui/lib/utils.ts` as `cn(...)`, using `clsx` and `tailwind-merge`.

### Refactor Constraints and Conventions

- Workspace instructions require smallest safe steps, read-only inspection before edits, short progress tracking, and verification before declaring completion.
- Security instructions apply globally: avoid printing secrets, prefer read-only checks before package/system changes, and treat package installation as risky.
- Do not start or restart servers; existing background server/frontend should be assumed to exist and verified through health checks only if needed by later work.
- Prefer focused helper extraction over broad rewrites. Existing refactor trajectory targets continued P0 reduction of `src/tauri/ui/ralph/ralph-flow-editor.tsx`, `src/core/ralph.ts`, and `src/tauri/ui/runtime.ts`, then P1 work in `src/core/scheduler.ts` and `src/cli/_helpers/cli-args.ts`.
- Preserve current CLI/runtime contracts unless the specific refactor requires behavior changes and focused tests are updated.
- For future verification, start with targeted Vitest commands for affected `.spec.ts`/`.test.tsx` files, then run `pnpm typecheck`, `pnpm typecheck:ui`, and/or `pnpm lint` based on touched surfaces.

### Verification Performed

- Read-only inspection commands completed for instructions, package/config files, source layout, representative helpers/specs, and worktree state.
- This progress entry was added with no server startup and no package installation.

## Scan Violations Block - 2026-06-19 Refresh

### Scope and Method

- Scope inspected: all tracked `src/**/*.ts` and `src/**/*.tsx` files plus currently untracked source files under `src`, including the active Ralph helper split.
- Used read-only PowerShell and `git ls-files`/`git ls-files --others --exclude-standard` scans. No dev servers were started or restarted.
- Applied the TypeScript/refactor guidance for strict typing, helper boundaries, file size, naming, coverage, duplication, and maintainability.

### Current Inventory

- Total TypeScript/TSX files in scan: 356.
- Production TypeScript/TSX files: 233.
- Vitest test files: 123.
- Files over 500 lines: 71 total.
- Production files over 500 lines: 55.
- Test files over 500 lines: 16.
- Helper directories found:
  - `src/cli/_helpers`
  - `src/common/_helpers`
  - `src/core/_helpers`
  - `src/tauri/ui/_helpers`
  - `src/tauri/ui/chat-session/_helpers`
  - `src/tauri/ui/ralph/_helpers`

### Filename Scan

- No TypeScript/TSX filename violations were found under `src` after allowing documented suffixes such as `.helper`, `.model`, `.generated`, `.spec`, and `.test`.
- Documented framework/tooling exceptions remain:
  - `src-tauri/**` follows Rust/Tauri naming conventions and is outside this TypeScript filename scan.
  - `src/tauri/ui/preview/index.html` and `src/tauri/ui/preview/favicon.png` are framework/static asset names.
  - `src/shared/runtime-config.schema.json` is an accepted schema artifact.
  - `src/core/runtime-contract.generated.ts` and `src/core/runtime-contract.generated.spec.ts` are generated contract artifacts and should be changed through the generator, not hand-refactored.

### P0 Violations

1. `src/tauri/ui/ralph/ralph-flow-editor.tsx` is still oversized at 11,237 lines.
   - Progress since earlier scans: validation, canvas layout, attachments, flow summaries, blank-flow creation, labels, node previews, visual helpers, and prompt history logic have started moving into `src/tauri/ui/ralph/_helpers`.
   - Remaining violations: local node/edge component definitions, large editor orchestration, selection/state transitions, run history/detail handling, AI generation flow, forms, persistence formatting, and remaining view-model helpers still live in the main component.
   - Next tasks:
     - Move local node and edge components into `src/tauri/ui/ralph/components/`.
     - Extract editor state transition/view-model helpers into `src/tauri/ui/ralph/_helpers`.
     - Keep only React wiring, event binding, and composition in `ralph-flow-editor.tsx`.
     - Add focused UI helper specs before removing more logic from the editor.

2. `src/core/ralph.ts` is 5,317 lines and has no direct colocated `ralph.spec.ts`.
   - Existing Ralph behavior is covered mostly by integration-style tests under `src/core/__test__`, which is useful but weak for safe module extraction.
   - Violations: run orchestration, storage, checkpoints/resume, variable and placeholder resolution, utility execution, MCP/browser handling, artifact handling, UI analyze behavior, and logging are mixed in one core module.
   - Next tasks:
     - Extract storage/path and run-record operations into `src/core/_helpers/ralph-storage` style helpers.
     - Extract checkpoint/input resume behavior into a focused helper with specs.
     - Extract placeholder/template/attachment resolution separately from block execution.
     - Split utility/MCP/browser/UI-analyze executors by capability.
     - Keep `runRalphFlow` as the public orchestration facade.

3. `src/tauri/ui/runtime.ts` is 4,035 lines.
   - Violations: Tauri command wrappers, command argument building, runtime snapshot normalization, scheduler normalization, MCP config document editing, desktop file/clipboard fallbacks, settings defaults, and event mapping share one file.
   - Existing `runtime.test.ts` is broad and should not remain the only protection for extracted business logic.
   - Next tasks:
     - Move command argument builders into UI helper modules with direct tests.
     - Move scheduler/runtime normalizers into `src/tauri/ui/_helpers`.
     - Move MCP config document helpers and desktop input fallbacks into focused helper files.
     - Keep `runtime.ts` as a thin bridge around `invoke`, event subscriptions, and exported runtime APIs.

4. `src/core/scheduler.ts` is 3,113 lines.
   - Violations: state storage, locking/atomic writes, migrations, trigger normalization, prompt discovery/frontmatter parsing, event filtering, retry/dedupe rules, queue control, and execution orchestration are combined.
   - Existing `scheduler.spec.ts` is broad; helper-level coverage is needed before splitting high-risk behavior.
   - Next tasks:
     - Extract scheduler state storage/locking.
     - Extract trigger/job normalization.
     - Extract prompt discovery and frontmatter parsing.
     - Extract event filter and dedupe rendering helpers.
     - Preserve the public scheduler API in `scheduler.ts`.

5. `src/cli/_helpers/cli-args.ts` is 2,284 lines and has no direct colocated parser spec.
   - Violations: many command-family parsers and defaults are implemented in one helper.
   - Next tasks:
     - Split into Ralph, scheduler, MCP, config, provider/model, and shared primitive parsers.
     - Add parser specs for invalid combinations, defaults, aliases, and positional arguments.

### P1 Oversized and Boundary Tasks

- `src/tauri/ui/chat-session/_helpers/use-chat-session-controller.ts` (2,457 lines): split lifecycle, submission, attachment, voice, settings, and remote-control behavior; extract pure state transitions into tested helpers.
- `src/core/ralph-generation.ts` (2,318 lines): split prompt assembly, interview state, JSON parsing/repair, validation, and persistence boundaries.
- `src/tauri/ui/marketplace/mcp-marketplace.tsx` (2,198 lines): move marketplace data/view-model logic under `src/tauri/ui/marketplace/_helpers` and leave the component focused on rendering.
- `src/tauri/ui/chat-session.model.ts` (1,949 lines): split message/timeline/status derivation into focused model helpers while preserving existing model tests.
- `src/tauri/ui/chat-session/_helpers/use-chat-session-runtime.ts` (1,914 lines): separate runtime event handling, command dispatch, and normalization helpers.
- `src/core/mcp/client.ts` (1,820 lines): split transport/session handling, config normalization, cache behavior, and result conversion.
- `src/core/agent-runtime.ts` (1,647 lines): extract provider/session orchestration and tool/autopilot helpers after Ralph P0 work stabilizes.
- `src/tauri/ui/chat-session/components/scheduler-panel.tsx` (1,597 lines): extract form normalization, scheduler view model, and mutation helpers.
- `src/core/mcp/marketplace.ts` (1,393 lines) and `src/core/mcp/config.ts` (1,135 lines): split persistence/parsing/fetch/enrichment/config mutation helpers.
- `src/cli/_helpers/cli-ralph-commands.ts` (1,236 lines) and `src/cli/_helpers/cli-scheduler-commands.ts` (1,032 lines): split command execution helpers after `cli-args.ts` parser extraction.

### Tool Definition Split Candidates

- Large schema/definition files are mostly declarative, but still exceed maintainability limits and should be split by capability group while preserving exported arrays and compatibility tests:
  - `src/core/_helpers/utility-tool-definitions.ts` (1,989 lines)
  - `src/core/_helpers/package-tool-definitions.ts` (1,886 lines)
  - `src/core/mcp/tool-definitions.ts` (1,758 lines)
  - `src/core/_helpers/scheduler-tool-definitions.ts` (1,748 lines)
  - `src/core/_helpers/browser-tool-definitions.ts` (1,707 lines)
  - `src/core/_helpers/desktop-ui-tool-definitions.ts` (1,240 lines)
  - `src/core/_helpers/macro-recorder-tool-definitions.ts` (1,190 lines)

### Coverage Gaps and Weak Coverage

- Oversized production files with no direct colocated test pair remain high-risk:
  - `src/core/ralph.ts`
  - `src/tauri/ui/chat-session/_helpers/use-chat-session-controller.ts`
  - `src/core/ralph-generation.ts`
  - `src/cli/_helpers/cli-args.ts`
  - `src/tauri/ui/marketplace/mcp-marketplace.tsx`
  - `src/core/agent-runtime.ts`
  - `src/tauri/ui/chat-session/components/scheduler-panel.tsx`
  - `src/tauri/ui/chat-session/components/settings-dialog-panels/instruction-settings-panel.tsx`
  - `src/core/_helpers/desktop-ui-tool-definitions.ts`
  - `src/cli/_helpers/cli-ralph-commands.ts`
  - `src/tauri/ui/chat-session/_helpers/use-remote-mission-control.ts`
  - `src/tauri/ui/chat-session/components/settings-dialog-panels/mcp-settings-panel.tsx`
  - `src/core/ralph-watches.ts`
- Oversized files with tests but weak extraction coverage:
  - `src/tauri/ui/ralph/ralph-flow-editor.tsx` has broad UI tests and several helper specs; remaining component/view-model extraction needs narrower specs.
  - `src/tauri/ui/runtime.ts` has `runtime.test.ts`; helper-level specs are still needed for normalizers, argument builders, and desktop fallbacks.
  - `src/core/scheduler.ts` has `scheduler.spec.ts`; storage, event filtering, prompt discovery, and normalization need focused tests.
  - `src/core/mcp/client.ts`, `src/core/mcp/config.ts`, and `src/core/mcp/marketplace.ts` have specs, but extraction should preserve compatibility tests and add focused helper tests for parsing/normalization.

### Duplication and Helper Boundary Findings

- Repeated `isRecord`/`isRecordValue` style guards appear across CLI, core, MCP, Ralph, scheduler, UI runtime, shell-store, marketplace, and chat-session modules.
  - Do not promote blindly to `src/helpers`; first confirm identical semantics during local extraction.
  - If a guard remains domain-neutral after two or more modules share the exact same behavior, promote to `src/helpers`.
- `src/helpers/normalize-optional-string.helper.ts` remains correctly placed as truly shared logic.
- Chat-session-only normalization should stay in `src/tauri/ui/chat-session/_helpers` unless another UI module imports it.
- UI runtime, remote-control, dropped-path, clipboard, and scheduler normalizers should stay in `src/tauri/ui/_helpers` because they depend on UI/runtime contracts.
- Ralph editor flow, node, attachment, canvas, and prompt helpers correctly belong in `src/tauri/ui/ralph/_helpers`, not global `src/helpers`.
- Core Ralph storage/resolution/execution helpers belong in `src/core/_helpers`; only type-independent primitives should be considered for `src/helpers`.
- `src/common/_helpers` is still a boundary placeholder for common UI helpers. Keep it empty for now or remove it in a dedicated cleanup if no planned common UI helper will use it.

### Maintainability Findings

- The largest files mix business rules and framework glue, which makes refactoring risky without helper-level tests.
- Several hooks/components have oversized functions and many local closures, especially Ralph editor, chat-session controller/runtime, marketplace, and scheduler panel surfaces.
- Broad integration tests are valuable but hide exact business-rule ownership; focused helper specs should be added in the same batch as each extraction.
- Avoid large moves/renames while the worktree contains existing Ralph changes. Continue using additive helper extraction and import rewiring in small batches.

### Prioritized Remaining-Work Checklist

- [ ] P0: Continue `ralph-flow-editor.tsx` reduction by extracting node/edge components and remaining pure editor view-model helpers with focused specs.
- [ ] P0: Split `src/core/ralph.ts` into storage, checkpoint/resume, resolution, utility/MCP/browser execution, UI-analyze, artifact, and orchestration helpers with direct core specs.
- [ ] P0: Split `src/tauri/ui/runtime.ts` into thin Tauri bridge plus tested command argument, normalizer, MCP config, and desktop fallback helpers.
- [ ] P1: Split `src/core/scheduler.ts` into state storage, normalization, prompt discovery, event filtering, retry/dedupe, and orchestration helpers.
- [ ] P1: Split `src/cli/_helpers/cli-args.ts` by command family and add direct parser coverage.
- [ ] P1: Reduce chat-session controller/runtime/model files by extracting pure state transitions and smaller side-effect hooks.
- [ ] P2: Split large tool-definition modules by family/schema group while preserving public exports and compatibility specs.
- [ ] P2: Review MCP client/config/marketplace modules for transport, persistence, parsing, enrichment, and mutation helper extraction.
- [ ] P2: Review marketplace, scheduler-panel, and settings-panel UI files for view-model extraction and component decomposition.
- [ ] P3: Decide whether `src/common/_helpers` should remain reserved for future common UI helpers or be removed as an empty placeholder.

### Verification Performed

- Re-read active workspace and security instructions.
- Read the refactor-code and TypeScript development guidelines skills for this scan.
- Checked current worktree state with `git status --short`; existing modified/untracked Ralph loop work is present and was not reverted.
- Enumerated tracked and untracked `src/**/*.ts`/`src/**/*.tsx` files.
- Counted production files, test files, and files over 500 lines.
- Checked TypeScript/TSX filenames against kebab-case with documented suffix exceptions.
- Enumerated `_helpers` directories.
- Compared the 30 largest production files against direct colocated `.spec.ts`, `.spec.tsx`, `.test.ts`, and `.test.tsx` pairs.
- Searched for repeated `isRecord`/`isRecordValue` patterns as duplication candidates.
- Updated only `ralph-progress.md`.

## Apply Focused Batch Block

Date: 2026-06-19

### Batch Applied

- Extracted one focused P0 Ralph editor helper batch from `src/tauri/ui/ralph/ralph-flow-editor.tsx`.
- Moved run-duration formatting into `src/tauri/ui/ralph/_helpers/format-duration-ms.helper.ts`.
- Moved run-record event label formatting into `src/tauri/ui/ralph/_helpers/get-ralph-record-event-label.helper.ts`.
- Moved Ralph desktop task id, task argument, flow reference, scope, and workspace comparison helpers into `src/tauri/ui/ralph/_helpers/parse-ralph-run-task-id.helper.ts`.
- Updated `ralph-flow-editor.tsx` to import those helpers and removed the extracted local closures.

### Tests Added

- Added focused helper specs:
  - `src/tauri/ui/ralph/_helpers/format-duration-ms.helper.spec.ts`
  - `src/tauri/ui/ralph/_helpers/get-ralph-record-event-label.helper.spec.ts`
  - `src/tauri/ui/ralph/_helpers/parse-ralph-run-task-id.helper.spec.ts`
- Coverage includes normal cases, invalid and empty inputs, null/undefined workspace input, boundary duration rounding, missing timestamps, invalid task ids, task scope defaults, and all Ralph run event label branches.

### Verification Performed

- `pnpm vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/_helpers/format-duration-ms.helper.spec.ts src/tauri/ui/ralph/_helpers/get-ralph-record-event-label.helper.spec.ts src/tauri/ui/ralph/_helpers/parse-ralph-run-task-id.helper.spec.ts`
  - Passed: 3 files, 38 tests.
- `pnpm typecheck:ui`
  - Passed.
- `pnpm exec eslint src/tauri/ui/ralph/ralph-flow-editor.tsx src/tauri/ui/ralph/_helpers/format-duration-ms.helper.ts src/tauri/ui/ralph/_helpers/format-duration-ms.helper.spec.ts src/tauri/ui/ralph/_helpers/get-ralph-record-event-label.helper.ts src/tauri/ui/ralph/_helpers/get-ralph-record-event-label.helper.spec.ts src/tauri/ui/ralph/_helpers/parse-ralph-run-task-id.helper.ts src/tauri/ui/ralph/_helpers/parse-ralph-run-task-id.helper.spec.ts`
  - Passed.
- Attempted `pnpm vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/ralph-flow-editor.test.tsx`.
  - Not selected by the current UI Vitest config because it includes `src/tauri/ui/**/*.spec.ts` only.

### Remaining Notes

- `src/tauri/ui/ralph/ralph-flow-editor.tsx` is still oversized at 11,903 lines after this batch.
- The broader P0 Ralph editor item remains open; continue with one focused extraction at a time because the worktree already contains other Ralph-loop changes.

## Update Progress Block

Date: 2026-06-19

### What Changed

- Recorded the latest validated Ralph focused batch across CLI, core Ralph runtime/generation, UI runtime, and the Ralph flow editor.
- Ralph editor work continued reducing inline helper logic by using extracted helpers for flow creation/scope/summary handling, canvas layout, attachment handling, prompt history normalization, preview/label formatting, block outputs, local validation, run duration formatting, run event labels, and desktop task id parsing.
- Core Ralph work expanded runtime behavior around run records, placeholders, flow parsing/validation, layout, generation, and run execution while preserving existing public surfaces.
- CLI and UI runtime changes were updated alongside tests for Ralph and scheduler command behavior plus runtime/Ralph UI coverage.

### Files Renamed, Moved, Split, or Created

- No existing files were renamed or moved by filesystem operation.
- Created Ralph UI helper modules under `src/tauri/ui/ralph/_helpers/`:
  - `create-blank-ralph-flow.helper.ts`
  - `create-flow-alias.helper.ts`
  - `format-duration-ms.helper.ts`
  - `format-ralph-flow-labels.helper.ts`
  - `get-block-outputs.helper.ts`
  - `get-ralph-block-visual.helper.ts`
  - `get-ralph-node-preview.helper.ts`
  - `get-ralph-record-event-label.helper.ts`
  - `normalize-ralph-ai-prompt-history.helper.ts`
  - `normalize-ralph-flow-scope.helper.ts`
  - `parse-ralph-run-task-id.helper.ts`
  - `ralph-attachments.helper.ts`
  - `ralph-canvas-layout.helper.ts`
  - `upsert-flow-summary.helper.ts`
  - `validate-flow-locally.helper.ts`
- Added focused Ralph UI helper specs:
  - `format-duration-ms.helper.spec.ts`
  - `get-ralph-record-event-label.helper.spec.ts`
  - `normalize-ralph-ai-prompt-history.helper.spec.ts`
  - `parse-ralph-run-task-id.helper.spec.ts`
  - `ralph-attachments.helper.spec.ts`
  - `ralph-canvas-layout.helper.spec.ts`
  - `ralph-flow-formatting.helper.spec.ts`
  - `ralph-flow-summaries.helper.spec.ts`
  - `validate-flow-locally.helper.spec.ts`
- Updated existing files in this batch include:
  - `src/tauri/ui/ralph/ralph-flow-editor.tsx`
  - `src/tauri/ui/ralph/ralph-flow-editor.test.tsx`
  - `src/tauri/ui/runtime.ts`
  - `src/tauri/ui/runtime.test.ts`
  - `src/core/ralph.ts`
  - `src/core/ralph-generation.ts`
  - `src/core/ralph-layout.ts`
  - `src/core/__test__/ralph-run.spec.ts`
  - `src/core/_helpers/create-ralph-run-record.helper.ts`
  - `src/core/_helpers/get-ralph-block-outputs.helper.ts`
  - `src/core/_helpers/parse-ralph-flow-record.helper.ts`
  - `src/core/_helpers/ralph-placeholders.helper.ts`
  - `src/core/_helpers/validate-ralph-flow-blocks.helper.ts`
  - `src/cli/_helpers/cli-args.ts`
  - `src/cli/_helpers/cli-ralph-commands.ts`
  - `src/cli/_helpers/cli-scheduler-commands.ts`
  - `vitest.ui.config.ts`

### Tests Added or Updated

- Added focused helper-level coverage for Ralph UI duration formatting, event labels, prompt history, run task id parsing, attachments, canvas layout, flow formatting/summaries, and local validation.
- Updated Ralph editor UI tests, UI runtime tests, and core Ralph run tests to cover the newly refactored behavior.
- Validation was reported as passed for this focused batch before this progress update.

### Validation Commands and Results

- Focused Ralph UI helper Vitest runs: passed.
- Ralph editor/runtime/core Ralph related tests updated for the batch: passed in the focused validation batch.
- UI type/lint checks for the touched Ralph UI helper/editor surface were previously recorded as passed.
- No dev server or frontend server was started or restarted.

### Framework-Required Filename Exceptions

- Existing filename exceptions remain documented and unchanged:
  - `src-tauri/**` follows Rust/Tauri native conventions.
  - `src/tauri/ui/preview/index.html` and `src/tauri/ui/preview/favicon.png` are framework/static asset names.
  - `src/shared/runtime-config.schema.json` is an accepted schema artifact.
  - `src/core/runtime-contract.generated.ts` and `src/core/runtime-contract.generated.spec.ts` are generated contract artifacts.
- New Ralph helper and spec filenames follow the existing kebab-case plus `.helper`, `.spec`, and `.test` conventions; no new filename exceptions were introduced.

### Remaining Tasks

- Continue P0 reduction of `src/tauri/ui/ralph/ralph-flow-editor.tsx`, especially local node/edge components, editor state transitions, run history/detail UI, AI generation flow, forms, and remaining view-model helpers.
- Continue P0 splitting of `src/core/ralph.ts` into storage, checkpoint/resume, resolution, utility/MCP/browser execution, UI-analyze, artifact, and orchestration helpers with direct core specs.
- Continue P0 splitting of `src/tauri/ui/runtime.ts` into a thinner Tauri bridge plus tested command argument, normalizer, MCP config, and desktop fallback helpers.
- Continue P1 work for `src/core/scheduler.ts` and `src/cli/_helpers/cli-args.ts` after the current Ralph P0 work is stable.

## Scan Violations Block - Current Re-Scan

Date: 2026-06-19

### Scope and Method

- Scope inspected: all current `src/**/*.ts` and `src/**/*.tsx` files.
- Excluded from source-quality counts: dependency/build/generated runtime directories outside `src`, including `node_modules`, `dist`, `.cache`, and `.machdoch` run artifacts.
- Current inventory:
  - 362 TypeScript/TSX files under `src`.
  - 236 production files.
  - 126 Vitest test files.
  - 71 total source/test files over 500 lines.
  - 55 production files over 500 lines.
- Current helper roots:
  - `src/cli/_helpers`
  - `src/common/_helpers`
  - `src/core/_helpers`
  - `src/tauri/ui/_helpers`
  - `src/tauri/ui/chat-session/_helpers`
  - `src/tauri/ui/ralph/_helpers`
  - `src/helpers`

### Filename Violations and Exceptions

- Current result: no TypeScript/TSX filename violations under `src` after allowing the established compound suffixes `.helper`, `.model`, `.generated`, `.spec`, and `.test`.
- Documented exceptions that should remain accepted:
  - `src-tauri/**` follows Rust/Tauri native conventions and is outside the TypeScript filename scan.
  - `src/tauri/ui/preview/index.html` and `src/tauri/ui/preview/favicon.png` are framework/static asset names.
  - `src/shared/runtime-config.schema.json` is an accepted schema artifact.
  - `src/core/runtime-contract.generated.ts` and `src/core/runtime-contract.generated.spec.ts` are generated contract artifacts and should be changed through the generator.

### P0 Refactoring Violations

1. `src/tauri/ui/ralph/ralph-flow-editor.tsx` is 11,141 lines.
   - Violations: oversized React component, still mixing editor orchestration, selection state, run history/detail behavior, AI generation flow, forms, local node/edge components, and remaining view-model logic.
   - Progress: many pure helpers have already moved into `src/tauri/ui/ralph/_helpers`, including flow creation/scope/summary handling, canvas layout, attachments, prompt history, preview/label formatting, local validation, run duration formatting, event labels, and desktop task id parsing.
   - Concrete next tasks:
     - Move remaining local node/edge component definitions into `src/tauri/ui/ralph/components/`.
     - Extract editor state transition helpers and run-history/detail view-model helpers into `src/tauri/ui/ralph/_helpers`.
     - Extract AI generation form and persistence formatting helpers with direct specs.
     - Keep `ralph-flow-editor.tsx` focused on React composition, event wiring, and integration.

2. `src/core/ralph.ts` is 5,317 lines and still has no direct colocated `ralph.spec.ts`.
   - Violations: run orchestration, storage/path operations, run records, checkpoints/resume, variable/template resolution, utility execution, MCP/browser/UI-analyze handling, artifact handling, and logging remain combined.
   - Concrete next tasks:
     - Extract storage/path/run-record operations into `src/core/_helpers/ralph-storage...` helpers.
     - Extract checkpoint and resume input behavior into focused helpers with specs.
     - Extract placeholder/template/attachment resolution separately from block execution.
     - Split utility, MCP, browser, and UI-analyze executors by capability.
     - Preserve `runRalphFlow` as the public orchestration facade.

3. `src/tauri/ui/runtime.ts` is 4,035 lines.
   - Violations: Tauri command wrappers, command argument construction, runtime snapshot normalization, scheduler normalization, MCP config document editing, desktop file/clipboard fallbacks, settings defaults, and event mapping share one bridge file.
   - Concrete next tasks:
     - Move command argument builders into UI helper modules with direct tests.
     - Move scheduler/runtime normalizers into `src/tauri/ui/_helpers`.
     - Move MCP config document helpers into `src/tauri/ui/_helpers/mcp-config-document...`.
     - Move dropped-path and clipboard fallback helpers into `src/tauri/ui/_helpers/desktop-input-fallbacks...`.
     - Keep `runtime.ts` as a thin bridge around `invoke`, event subscriptions, and exported APIs.

4. `src/core/scheduler.ts` is 3,113 lines.
   - Violations: state storage, locking/atomic writes, migrations, trigger normalization, prompt discovery/frontmatter parsing, event filtering, retry/dedupe rules, queue control, and execution orchestration are combined.
   - Concrete next tasks:
     - Extract state storage and locking helpers.
     - Extract trigger/job normalization helpers.
     - Extract prompt discovery and frontmatter parsing helpers.
     - Extract event filtering and dedupe rendering helpers.
     - Keep the public scheduler API stable in `scheduler.ts`.

5. `src/cli/_helpers/cli-args.ts` is 2,284 lines and has no direct colocated parser spec.
   - Violations: command-family parsing, defaults, aliases, validation, and help text for unrelated command families live in one helper.
   - Concrete next tasks:
     - Split parser logic into Ralph, scheduler, MCP, config/provider/model, instruction, and shared primitive parser helpers.
     - Add direct parser specs for invalid combinations, defaults, aliases, positional arguments, and JSON/file argument handling.

### P1 Oversized and Boundary Tasks

- `src/tauri/ui/chat-session/_helpers/use-chat-session-controller.ts` (2,457 lines): split lifecycle, submission, attachment, voice, settings, remote-control, and reducer-like state transition logic.
- `src/core/ralph-generation.ts` (2,318 lines): split prompt assembly, interview state, JSON parsing/repair, validation, layout handoff, and persistence boundaries.
- `src/tauri/ui/marketplace/mcp-marketplace.tsx` (2,198 lines): move marketplace data/view-model logic under `src/tauri/ui/marketplace/_helpers`; leave the component focused on rendering and interaction.
- `src/tauri/ui/chat-session.model.ts` (1,949 lines): split timeline/message/task/status derivation into focused model helpers while preserving existing model tests.
- `src/tauri/ui/chat-session/_helpers/use-chat-session-runtime.ts` (1,914 lines): separate runtime event handling, command dispatch, normalization, and local UI state synchronization.
- `src/core/mcp/client.ts` (1,820 lines): split transport/session handling, config normalization, cache behavior, and result conversion.
- `src/core/agent-runtime.ts` (1,647 lines): extract provider/session orchestration, tool execution helpers, and autopilot helpers after Ralph P0 work stabilizes.
- `src/tauri/ui/chat-session/components/scheduler-panel.tsx` (1,597 lines): extract form normalization, scheduler view model, and mutation helpers.
- `src/core/mcp/marketplace.ts` (1,393 lines) and `src/core/mcp/config.ts` (1,135 lines): split persistence, parsing, fetch/enrichment, and config mutation helpers.
- `src/cli/_helpers/cli-ralph-commands.ts` (1,236 lines) and `src/cli/_helpers/cli-scheduler-commands.ts` (1,032 lines): split command execution helpers after parser extraction.

### P2 Tool Definition and Helper-Size Tasks

- Large tool-definition files are mostly declarative, but still exceed the 500-line maintainability target and should be split by capability group while preserving exported arrays and compatibility specs:
  - `src/core/_helpers/utility-tool-definitions.ts` (1,989 lines)
  - `src/core/_helpers/package-tool-definitions.ts` (1,886 lines)
  - `src/core/mcp/tool-definitions.ts` (1,758 lines)
  - `src/core/_helpers/scheduler-tool-definitions.ts` (1,748 lines)
  - `src/core/_helpers/browser-tool-definitions.ts` (1,707 lines)
  - `src/core/_helpers/desktop-ui-tool-definitions.ts` (1,240 lines)
  - `src/core/_helpers/macro-recorder-tool-definitions.ts` (1,190 lines)
- Existing helper files that have grown too large should be treated as refactor targets, not automatically accepted because they are in `_helpers`:
  - `src/tauri/ui/chat-session/_helpers/use-chat-session-controller.ts` (2,457 lines)
  - `src/tauri/ui/chat-session/_helpers/use-chat-session-runtime.ts` (1,914 lines)
  - `src/tauri/ui/chat-session/_helpers/use-remote-mission-control.ts` (1,176 lines)
  - `src/core/_helpers/external-agent-provider.ts` (966 lines)
  - `src/tauri/ui/chat-session/_helpers/use-chat-session-shell-state.ts` (753 lines)
  - `src/core/_helpers/parse-ralph-flow-record.helper.ts` (607 lines)

### Coverage Gaps and Weak Coverage

- Oversized production files over 500 lines with no direct colocated `.spec.ts`, `.spec.tsx`, `.test.ts`, or `.test.tsx` pair remain high-risk:
  - `src/core/ralph.ts`
  - `src/tauri/ui/chat-session/_helpers/use-chat-session-controller.ts`
  - `src/core/ralph-generation.ts`
  - `src/cli/_helpers/cli-args.ts`
  - `src/tauri/ui/marketplace/mcp-marketplace.tsx`
  - `src/core/agent-runtime.ts`
  - `src/tauri/ui/chat-session/components/scheduler-panel.tsx`
  - `src/tauri/ui/chat-session/components/settings-dialog-panels/instruction-settings-panel.tsx`
  - `src/core/_helpers/desktop-ui-tool-definitions.ts`
  - `src/cli/_helpers/cli-ralph-commands.ts`
  - `src/tauri/ui/chat-session/_helpers/use-remote-mission-control.ts`
  - `src/tauri/ui/chat-session/components/settings-dialog-panels/mcp-settings-panel.tsx`
  - `src/core/ralph-watches.ts`
  - `src/core/provider-model-registry.ts`
  - `src/cli/_helpers/cli-summary-commands.ts`
  - `src/tauri/ui/lib/shell-store.ts`
  - `src/core/ralph-layout.ts`
- Oversized files with tests but weak extraction coverage:
  - `src/tauri/ui/ralph/ralph-flow-editor.tsx` has UI tests and many helper specs, but remaining component/view-model extractions need narrower tests.
  - `src/tauri/ui/runtime.ts` has `runtime.test.ts`, but normalizers, command builders, MCP document editing, and desktop fallbacks need helper-level specs.
  - `src/core/scheduler.ts` has `scheduler.spec.ts`, but storage, event filtering, prompt discovery, and normalization should be covered separately.
  - `src/core/mcp/client.ts`, `src/core/mcp/config.ts`, and `src/core/mcp/marketplace.ts` have specs, but extraction should keep compatibility tests and add focused helper specs for parsing/normalization.

### Duplication and Helper Boundary Findings

- Repeated `isRecord` / `isRecordValue` style type guards appear across CLI, core, MCP, scheduler, Ralph, UI runtime, shell-store, marketplace, and chat-session code.
  - Do not promote blindly to `src/helpers`; first confirm identical semantics during nearby extraction.
  - If an identical domain-neutral guard remains shared by multiple modules after extraction, promote it to `src/helpers`.
- `src/helpers/normalize-optional-string.helper.ts` and `src/helpers/sort-entry-names.helper.ts` remain correctly placed as truly shared helpers.
- Chat-session-only normalization and controller/runtime helpers should remain under `src/tauri/ui/chat-session/_helpers`.
- Ralph editor flow, node, attachment, canvas, prompt, validation, and preview helpers correctly belong under `src/tauri/ui/ralph/_helpers`, not global `src/helpers`.
- UI runtime, scheduler UI, remote-control, dropped-path, clipboard, and settings normalizers should stay under `src/tauri/ui/_helpers` because they depend on UI/runtime contracts.
- Core Ralph storage/resolution/execution helpers belong in `src/core/_helpers`; only type-independent primitives should be considered for `src/helpers`.
- `src/common/_helpers` remains an empty/placeholder helper boundary. Either use it for genuine common UI helpers in a future extraction or remove it in a dedicated cleanup.

### Maintainability Findings

- The worst files still mix framework glue with business rules, making direct edits risky without helper-level tests.
- Several large hooks/components contain many local closures and state transitions that should become pure, named helpers before additional UI changes.
- Tool-definition files are declarative but too large for easy review; split them only after compatibility tests lock down exported schemas.
- Broad integration tests are useful but should not be the only protection for business logic that is being moved.
- Continue additive helper extraction and import rewiring in small batches because the current worktree already contains uncommitted Ralph-loop changes.

### Prioritized Remaining-Work Checklist

- [ ] P0: Continue reducing `src/tauri/ui/ralph/ralph-flow-editor.tsx` by extracting local node/edge components, editor state transitions, run history/detail helpers, AI generation form helpers, and persistence formatting with focused specs.
- [ ] P0: Split `src/core/ralph.ts` into storage, checkpoint/resume, resolution, utility/MCP/browser execution, UI-analyze, artifact, and orchestration helpers with direct core specs.
- [ ] P0: Split `src/tauri/ui/runtime.ts` into a thin Tauri bridge plus tested command argument, normalizer, MCP config document, and desktop fallback helpers.
- [ ] P1: Split `src/core/scheduler.ts` into state storage, normalization, prompt discovery, event filtering, retry/dedupe, and orchestration helpers.
- [ ] P1: Split `src/cli/_helpers/cli-args.ts` by command family and add direct parser coverage.
- [ ] P1: Reduce chat-session controller/runtime/model files by extracting pure state transitions and smaller side-effect hooks.
- [ ] P1: Split `src/core/ralph-generation.ts` into prompt assembly, interview, parsing/repair, validation, layout, and persistence helpers.
- [ ] P2: Split large tool-definition modules by family/schema group while preserving public exports and compatibility specs.
- [ ] P2: Review MCP client/config/marketplace modules for transport, persistence, parsing, enrichment, and mutation helper extraction.
- [ ] P2: Review marketplace, scheduler-panel, settings-panel, shell-store, and task-thinking UI files for view-model extraction and component decomposition.
- [ ] P3: Decide whether `src/common/_helpers` should remain reserved for future common UI helpers or be removed as an empty placeholder.

### Verification Performed

- Re-read `.machdoch/instructions.md` and `.machdoch/instructions/security.instructions.md`.
- Read and applied the `refactor-code` and `typescript-development-guidelines` skill instructions for this scan.
- Checked current worktree state with `git status --short`; existing modified/untracked Ralph-loop work is present and was not reverted.
- Counted current `src/**/*.ts` and `src/**/*.tsx` production/test files.
- Checked TypeScript/TSX filenames against kebab-case with documented compound suffix exceptions.
- Enumerated active `_helpers` directories.
- Ranked current production files over 500 lines.
- Compared oversized production files against direct colocated Vitest test pairs.
- Scanned for repeated type-guard and normalization patterns as duplication/helper-boundary candidates.
- Updated only `ralph-progress.md`; no implementation files were changed for this scan block.

## Apply Focused Batch Block - 2026-06-19

### Batch Applied

- Applied one focused P0 Ralph editor component extraction batch from `src/tauri/ui/ralph/ralph-flow-editor.tsx`.
- Moved the local React Flow canvas renderers into `src/tauri/ui/ralph/components/ralph-flow-canvas-elements.tsx`:
  - `RalphNoteNode`
  - `RalphGroupNode`
  - `RalphBlockNode`
  - `RalphRouteEdge`
  - `RALPH_NODE_TYPES`
  - `RALPH_EDGE_TYPES`
- Updated `ralph-flow-editor.tsx` to import the node/edge type maps from the new component boundary.
- Removed stale editor imports for React Flow primitives, node sizing constants, node preview helpers, and canvas node data types that are now owned by the component file.

### Tests Added or Updated

- No new business helper was introduced in this component-only extraction.
- Existing focused Ralph UI helper specs were rerun for the business logic that feeds the moved components:
  - `src/tauri/ui/ralph/_helpers/ralph-canvas-layout.helper.spec.ts`
  - `src/tauri/ui/ralph/_helpers/ralph-flow-formatting.helper.spec.ts`

### File Size and Naming Notes

- New file follows the allowed kebab-case component filename pattern.
- `src/tauri/ui/ralph/components/ralph-flow-canvas-elements.tsx` is 313 lines, below the 500-line split threshold.
- `src/tauri/ui/ralph/ralph-flow-editor.tsx` remains oversized and is now 11,602 lines in the current worktree.

### Verification Performed

- `pnpm exec eslint src/tauri/ui/ralph/ralph-flow-editor.tsx src/tauri/ui/ralph/components/ralph-flow-canvas-elements.tsx` - passed.
- `pnpm typecheck:ui` - passed.
- `pnpm vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/_helpers/ralph-canvas-layout.helper.spec.ts src/tauri/ui/ralph/_helpers/ralph-flow-formatting.helper.spec.ts` - passed, 2 files and 25 tests.
- No dev server or frontend server was started or restarted.

### Remaining Tasks

- Continue P0 reduction of `src/tauri/ui/ralph/ralph-flow-editor.tsx` with future focused batches for editor state transitions, run history/detail helpers, AI generation form helpers, and persistence formatting.
- Continue P0 splitting of `src/core/ralph.ts` and `src/tauri/ui/runtime.ts` after the Ralph editor component boundary is stable.

## Update Progress Block - 2026-06-19

### What Changed

- Recorded the validation-passed Ralph focused batch in this progress file.
- The focused batch reduced `src/tauri/ui/ralph/ralph-flow-editor.tsx` by moving React Flow node/edge rendering out of the editor and into a component boundary.
- Existing Ralph helper extraction work remains present in the worktree across UI helper, core Ralph, CLI Ralph/scheduler, runtime, and validation surfaces.

### Files Renamed, Moved, Split, or Created

- Created `src/tauri/ui/ralph/components/ralph-flow-canvas-elements.tsx` for:
  - `RalphNoteNode`
  - `RalphGroupNode`
  - `RalphBlockNode`
  - `RalphRouteEdge`
  - `RALPH_NODE_TYPES`
  - `RALPH_EDGE_TYPES`
- Split component rendering responsibility out of `src/tauri/ui/ralph/ralph-flow-editor.tsx`.
- Created Ralph UI helper/spec files under `src/tauri/ui/ralph/_helpers/` for attachments, canvas layout, flow formatting, summaries, validation, prompt history, event labels, duration formatting, task id parsing, flow scope, aliases, blank flow creation, node previews, block visuals, and block outputs.
- No file rename was detected in this update block.

### Tests Added or Updated

- Added focused Ralph UI helper specs for:
  - `format-duration-ms.helper.spec.ts`
  - `get-ralph-record-event-label.helper.spec.ts`
  - `normalize-ralph-ai-prompt-history.helper.spec.ts`
  - `parse-ralph-run-task-id.helper.spec.ts`
  - `ralph-attachments.helper.spec.ts`
  - `ralph-canvas-layout.helper.spec.ts`
  - `ralph-flow-formatting.helper.spec.ts`
  - `ralph-flow-summaries.helper.spec.ts`
  - `validate-flow-locally.helper.spec.ts`
- Updated existing coverage in `src/tauri/ui/ralph/ralph-flow-editor.test.tsx`, `src/tauri/ui/runtime.test.ts`, and `src/core/__test__/ralph-run.spec.ts`.

### Validation Commands and Results

- Focused batch validation was passed before this update-progress block.
- Recorded successful commands from the focused batch:
  - `pnpm exec eslint src/tauri/ui/ralph/ralph-flow-editor.tsx src/tauri/ui/ralph/components/ralph-flow-canvas-elements.tsx` - passed.
  - `pnpm typecheck:ui` - passed.
  - `pnpm vitest run --config vitest.ui.config.ts src/tauri/ui/ralph/_helpers/ralph-canvas-layout.helper.spec.ts src/tauri/ui/ralph/_helpers/ralph-flow-formatting.helper.spec.ts` - passed, 2 files and 25 tests.
- No dev server or frontend server was started or restarted.

### Framework-Required Filename Exceptions

- Existing documented exceptions remain unchanged:
  - `src-tauri/**` follows Rust/Tauri native conventions.
  - `src/tauri/ui/preview/index.html` and `src/tauri/ui/preview/favicon.png` are framework/static asset names.
  - `src/shared/runtime-config.schema.json` is an accepted schema artifact.
  - `src/core/runtime-contract.generated.ts` and `src/core/runtime-contract.generated.spec.ts` are generated contract artifacts.
- New Ralph helper, spec, test, and component files use established kebab-case names plus accepted `.helper`, `.spec`, and `.test` suffixes. No new filename exception was introduced.

### Remaining Tasks

- Continue P0 reduction of `src/tauri/ui/ralph/ralph-flow-editor.tsx`, especially editor state transitions, run history/detail helpers, AI generation form helpers, persistence formatting, and any remaining view-model logic.
- Continue P0 splitting of `src/core/ralph.ts` into storage/path, checkpoint/resume, resolution, utility/MCP/browser execution, UI-analyze, artifact, and orchestration helpers with direct core specs.
- Continue P0 splitting of `src/tauri/ui/runtime.ts` into a thinner Tauri bridge plus tested command argument, normalizer, MCP config document, and desktop fallback helpers.
- Continue P1 work on `src/core/scheduler.ts` and `src/cli/_helpers/cli-args.ts` after the current Ralph P0 surface is stable.

## Inspect Repository Block - 2026-06-19

### Repository State Inspected

- Root project is private package `machdoch` version `0.17.0`, ESM (`"type": "module"`), pnpm-managed (`pnpm@11.6.0`) and requires Node `>=20.10`.
- Current worktree already contains modified and untracked Ralph-loop refactor files, including `src/cli/_helpers/*`, `src/core/ralph*.ts`, `src/tauri/ui/runtime.ts`, `src/tauri/ui/ralph/ralph-flow-editor.tsx`, `vitest.ui.config.ts`, new Ralph UI helper/component folders, and untracked `ralph-progress.md`. Existing changes were not reverted.
- Active workspace instructions are `.machdoch/instructions.md` and `.machdoch/instructions/security.instructions.md`: prefer read-only inspection first, keep working until complete or blocked, do not start/restart servers for this block, avoid printing secrets, and treat installs/system changes as risky.
- `rg` is unavailable in the current PowerShell environment, so repository inspection used `Get-ChildItem`, `Get-Content`, `Select-String`, and `git status --short`.

### Scripts and Tooling

- Package scripts:
  - `build`: `tsc -p tsconfig.json`
  - `build:cli-bundle`: `node scripts/build-cli-bundle.mjs`
  - `build:ui`: `vite build --config vite.ui.config.ts`
  - `generate:runtime-contract`: `node scripts/generate-runtime-contract.mjs`
  - `version:bump`: `node scripts/bump-version.mjs`
  - `lint`: `eslint src vite.ui.config.ts vitest.config.ts vitest.ui.config.ts`
  - `typecheck`: `tsc --noEmit -p tsconfig.json`
  - `typecheck:ui`: `tsc -p tsconfig.ui.json --noEmit`
  - `dev`: `tsx src/cli/main.ts`
  - `dev:ui`: `vite --config vite.ui.config.ts`
  - `inspect`: `tsx src/cli/main.ts inspect`
  - `preview:ui`: `vite preview --config vite.ui.config.ts`
  - `start`: `node dist/cli/main.js`
  - `tauri`, `tauri:build`, `tauri:dev`
  - `test`: `vitest run`
  - `test:ui`: `vitest run --config vitest.ui.config.ts`
  - `test:watch`: `vitest`
  - `coverage`: `vitest run --coverage`
- Do not use `dev`, `dev:ui`, `preview:ui`, `start`, or `tauri:dev` during this refactor loop unless later instructions explicitly permit server startup.
- Scripts directory contains `build-cli-bundle.mjs`, `bump-version.mjs`, and `generate-runtime-contract.mjs`.

### TypeScript, ESLint, and Build Conventions

- Main TypeScript config targets ES2022, uses `NodeNext` module/moduleResolution, `strict`, `noImplicitOverride`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, declarations, source maps, `.cache/tsconfig.tsbuildinfo`, and includes only `src/**/*.ts`.
- Main build excludes tests, `src/**/__test__/**/*.ts`, and all `src/tauri/ui/**/*.ts[x]`; UI code is compiled separately.
- Spec TS config extends main config, enables Vitest globals, allows importing `.ts` extensions, and excludes UI tests.
- UI TS config extends main config with `ESNext`/`Bundler`, `react-jsx`, DOM libs, Vitest globals, and `@/* -> ./src/*`; includes `src/core/types.ts` and `src/tauri/ui/**/*.ts[x]`.
- ESLint uses `@eslint/js` plus `typescript-eslint` recommended rules over `src/**/*.{ts,tsx}` and root `*.ts`, ignores `coverage`, `dist`, `node_modules`, and `src-tauri/target`, and enforces `@typescript-eslint/no-explicit-any`.

### Vitest Usage

- Main `vitest.config.ts`:
  - Environment: `node`
  - Globals enabled
  - Include: `src/**/*.spec.ts`
  - `restoreMocks: true`, `unstubEnvs: true`
  - Coverage via V8; includes `src/core/**/*.ts`; excludes `src/**/__test__/**/*.ts` and specs.
- UI `vitest.ui.config.ts`:
  - Environment: `jsdom`
  - Globals enabled
  - Include: `src/tauri/ui/**/*.spec.ts`
  - `fileParallelism: false`
  - `passWithNoTests: true`
  - Tauri package aliases point to `src/tauri/ui/test/tauri-test-mocks.ts`
  - Coverage via V8 for `src/tauri/ui/**/*.ts[x]`, excluding `.test` and `.spec` files.
- Current UI source contains both `.spec.ts` and `.test.ts[x]` files; because the config include is `src/tauri/ui/**/*.spec.ts`, `.test.ts[x]` coverage depends on the current modified `vitest.ui.config.ts` or explicit file arguments in targeted runs. Preserve this distinction when choosing validation commands.
- Test style uses Vitest `describe`/`it`/`expect`, frequent globals with occasional explicit imports from `vitest`, `vi.mock`, `vi.mocked`, `vi.spyOn`, `vi.stubGlobal`, and reset/restore in `beforeEach`/`afterEach`.
- Existing shared test helpers include `src/core/__test__/ralph-test-helpers.ts` for Ralph flow/execution fixtures and `src/tauri/ui/test/tauri-test-mocks.ts` for Tauri invoke/window/dialog/opener mocks.

### Source Layout and Naming Conventions

- Top-level source folders: `src/cli`, `src/common`, `src/core`, `src/helpers`, `src/shared`, and `src/tauri`.
- Core has `src/core/_helpers`, `src/core/__test__`, and `src/core/mcp`.
- UI has `src/tauri/ui/_helpers`, `app-shell`, `chat-session`, `components`, `lib`, `marketplace`, `preview`, `ralph`, and `test`.
- Naming is predominantly kebab-case with semantic suffixes such as `.helper.ts`, `.spec.ts`, `.test.ts`, `.test.tsx`, and generated artifacts like `runtime-contract.generated.ts`.
- Helper directories use `_helpers`; shared test-only fixtures use `__test__` in core and `test` under UI.
- Refactor changes should preserve public module contracts, use existing helper/test naming, prefer small extracted helpers with colocated specs, and avoid moving UI code into the main Node build boundary.

### Refactor Constraints and Verification Implications

- Use pnpm scripts and existing configs; do not install packages or upgrade dependencies for ordinary refactor work.
- For Node/core/CLI changes, prefer focused `pnpm vitest run <spec paths>`, then `pnpm typecheck` or `pnpm exec eslint <touched files>` as risk warrants.
- For UI changes, prefer `pnpm vitest run --config vitest.ui.config.ts <spec/test paths>` when targeting files directly, plus `pnpm typecheck:ui` and focused ESLint for touched UI files.
- No dev server, frontend server, preview server, or Tauri dev process was started or restarted during this inspect block.

## Scan Violations Block - 2026-06-19 Refresh

### Scope and Current Inventory

- Scope inspected: all current `src/**/*.ts` and `src/**/*.tsx` files, excluding generated dependency/build output.
- Inventory from the current worktree:
  - 363 TypeScript/TSX files under `src`.
  - 237 production files.
  - 126 Vitest/test-support files.
  - 71 source/test files over 500 lines.
  - 55 production files over 500 lines.
  - 23 oversized production files have no direct colocated `.spec.ts`, `.spec.tsx`, `.test.ts`, or `.test.tsx` pair.
- `rg` is not available in this PowerShell environment, so the scan used `Get-ChildItem`, `Get-Content`, `Measure-Object`, `Select-String`, and `git status --short`.
- Current worktree already contains modified and untracked Ralph-loop refactor work. This scan did not revert or normalize those changes.

### Filename Findings and Exceptions

- No real non-kebab-case TypeScript/TSX filename violations were found after allowing documented compound suffixes:
  - `.helper.ts`
  - `.model.ts`
  - `.generated.ts`
  - `.spec.ts`
  - `.spec.tsx`
  - `.test.ts`
  - `.test.tsx`
  - compound helper specs such as `.helper.spec.ts`
- Documented framework/tooling exceptions remain valid:
  - `src-tauri/**` follows Rust/Tauri native naming conventions and is outside this TypeScript filename scan.
  - `src/tauri/ui/preview/index.html` and `src/tauri/ui/preview/favicon.png` are expected static/framework asset names.
  - `src/shared/runtime-config.schema.json` uses the established schema artifact suffix.
  - `src/core/runtime-contract.generated.ts` and `src/core/runtime-contract.generated.spec.ts` are generated runtime contract artifacts.
- Active helper boundaries are:
  - `src/cli/_helpers`
  - `src/common/_helpers`
  - `src/core/_helpers`
  - `src/tauri/ui/_helpers`
  - `src/tauri/ui/chat-session/_helpers`
  - `src/tauri/ui/ralph/_helpers`
  - `src/helpers`
- `src/common/_helpers` currently remains an empty or near-empty placeholder boundary; keep it only if future common UI helpers justify it.

### P0 Oversized Business-Logic Violations

- `src/tauri/ui/ralph/ralph-flow-editor.tsx` is 10,859 lines.
  - Still the largest refactor target despite prior helper/component extraction.
  - Violations: oversized React component, mixed editor orchestration, validation, flow/view-model formatting, canvas interaction logic, run history/detail state, prompt/generation form state, and persistence formatting.
  - Next tasks:
    - Continue moving pure flow state transitions, run-history derivation, generation form normalization, and persistence formatting into `src/tauri/ui/ralph/_helpers`.
    - Continue moving presentational/editor subcomponents into `src/tauri/ui/ralph/components`.
    - Keep each extraction under 500 lines where practical and add direct helper specs before rewiring risky behavior.
- `src/core/ralph.ts` is 5,317 lines and has no direct colocated test pair.
  - Violations: oversized orchestration module with storage/path logic, run lifecycle, checkpoint/resume logic, placeholder/template resolution, utility execution, MCP/browser/UI-analyze execution, artifacts, and logging in one file.
  - Next tasks:
    - Extract storage/path operations into `src/core/_helpers`.
    - Extract placeholder, attachment, image-input, and block-output resolution into focused helpers.
    - Extract utility/MCP/browser execution families with direct specs.
    - Keep `runRalphFlow` as the public orchestration facade.
- `src/tauri/ui/runtime.ts` is 4,035 lines.
  - Violations: oversized bridge mixing Tauri command wrappers, runtime validators, normalizers, default settings, scheduler conversion, MCP config document editing, dropped-path fallbacks, and clipboard/image handling.
  - Next tasks:
    - Extract command argument builders, runtime normalizers, MCP config document helpers, dropped-path/clipboard fallbacks, and scheduler UI normalizers into `src/tauri/ui/_helpers`.
    - Add direct helper specs because `runtime.test.ts` is too broad to be the only safety net.
- `src/core/scheduler.ts` is 3,113 lines.
  - Violations: mixed state storage, file locking, migration, trigger normalization, prompt discovery/parsing, event matching, dedupe rendering, queue/retry policy, and execution loop.
  - Next tasks:
    - Extract scheduler state storage, normalization, prompt discovery, event filters, retry/dedupe helpers, and keep the public scheduler API thin.
- `src/cli/_helpers/cli-args.ts` is 2,284 lines and has no direct colocated test pair.
  - Violations: oversized parser and command-family business logic mixed together.
  - Next tasks:
    - Split by command family: Ralph, scheduler, MCP, config, summary, and shared parse primitives.
    - Add parser coverage for defaults, invalid combinations, and error messages.

### P1 Oversized Module and Coverage Tasks

- `src/tauri/ui/chat-session/_helpers/use-chat-session-controller.ts` is 2,457 lines with no direct test pair.
  - Split lifecycle, submission, attachment, voice, settings, and remote-control logic into smaller hooks/helpers.
- `src/core/ralph-generation.ts` is 2,318 lines with no direct test pair.
  - Split prompt assembly, interview state, model response parsing/repair, validation, layout, and persistence boundaries.
- `src/tauri/ui/marketplace/mcp-marketplace.tsx` is 2,198 lines with no direct test pair.
  - Move view-model and mutation logic into `src/tauri/ui/marketplace/_helpers` before reducing UI sections.
- `src/tauri/ui/chat-session.model.ts` is 1,949 lines.
  - Has direct tests, but should be split into timeline, task/status, message, attachment, and session summary model helpers.
- `src/tauri/ui/chat-session/_helpers/use-chat-session-runtime.ts` is 1,914 lines.
  - Has direct tests, but should be split by runtime command group and side-effect boundary.
- Other oversized files needing decomposition or focused coverage:
  - `src/core/mcp/client.ts` (1,820 lines)
  - `src/core/agent-runtime.ts` (1,647 lines, no direct test pair)
  - `src/tauri/ui/chat-session/components/scheduler-panel.tsx` (1,597 lines, no direct test pair)
  - `src/core/mcp/marketplace.ts` (1,393 lines)
  - `src/tauri/ui/chat-session/components/settings-dialog-panels/instruction-settings-panel.tsx` (1,273 lines, no direct test pair)
  - `src/cli/_helpers/cli-ralph-commands.ts` (1,236 lines, no direct test pair)
  - `src/tauri/ui/chat-session/_helpers/use-remote-mission-control.ts` (1,176 lines, no direct test pair)
  - `src/core/mcp/config.ts` (1,135 lines)
  - `src/cli/_helpers/cli-scheduler-commands.ts` (1,032 lines)

### P2 Declarative and Helper-Size Tasks

- Tool definition files are mostly declarative but still exceed the 500-line maintainability target. Split only after preserving exported arrays and compatibility specs:
  - `src/core/_helpers/utility-tool-definitions.ts` (1,989 lines)
  - `src/core/_helpers/package-tool-definitions.ts` (1,886 lines)
  - `src/core/mcp/tool-definitions.ts` (1,758 lines)
  - `src/core/_helpers/scheduler-tool-definitions.ts` (1,748 lines)
  - `src/core/_helpers/browser-tool-definitions.ts` (1,707 lines)
  - `src/core/_helpers/desktop-ui-tool-definitions.ts` (1,240 lines, no direct test pair)
  - `src/core/_helpers/macro-recorder-tool-definitions.ts` (1,190 lines)
  - `src/core/_helpers/shell-network-tool-definitions.ts` (828 lines)
  - `src/core/_helpers/git-tool-definitions.ts` (663 lines)
  - `src/core/_helpers/filesystem-tool-definitions.ts` (613 lines, no direct test pair)
- Existing helper files over 500 lines should not be exempt just because they already live in `_helpers`:
  - `src/core/_helpers/external-agent-provider.ts` (966 lines)
  - `src/tauri/ui/chat-session/_helpers/use-chat-session-shell-state.ts` (753 lines)
  - `src/core/_helpers/parse-ralph-flow-record.helper.ts` (607 lines)
  - `src/core/_helpers/execution-sections.ts` (526 lines, no direct test pair)
  - `src/tauri/ui/chat-session/_helpers/smart-context-packs.ts` (517 lines)

### Helper Boundary and Duplication Findings

- `src/helpers/normalize-optional-string.helper.ts` and `src/helpers/sort-entry-names.helper.ts` remain correctly placed as truly shared helpers.
- Ralph editor helpers belong under `src/tauri/ui/ralph/_helpers` unless they become framework-neutral and are reused outside the UI.
- Chat-session controller/model/runtime helpers belong under `src/tauri/ui/chat-session/_helpers`.
- UI runtime, scheduler UI, remote-control, dropped-path, clipboard, and settings normalizers should stay under `src/tauri/ui/_helpers` because they depend on desktop/UI contracts.
- Core Ralph storage, resolution, validation, execution, and artifact helpers belong under `src/core/_helpers`.
- Repeated `isRecord` / `isRecordValue` style guards were found across 29 files, including CLI commands, core Ralph, MCP, scheduler, UI runtime, marketplace, shell-store, and chat-session code.
  - Do not blindly promote all of these to `src/helpers`; several have subtly different naming and local semantics.
  - During nearby extractions, consolidate identical domain-neutral guards into one shared helper only if at least two independent modules still need the exact same behavior.
- No meaningful TODO/FIXME/HACK debt was found in production code beyond domain strings and instruction text.

### Missing or Weak Vitest Coverage

- Highest-priority oversized production files with no direct colocated test pair:
  - `src/core/ralph.ts`
  - `src/tauri/ui/chat-session/_helpers/use-chat-session-controller.ts`
  - `src/core/ralph-generation.ts`
  - `src/cli/_helpers/cli-args.ts`
  - `src/tauri/ui/marketplace/mcp-marketplace.tsx`
  - `src/core/agent-runtime.ts`
  - `src/tauri/ui/chat-session/components/scheduler-panel.tsx`
  - `src/tauri/ui/chat-session/components/settings-dialog-panels/instruction-settings-panel.tsx`
  - `src/core/_helpers/desktop-ui-tool-definitions.ts`
  - `src/cli/_helpers/cli-ralph-commands.ts`
  - `src/tauri/ui/chat-session/_helpers/use-remote-mission-control.ts`
  - `src/tauri/ui/chat-session/components/settings-dialog-panels/mcp-settings-panel.tsx`
  - `src/core/ralph-watches.ts`
  - `src/core/provider-model-registry.ts`
  - `src/cli/_helpers/cli-summary-commands.ts`
  - `src/tauri/ui/lib/shell-store.ts`
  - `src/tauri/ui/components/ui/sidebar.tsx`
  - `src/core/ralph-layout.ts`
- Oversized files with tests but weak extraction coverage:
  - `src/tauri/ui/ralph/ralph-flow-editor.tsx`
  - `src/tauri/ui/runtime.ts`
  - `src/core/scheduler.ts`
  - `src/core/mcp/client.ts`
  - `src/core/mcp/config.ts`
  - `src/core/mcp/marketplace.ts`
  - `src/tauri/ui/chat-session.model.ts`
  - `src/tauri/ui/chat-session/_helpers/use-chat-session-runtime.ts`
- UI test naming remains mixed between `.spec.ts[x]` and `.test.ts[x]`; verify `vitest.ui.config.ts` includes the intended suffixes before relying on broad `pnpm test:ui` results.

### Prioritized Remaining-Work Checklist

- [ ] P0: Continue reducing `src/tauri/ui/ralph/ralph-flow-editor.tsx` by extracting editor state transitions, run history/detail derivation, AI generation form helpers, persistence formatting, and remaining subcomponents with focused helper specs.
- [ ] P0: Split `src/core/ralph.ts` into storage/path, checkpoint/resume, resolution, utility/MCP/browser execution, UI-analyze, artifact, and orchestration helpers with direct core specs.
- [ ] P0: Split `src/tauri/ui/runtime.ts` into a thin Tauri bridge plus tested command argument, normalizer, MCP config document, scheduler conversion, and desktop fallback helpers.
- [ ] P1: Split `src/core/scheduler.ts` into state storage, locking, normalization, prompt discovery, event filtering, retry/dedupe, and orchestration helpers.
- [ ] P1: Split `src/cli/_helpers/cli-args.ts` by command family and add direct parser coverage.
- [ ] P1: Reduce chat-session controller/runtime/model files by extracting pure state transitions and smaller side-effect hooks.
- [ ] P1: Split `src/core/ralph-generation.ts` into prompt assembly, interview, parsing/repair, validation, layout, and persistence helpers.
- [ ] P2: Split large tool-definition modules by family/schema group while preserving public exports and compatibility specs.
- [ ] P2: Review MCP client/config/marketplace modules for transport, persistence, parsing, enrichment, and mutation helper extraction.
- [ ] P2: Review marketplace, scheduler-panel, settings-panel, shell-store, task-thinking, onboarding, sidebar, and sessions UI files for view-model extraction and component decomposition.
- [ ] P3: Decide whether `src/common/_helpers` should remain reserved for future common UI helpers or be removed as an empty placeholder in a dedicated cleanup.

### Verification Performed

- Re-read active progress and workspace instructions already recorded in this file.
- Checked worktree state with `git status --short`; existing modified/untracked Ralph-loop work remains untouched.
- Counted current TypeScript/TSX production and test files.
- Checked TypeScript/TSX filenames against kebab-case with accepted compound suffix exceptions.
- Enumerated current `_helpers` directories.
- Ranked current source/test and production files over 500 lines.
- Compared oversized production files against direct colocated Vitest test pairs.
- Searched for repeated `isRecord` / `isRecordValue` duplication and TODO/FIXME/HACK markers.
- Updated only `ralph-progress.md`; no implementation files, tests, configs, package files, or servers were changed.

## Apply Focused Batch Block - 2026-06-19

### Batch Selected

- Selected one P2 helper-size batch from the current checklist: split oversized `src/core/_helpers/parse-ralph-flow-record.helper.ts` without changing its public parser API.
- Kept the scope inside `src/core/_helpers` because the extracted behavior is Ralph/core-specific block coercion, not a repository-wide helper.

### Changes Made

- Added `src/core/_helpers/coerce-ralph-flow-block-record.helper.ts`.
  - Moved Ralph block-level coercion, block settings coercion, input field coercion, MCP argument coercion, annotation block fields, group boundaries, and retry/workspace settings into the new helper.
  - Preserved NodeNext runtime imports with `.js` extensions.
  - Kept the new helper under 500 lines.
- Updated `src/core/_helpers/parse-ralph-flow-record.helper.ts`.
  - Left flow-level parsing, variables, flow settings, edges, and annotation links in the parser helper.
  - Rewired block parsing to call `coerceRalphFlowBlockRecord`.
  - Reduced the parser helper from 607 lines to 144 lines.
- Added `src/core/_helpers/coerce-ralph-flow-block-record.helper.spec.ts`.
  - Covered representative block/settings normalization.
  - Covered input-field defaults, option filtering, finite validation values, and `null` timeout handling.
  - Covered malformed/default block variants and invalid MCP arguments.

### Verification Performed

- `pnpm vitest run src/core/_helpers/coerce-ralph-flow-block-record.helper.spec.ts src/core/_helpers/parse-ralph-flow-record.helper.spec.ts`
  - Passed: 2 files, 14 tests.
- `pnpm exec eslint src/core/_helpers/coerce-ralph-flow-block-record.helper.ts src/core/_helpers/coerce-ralph-flow-block-record.helper.spec.ts src/core/_helpers/parse-ralph-flow-record.helper.ts src/core/_helpers/parse-ralph-flow-record.helper.spec.ts`
  - Passed.
- `pnpm typecheck`
  - Passed.

### Remaining Notes

- The broader worktree still contains pre-existing modified/untracked Ralph-loop files unrelated to this batch.
- No dev server, frontend server, preview server, or Tauri dev process was started.
