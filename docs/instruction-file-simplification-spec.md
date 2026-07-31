# Instruction Profiles and Delivery Specification

Status: implemented and normative
Schema generation: 1
Last implementation review: 2026-07-31

## 1. Product contract

Machdoch has one instruction model:

1. reusable Markdown profiles stored in the user instruction library;
2. ordered profile assignments for all workspaces, a workspace root, or a
   workspace folder;
3. repository-owned `AGENTS.md` files at the root or in nested folders; and
4. optional `guidance` embedded in a RALPH flow definition.

Every model-executed operation resolves those sources into one immutable,
provider-neutral instruction envelope before the first provider request.
Provider adapters deliver that exact envelope and produce a delivery plan and
receipt. Instructions never grant tools, permissions, network access, secret
access, or filesystem authority.

No other file tree, matcher language, sidecar, provider projection, or
instruction-specific provider setting is part of the canonical model.
Provider-native instruction files are inventoried because a delegated provider
may load them independently; they are not imported into the canonical
envelope.

## 2. Required invariants

- There is one resolver for interactive tasks, one-shot tasks, scheduled work,
  validators, generators, retries, continuations, and RALPH blocks.
- Selection is structural. Task words, mentioned paths, frontmatter, glob
  patterns, roles, keywords, and manual references do not select sources.
- Source order is deterministic and preserved in the envelope.
- Every valid selected source is delivered in full. Invalid or unreadable
  instruction files are skipped with diagnostics and never block execution.
  Truncation is forbidden.
- The frozen source set is reused for continuations and retries.
- A provider switch may recompute provider evidence and budget data, but it
  must not reread or change frozen source bodies.
- Persistent provider synchronization manages MCP configuration only.
- Repository files are never rewritten merely to enroll a provider.
- Inspection output omits profile and local bodies unless the caller
  explicitly requests content.
- Store and repository writes use compare-and-swap checks.
- Symlinks, path escapes, case collisions, malformed data, ambiguous ownership,
  and stale mutations fail closed.

## 3. Data model and persistence

### 3.1 Instruction library

The user-owned store is `instruction-library.json` in the Machdoch user config
directory. The JSON document conforms to
[`instruction-library.schema.json`](../src/shared/instruction-library.schema.json)
and has exactly these top-level fields:

```json
{
  "schemaVersion": 1,
  "revision": 0,
  "profiles": [],
  "defaults": { "profiles": [] },
  "workspaces": []
}
```

An instruction profile contains:

```ts
interface InstructionProfile {
  id: string; // UUID
  name: string;
  description?: string;
  body: string; // normalized Markdown
  createdAt: string; // RFC 3339
  updatedAt: string; // RFC 3339
}
```

Profile UUIDs are stable identity. Names are user-facing labels and are not
identity keys. Bodies are stored once and referenced by UUID from assignments.

### 3.2 Assignments

`defaults.profiles` is an ordered list that applies at workspace scope `.`.
A workspace binding contains a stable UUID, its current absolute root, optional
identity hints, and ordered scope assignments:

```ts
interface InstructionWorkspaceBinding {
  id: string;
  root: string;
  displayName?: string;
  identityHints?: {
    gitRemote?: string;
    repositoryId?: string;
  };
  scopes: Array<{
    path: string; // "." or normalized workspace-relative folder
    profiles: string[]; // ordered profile UUIDs
  }>;
}
```

Scope paths use `/`, cannot be absolute, cannot contain empty, `.` or `..`
segments, and must resolve to real directories inside the registered
workspace. Assigning the same profile below an applicable ancestor is
redundant; the descendant occurrence is reported as skipped.

### 3.3 Local instructions

Repository guidance uses ordinary `AGENTS.md` files. A root file applies to the
entire workspace. A nested file applies to its directory and descendants.
Local files have no Machdoch frontmatter or matcher metadata.

Discovery:

