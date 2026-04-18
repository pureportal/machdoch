# machdoch

> Local-first OS AI agent for CLI and desktop.

`machdoch` is a pre-alpha operating-system AI agent with a shared TypeScript runtime, a runnable CLI, and a Tauri/React desktop shell. Give it a task, choose which tools and mode it may use, and let it stage a preview, execute deterministic local actions, or hand off to a model-driven loop when a provider is configured.

**Current state:** pre-alpha / working CLI + desktop prototype  
**Repository state:** shared runtime, customization loading, model providers, desktop shell, and release workflows are implemented; broader browser/server/ecosystem features are still in progress.

## What exists today

- shared TypeScript runtime for config, customizations, prompt resolution, tool policies, deterministic execution, and model-driven task execution
- runnable CLI with `run`, `inspect`, `config`, `tools`, `profiles`, provider helpers, default-model persistence, and global-memory controls
- interactive chat entry in the CLI when runtime options are provided without a one-shot task
- provider adapters for OpenAI, Anthropic, and Google
- Perplexity/Tavily web search integration when configured
- session and global conversation memory
- Tauri + React desktop shell with persisted sessions, provider settings, profile/model/mode controls, workspace handoff, and task progress streaming
- desktop voice input/output plus a desktop UI-control bridge on supported platforms
- Windows/Linux release automation for Tauri bundle artifacts

## Try the current repo

`machdoch` currently expects Node.js $>= 20.10$. Use Rust stable and the normal Tauri system dependencies only when you want to run or build the desktop shell.

```bash
npm install
npm test
npm run test:ui
npm run coverage
npm run inspect
npm run dev -- config
npm run dev -- tools
npm run dev -- profiles
npm run dev -- "show README.md"
npm run dev -- "scan this workspace and explain the setup"
npm run tauri:dev
```

Optional global command during development:

```bash
npm run build
npm link
machdoch inspect
machdoch config
machdoch tools
machdoch "summarize this project"
```

## Why `machdoch`

- **Finish tasks, not just chats**
- **One core, two interfaces**: CLI today, desktop shell already in progress
- **Safe defaults without maximum bureaucracy**
- **Provider-flexible by design**: OpenAI, Anthropic, and Google today; more providers and local backends later
- **Extensible by design**: instructions, prompt files, skills, profiles, and compatibility hooks

## Design principles

- local-first execution
- simple security model
- observable actions and approvals
- powerful features stay opt-in
- no permanent admin mode
- keep the core small and understandable

## Status legend

- **Done** — already exists in this repository today
- **Partly Implemented** — runnable or wired up in code, but not yet complete or polished
- **Planned** — agreed target, not started or still only lightly sketched

## Current repo status

| Area | Status | Details |
| --- | --- | --- |
| Shared runtime | **Partly Implemented** | `src/core` already loads config and env, discovers customizations, resolves prompt invocations and tool policies, executes deterministic local tasks, and can switch into a model-driven tool loop. |
| CLI | **Partly Implemented** | The CLI is runnable today and exposes `run`, `inspect`, `config`, `tools`, `profiles`, provider setup, default-model persistence, and global-memory toggles. |
| Desktop shell | **Partly Implemented** | The Tauri + React desktop app already exists with sessions, workspace selection, provider/model/mode/profile controls, task handoff, progress streaming, and settings dialogs. |
| Customization system | **Partly Implemented** | The repo ships a real `.machdoch/config.json`, always-on and conditional instructions, a prompt file, and a skill folder; discovery and prompt resolution are implemented. |
| Provider integration | **Partly Implemented** | OpenAI, Anthropic, and Google adapters are wired into the shared runtime, with user-scoped API key storage in the desktop shell/runtime helpers. |
| Web search | **Partly Implemented** | Perplexity and Tavily settings plus a `search_web` tool are implemented when a provider is configured. |
| Voice + desktop control | **Partly Implemented** | The desktop shell already supports OpenAI/Google voice features and a desktop UI-control bridge for captures and input automation on supported platforms. |
| Test coverage | **Done** | Vitest currently covers the shared runtime, CLI parsing/helpers, tool definitions, execution flow, and the desktop chat/session shell. |
| Packaging + release automation | **Partly Implemented** | Tauri bundle targets and GitHub Actions workflows already build Windows and Linux installers plus release assets. |

