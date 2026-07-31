# Provider Instruction Delivery and MCP Enrollment

Status: implemented
Last implementation review: 2026-07-31

## 1. Scope

Machdoch integrates two independent provider concerns:

- **Instruction delivery** is run-scoped. One frozen instruction envelope is
  attached to every model request or delegated CLI invocation.
- **MCP enrollment** projects the effective MCP catalog into a run-scoped
  environment or, when explicitly enabled, into provider-native MCP
  configuration.

Persistent synchronization is an MCP facility. It never persists instruction
profiles or writes provider instruction files.

## 2. Universal instruction contract

Before provider execution, Machdoch resolves reusable profiles, structural
assignments, repository `AGENTS.md`, and optional RALPH guidance. See
[Instruction Profiles and Delivery Specification](instruction-file-simplification-spec.md).

Every provider adapter receives:

- immutable resolution ID and canonical digest;
- rendered envelope;
- provider/surface/model identity;
- native-provider inventory;
- byte and token budget;
- invocation phase;
- MCP initialization-hint snapshot.

The adapter must:

1. publish a capability descriptor;
2. create a twelve-dimension delivery plan;
3. block unsupported execution;
4. deliver the complete envelope without rewriting or truncation;
5. reattach it on every provider request required by the lifecycle;
6. verify the observed canonical digest at the request boundary;
7. create a receipt without storing bodies; and
8. clean up run-scoped artifacts.

## 3. Delivery grades

| Grade         | Meaning                                                                                                    | Execution                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `full`        | Complete content, required authority/isolation, known lifecycle, budget, conformance, and receipt evidence | Allowed                                    |
| `compatible`  | Complete content is available, but at least one non-content property is weaker or unverified               | Allowed and reported as delivery telemetry |
| `unsupported` | Complete delivery cannot be guaranteed                                                                     | Blocked                                    |

The dimensions are content, scope, authority, native isolation, initial,
continuation, retry, roles, subagents, budget, conformance, and receipt.

No provider has a partial-content mode. A missing required CLI flag, unknown
critical lifecycle, digest mismatch, or oversized request fails before or at
the delivery boundary.

## 4. API providers

API enrollment is application-managed and has no persistent provider file.

### OpenAI

- Route: Responses API `instructions`.
- Authority: developer.
- The envelope is attached to initial requests and reattached when using
  `previous_response_id`.
- Retry, validator, and generator requests use the same frozen envelope.

### Anthropic

- Route: Messages API top-level `system`.
- Authority: system.
- The envelope is supplied on every request because the API has no persistent
  system state between requests.

### Google

- Route: Gemini `systemInstruction`.
- Authority: system.
- The envelope is supplied on every request.

### Langdock

- Route: the adapter's system-message mapping.
- Authority: system as exposed by the route.
- Conformance remains provisional; the delivery plan reports that limitation.

For all API adapters, MCP servers are application-managed. MCP initialization
hints are supplied as bounded advisory runtime context, not merged into the
canonical envelope.

## 5. Delegated CLI providers

CLI enrollment is ephemeral. Machdoch probes the configured executable's
version and help output, verifies required flags, creates an owner-restricted
temporary root, invokes the provider, writes a manifest/receipt, and removes
the root.

### Codex CLI

- Uses an isolated `CODEX_HOME`.
- Writes the complete system payload once to
  `CODEX_HOME/config.toml` as `developer_instructions`.
- Supplies the run-scoped MCP projection through isolated Codex config.
- Sets project instruction discovery limits to zero and marks the workspace
  and every ancestor untrusted so project configuration cannot re-enable it.
- Reads the user task from stdin through `codex exec -`; instruction content
  is absent from argv and stdin.
- Reattaches the envelope when Machdoch starts a retry or a new role.

### Claude CLI

- Uses an isolated Claude configuration directory.
- Supplies the canonical envelope through the probed system-prompt file flag.
- Loads no user/project/local setting sources and disables CLAUDE.md and auto
  memory for the invocation.
- Uses strict run-scoped MCP configuration.
- Uses documented bare mode only when the executable exposes it and explicit
  API-key authentication is available. Inline subagent prompt duplication is
  never used.
- Reads the user task from stdin and rejects payloads above Claude's documented
  10 MiB stdin limit without truncation.
- Reattaches the envelope when Machdoch starts a retry or a new role.

### Copilot CLI

- Uses isolated home and cache directories.
- Sanitizes copied authentication state.
- Disables auto-update, custom instructions, ambient plugins, built-in MCP,
  and other discovered MCP configuration through verified flags.
- Writes the complete system payload once to a uniquely named custom-agent
  profile in the isolated home and selects it with `--agent`.
- Keeps the user task on piped stdin and uses repeated `--attachment` flags
  when attachments are supplied.
- Blocks if the CLI cannot expose the custom-agent contract; there is no user
  prompt fallback.

## 6. Provider-native instruction inventory

Provider-native files can otherwise remain active provider features. Examples include
Codex/`AGENTS.md`, Claude memory and rules, Gemini context files, and GitHub
Copilot instruction files.

Machdoch inventories the documented locations relevant to the selected
provider and classifies each entry:

- `canonical`: a local `AGENTS.md` already represented in the envelope;
- `native-extra`: provider behavior outside the canonical set;
- `suppressed`: the invocation has a verified suppression mechanism;
- `inactive`: not applicable to this provider or surface;
- `unknown`: applicability cannot be established; or
- `unreadable`: safe inspection failed.

Inventory affects the environment digest and delivery grade. It is read-only,
bounded, symlink-safe, and body-redacted in ordinary output.

## 7. Run-scoped MCP projection

Machdoch loads the effective canonical MCP catalog, resolves environment
references, validates transport/authentication data, and maps each enabled
server to the selected provider:

1. direct native transport when the provider supports it;
2. per-server stdio proxy when a remote transport needs adaptation;
3. aggregate broker when required by the provider surface; or
4. uncovered, which blocks or is reported according to the operation.

Provider configuration is generated in the temporary run root. Approval policy
is `never`; Machdoch does not rely on an interactive provider prompt to approve
tools.

Coverage records bind canonical server ID, provider-visible name, route,
capabilities, effective config digest, and catalog digest.

## 8. Persistent MCP synchronization

Persistent sync is opt-in and controlled by `providerEnrollment`:

```json
{
  "providerEnrollment": {
    "enabled": true,
    "mcp": {
      "unmanagedNative": "allow",
      "approvals": "never"
    },
    "persistentSync": {
      "enabled": false,
      "watch": true,
      "daemonAtLogin": true,
      "debounceMs": 500,
      "fullRescanIntervalMs": 600000
    },
    "providers": {
      "codex-cli": { "enabled": true },
      "claude-cli": { "enabled": true },
      "copilot-cli": { "enabled": true }
    }
  }
}
```

There is no instruction-delivery configuration in this object. Instruction
selection and delivery are invariant behavior, not a provider enrollment
preference.

### Reconciliation

For each enabled provider and user/workspace scope, the coordinator:

1. loads and validates canonical MCP configuration;
2. builds a deterministic provider projection;
3. acquires the provider/workspace cooperative lock;
4. verifies current ownership and target snapshots;
5. merges only the managed TOML/JSON region;
6. commits atomically;
7. records ownership, coverage, status, and a recovery checkpoint; and
8. removes empty managed MCP targets when no canonical servers remain.

The coordinator refuses malformed targets, linked paths, unmanaged collisions,
stale snapshots, ambiguous ownership, and filesystem escapes. Unmanaged
provider settings outside the managed MCP region are preserved.

### Watcher

The daemon watches only:

- user configuration relevant to provider enrollment;
- user MCP configuration;
- workspace `.machdoch/mcp` configuration; and
- periodic full-rescan triggers.

Repository instruction files and the instruction library do not trigger
persistent sync.

### Provider refresh

Persistent writes become effective at provider-specific refresh boundaries:

- API providers: next request;
- delegated CLI run-scoped enrollment: current invocation;
- persistent CLI MCP config: next session or verified reload boundary.

Status uses `awaiting-provider-refresh` when bytes are synchronized but the
provider has not yet crossed its refresh boundary.

## 9. Ownership and recovery

Managed provider MCP targets have:

- a target snapshot;
- canonical/effective config digests;
- managed server IDs;
- provider and scope identity;
- ownership manifest revision;
- last successful sync timestamp; and
- interruption checkpoint when a commit is in progress.

All writes use cooperative locks and compare observed state with the recorded
snapshot immediately before commit. Recovery may finish or roll back a known
managed transition; it never overwrites unknown bytes.

Uninstall removes only verified managed MCP regions and ownership state.
Provider-native instructions and unmanaged MCP entries are untouched.

## 10. Planning, status, and diagnostics

`provider-sync plan` is read-only and reports:

- configured and detected providers;
- probed version/features;
- user and workspace MCP targets;
- catalog digests;
- projected servers and routes;
- coverage;
- unmanaged-MCP policy; and
- warnings.

`status`, `refresh`, and `doctor` report reconciliation health, pending provider
refresh, ownership conflicts, stale locks/checkpoints, binary capability drift,
and uncovered servers.

Settings exposes the persistent MCP toggle directly. Instruction profile
management and delivery preview live in the Instructions section.

## 11. Security requirements

- Temporary roots and instruction files are owner-restricted.
- Provider authentication state is copied only when required and is sanitized.
- Environment values and headers are redacted from logs, plans, and manifests.
- Instruction bodies are absent from receipts and standard diagnostics.
- Canonical MCP server commands, arguments, URLs, and headers are bounded.
- Links and path escapes are rejected for source and target traversal.
- Provider updates and plugins cannot change a probed CLI invocation.
- MCP initialization hints cannot grant tools or permissions.
- Managed writes preserve unrelated provider configuration.

## 12. Implementation map

| Responsibility                     | Module                                                |
| ---------------------------------- | ----------------------------------------------------- |
| Capability and delivery plan       | `src/core/instruction-system/delivery.ts`             |
| Provider capability/probe registry | `src/core/provider-enrollment/capability-registry.ts` |
| API instruction/MCP snapshot       | `api-enrollment.ts`                                   |
| CLI temporary materialization      | `materializer.ts`                                     |
| MCP provider projection            | `mcp-projector.ts`                                    |
| TOML/JSON ownership merge          | `ownership-merge.ts`                                  |
| Persistent reconciliation          | `sync-coordinator.ts`                                 |
| Watch daemon                       | `sync-daemon.ts`                                      |
| Coverage and receipts              | `coverage-ledger.ts`                                  |
| MCP initialization hints           | `src/core/mcp/initialization-instructions.ts`         |

## 13. Acceptance criteria

- Every supported model request receives the complete frozen instruction
  envelope through the documented adapter route.
- Continuation, retry, validator, generator, and RALPH lifecycle behavior is
  digest-stable.
- Unsupported delivery blocks; compatible delivery remains visible in
  diagnostics and receipts.
- Provider-native sources are accounted for without being imported or
  modified.
- Run-scoped MCP projection covers every enabled canonical server or reports
  the gap.
- Persistent sync modifies MCP configuration only.
- Ownership conflicts and ambiguous recovery fail closed.
- Plans, receipts, and diagnostics expose evidence without instruction bodies
  or secrets.
- CLI capability drift is detected before launch.