- walks real directories under the canonical workspace root;
- ignores `.git`, `.machdoch`, `node_modules`, `coverage`, `dist`, `build`, and
  `target`;
- refuses directory and file symlinks;
- detects host-specific case collisions;
- enforces directory, file-count, per-file, aggregate, and UTF-8 bounds; and
- records normalized portable relative paths and content digests.

### 3.4 RALPH guidance

Persistent flow-wide guidance is the optional `guidance` string inside the
RALPH flow JSON. It is resolved after profiles and local files. Block prompts
remain task input and are not persistent instruction sources.

## 4. Resolution

### 4.1 Inputs

The resolver receives:

- canonical workspace root;
- provider and surface (`api` or `cli`);
- optional model;
- optional RALPH flow ID and guidance.

It loads the instruction library, local `AGENTS.md` files, provider-native
inventory, and bounded MCP initialization hints.

### 4.2 Deterministic order

The selected source order is:

1. ordered all-workspace defaults at scope `.`;
2. for each applicable scope from shallowest to deepest:
   1. ordered workspace profile assignments at that scope;
   2. the local `AGENTS.md` at that scope, if present;
3. RALPH flow guidance, if present.

Within a scope, the user-defined profile order is authoritative. Later
applicable sources have higher precedence. The resolver reports structural
overlap but does not attempt to infer semantic contradictions.

A path preview filters the frozen ordered list to sources whose scope is an
ancestor of the requested workspace-relative path.

### 4.3 Normalization and exact deduplication

Bodies must be non-empty valid UTF-8 Markdown. Line endings and terminal
newlines are normalized before hashing.

Consecutive equal bodies at the same scope may be rendered once while all
source attributions are retained. Equal bodies separated by another source or
attached to different scopes remain separate when their position affects
precedence.

### 4.4 Canonical envelope

The resolver renders a bounded MIME-like envelope containing:

- a collision-safe boundary;
- a canonical SHA-256 digest;
- one Markdown part per rendered body group;
- base64url-encoded source attribution metadata; and
- a final control block that defines scope, precedence, trust, and
  authorization boundaries.

`canonicalDigest` covers source identity, scope, order, normalized body
digests, and body-group attribution. `environmentDigest` separately covers the
provider capability, model budget evidence, provider-native inventory, and MCP
initialization-hint metadata.

The resolution explanation conforms to
[`instruction-resolution.schema.json`](../src/shared/instruction-resolution.schema.json).
It is body-free by default.

### 4.5 Budgets

The resolver accounts for:

- normalized body bytes;
- full envelope bytes and lines;
- MCP initialization-hint bytes;
- conservative token estimates;
- verified model context limits; and
- a reserved non-instruction allowance.

Advisory thresholds and provider-input estimates produce diagnostics. The
resolver never truncates, and instruction-sharing limits do not become chat
execution gates.

## 5. Native provider inventory

Machdoch inventories documented provider-native locations relevant to the
selected provider, including current `AGENTS.md`, Claude memory/rules, Gemini
context files, and GitHub Copilot instruction files.

Inventory records are classified as canonical, native-extra, suppressed,
inactive, unknown, or unreadable. Canonical local `AGENTS.md` entries are
already represented in the envelope. Other native entries remain external
provider state and affect telemetry only. Delegated runs use isolated provider
state where supported and treat the canonical Machdoch envelope as the sole
instruction source of truth.

Inventory is bounded, link-safe, and read-only. Provider-specific instruction
files are not deleted, rewritten, imported as profiles, or persistently
generated.

## 6. MCP initialization hints

Non-empty `instructions` values returned during initialization by enabled MCP
servers are advisory runtime supplements, separate from the canonical
instruction envelope.

Machdoch:

- snapshots them at the run boundary;
- exact-deduplicates identical bodies while retaining server attribution;
- enforces per-server, count, aggregate-byte, and token limits;
- includes their bytes in budget preflight; and
- reattaches them to every model-executed role in that run.

Hints do not enable an MCP server, expose tools, or grant authority.