## What `machdoch` is aiming for

`machdoch` should feel like a practical OS copilot:

- you describe a goal
- the agent builds a plan
- it uses allowed tools to execute the work
- it verifies progress
- it keeps going until the task is complete, blocked, or needs approval

That means the product is not just a chat window with a terminal taped to it. It should be a real task runner with guardrails.

## Feature status

### Core runtime

| Feature | Status | Details |
| --- | --- | --- |
| Task automation loop | **Partly Implemented** | The execution controller can resolve task context, stage previews, execute deterministic workspace inspections or file-creation flows, and fall back to preview when no safe path exists yet. |
| Model-driven execution | **Partly Implemented** | When a provider is configured, the shared runtime can run a tool-using executor loop backed by OpenAI, Anthropic, or Google. |
| Streaming task output | **Partly Implemented** | CLI `--verbose` emits execution-state progress, and the desktop shell streams progress lines into the live thinking panel. |
| Session save/restore | **Partly Implemented** | The desktop shell persists sessions and shell state via Tauri Store/localStorage; CLI chat history is still process-local. |
| Interactive session commands | **Partly Implemented** | CLI chat mode supports `/help`, `/exit`, and `/quit`; richer commands like `/reset` and `/undo` are still planned. |
| Verbose / inspect mode | **Partly Implemented** | `inspect`, `config`, `tools`, `profiles`, JSON output, and verbose progress are implemented. |
| Headless / server mode | **Planned** | Expose the runtime through a local API for scripts or other apps. |
| Budget / usage caps | **Planned** | Support token and cost guardrails per task or profile. |

### Interfaces

| Feature | Status | Details |
| --- | --- | --- |
| CLI app | **Partly Implemented** | The TypeScript CLI is already usable for inspection, config review, tool-policy review, profiles, and task execution/preview. |
| Global `machdoch` command | **Partly Implemented** | The package exposes a real bin entry, but you currently need to build first and then link/install it. |
| Desktop app | **Partly Implemented** | The desktop shell already provides sessions, settings, chat/task handoff, execution rendering, voice controls, and workspace-aware task runs. |
| Tray + startup behavior | **Partly Implemented** | The desktop shell already has a tray icon, hide-to-tray behavior, autostart settings, and startup-mode handling. |
| Context menu integration | **Planned** | Add right-click OS/file-manager actions for selected files and folders. |
| Timeline view | **Partly Implemented** | Timeline/grouping models exist in the UI layer, but the dedicated timeline surface is not exposed in the current shell. |
| Diff viewer | **Planned** | Preview file changes before or after write operations. |
| Approval dashboard | **Planned** | Approval-required states are surfaced inline today, but there is no dedicated dashboard yet. |
| Notifications | **Planned** | Signal approvals or task completion without keeping the main window open. |

### Safety and control

| Feature | Status | Details |
| --- | --- | --- |
| Approval mode | **Partly Implemented** | Safe/ask mode can stop model-driven tool calls with an `approval-required` result instead of blindly continuing. |
| Autopilot mode | **Partly Implemented** | `auto` mode already runs an executor plus validator/monitor pass with continuation limits. |
| Simple safe mode | **Partly Implemented** | Safe mode resolves policies conservatively and prevents automatic execution without approval. |
| Tool allow/deny profiles | **Partly Implemented** | `.machdoch/config.json` and named profiles can change enabled tools, mode, provider, model, offline mode, and compatibility flags. |
| Elevated/admin actions | **Planned** | Elevation should happen per action, not as a permanent session state. |
| Audit log | **Partly Implemented** | Per-task traces and structured output sections exist, but there is no separate durable audit-log store yet. |
| Secret redaction | **Planned** | Logs and UI should avoid leaking credentials or tokens. |
| Checkpoints / rollback | **Planned** | Later safety feature for higher-risk workflows. |

### Models, config, and extensibility

