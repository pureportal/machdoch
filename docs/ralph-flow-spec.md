# Ralph Flow Overhaul Specification

## Goal

Replace the current linear Ralph template implementation with a graph-based self-executing prompt flow system. A Ralph flow is a saved, editable flow chart where prompt, validator, decision, pack, start, and end blocks are connected by rule-labeled edges. The runner executes blocks autonomously with model, workspace, file, web, memory, attachment, retry, and variable support per block.

Ralph is not currently in production use, so the existing linear template model can be removed instead of migrated.

## Product Principles

- Ralph flows run inside machdoch and default to the active chat workspace.
- Ralph should be able to execute without human approval. Manual stop is always available.
- Normal chat ask mode remains separate. Ralph runs use machdoch execution mode.
- Flows may loop indefinitely at graph level. Individual block execution has retry controls.
- Users can build flows manually, generate complete flows, generate single prompt blocks, or ask AI to refactor/improve existing flows.
- AI edits mutate the current flow directly in "Do it" mode and create restorable revisions.
- "Interview" mode asks clarifying questions first and applies changes only after the interview is complete.

## Storage

Use filesystem-backed JSON artifacts:

```text
.machdoch/ralph/flows/<flow-id>.json
.machdoch/ralph/runs/<run-id>.json
.machdoch/ralph/revisions/<flow-id>/<revision-id>.json
```

No import/export UI is required initially. Filesystem storage is sufficient.

Manual edits create a revision when the edited prompt/block is closed, not on every keystroke. AI edits always create a revision. Restoring a revision creates a new revision first, so restores are undoable.

## Flow Graph Model

Each flow has exactly one `START` block and any number of `END` blocks. Blocks are connected by directed edges. Edges are labeled by the output condition they handle.

### Block Types

| Type | Purpose | Default outputs |
| --- | --- | --- |
| `START` | Entry point. Only one per flow. | `SUCCESS` |
| `PROMPT` | Runs a normal agent prompt. No required decision marker. | `SUCCESS`, `ERROR` |
| `VALIDATOR` | Evaluates prior work or a configured scope. Must return a decision marker. | `DONE`, `CONTINUE`, `RETRY`, `ERROR` |
| `DECISION` | AI classifier/router. Initially supports configured labels such as `YES` and `NO`. | configured labels, `ERROR` |
| `PACK` | Injects an existing context pack into downstream execution. | `SUCCESS`, `ERROR` |
| `END` | Terminal status node. Multiple end blocks are allowed. | none |

Validator blocks use fixed decisions for now. Custom decision labels are reserved for `DECISION` blocks and possible future extensibility.

### Routing Semantics

- `PROMPT.SUCCESS` routes to the next connected block.
- `PROMPT.ERROR` uses the block retry policy first. If retry is exhausted or disabled and an `ERROR` edge exists, follow it. Otherwise the run crashes at that block.
- `VALIDATOR.DONE` should route to an `END` block or the next group.
- `VALIDATOR.CONTINUE` must have an explicit connected edge. Missing `CONTINUE` handling is a warning in the editor and a runtime crash if returned.
- `VALIDATOR.RETRY` may be connected explicitly. If it is unconnected, rerun from the validator's group start.
- `VALIDATOR.ERROR` uses the block retry policy first. If retry is exhausted or disabled and an `ERROR` edge exists, follow it. Otherwise the run crashes at that block.
- `DECISION` outputs must be connected explicitly when the label is possible. Missing labels are warnings and crash at runtime if returned.
- `PACK.SUCCESS` continues to the next block. `PACK.ERROR` follows the error retry behavior.

`BLOCKED` is not a normal flow decision. Runtime or guardrail failures are represented as `ERROR`.

## Validation Scope And Groups

Validator blocks have a `validationScope` setting:

- `sinceLastValidator` default
- `previousBlock`
- `selectedBlocks`
- `wholeFlow`

For `sinceLastValidator`, the group start is the first executable block after the previous validator, decision block, start block, or manually marked group boundary. This supports flows like:

```text
START -> Fix TSC -> Fix Lint -> Validate Both
```

If `Validate Both` returns `RETRY` and no `RETRY` edge is connected, Ralph reruns from `Fix TSC`.

## Retry And Loop Semantics

Ralph-level graph loops are allowed and can be endless. This is the main Ralph behavior.

Each executable block has a retry policy:

```json
{
  "retry": {
    "mode": "infinite",
    "maxRetries": null,
    "delaySeconds": 0
  }
}
```

- Default retry mode is infinite for `ERROR`.
- A finite `maxRetries` can be set per block.
- Retry counters reset after a successful continue to another block.
- A manual stop button is mandatory in the run UI.
- Optional runtime/cost caps can exist, but they must be visible and configurable.

Prompt blocks also have internal execution settings:

- `maxIterations` defaults to `1`.
- If `maxIterations > 1`, the prompt reruns in the same agent context, like normal chat mode.
- Internal prompt validators are disabled by default for Ralph but can be enabled per prompt block.

## Per-Block Execution Settings

Every executable block can configure:

- provider
- model
- workspace: `default` uses active chat workspace, or a custom workspace path
- web access
- file access
- attachments
- context packs
- max internal iterations
- timeout
- temperature
- retry policy

An omitted or `null` timeout does not impose an absolute runtime deadline. Normal inactivity detection, explicit cancellation, and execution failures still apply.

The block inspector should show the most used settings first and hide advanced settings behind "Show more".

Unavailable selected provider/model is a hard run blocker. The UI should offer an AI action to replace unavailable models in the flow.

## Context, Memory, And Results

Ralph can use enabled session memory and global memory. Session memory should be sufficient as a knowledge base when enabled.

Each run writes separate run memory/logs under `.machdoch/ralph/runs`. Logs should store:

- flow id and revision id
- block execution order
- resolved variables
- prompts and results as text
- result summaries
- error records
- attachment references and metadata
- capped large content, not unlimited file blobs

Every block result is addressable by id. Built-in placeholders:

```text
{{lastResult}}
{{lastResultSummary}}
{{lastError}}
{{runLog}}
{{result:block-id}}
{{summary:block-id}}
{{error:block-id}}
```

Normal prompt blocks do not need to emit a decision marker. Their final output is available to downstream blocks through these placeholders.

## Variables

Variables are discovered from prompt/block text and attachment expressions. Variables that are not used in prompts or block settings are not needed.

Use this syntax:

```text
{{name:type=default}}
```

Examples:

```text
Scope: {{scope:path=ALL}}
Target URL: {{targetUrl:url}}
Attach screenshot: {{screenshot:image}}
```

Supported initial variable types:

- `string`
- `text`
- `path`
- `file`
- `files`
- `url`
- `number`
- `boolean`
- `image`
- `images`
- `model`
- `provider`
- `pack`

Before running a flow, the UI asks for values for discovered variables. Defaults are prefilled. File/image variables can be used as attachments.

## Packs

Ralph uses the existing machdoch context packs. There is no Ralph-specific pack type.

Pack references always use the latest pack version. Pack blocks can be configured with a propagation mode:

- `nextBlockOnly`
- `untilOverridden`

When deleting or removing a pack, the UI must warn if any Ralph flow references it.

## Flow Validation

Validation produces hard errors and warnings.

Hard blockers:

- invalid flow JSON/schema
- no `START` block
- more than one `START` block
- missing referenced block
- missing required run variable
- unavailable selected provider/model

Warnings:

- missing edge for a possible output
- `VALIDATOR.CONTINUE` edge missing
- decision label not connected
- no terminal path to an `END` block
- pack reference missing or removable pack is in use
- unreachable blocks
- validator scope cannot be resolved cleanly
- prompt references a missing built-in result
- attachment variable has unsupported type for the selected provider/model

Users can run with warnings. If a missing route is reached at runtime, the flow crashes and the live graph highlights the crashed block/edge condition.

## AI Generation And Editing

AI support exists in three places:

1. Generate a complete flow.
2. Generate a single prompt block.
3. Refactor, change, or improve an existing flow or prompt block.

Each action supports:

- `Do it`: directly generate or mutate the flow.
- `Interview`: ask clarifying questions first, then apply changes after the interview ends.

Flow generation behavior:

- If the current canvas is empty, generate a complete flow.
- If a flow already exists, modify the current flow based on the request.
- The generator can inspect workspace files and use web access when useful.
- A second AI validation pass reviews the generated/modified graph before finishing.
- Generation and validation results are stored in flow revision metadata.

The generator must create explicit validation blocks for important objectives. The last meaningful work group should normally be validated by a validator block before reaching success.

## UI Requirements

Use a canvas-first editor:

- left side: flow list and block palette
- center: node canvas
- right side: selected block inspector
- bottom: warnings, validation details, and run log

When a Ralph flow is running from the chat window:

- replace the normal chat textarea with a Ralph run control bar
- show the live canvas state
- highlight the current block
- highlight crashed blocks and missing route conditions
- show current block transcript
- show a collapsible run log
- always show a stop button

### Visual Block Language

Blocks need distinct icon/color treatment:

- `START`: entry icon, neutral/green
- `PROMPT`: prompt/message icon, blue
- `VALIDATOR`: check/shield icon, green/amber
- `DECISION`: split/branch icon, violet
- `PACK`: package/library icon, orange
- `END`: stop/flag icon, slate/red/green based on terminal status

Blocks with incomplete rule handling should show a warning badge. Blocks using unavailable models should show a hard-error badge.

### Prompt Editing

Prompt blocks are manually editable. The editor needs syntax highlighting for:

- user variables
- variable types
- defaults
- built-in result placeholders
- invalid placeholders

Users can add `START` and `END` blocks manually. The editor must prevent adding a second start block or immediately mark it as invalid.

## Initial Schema Shape

```json
{
  "schemaVersion": 1,
  "id": "flow-id",
  "name": "Flow name",
  "description": "Optional description",
  "createdAt": "2026-06-13T00:00:00.000Z",
  "updatedAt": "2026-06-13T00:00:00.000Z",
  "variables": [],
  "blocks": [
    {
      "id": "start",
      "type": "START",
      "title": "Start",
      "position": { "x": 0, "y": 0 }
    },
    {
      "id": "fix-tsc",
      "type": "PROMPT",
      "title": "Fix TSC errors",
      "prompt": "Fix TypeScript errors in {{scope:path=ALL}}.",
      "settings": {
        "workspace": { "mode": "default" },
        "provider": "default",
        "model": "default",
        "webAccess": false,
        "fileAccess": true,
        "attachments": [],
        "packs": [],
        "maxIterations": 1,
        "timeoutSeconds": null,
        "temperature": null,
        "internalValidatorEnabled": false,
        "retry": { "mode": "infinite", "maxRetries": null, "delaySeconds": 0 }
      },
      "position": { "x": 260, "y": 0 }
    },
    {
      "id": "validate",
      "type": "VALIDATOR",
      "title": "Validate fixes",
      "prompt": "Validate TSC and lint for {{scope:path=ALL}}. End with RALPH_DECISION: DONE, CONTINUE, RETRY, or ERROR.",
      "validationScope": { "mode": "sinceLastValidator" },
      "settings": {
        "workspace": { "mode": "default" },
        "provider": "default",
        "model": "default",
        "webAccess": false,
        "fileAccess": true,
        "attachments": [],
        "packs": [],
        "timeoutSeconds": null,
        "temperature": null,
        "retry": { "mode": "infinite", "maxRetries": null, "delaySeconds": 0 }
      },
      "position": { "x": 520, "y": 0 }
    },
    {
      "id": "success",
      "type": "END",
      "title": "Success",
      "status": "success",
      "position": { "x": 780, "y": 0 }
    }
  ],
  "edges": [
    { "id": "start-to-fix", "from": "start", "fromOutput": "SUCCESS", "to": "fix-tsc" },
    { "id": "fix-to-validate", "from": "fix-tsc", "fromOutput": "SUCCESS", "to": "validate" },
    { "id": "validate-done", "from": "validate", "fromOutput": "DONE", "to": "success" },
    { "id": "validate-continue", "from": "validate", "fromOutput": "CONTINUE", "to": "fix-tsc" }
  ]
}
```

## Implementation Notes

- Remove old linear Ralph template types, CLI commands, and UI concepts instead of migrating them.
- Keep CLI and GUI support. CLI can run, list, show, validate, and generate flows from the same flow JSON.
- The graph runner should be pure core logic where possible, with CLI/Tauri wrappers for IO and UI.
- Validation should be available without running the flow.
- Runtime events should stream block start, block output, edge routing, retry, crash, and end events to the UI.
- The executor should isolate per-block settings but still allow session/global memory and configured context packs.
- Avoid adding a graph dependency until the UI implementation confirms whether existing React/Tailwind primitives are insufficient. If a dependency is added, prefer a maintained React graph/canvas library and keep graph data in the Ralph schema, not in library-specific state.
