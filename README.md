<div align="center">
  <img src="assets/branding/logo.png" alt="machdoch logo" width="180" />
  <h1>machdoch</h1>
  <p><strong>Local-first OS AI agent for CLI and desktop.</strong></p>
  <p>Shared TypeScript runtime • Node.js CLI • Tauri + React desktop shell</p>
</div>

<p align="center">
  <img alt="Status: pre-alpha" src="https://img.shields.io/badge/status-pre--alpha-orange" />
  <img alt="Node.js >=20.10" src="https://img.shields.io/badge/node-%E2%89%A520.10-339933?logo=node.js&amp;logoColor=white" />
  <img alt="Tauri v2" src="https://img.shields.io/badge/tauri-v2-24C8DB?logo=tauri&amp;logoColor=white" />
</p>

`machdoch` is a pre-alpha operating-system AI agent prototype with a shared TypeScript runtime, a runnable Node.js CLI, and a Tauri + React desktop shell. The repo already contains real runtime, CLI, desktop, customization, provider, and packaging code — the main gap is between the broader product vision and the narrower set of executor backends that exist today.

> [!IMPORTANT]
> `machdoch` is already real software, not just a mock shell. Filesystem, shell, network, memory, and desktop UI-control workflows exist today. At the same time, `browser`, `git`, and `packages` are still registered categories without dedicated executor backends, so those workflows currently fall back to shell-based approaches or remain planned.

## Table of contents