| Feature | Status | Details |
| --- | --- | --- |
| Model abstraction layer | **Partly Implemented** | The shared runtime already includes adapters for OpenAI, Anthropic, and Google. |
| Web search providers | **Partly Implemented** | Perplexity/Tavily configuration and runtime search support are implemented. |
| Local model mode | **Planned** | Connect to Ollama, LM Studio, Jan, or similar local endpoints. |
| Profiles / config files | **Partly Implemented** | The runtime loads `.machdoch/config.json`, workspace `.env`, env overrides, named profiles, and workspace default-model persistence. |
| Instruction files | **Partly Implemented** | Always-on and conditional instructions are discovered, matched by keywords/path globs, and included in task context. |
| Prompt files | **Partly Implemented** | Prompt invocation and input resolution are implemented, and the repo already ships a `debug-build` prompt example. |
| Skill folders | **Partly Implemented** | Skill discovery and metadata loading are implemented, and the repo already ships a `browser-automation` skill example. |
| VS Code compatibility mode | **Partly Implemented** | The runtime can optionally discover `.github/copilot-instructions.md`, `.github/instructions`, `.github/prompts`, `.github/skills`, and `AGENTS.md`. |
| Plugin / MCP integrations | **Planned** | Native plugins and MCP-style integrations are still future work. |

### Computer capabilities

| Feature | Status | Details |
| --- | --- | --- |
| Filesystem tools | **Partly Implemented** | The executor already supports listing directories, reading files, searching the workspace, creating brand-new files, and targeted exact-text replacement inside the workspace boundary. |
| Shell commands | **Partly Implemented** | The executor can run shell commands in-workspace or start detached commands for long-lived apps/documents/URLs. |
| Network tools | **Partly Implemented** | The runtime can fetch URLs directly and use configured web search providers. |
| Browser automation | **Partly Implemented** | There is no dedicated browser-driver runtime yet, but the repo already ships a browser-automation skill example and desktop UI control can automate browser windows indirectly. |
| Git support | **Partly Implemented** | There is no dedicated Git tool abstraction yet, but Git workflows can already run through the shell tool under policy control. |
| Package manager support | **Partly Implemented** | There is no dedicated npm/pnpm/pip/cargo tool layer yet, but package commands can already run through the shell tool. |
| Data workflows | **Planned** | Plot, clean, inspect, and transform data. |
| Media / document workflows | **Planned** | Create or edit images, PDFs, subtitles, and similar assets. |
| Window / input automation | **Partly Implemented** | The desktop UI bridge can enumerate monitors/windows, capture screens/windows, click, drag, type, press keys, wait for windows, and on Windows target native child controls. |
| Voice mode | **Partly Implemented** | The desktop shell already supports OpenAI/Google TTS+STT, browser speech fallback, and optional auto-read of assistant replies. |

### Distribution

| Feature | Status | Details |
| --- | --- | --- |
| Windows installer | **Partly Implemented** | Tauri bundling already targets MSI and NSIS, and CI workflows build those artifacts. |
| Linux installer | **Partly Implemented** | Tauri bundling already targets deb, rpm, and AppImage, and CI workflows build those artifacts. |
| Release automation | **Partly Implemented** | GitHub Actions already create/reuse releases, upload Tauri assets, and generate SBOM/provenance attestations. |
| Shell / terminal integration | **Partly Implemented** | The npm package exposes a `machdoch` command once the CLI has been built and linked/installed. |
| File-manager context menu integration | **Planned** | Add OS-level context menu hooks for selected files/folders. |
| One-line install path | **Planned** | Simple bootstrap flow inspired by Open Interpreter installers. |
| No-install sandbox/demo | **Planned** | Optional isolated trial environment for safer exploration. |
| Auto-updates | **Planned** | For packaged desktop releases later on. |

## Nice features we still want after reviewing Open Interpreter

Open Interpreter is still a good reference point for what makes a local AI agent feel useful quickly. These are the ideas worth borrowing or adapting next:

- **Terminal-first MVP** — keep proving the shared runtime in the CLI before overdesigning the desktop shell.
- **Richer streaming execution** — the groundwork exists, but the output experience can still get better.
- **Stronger session restore** — persist and resume more than the current desktop shell state.
- **Simple profiles** — keep switching models, policies, or runtime defaults easy.
- **Local model connectivity** — add serious offline-ish workflows without changing the core design.
- **Verbose mode** — continue making the agent debuggable for developers and power users.
- **Interactive helper commands** — expand the current minimal chat command set.
- **Server mode** — expose the core engine to other applications over an API.
- **One-line installers** — reduce friction for people who just want to try it.
- **Optional browser / OS modes** — powerful capabilities should stay installable and visible, not surprising.