## 7. Provider delivery

The delivery plan evaluates twelve dimensions: content, scope, authority,
native isolation, initial request, continuation, retry, roles, subagents,
budget, conformance, and receipt evidence.

Grades:

- `full`: all required dimensions are satisfied;
- `compatible`: exact content can be delivered, but one or more authority,
  isolation, lifecycle, or conformance properties are weaker or unverified;
- `unsupported`: complete delivery cannot be guaranteed.

Compatible plans execute with their limitations recorded. Unsupported plans
block before provider launch. Machdoch never falls back to placing system
instructions in user prompt content.

### 7.1 API surfaces

| Provider  | Instruction field               | Lifecycle                                                                     |
| --------- | ------------------------------- | ----------------------------------------------------------------------------- |
| OpenAI    | Responses API `instructions`    | Reattached on initial, continuation, retry, validator, and generator requests |
| Anthropic | Messages API top-level `system` | Reattached on every request                                                   |
| Google    | Gemini `systemInstruction`      | Reattached on every request                                                   |
| Langdock  | Adapter system message          | Reattached on known request paths; capability remains provisional             |

### 7.2 CLI surfaces

CLI enrollment is run-scoped and owner-restricted. The adapter probes the
actual executable and refuses to assume missing flags.

| Provider    | Run-scoped route                                                             |
| ----------- | ---------------------------------------------------------------------------- |
| Codex CLI   | Isolated `CODEX_HOME/config.toml` `developer_instructions`                   |
| Claude CLI  | `--append-system-prompt-file` with isolated settings and memory discovery    |
| Copilot CLI | Unique custom-agent file in isolated `COPILOT_HOME`, selected with `--agent` |

Temporary directories contain the envelope, the projected MCP configuration,
an enrollment manifest, and only provider state required for that invocation.
They are removed after the run. Authentication state copied into isolation is
sanitized and bounded.

Runtime role/completion guidance is delivered in the same native instruction
payload as the envelope. Task, conversation, resolved non-instruction context,
and attachment references remain user input on stdin. Instruction content is
never repeated in stdin or argv.

Codex reads a `-` prompt from stdin. Claude print mode reads stdin with its
documented 10 MiB cap; Machdoch fails before launch above that cap rather than
truncate or change roles. Copilot uses documented piped input. Native repeated
attachment flags are used for Codex images and Copilot attachments. Windows
invocations are preflighted below the `cmd.exe` or `CreateProcess` command-line
limit, including quoting overhead.

### 7.3 Receipts

Every provider call emits an in-memory or persisted receipt conforming to
[`instruction-delivery.schema.json`](../src/shared/instruction-delivery.schema.json).
A receipt binds the plan, resolution, canonical digest, provider, phase,
assembled request digest, delivered byte count, route, and evidence. Bodies are
never stored in receipts.

Indeterminate delivery is explicit and cannot be reported as delivered.

## 8. Run lifecycle

The first provider call freezes the resolution. Interactive continuations,
automatic continuation, retries, validator passes, generator passes, and
RALPH blocks reuse the same source bodies.

RALPH checkpoints persist the instruction boundary and digest. Resume policies
may require a matching current boundary, deliberately retain the original
boundary, or start a clearly new boundary. A source change is never silently
adopted mid-run.

Provider switching adapts the frozen envelope to the new provider and reruns
capability, native-inventory, and budget preflight. It does not rerun source
selection.

## 9. Authoring and inspection surfaces

Settings > Instructions provides:

- profile library create, edit, duplicate, and delete;
- ordered defaults and workspace/folder assignments;
- workspace register, relink, and unregister;
- local `AGENTS.md` create, edit, and delete;
- provider/path resolution preview;
- native-source and MCP-hint inspection;
- transfer; and
- store recovery.

The CLI mirrors the same model:

```text
machdoch instructions profiles list|show|create|edit|duplicate|delete
machdoch instructions assignments list|set-defaults|set|remove|relink
machdoch instructions local list|show|create|edit|delete
machdoch instructions workspaces list|register|relink|unregister
machdoch instructions resolve
machdoch instructions validate
machdoch instructions transfer export|import
machdoch instructions recovery status|restore|export|reset
```

Profile, assignment, and workspace mutations require the current library
revision. Local edit/delete requires the current file digest.

## 10. Transfer and recovery

Portable export includes profiles and ordered defaults. Workspace assignments
may be included only as root-free, unbound records. Import never binds an
absolute sender path; each mapping requires explicit relink.

Conflicts are deterministic:

- same UUID and same normalized content is idempotent;
- same UUID with different content requires a reviewed decision;
- same normalized name with different UUID requires a reviewed decision; and
- missing profile references fail validation.

The primary library is written atomically with a bounded backup and audit log.
If the primary is corrupt, normal mutations stop. Recovery status reports
digests without exposing bodies. Restore, recovery export, and reset require a
reviewed expected digest.

The Settings Transfer category ID is `instruction-profiles.global`. It carries
only the portable instruction-library projection and never carries repository
files, absolute workspace roots, run receipts, MCP state, or provider-native
files.

## 11. Persistent provider synchronization

`provider-sync` is an opt-in MCP projection service. It reads canonical MCP
configuration and reconciles managed TOML or JSON regions in supported
provider locations.

It does not read the instruction library, resolve instructions, render
Markdown, or create provider instruction files. Its watcher responds only to
MCP/configuration inputs. Managed ownership metadata, locks, collision checks,
atomic commits, checkpoints, and status records protect provider MCP files.

## 12. Security and privacy

- Profile bodies are private user configuration and are redacted from ordinary
  diagnostics.
- Local `AGENTS.md` bodies are repository-controlled, untrusted instruction
  content.
- Envelope metadata, not body text, defines source scope and precedence.
- Instruction text cannot expand the current tool or sandbox policy.
- Secret-bearing native files are inventoried by digest and metadata; output
  paths are redacted where appropriate.
- Temporary provider state is owner-restricted and cleaned up.
- All filesystem traversal stays within canonical roots and rejects links.

## 13. Implementation map

| Area                        | Implementation                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| Store and mutations         | `src/core/instruction-system/library-store.ts`                                               |
| Local discovery and writes  | `local-discovery.ts`, `local-files.ts`                                                       |
| Resolution and envelope     | `resolver.ts`, `normalization.ts`                                                            |
| Delivery plans and receipts | `delivery.ts`                                                                                |
| Native inventory            | `native-inventory.ts`                                                                        |
| API enrollment              | `src/core/provider-enrollment/api-enrollment.ts`                                             |
| CLI materialization         | `src/core/provider-enrollment/materializer.ts`                                               |
| MCP-only persistent sync    | `sync-coordinator.ts`, `sync-daemon.ts`                                                      |
| MCP initialization hints    | `src/core/mcp/initialization-instructions.ts`                                                |
| CLI                         | `src/cli/_helpers/cli-instruction-commands.ts`                                               |
| Desktop UI                  | `src/tauri/ui/chat-session/components/settings-dialog-panels/instruction-settings-panel.tsx` |
| Schemas                     | `src/shared/instruction-*.schema.json`                                                       |

## 14. Verification contract

Changes to this system must pass:

- runtime and test TypeScript checks;
- ESLint and formatting;
- store, resolver, provider, lifecycle, UI-model, CLI, and schema tests;
- core, desktop UI, and CLI-bundle builds;
- byte-stable runtime-contract generation;
- Rust formatting, checking, and tests;
- strict schema parsing and unknown-field rejection;
- strict UTF-8 and Markdown validation; and
- `git diff --check`.

Acceptance requires deterministic resolution, fail-closed canonical delivery,
current provider integration behavior, MCP-only persistent sync, body-free
default inspection, safe transfer/recovery, and no alternate instruction
source pipeline.
