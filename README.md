<div align="center">
  <img src="./assets/branding/logo.png" alt="machdoch logo" width="120" />
  <h1>machdoch</h1>
  <p><strong>Local-first OS AI agent for desktop and CLI.</strong></p>
  <p>Use AI models with your files, terminal, browser, Git repository, package manager, memory, voice, and desktop UI.</p>
</div>

<p align="center">
  <img alt="Status: pre-alpha" src="https://img.shields.io/badge/status-pre--alpha-orange" />
  <img alt="Windows installer" src="https://img.shields.io/badge/windows-installer-0078D4?logo=windows&amp;logoColor=white" />
  <img alt="Linux packages" src="https://img.shields.io/badge/linux-deb%20%7C%20rpm%20%7C%20AppImage-FCC624?logo=linux&amp;logoColor=black" />
</p>

`machdoch` is a pre-alpha desktop app and command-line agent that runs against a local workspace. It can chat interactively, run one-shot tasks, attach files/folders/images as context, remember useful facts, control installed browsers, inspect or edit files, run shell workflows, use Git, work with Node package projects, and use desktop voice or UI-control features when available.

> [!IMPORTANT]
> `machdoch` can read and modify local files and run local tools when those tools are enabled. Use `safe` or `ask` mode when you want approval prompts before higher-risk actions.

## Contents