## Simple security model

Security matters, but it should not turn the project into a compliance fan fiction generator.

The default model should stay understandable:

### `safe`

- no automatic execution
- conservative tool defaults
- explicit approval before enabled tools run
- best for first-time use or untrusted tasks

### `ask`

- recommended default
- ask before riskier commands, writes, package installs, browser/UI automation, or network side effects
- still fast enough for day-to-day use

### `auto`

- for trusted workspaces and trusted profiles
- auto-run actions only within allowed tool boundaries
- includes a validator/monitor pass when model-driven execution is active

### `elevated`

- **not** a full-session mode
- specific actions may request admin/root access later
- the main app should stay unprivileged
- elevation should be explicit, inspectable, and reversible where possible

### MVP security philosophy

For the first real versions, we should prefer:

- human-readable tool policies
- a few clear execution modes
- good defaults
- visible approvals
- inspectable task traces

Over:

- giant policy DSLs
- deep enterprise-only permission trees
- magical security claims that are hard to verify

## Customization model

After reviewing VS Code's approach, `machdoch` separates customization into three layers:

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

## Current repo customization layout

This repository already ships a small but working `.machdoch/` example:

```text
.machdoch/
  config.json
  instructions.md
  instructions/
    security.instructions.md
  prompts/
    debug-build.prompt.md
  skills/
    browser-automation/
      SKILL.md
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

`machdoch` supports named profiles in `.machdoch/config.json`.

The current repository already ships these example profiles:

- `workspace` — default interactive workspace profile in `ask` mode
- `safe-review` — read-focused profile with `safe` mode and limited tools
- `local-model` — example alternate provider/model profile

General behavior:

- `defaultProfile` selects the workspace default profile
- `profiles.<name>` can override mode, tools, provider, model, offline mode, and compatibility flags
- `--profile <name>` overrides the default for a single command
- `machdoch profiles` lists configured profiles and marks the active one

### Current compatibility support

If `compatibility.discoverGithubCustomizations` is enabled in `.machdoch/config.json`, the runtime can also discover:

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

The current code layout is:

- `src/core` — runtime config, customization discovery, prompt resolution, policy, execution, provider adapters, web search, memory, and tool definitions
- `src/cli` — CLI parsing, summaries, interactive chat entry, and task-run helpers
- `src/tauri/ui` — React desktop shell, session state, settings UI, provider/model catalog, and desktop runtime bridge
- `src-tauri` — Rust shell, tray/autostart behavior, runtime snapshot APIs, desktop task bridge, voice APIs, and desktop UI-control bridge

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

Mostly complete.

- finalize README direction
- choose repo structure and package strategy
- define the shared runtime boundaries

### Phase 1 — CLI MVP

In progress.

- task loop
- model abstraction
- tool registry and execution
- config loading
- approvals and logging
- instructions, prompts, and skills discovery
- global `machdoch` command for Linux shells and Windows terminal usage

### Phase 2 — desktop shell

In progress.

- Tauri app
- React desktop shell
- session and settings UX
- progress streaming and execution rendering
- approvals, timeline, diff, and richer logs still to come

### Phase 3 — safety and power features

- stronger safe mode and approval UX
- elevation broker
- richer browser automation
- deeper session restore
- API/server mode

### Phase 4 — packaging and ecosystem

- polished Windows/Linux installers
- one-line installers
- file-manager context menu integration
- plugin / MCP integrations
- import/export of skill and prompt packs

## Summary

`machdoch` is now a **pre-alpha, extensible, local-first OS AI agent prototype** with:

- a shared TypeScript runtime
- a working CLI
- a real Tauri + React desktop shell
- provider adapters for OpenAI, Anthropic, and Google
- customizable instructions, prompts, skills, and profiles
- configurable web search, memory, voice, and desktop UI-control foundations
- Windows/Linux packaging workflows already underway

The goal is still ambitious, but the repository is no longer just an idea doc—it already behaves like an early task runner, and the remaining work is mostly about broadening capability, tightening safety, and polishing the experience.
