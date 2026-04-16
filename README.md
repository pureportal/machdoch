# machdoch

> Local-first OS AI agent for CLI and desktop.

`machdoch` is a planned operating-system AI agent: give it a task, decide which tools it may use, choose between approval or autopilot, and let it work until the task is done, blocked, or needs you.

**Current state:** pre-alpha / initial scaffold  
**Repository state:** first CLI + shared-core scaffold is now implemented

## Try the current scaffold

```bash
npm install
npm run inspect
npm test
npm run coverage
npm run dev -- profiles
npm run dev -- tools
npm run dev -- "show README.md"
npm run dev -- "list src"
npm run dev -- "scan this workspace and explain the setup"
```

Optional global command during development:

```bash
npm link
machdoch inspect
machdoch tools
machdoch "summarize this project"
```

## Why `machdoch`

- **Finish tasks, not just chats**
- **One core, two interfaces**: CLI first, desktop second
- **Safe defaults without maximum bureaucracy**
- **Model-provider agnostic**: OpenAI, Anthropic, Google, local backends, and more
- **Extensible by design**: instructions, prompt files, skills, plugins, profiles

## Design principles

- local-first execution
- simple security model
- observable actions and approvals
- powerful features stay opt-in
- no permanent admin mode
- keep the core small and understandable

## Status legend

- **Done** — already exists in this repository today
- **Partly Implemented** — defined/documented here, but runtime code is not finished
- **Planned** — agreed target, not started yet

## Current repo status

| Area                              | Status                 | Details                                                                                                                                                                                                              |
| --------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product blueprint                 | **Done**               | This README defines the first serious product direction for the project.                                                                                                                                             |
| VS Code customization research    | **Done**               | Instructions, prompt files, and skills were researched and translated into a `machdoch`-native model.                                                                                                                |
| Open Interpreter feature research | **Done**               | Useful features from Open Interpreter were reviewed and folded into this plan.                                                                                                                                       |
| Vitest test harness               | **Done**               | A Vitest-based test suite now covers frontmatter parsing, workspace loading, tool policy decisions, and task-preview edge cases.                                                                                     |
| `.machdoch/` customization design | **Partly Implemented** | Folder layout, starter files, and discovery logic now exist; advanced injection and compatibility loading are still pending.                                                                                         |
| Simplified security model         | **Partly Implemented** | Safety modes and privilege strategy are defined, and the scaffold can already resolve per-tool decisions for `safe`, `ask`, and `auto`, but there is no live enforcement/execution loop yet.                         |
| Core runtime                      | **Partly Implemented** | The current core can load config, discover customizations, resolve tool policies, preview task plans, and execute safe read-only filesystem flows for workspace summaries plus explicit file and directory previews. |
| CLI                               | **Partly Implemented** | A runnable `machdoch` CLI now exists with `run`, `inspect`, `config`, `profiles`, and `tools`; `run` can now execute safe read-only inspection flows or fall back to preview mode.                                   |
| Desktop app                       | **Planned**            | Tauri + React + shadcn/ui after the shared runtime exists.                                                                                                                                                           |

## What `machdoch` should be

`machdoch` should feel like a practical OS copilot:

- you describe a goal
- the agent builds a plan
- it uses allowed tools to execute the work
- it verifies progress
- it keeps going until the task is complete, blocked, or needs approval

That means the product is not just a chat window with a terminal taped to it. It should be a real task runner with guardrails.

## Feature status

### Core runtime

| Feature                      | Status                 | Details                                                                                                                                                                                                                                                        |
| ---------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task automation loop         | **Partly Implemented** | The CLI can stage a task preview with suggested tools and execution steps, and it now executes deterministic read-only filesystem paths for workspace inspection plus direct file and directory preview tasks; broader live execution loops are still to come. |
| Streaming task output        | **Planned**            | Show actions, tool output, logs, and verification progress in real time.                                                                                                                                                                                       |
| Session save/restore         | **Planned**            | Resume interrupted work and restore message/task history.                                                                                                                                                                                                      |
| Interactive session commands | **Planned**            | Commands like `/reset`, `/undo`, `/tokens`, `/help`, inspired by Open Interpreter's lightweight terminal UX.                                                                                                                                                   |
| Verbose / inspect mode       | **Planned**            | Useful for debugging, prompt inspection, and tool trace visibility.                                                                                                                                                                                            |
| Headless / server mode       | **Planned**            | Expose the agent core through a local API for scripts, services, or other apps.                                                                                                                                                                                |
| Budget / usage caps          | **Planned**            | Support token and cost guardrails per task or profile.                                                                                                                                                                                                         |

