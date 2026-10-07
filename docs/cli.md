# Terminal

Start an interactive session with `machdoch --cli`, or run a single task with `machdoch run "your task"`. Use `--cwd <folder>` to choose the workspace.

Run `machdoch update` to install the latest release, or `machdoch update --check` to check first. See [Updating Machdoch](updates.md).

## Input

| Key                    | Action                                                   |
| ---------------------- | -------------------------------------------------------- |
| Enter                  | Send                                                     |
| Ctrl+J, Alt+Enter      | Insert a newline                                         |
| Shift+Enter            | Insert a newline when the terminal reports extended keys |
| Backslash, then Enter  | Continue on a new line                                   |
| Up / Down              | Move between visible rows, then browse prompt history    |
| Ctrl+R                 | Search history; Enter accepts, Esc restores the draft    |
| Tab                    | Complete slash commands and their arguments              |
| Ctrl+G                 | Edit the draft with `VISUAL` or `EDITOR`                 |
| Ctrl+A / Ctrl+E        | Start / end of the line                                  |
| Ctrl+Left / Ctrl+Right | Move by word                                             |
| Ctrl+U / Ctrl+K        | Delete to the start / end of the line                    |
| Ctrl+W / Ctrl+Y        | Delete a word / paste deleted text                       |
| Ctrl+_                 | Undo an edit                                             |
| Ctrl+L                 | Clear the terminal and redraw                            |
| Ctrl+C                 | Cancel the task or discard the draft                     |
| Esc                    | Cancel the running task                                  |
| Ctrl+D                 | Exit when the prompt is empty                            |

Bracketed paste keeps a whole block editable, including newlines and tabs. In a terminal without bracketed paste, use `/paste` and finish with `/end`. Prompt history persists across sessions. `/shortcuts` lists the controls in the terminal.

## Conversation

Use `/commands` to search the command menu, `/model` to switch models, `/sessions` to resume a saved conversation, and `/retry` to repeat the last task. `/diff` shows unstaged Git changes; `/diff staged` shows staged changes. `/verbose on` shows full tool output. `/export <file>` saves conversation context.

Activity stays above the prompt, with live elapsed time, tool output, completion or failure, and formatted answers. `NO_COLOR` disables colors. Piped and JSON output remain suitable for scripts.

## Settings

`machdoch config edit` opens searchable menus for Workspace settings, Global settings, and Defaults. Type a label or setting key to filter a menu; use arrows and Enter to select, or Esc to go back. Values can be reset individually. API keys use masked inputs.

Workspace settings include provider, model, mode, reasoning, context window, memory, adaptive behavior, agent limits, and MCP connections. Global settings include credentials, provider integration, agent settings, memory, voice, desktop behavior, appearance, asset storage, and workspace-run timing. Defaults include session policy and new-chat choices.

Desktop-stored defaults, appearance, asset operations, startup registration, and settings transfer require the desktop app to be running. Other settings can be edited with the desktop closed.

Transfer settings supports encrypted files and transfers between computers. Imports show the categories that will be replaced or cleared before applying them. Network transfers require confirmation of the matching pairing code on both computers.

For scripts:

```sh
machdoch config list --json
machdoch config get workspace.model
machdoch config set agent.adaptive on
machdoch config set desktop.ai-context-max-messages 80
machdoch config set desktop.chat-idle-timeout-minutes 30
machdoch config unset workspace.reasoning
```

The context cap and inactivity timeout apply to CLI tasks as well as desktop tasks.

## Interaction references

The keyboard and discovery patterns draw on [Claude Code](https://code.claude.com/docs/en/interactive-mode), [Codex](https://learn.chatgpt.com/docs/codex/cli), [Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference), and [AWS CLI auto-prompt](https://docs.aws.amazon.com/cli/latest/userguide/cli-usage-parameters-prompting.html). Maintainer issue trackers also identify [premature submission during multiline paste](https://github.com/openai/codex/issues/10146) and [difficulty inspecting collapsed pasted text](https://github.com/anthropics/claude-code/issues/48829).