- [Install](#install)
- [First Run](#first-run)
- [Desktop App](#desktop-app)
- [CLI](#cli)
- [Modes](#modes)
- [Capabilities](#capabilities)
- [Workspace Customization](#workspace-customization)
- [User Configuration](#user-configuration)
- [Troubleshooting](#troubleshooting)

## Install

Release downloads: <https://github.com/pureportal/machdoch/releases/latest>

Release builds publish Windows and Linux desktop packages with stable asset names.

### Windows Setup

```powershell
Invoke-WebRequest -Uri https://github.com/pureportal/machdoch/releases/latest/download/machdoch-windows-x64-setup.exe -OutFile machdoch-setup.exe
Start-Process .\machdoch-setup.exe -Wait
```

### Windows MSI

```powershell
Invoke-WebRequest -Uri https://github.com/pureportal/machdoch/releases/latest/download/machdoch-windows-x64.msi -OutFile machdoch.msi
msiexec /i .\machdoch.msi
```

### Debian/Ubuntu

```bash
wget -O machdoch.deb https://github.com/pureportal/machdoch/releases/latest/download/machdoch-linux-amd64.deb
sudo apt install ./machdoch.deb
```

### Fedora/RHEL/openSUSE

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

## First Run

You need an API key from at least one supported model provider for normal agent tasks:

- OpenAI
- Anthropic
- Google

In the desktop app, open Settings, choose Providers, paste your key, and save it. Then choose a workspace folder, pick a provider/model, pick a mode, and send a task.

For browser automation, install Microsoft Edge or Google Chrome. `machdoch` uses installed Chromium-based browsers through `playwright-core`; it does not download bundled browser binaries.

## Desktop App

The desktop app provides:

- persisted chat sessions with rename/delete/history controls
- workspace selection
- provider, model, profile, and mode controls per session
- progress streaming and task cancellation
- context attachments for files, folders, and images
- per-session memory and optional cross-session global memory
- provider setup for OpenAI, Anthropic, and Google
- web-search setup for Perplexity, Tavily, and Serper
- speech-to-text through OpenAI/Google and spoken replies through OpenAI/Google or system voices where available
- a desktop assistant bubble, Quick Voice shortcut, tray behavior, and sign-in startup settings
- optional desktop UI control for screenshots, windows, mouse, keyboard, and Windows control handles

## CLI

The examples below assume the `machdoch` CLI is installed and available on your `PATH`.

### Chat And Tasks

| Goal | Command |
| --- | --- |
| Start interactive chat | `machdoch` |
| Start chat with an initial task | `machdoch "summarize this project"` |
| Start chat with an explicit task flag | `machdoch --task "summarize this project"` |
| Run a one-shot task | `machdoch run "summarize this project"` |
| Run a one-shot task with `--quick` | `machdoch --quick --task "summarize this project"` |
| Run with progress lines | `machdoch --verbose run "review this workspace"` |
| Show help | `machdoch --help` |

Interactive chat supports `/help` and exits with `/exit`, `/quit`, or Ctrl+C. During a one-shot task, Ctrl+C requests cancellation after the current execution step.

### Setup And Inspection

| Goal | Command |
| --- | --- |
| Save an OpenAI API key | `machdoch --set-api --provider openai --key YOUR_OPENAI_API_KEY` |
| Save an Anthropic API key | `machdoch --set-api --provider anthropic --key YOUR_ANTHROPIC_API_KEY` |
| Save a Google API key | `machdoch --set-api --provider google --key YOUR_GOOGLE_API_KEY` |
| Inspect resolved runtime config | `machdoch config` |
| Print config as JSON | `machdoch config --json` |
| Inspect workspace customizations | `machdoch inspect` |
| List available tools and policies | `machdoch tools` |
| List workspace profiles | `machdoch profiles` |

Add `--json` to `config`, `inspect`, `tools`, or `profiles` for machine-readable output.

### Runtime Overrides

| Goal | Command |
| --- | --- |
| Use a specific model | `machdoch --model gpt-5.5 run "review this repo"` |
| Persist the workspace default model | `machdoch --default-model gpt-5.5` |
| Use a specific provider | `machdoch --runtime-provider openai run "review this repo"` |
| Use a specific mode | `machdoch --mode safe run "review this repo"` |
| Use a named profile | `machdoch --profile safe-review run "review this repo"` |
| Use another workspace | `machdoch --cwd <path> config` |

Valid runtime providers are `openai`, `anthropic`, and `google`. Valid modes are `safe`, `ask`, and `auto`.

Model selection order is:

1. `--model`
2. the selected profile or workspace `.machdoch/config.json`
3. `MACHDOCH_MODEL`
4. the built-in default

`--default-model` writes the workspace default to `.machdoch/config.json`.

### Context And Memory

| Goal | Command |
| --- | --- |
| Add files or folders as context | `machdoch --context README.md --context src/core run "review this context"` |
| Attach images for a vision-capable model | `machdoch --image ./screen.png --image ./mockup.webp run "compare these"` |
| Load conversation context from JSON | `machdoch --conversation-context-file ./context.json run "continue"` |
| Enable global memory by default | `machdoch --set-global-memory on` |
| Disable global memory by default | `machdoch --set-global-memory off` |
| Disable session memory for one run | `machdoch --session-memory off run "summarize this project"` |
| Force global memory on for one run | `machdoch --global-memory on run "summarize this project"` |
| Force global memory off for one run | `machdoch --global-memory off run "summarize this project"` |

Image attachments require a model that supports image input. Supported image formats depend on the selected provider and model.

## Modes

`machdoch` uses modes to decide when local tools may run:

- `safe`: every enabled tool action requires approval.
- `ask`: low-risk enabled tools can run automatically; medium- and high-risk actions require approval.
- `auto`: enabled tools can run automatically within the workspace policy.

Tools must also be enabled by workspace configuration. If a tool is not enabled, the runtime blocks that action even in `auto` mode.

## Capabilities

When enabled for a workspace, `machdoch` can use these local capabilities:

| Capability | What it can do |
| --- | --- |
| Filesystem | List folders, read files, search a workspace, create files, and perform targeted replacements inside workspace boundaries. |
| Shell | Run shell commands and start detached commands under policy control. |
| Network | Fetch URLs and use web search when Perplexity, Tavily, or Serper is configured. |
| Browser | Start installed Chrome/Edge/Chromium sessions, navigate, read page text, capture screenshots, click selectors, type text, list sessions, and close sessions. |
| Git | Inspect status, summarize diffs, read recent logs, and create local commits. It does not push to remotes. |
| Packages | Inspect Node package manifests/workspaces, run declared scripts, check outdated dependencies for npm/pnpm, run audits for npm/pnpm/yarn/bun, and install registry package specs with supported package-manager options. |
| Utilities | Generate UUIDs, ULIDs, random values, timestamps, hashes, encodings, JSON validation results, formatted identifiers, URL components, version comparisons, regex matches, compact diffs, and sorted unique line lists without shell access. |
| Memory | Store short session facts and optional cross-session global facts. |
| Desktop UI | In the desktop app, list monitors/windows, capture screens/windows, click, drag, type, press keys, wait for windows, and use richer Windows control-handle actions. |

## Workspace Customization

Workspace customization lives under `.machdoch/`:

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

`config.json` can set the default profile, mode, provider, model, enabled tools, offline behavior, and compatibility discovery:

```json
{
  "defaultProfile": "workspace",
  "defaultMode": "ask",
  "enabledTools": [
    "filesystem",
    "shell",
    "network",
    "browser",
    "git",
    "packages",
    "utilities"
  ],
  "provider": "openai",
  "model": "gpt-5.5",
  "offline": false,
  "profiles": {
    "workspace": {
      "description": "Default interactive workspace profile.",
      "mode": "ask"
    },
    "safe-review": {
      "description": "Read-focused review mode with approval gates and limited tools.",
      "mode": "safe",
      "enabledTools": ["filesystem", "git", "utilities"]
    }
  },
  "compatibility": {
    "discoverGithubCustomizations": false
  }
}
```

Native customization files:

- `.machdoch/instructions.md`
- `.machdoch/instructions/**/*.instructions.md`
- `.machdoch/prompts/**/*.prompt.md`
- `.machdoch/skills/**/SKILL.md`

When `compatibility.discoverGithubCustomizations` is enabled, `machdoch` can also discover:

- `.github/copilot-instructions.md`
- `.github/instructions/**/*.instructions.md`
- `.github/prompts/**/*.prompt.md`
- `.github/skills/**/SKILL.md`
- `AGENTS.md`

## User Configuration

Provider keys, web-search keys, voice settings, desktop settings, and global memory are stored in a user-scoped config file, not in the workspace.

Default locations:

- Windows: `%APPDATA%/machdoch/user-config.json`
- macOS: `~/Library/Application Support/machdoch/user-config.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/machdoch/user-config.json`

Environment variables can also configure the runtime:

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI model provider key |
| `ANTHROPIC_API_KEY` | Anthropic model provider key |
| `GOOGLE_API_KEY` | Google model provider key |
| `PERPLEXITY_API_KEY` | Perplexity web-search key |
| `TAVILY_API_KEY` | Tavily web-search key |
| `SERPER_API_KEY` | Serper web-search key |
| `MACHDOCH_MODEL` | Default model override |
| `MACHDOCH_MODE` | Default mode override |
| `MACHDOCH_PROFILE` | Default profile override |
| `MACHDOCH_OFFLINE` | Set to `true` to force offline behavior |
| `MACHDOCH_WEB_SEARCH_PROVIDER` | Active web-search provider override |
| `MACHDOCH_USER_CONFIG_DIR` | Override the user config directory |

When running through `sudo`, `machdoch` may read root's user config instead of your normal user config. Run `machdoch config` without `sudo`, or pass the relevant environment variables deliberately.

## Troubleshooting

If provider setup looks correct but tasks still run as unconfigured, run:

```bash
machdoch config
```

If a tool is blocked, run:

```bash
machdoch tools
```

If a profile does not load, run:

```bash
machdoch profiles
```

If browser automation fails, install Microsoft Edge or Google Chrome and try again. The browser backend uses installed Chromium-based browser channels and does not download browser binaries.

If image attachments are rejected, select a vision-capable model or remove the image attachments.