### Interfaces

| Feature                   | Status                 | Details                                                                                                                                       |
| ------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI app                   | **Partly Implemented** | A working TypeScript CLI scaffold exists and can inspect workspace customizations, resolve config, and preview task runs.                     |
| Global `machdoch` command | **Partly Implemented** | The package exposes a real `machdoch` bin entry; global usage works after linking or installation, while polished installers come later.      |
| Desktop app               | **Planned**            | Built with Tauri + React + shadcn/ui for approvals, logs, diffs, and configuration.                                                           |
| Context menu integration  | **Planned**            | Add right-click actions for files/folders so users can send selections directly to `machdoch` with the current path or file context attached. |
| Timeline view             | **Planned**            | Show what the agent decided, ran, and verified at each step.                                                                                  |
| Diff viewer               | **Planned**            | Preview file changes before or after write operations.                                                                                        |
| Approval dashboard        | **Planned**            | Central place to allow, deny, remember, or revoke permissions.                                                                                |
| Notifications             | **Planned**            | Prompt for approval or signal task completion without forcing users to babysit the UI.                                                        |

### Safety and control

| Feature                  | Status                 | Details                                                                                                                                               |
| ------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approval mode            | **Partly Implemented** | The runtime can already resolve which tools would be approval-gated in `safe` and `ask` modes, but it does not execute and pause live tool calls yet. |
| Autopilot mode           | **Planned**            | Runs continuously within profile and tool restrictions.                                                                                               |
| Simple safe mode         | **Partly Implemented** | The intended behavior is documented below, and the CLI can already show what `safe` mode would allow, ask, or block.                                  |
| Tool allow/deny profiles | **Partly Implemented** | `.machdoch/config.json` already enables basic per-tool allow/block behavior, but richer reusable profiles are still to come.                          |
| Elevated/admin actions   | **Planned**            | Elevation should happen per action, never by running the whole app as admin/root.                                                                     |
| Audit log                | **Planned**            | Every action, approval, and result should be inspectable.                                                                                             |
| Secret redaction         | **Planned**            | Logs and UI should avoid leaking keys, tokens, or credentials.                                                                                        |
| Checkpoints / rollback   | **Planned**            | A later safety feature for higher-risk workflows.                                                                                                     |

### Models, config, and extensibility

| Feature                    | Status                 | Details                                                                                                                                                                                                               |
| -------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model abstraction layer    | **Partly Implemented** | The shared runtime now includes OpenAI, Anthropic, and Google adapters, while broader provider coverage and hardening are still in progress.                                                                      |
| Local model mode           | **Planned**            | Connect to Ollama, LM Studio, Jan, or similar local endpoints without changing the core design.                                                                                                                       |
| Profiles / config files    | **Partly Implemented** | The scaffold can load `.machdoch/config.json`, `.env`, named profiles, and the `--profile` CLI override; richer user/global config layers are still to come.                                                          |
| Instruction files          | **Partly Implemented** | The runtime discovers relevant `.machdoch/instructions.md` and `*.instructions.md` files and includes them in task context, but instruction precedence and richer composition still need more hardening.              |
| Prompt files               | **Partly Implemented** | Prompt files are discovered, resolved, and can flow into the shared runtime, but richer prompt orchestration and input UX are still evolving.                                                                         |
| Skill folders              | **Partly Implemented** | Skill folders with `SKILL.md` are discovered and summarized, but on-demand skill loading is still planned.                                                                                                            |
| VS Code compatibility mode | **Partly Implemented** | The runtime can now optionally discover `.github/copilot-instructions.md`, `.github/instructions`, `.github/prompts`, `.github/skills`, and `AGENTS.md` when `compatibility.discoverGithubCustomizations` is enabled. |
| Plugin / MCP integrations  | **Planned**            | Native plugins and MCP servers should both be possible extension points.                                                                                                                                              |

### Computer capabilities

