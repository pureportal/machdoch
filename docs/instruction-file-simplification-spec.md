# Instruction File System

Status: implemented and normative
Schema generation: 2
Last implementation review: 2026-08-04

## Product contract

Machdoch stores reusable Markdown instruction files in one user-owned library.
Every file has stable identity, content, details, enabled state, tags, and one
application mode:

- **Global**: applies to every workspace and cannot be disabled while global.
- **Tag match**: applies when its rule matches the workspace tags.
- **Manual**: applies when selected in that workspace's management flow.

Global files are always selected, including for workspaces without saved
instruction configuration. Saving workspace tags or manual selections creates
or updates the binding atomically.

Repository instruction files are not Machdoch instruction sources. Machdoch
does not create, edit, import, copy, or synchronize `AGENTS.md` or equivalent
provider files. Delegated CLI runs inventory provider-native sources only to
verify that the run-scoped adapter suppresses or isolates them.

## Persistence and assignment

The central `instruction-library.json` contains:

- instruction file records (`profiles`), including each file's global state;
- deterministic file order; and
- workspace tags and manual file IDs.

`enabled`, `global`, and `tags` are required persisted fields. Global files must
be enabled and cannot also have a tag rule. Invalid or obsolete shapes fail
validation instead of taking a compatibility path.

Workspace configuration accepts the root, display name, tags, and root-level
manual file IDs in one revision-checked mutation. A workspace binding is
created on first assignment or tag save. Global files cannot be stored as
manual assignments. Advanced CLI mutations may assign manual files to nested
workspace scopes. The workspace view exposes those scoped assignments so they
can be found and removed without using the CLI.

## Resolution

The resolver selects, in order:

1. every global instruction file;
2. enabled files whose rules match the workspace tags;
3. enabled manually assigned files, ordered by applicable scope; and
4. optional run-specific flow guidance.

Consecutive exact bodies at the same scope are reported and rendered once
without losing source attribution. The
selected content is frozen before provider execution and rendered into one
bounded, digest-addressed envelope. Retries and continuations reuse the frozen
content. The resolver never falls back to repository files and never truncates
an oversized envelope.

## Interface

The **Instructions** app manages instruction files only: list, search, filter,
create, edit, Markdown preview, details, enabled/global settings, tags, tag
rules, duplicate, and delete. It has no workspace assignment controls and uses
plain hierarchy and icons instead of badges.

The **Workspaces** app owns workspace tags and manual instruction selection.
Global and matching-tag files appear there as read-only effective state;
manual files use selection controls. Existing nested-scope assignments appear
under their file with a removal control. Changes are saved directly from the
workspace. Central bindings remain visible even when the corresponding root is
no longer in recent-workspace history, so they can be relinked or removed.

Settings contains no instruction panel, resolver options, local-file editor,
or compatibility configuration.

## CLI transport

Large and multiline content must not be placed in process arguments. Windows
`CreateProcess` limits a command line to 32,767 characters, while `cmd.exe`
limits command lines and inherited environment expansion to 8,191 characters.
Machdoch therefore passes the desktop task to its shared CLI with `--task -`
and writes the complete UTF-8 task to stdin. The shared CLI validates UTF-8,
rejects empty or over-limit input, and closes stdin after the write.

Delegated providers also receive user content through stdin. Codex documents
`codex exec -` as reading the prompt from stdin, so Machdoch uses that route.
It does not write a prompt file and tell the model to read it.

Resolved instruction content is separate from user content and is supplied
only through each provider's supported system-instruction mechanism:

- Codex: `developer_instructions` in an owner-private, isolated, run-scoped
  `CODEX_HOME/config.toml`, with project instruction discovery disabled;
- Claude: an owner-private, run-scoped `--append-system-prompt-file`;
- Copilot: an owner-private, run-scoped custom agent, with custom repository
  instructions disabled; and
- API providers: the provider's system/developer instruction field.

Run-scoped files are transport artifacts, not synchronized instruction files.
They are deleted after execution, deleted on materialization failure, and
covered by bounded stale-artifact cleanup after abnormal termination.

Primary references:

- [OpenAI Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [OpenAI Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Codex CLI argument source](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs)
- [Microsoft `CreateProcess` documentation](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessa)
- [Microsoft command-line length guidance](https://learn.microsoft.com/en-us/troubleshoot/windows-client/shell-experience/command-line-string-limitation)

## Synchronization boundary

There is no instruction-file synchronization service, daemon, ownership
marker, projection, or reconciliation path. Provider synchronization is an
independent MCP feature and may persist only managed MCP configuration.
Instruction content exists centrally at rest and in private run-scoped
system-prompt transport during execution.
