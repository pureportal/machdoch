# Instruction Profiles

Machdoch combines reusable profiles, workspace/folder assignments, repository
`AGENTS.md` files, and optional RALPH flow guidance into one instruction set
for each run.

## Choose the right source

| Need                                                                | Use                         |
| ------------------------------------------------------------------- | --------------------------- |
| Guidance shared across many repositories                            | Reusable profile            |
| Guidance for one workspace or folder, stored outside the repository | Profile assignment          |
| Guidance reviewed and versioned with a repository                   | Root or nested `AGENTS.md`  |
| Guidance for every block in one RALPH flow                          | The flow's `guidance` field |
| A reusable task template                                            | Prompt customization        |
| An on-demand workflow with supporting assets                        | Skill customization         |

Profiles are Markdown documents with stable UUIDs. An assignment references a
profile; it does not copy its body. Editing a profile updates every assignment
that references it on the next run boundary.

## Resolution order

Machdoch orders sources from general to specific:

1. all-workspace profile defaults;
2. workspace and folder profile assignments from shallow to deep;
3. `AGENTS.md` at each corresponding scope; and
4. RALPH flow guidance.

Within one assignment, profile order is significant. Later applicable sources
have higher precedence. Selection is structural: task wording, frontmatter,
keywords, roles, and glob patterns do not change the selected set.

The set is frozen before the first provider call. Continuations, retries,
validators, and generators reuse it. A provider switch reruns delivery
preflight without rereading the bodies.

## Settings workflow

Open **Settings > Instructions**.

### Profiles

Create a profile with a concise name and Markdown body. A description is
optional. Use duplicate when a new profile should start from an existing one
without sharing identity.

Profile edits use the library revision shown when the page loaded. If another
window changed the library, refresh and apply the edit again.

Deleting an assigned profile is blocked until its assignments are removed.

### Defaults and assignments

- **Defaults** apply at workspace scope `.` in every workspace.
- Register a workspace to add workspace-specific assignments.
- Assign profiles at `.` for the entire workspace.
- Assign profiles to a relative folder for that folder and descendants.
- Relink a workspace or folder when it moves.
- Unregistering a workspace requires confirmation if it removes assignments.

Assigning the same profile at a descendant of an already applicable assignment
is unnecessary. Resolution reports the descendant assignment as skipped.

### Local files

Use the Local files area to create, edit, or delete `AGENTS.md` at the
workspace root or an existing relative folder.

Local file edits and deletion require the current SHA-256 digest. Machdoch
refuses linked files, linked directories, missing scopes, and paths outside the
workspace.

### Preview

Choose the provider, surface, model, and optional relative path, then refresh
the preview. The summary shows:

- selected and skipped sources;
- effective order and path applicability;
- byte and token budget;
- delivery grade and limitations;
- provider-native files that may also be loaded;
- MCP initialization-hint metadata; and
- diagnostics.

Bodies stay collapsed and are excluded from ordinary JSON output.

## CLI examples

Create and inspect profiles:

```bash
machdoch instructions profiles create "Review rules" \
  --prompt "Prefer focused tests and explain risky changes."
machdoch instructions profiles list --json
machdoch instructions profiles show <profile-uuid>
machdoch instructions profiles edit <profile-uuid> \
  --expected-revision <revision> \
  --prompt-file review-rules.md
```

Set defaults:

```bash
machdoch instructions assignments set-defaults \
  --expected-revision <revision> \
  --profile <profile-uuid> \
  --profile <second-profile-uuid>
```

Register and assign a workspace:

```bash
machdoch instructions workspaces register .
machdoch instructions assignments set <workspace-uuid> \
  --path . \
  --expected-revision <revision> \
  --profile <profile-uuid>
machdoch instructions assignments set <workspace-uuid> \
  --path apps/web \
  --expected-revision <revision> \
  --profile <web-profile-uuid>
```

Manage local `AGENTS.md`:

```bash
machdoch instructions local create apps/web \
  --prompt "Use the web package scripts for checks."
machdoch instructions local show apps/web --json
machdoch instructions local edit apps/web \
  --expected-digest <sha256> \
  --prompt-file apps-web-agents.md
machdoch instructions local delete apps/web --expected-digest <sha256>
```

Inspect a resolution:

```bash
machdoch instructions resolve \
  --surface cli \
  --path apps/web/src \
  --json
```

Add `--include-content` only when body disclosure is intentional. Compatible
delivery needs no acknowledgement; unsupported delivery blocks before launch.

Validate all current state:

```bash
machdoch instructions validate --json
```

## Provider delivery

API providers receive the frozen envelope through their supported instruction
field on every request. Delegated CLIs receive it through an owner-restricted,
run-scoped adaptation selected after probing the actual executable.

Delivery is graded:

- `full`: all delivery dimensions are satisfied;
- `compatible`: complete content is available, but a provider property such as
  authority, isolation, lifecycle, or conformance is weaker or unverified;
- `unsupported`: complete delivery cannot be guaranteed.

There is no truncation or prompt-fallback mode. Provider limitations remain
visible as telemetry, and the complete canonical envelope is delivered once
through the provider's system/developer/native-instruction channel. If that
contract is unavailable, execution blocks.

Provider-native files such as Claude memory, Gemini context, or GitHub Copilot
instructions remain provider-owned. Machdoch does not import or rewrite them;
delegated runs use isolated state and treat Machdoch's canonical envelope as
the sole instruction source of truth. Invalid files are skipped with warnings.

## MCP initialization hints

Enabled MCP servers can return non-empty initialization instructions. Machdoch
freezes, deduplicates, bounds, budgets, and reattaches these hints as advisory
runtime context. They are separate from profiles and do not grant tools or
permissions.

Persistent **Provider MCP sync** projects MCP configuration only. It does not
store or project instruction profiles.

## RALPH

Put flow-wide persistent guidance in the flow JSON `guidance` field. The
guidance applies after profiles and local `AGENTS.md`. Individual prompt-block
content remains the current task input.

RALPH checkpoints bind the frozen instruction digest. Resume can require the
current digest, retain the recorded boundary, or explicitly start a new
boundary; it never adopts changed guidance silently.

## Transfer

Export profiles and ordered defaults:

```bash
machdoch instructions transfer export --json > instruction-profiles.json
```

Add `--include-workspaces` to include root-free assignment records. Imported
workspace records are unbound and require explicit relink:

```bash
machdoch instructions transfer import \
  --prompt-file instruction-profiles.json \
  --include-workspaces \
  --decisions-file transfer-decisions.json
```

Transfer never includes absolute workspace roots or repository `AGENTS.md`.
Conflicting UUIDs or names require an explicit reviewed decision.

The desktop Settings Transfer category is **Instruction Profiles**
(`instruction-profiles.global`).

## Recovery

If the primary instruction library is corrupt, normal mutations stop. Inspect
recovery metadata first:

```bash
machdoch instructions recovery status --json
```

After validating the reported backup digest, restore it:

```bash
machdoch instructions recovery restore \
  --expected-digest <validated-backup-sha256>
```

Recovery export requires both the expected digest and `--include-content`.
Reset requires the reviewed digest of the corrupt primary and creates a new
empty library. These operations never infer or silently discard profile data.

## Storage and privacy

The library is stored in the Machdoch user config directory as
`instruction-library.json`, with an atomic backup and redacted audit log.
Profile and local bodies are omitted from standard inspection, delivery
receipts, and diagnostics. Settings transfer encrypts instruction-profile
content in transit.

For the normative implementation contract, see
[Instruction Profiles and Delivery Specification](instruction-file-simplification-spec.md).