| Feature                    | Status                 | Details                                                                                                                                                                                         |
| -------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell + filesystem tools   | **Partly Implemented** | Safe read-only filesystem flows now support workspace inspection plus explicit file and directory previews inside the workspace; shell execution and broader write workflows are still planned. |
| Network tools              | **Planned**            | Fetch APIs, web pages, and external resources when allowed.                                                                                                                                     |
| Browser automation         | **Planned**            | Optional skill/tool for research, forms, screenshots, and site workflows.                                                                                                                       |
| Git support                | **Planned**            | Status, diff, commit, branch, and repo-aware workflows.                                                                                                                                         |
| Package manager support    | **Planned**            | npm, pnpm, pip, cargo, system package managers, and more where allowed.                                                                                                                         |
| Data workflows             | **Planned**            | Plot, clean, inspect, and transform data.                                                                                                                                                       |
| Media / document workflows | **Planned**            | Create or edit images, PDFs, subtitles, and similar assets, inspired by Open Interpreter use cases.                                                                                             |
| Window / input automation  | **Planned**            | Keyboard, mouse, clipboard, and window automation later on.                                                                                                                                     |
| Voice mode                 | **Planned**            | Nice-to-have later, not part of the first MVP.                                                                                                                                                  |

### Distribution

| Feature                               | Status      | Details                                                                                                                                    |
| ------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Windows installer                     | **Planned** | Desktop installer plus CLI install path.                                                                                                   |
| Linux installer                       | **Planned** | AppImage and/or distro packages plus CLI install path.                                                                                     |
| Shell / terminal integration          | **Planned** | Register the global `machdoch` command in PATH for Linux shells and Windows terminal workflows, with optional shell completions later.     |
| File-manager context menu integration | **Planned** | Add OS-level context menu hooks so `machdoch` can be launched from Explorer and supported Linux file managers with selected files/folders. |
| One-line install path                 | **Planned** | Simple bootstrap flow inspired by Open Interpreter's installers.                                                                           |
| No-install sandbox/demo               | **Planned** | Optional isolated trial environment for safer exploration.                                                                                 |
| Auto-updates                          | **Planned** | For packaged desktop releases later on.                                                                                                    |

## Nice features we want after reviewing Open Interpreter

Open Interpreter is a good reference point for what makes a local AI agent feel useful quickly. These are the ideas worth borrowing or adapting:

- **Terminal-first MVP** — prove the core in the CLI before building a richer desktop shell.
- **Streaming execution** — show tool output as it happens, not just a final summary.
- **Session restore** — let users resume a previous conversation or task.
- **Simple profiles** — switch models, policies, or runtime defaults without passing endless flags.
- **Local model connectivity** — support local servers and offline-ish workflows.
- **Verbose mode** — make the agent debuggable for developers and power users.
- **Interactive helper commands** — reset, undo, token inspection, help, and maybe profile switching.
- **Server mode** — expose the core engine to other applications over an API.
- **One-line installers** — reduce friction for people who just want to try it.
- **Optional browser / OS modes** — powerful capabilities should be installable and visible, not hidden surprises.

## Simple security model

Security matters, but it should not turn the project into a compliance fan fiction generator.

The default model should stay understandable:

### `safe`

- no automatic execution
- optional code/package scanning
- conservative tool defaults
- best for first-time use or untrusted tasks

### `ask`

- recommended default
- ask before commands, writes, package installs, browser automation, or network side effects
- still fast enough for day-to-day use

### `auto`

- for trusted workspaces and trusted profiles
- auto-run actions only within allowed tool boundaries
- still log everything

### `elevated`

- **not** a full-session mode
- specific actions may request admin/root access
- the main app should stay unprivileged
- elevation should be explicit, inspectable, and reversible where possible

### MVP security philosophy

For the first real versions, we should prefer:

- human-readable tool policies
- a few clear execution modes
- good defaults
- visible approvals
- strong audit logs

Over:

- giant policy DSLs
- deep enterprise-only permission trees
- magical security claims that are hard to verify

## Customization model

After reviewing VS Code's approach, `machdoch` should separate customization into three layers:

### Instructions

Always-on or conditionally injected rules.

Use for:

- project conventions
- tool restrictions
- security requirements
- workflow hints based on files, folders, or keywords

### Prompt files

Reusable task templates that the user invokes directly.

Use for:

- `/debug-build`
- `/create-release-notes`
- `/summarize-project`
- `/prepare-onboarding`

### Skills

Portable, multi-file capability packs.

Use for:

- browser automation
- release workflows
- repo maintenance
- data inspection
- document processing

## Planned customization layout

```text
.machdoch/
  instructions.md
  instructions/
    backend.instructions.md
    security.instructions.md
    releases/
      changelog.instructions.md
  prompts/
    summarize-project.prompt.md
    debug-build.prompt.md
  skills/
    browser-automation/
      SKILL.md
      scripts/
      references/
      assets/
```

### User-level config locations

