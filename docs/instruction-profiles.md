# Instruction Files

Instruction files are reusable Markdown documents managed in the
**Instructions** app.

## Apply a file

- Turn on **Global** to apply the file to every workspace.
- Add a workspace tag rule to apply it automatically.
- Select it manually from the workspace's **Instructions** section.

Global files are always enabled and always included. Workspace tags and manual
selections are saved from the workspace view; there is no separate registration
step.

## Manage content

Select a file to edit its name, optional description, content, settings, and
tags. Use **Preview** to read the rendered Markdown. A file that is still
assigned must be unassigned before deletion.

## CLI

Create and inspect files:

```bash
machdoch instructions profiles create "Review rules" \
  --prompt-file review-rules.md
machdoch instructions profiles list --json
machdoch instructions profiles show <file-uuid>
```

Configure workspace tags and root-level manual selections in one mutation:

```bash
machdoch instructions workspaces configure . \
  --metadata-json '{"tags":["typescript"],"profileIds":["<file-uuid>"]}' \
  --expected-revision <revision>
```

Advanced CLI workflows can assign a manual file to a nested workspace scope:

```bash
machdoch instructions assignments set <workspace-uuid> \
  --path packages/app \
  --profile <file-uuid> \
  --expected-revision <revision>
```

The workspace view shows nested assignments and can remove them.

Inspect the effective set:

```bash
machdoch instructions resolve --surface cli --json
machdoch instructions validate --json
```

## Delivery

Machdoch resolves the applicable central files before a run, freezes their
content, and supplies it through the provider's system/developer instruction
channel. User prompts are streamed through stdin for delegated CLIs. Machdoch
does not synchronize instruction files or use repository `AGENTS.md` as an
instruction source.

Instruction library exports include central files and their settings.
Workspace records are optional and root-free. Imports return them as unbound
mappings; they are not persisted until a caller explicitly configures a new
root and reapplies any nested assignments. Settings transfer does not include
the instruction library.