- [Highlights](#highlights)
- [What exists today](#what-exists-today)
- [Tooling reality check](#tooling-reality-check)
- [Install guide](#install-guide)
- [Quick start](#quick-start)
- [Useful commands](#useful-commands)
- [Shipped customizations](#shipped-customizations)
- [User-scoped configuration](#user-scoped-configuration)
- [Project layout](#project-layout)
- [Roadmap](#roadmap)
- [Contributing](#contributing)

## Highlights

- shared TypeScript runtime for config/env loading, tool-policy resolution, memory, deterministic execution, and model-driven execution
- runnable Node.js CLI with `run`, `inspect`, `config`, `tools`, `profiles`, and provider/memory setup helpers
- Tauri + React desktop shell with persisted sessions, workspace selection, provider/model/profile/mode controls, and progress streaming
- provider adapters for OpenAI, Anthropic, and Google, plus optional Perplexity/Tavily web search when configured
- desktop voice I/O plus a UI-control bridge for screenshots, windows, input automation, and richer native control support on Windows
- GitHub Actions workflows that build Windows and Linux installers, generate SBOMs, and attest build provenance

## What exists today

| Area | Status | What it means |
| --- | --- | --- |
| Shared runtime | 🟡 Partly implemented | `src/core` loads `.machdoch/config.json` and `.env`, discovers instructions/prompts/skills, resolves tool policies, manages memory, previews deterministic tasks, and can run provider-backed tool loops with an autopilot validator pass. |
| CLI | 🟡 Partly implemented | The CLI exposes `run`, `inspect`, `config`, `tools`, `profiles`, `--set-api`, `--default-model`, and `--set-global-memory`. Interactive chat works in a real TTY. |
| Desktop shell | 🟡 Partly implemented | The Tauri + React app persists sessions, remembers provider/model/profile/mode choices, streams task progress, and includes tray/autostart behavior. |
| Customization system | 🟡 Partly implemented | Native `.machdoch` instructions, prompts, skills, and profiles work today. GitHub-style compatibility discovery exists, but it is opt-in and disabled by default. |
| Providers + desktop extras | 🟡 Partly implemented | OpenAI, Anthropic, and Google adapters are wired in. Voice and desktop UI control are desktop-only capabilities. |
| Tests | ✅ Done | Vitest covers the core runtime, CLI helpers, tool logic, and desktop UI/session models. |
| Release automation | ✅ Done | GitHub Actions build Windows (`msi`, `nsis`) and Linux (`deb`, `rpm`, `AppImage`) bundles, generate SBOMs, and attest provenance. |

## Tooling reality check

These are the tool categories the runtime can actually execute today.

| Tool category | Status | Notes |
| --- | --- | --- |
| `filesystem` | ✅ Done | Lists directories, reads files, searches the workspace, creates files, and performs targeted replacement inside the workspace boundary. |
| `shell` | ✅ Done | Runs shell commands in the workspace and can launch detached processes under policy control. |
| `network` | 🟡 Partly implemented | URL fetches are supported, and web search works when Perplexity or Tavily is configured. |
| Memory tools | ✅ Done | Session and global memory helpers can persist short facts. |
| Desktop UI control | 🟡 Partly implemented | Supports monitor/window enumeration, screenshots, clicks, drags, typing, key presses, and window waits. Windows also has richer native control-handle support. |
| `browser` | 🔜 Planned | Registered in the tool surface, but there is no dedicated browser-driver backend yet. |
| `git` | 🔜 Planned | Registered in the tool surface, but there is no first-class Git executor. Use shell-based Git workflows for now. |
| `packages` | 🔜 Planned | Registered in the tool surface, but package installs/updates still go through the shell. |

## Install guide

Release downloads: <https://github.com/pureportal/machdoch/releases/latest>

### Recommended: desktop installer

Download the latest release asset for your platform.

### Windows setup installer

```powershell
Invoke-WebRequest -Uri https://github.com/pureportal/machdoch/releases/latest/download/machdoch-windows-x64-setup.exe -OutFile machdoch-setup.exe
Start-Process .\machdoch-setup.exe -Wait
```

### Windows MSI package

```powershell
Invoke-WebRequest -Uri https://github.com/pureportal/machdoch/releases/latest/download/machdoch-windows-x64.msi -OutFile machdoch.msi
msiexec /i .\machdoch.msi
```

### Debian/Ubuntu package

```bash
wget -O machdoch.deb https://github.com/pureportal/machdoch/releases/latest/download/machdoch-linux-amd64.deb
sudo apt install ./machdoch.deb
```

### Fedora/RHEL/openSUSE package

```bash
wget -O machdoch.rpm https://github.com/pureportal/machdoch/releases/latest/download/machdoch-linux-x86_64.rpm
sudo dnf install ./machdoch.rpm
```

### Linux AppImage

```bash
wget -O machdoch.AppImage https://github.com/pureportal/machdoch/releases/latest/download/machdoch-linux-amd64.AppImage
chmod +x machdoch.AppImage
./machdoch.AppImage
```

### From a checkout

```bash
git clone https://github.com/pureportal/machdoch.git
cd machdoch
npm ci
npm test
npm run dev -- tools
npm run dev -- "scan this workspace and explain the setup"
```

Use `npm install` instead of `npm ci` only when you intentionally want to update `package-lock.json`.

### Build or link locally

```bash
npm run build
npm link
machdoch inspect
machdoch tools
machdoch "summarize this project"
```

For the desktop shell, install Rust stable and the normal Tauri system dependencies, then run:

```bash
npm run tauri:dev
```

To build local installer bundles:

```bash
npm run tauri:build
```

### Configure a provider

The full model-driven agent loop needs an OpenAI, Anthropic, or Google key. The desktop app exposes this in settings; the CLI can persist it in the user-scoped config file:

```bash
machdoch --set-api --provider openai --key YOUR_OPENAI_API_KEY
machdoch config
```

## Quick start

### Requirements

- Node.js `>= 20.10`
- Rust stable and the normal Tauri system dependencies only if you want to run or build the desktop shell

### Install and try the CLI

```bash
npm install
npm test
npm run dev -- tools
npm run dev -- "scan this workspace and explain the setup"
```

### Run the desktop shell

```bash
npm run tauri:dev
```

### Optional global CLI flow during development

```bash
npm run build
npm link
machdoch inspect
machdoch tools
machdoch "summarize this project"
```

## Useful commands

| Goal | Command |
| --- | --- |
| Inspect resolved runtime config | `npm run inspect` |
| Print CLI config help | `npm run dev -- config` |
| List available tools | `npm run dev -- tools` |
| List available profiles | `npm run dev -- profiles` |
| Run the core test suite | `npm test` |
| Run desktop/UI tests | `npm run test:ui` |
| Generate coverage | `npm run coverage` |
| Lint the TypeScript code | `npm run lint` |
| Type-check the shared runtime + CLI | `npm run typecheck` |
| Type-check the desktop UI | `npm run typecheck:ui` |
| Start the desktop app in development | `npm run tauri:dev` |

## Shipped customizations

This repo already includes a working `.machdoch/` example:

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

The sample configuration:

- defaults to the `workspace` profile in `ask` mode
- enables `filesystem`, `shell`, and `network`
- includes example profiles `workspace`, `safe-review`, and `local-model`
- keeps GitHub-style compatibility discovery disabled by default

If `compatibility.discoverGithubCustomizations` is enabled, the runtime can also discover:

- `.github/copilot-instructions.md`
- `.github/instructions/**/*.instructions.md`
- `.github/prompts/**/*.prompt.md`
- `.github/skills/**/SKILL.md`
- `AGENTS.md`

## User-scoped configuration

Provider keys, web-search settings, voice settings, desktop settings, and global memory are stored in a user-scoped config file rather than inside the workspace.

Default locations:

- **Windows**: `%APPDATA%/machdoch/user-config.json`
- **macOS**: `~/Library/Application Support/machdoch/user-config.json`
- **Linux**: `${XDG_CONFIG_HOME:-~/.config}/machdoch/user-config.json`

## Project layout

- `src/core` — runtime config, env loading, customizations, tool policies, deterministic execution, model-driven execution, memory, and web search
- `src/cli` — CLI parsing, summaries, interactive chat, and task-run helpers
- `src/tauri/ui` — React desktop shell, session state, model catalog, runtime bridge, and preview/test fixtures
- `src-tauri` — Rust shell, tray/autostart behavior, runtime snapshots, desktop task bridge, voice APIs, and UI-control bridge

## Roadmap

The following are still roadmap items rather than working features:

- dedicated browser-driver automation
- first-class Git and package-manager tool backends
- headless/server mode
- local-model integrations such as Ollama, LM Studio, and Jan
- diff viewer, standalone timeline/approval surfaces, and notifications
- context-menu integration, auto-updates, and one-line installers
- elevation broker, secret redaction, and a separate durable audit-log store

## Contributing

Issues and pull requests are welcome while the project is still taking shape.

For now, the repo does not ship a dedicated `CONTRIBUTING.md`, so please keep changes small, well scoped, and verified. A good pre-PR checklist is:

```bash
npm test
npm run test:ui
npm run lint
npm run typecheck
npm run typecheck:ui
```

If you want to propose a broader product or architecture change, opening an issue first is the friendliest way to align on scope:

- [Open an issue](https://github.com/pureportal/machdoch/issues)

## Summary

`machdoch` is already a real pre-alpha codebase: the CLI works, the desktop shell exists, customizations are discoverable, provider-backed execution is wired in, and packaging workflows are real. The biggest gap is not whether anything exists — it is the distance between the larger product vision and the smaller set of executor backends that are implemented today.