- **Windows**: `%APPDATA%/machdoch/`
- **Linux**: `~/.config/machdoch/`

### Compatibility goals

Later, `machdoch` should optionally discover or import familiar files from other ecosystems, especially:

- `.github/copilot-instructions.md`
- `.github/instructions/**/*.instructions.md`
- `.github/prompts/**/*.prompt.md`
- `.github/skills/**/SKILL.md`
- `AGENTS.md`

### Current profile support

`machdoch` now supports named profiles in `.machdoch/config.json`.

- `defaultProfile` selects the workspace default profile
- `profiles.<name>` can override mode, tools, provider, model, offline mode, and compatibility flags
- `--profile <name>` overrides the default for a single command
- `machdoch profiles` lists configured profiles and marks the active one

### Current compatibility support

If `compatibility.discoverGithubCustomizations` is enabled in `.machdoch/config.json`, the scaffold now also discovers:

- `.github/copilot-instructions.md`
- `.github/instructions/**/*.instructions.md`
- `.github/prompts/**/*.prompt.md`
- `.github/skills/**/SKILL.md`
- `AGENTS.md`

## Proposed file formats

### Always-on instructions

Recommended file: `.machdoch/instructions.md`

Use it for project-wide rules and automation policy defaults.

### Conditional instructions

Recommended files: `.machdoch/instructions/**/*.instructions.md`

Suggested frontmatter:

```yaml
---
name: Security review rules
description: Apply when the task involves authentication, secrets, or permissions.
applyTo: "**/*"
keywords: ["security", "auth", "token", "secret", "permission"]
priority: 80
---
```

### Prompt files

Recommended files: `.machdoch/prompts/*.prompt.md`

Suggested frontmatter:

```yaml
---
name: debug-build
description: Diagnose and fix build failures with minimal changes.
argument-hint: "Describe the build error or attach logs"
agent: agent
model: auto
tools: ["terminal", "filesystem", "git"]
inputs:
  - error
  - logs
---
```

### Skills

Recommended files: `.machdoch/skills/<skill-name>/SKILL.md`

Suggested frontmatter:

```yaml
---
name: browser-automation
description: Automates browser tasks such as login flows, form filling, scraping, and screenshot verification.
argument-hint: "Target site and desired outcome"
user-invocable: true
disable-model-invocation: false
allowed-tools: "browser filesystem network"
---
```

## Architecture at a glance

The current best direction is:

- **TypeScript agent core** for models, tools, prompts, instructions, skills, memory, and task orchestration
- **CLI interface** as the first product surface
- **Tauri/Rust shell** for desktop packaging, native OS integration, and privilege boundaries
- **React + shadcn/ui** for the desktop experience

Suggested modules:

- `agent-core`
- `model-router`
- `tool-runtime`
- `policy-engine`
- `instruction-loader`
- `prompt-runner`
- `skill-loader`
- `audit-log`
- `cli`
- `desktop-app`

## What we want to keep intentionally small

Inspired by Open Interpreter's "keep the core focused" philosophy, `machdoch` should avoid becoming a kitchen-sink framework too early.

Early non-goals:

- giant enterprise policy systems
- dozens of agent personas before the first solid one exists
- permanent root/admin sessions
- desktop-only architecture from day one
- custom file formats when simple Markdown + frontmatter is enough

## Roadmap

### Phase 0 — planning

- finalize README direction
- choose repo structure and package strategy
- define the shared runtime boundaries

### Phase 1 — CLI MVP

- task loop
- model abstraction
- tool registry
- config loading
- approvals and logging
- instructions, prompts, and skills discovery
- global `machdoch` command for Linux shells and Windows terminal usage

### Phase 2 — desktop shell

- Tauri app
- React + shadcn/ui frontend
- approvals UI
- task timeline
- diff and log views

### Phase 3 — safety and power features

- safe mode
- elevation broker
- browser automation
- session restore
- API/server mode

### Phase 4 — packaging and ecosystem

- Windows/Linux installers
- one-line installers
- file-manager context menu integration
- plugin / MCP integrations
- import/export of skill and prompt packs

## Summary

`machdoch` aims to be a **practical, extensible, local-first OS AI agent** with:

- CLI and desktop interfaces
- task completion loops
- approval and autopilot modes
- simple but serious security defaults
- reusable instructions, prompts, and skills
- model-provider flexibility
- Windows and Linux delivery

The goal is ambitious, but the implementation style should stay boring in the best possible way: clear, inspectable, and useful.
