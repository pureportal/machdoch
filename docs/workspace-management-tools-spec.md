# Workspace files and terminal

## Goal

Make the existing Workspaces surface the place to inspect and work in a registered folder without weakening Machdoch's local-first desktop boundary. The workspace list, metadata, Git, and instruction assignment behavior remain intact; the selected workspace gains a primary Files surface containing a lazy file tree, editor/preview, and collapsible terminal.

## Decisions

- Keep privileged work in Tauri's Rust process. This repository has no Node desktop host, so `node:fs`, `node-pty`, and Electron-oriented file bridges would add a second runtime boundary. `portable-pty` provides the equivalent cross-platform PTY primitive directly in the existing backend, including cloned readers and resize support.
- Use CodeMirror 6 for editable UTF-8 text. It provides a keyboard-first editor, syntax packages, search/history, and viewport rendering for large documents. Monaco was rejected because its worker and bundle model is disproportionate for this surface; a highlighted `textarea` was rejected because it would reproduce editor behavior poorly.
- Use xterm.js with its first-party fit addon for terminal rendering and measurement. Terminal bytes are passed through without putting output into HTML, links are not auto-opened, and terminal instances/addons are disposed with the React component.
- Stream PTY output over a per-session Tauri IPC channel. Commands remain request/response operations for discovery, input, resize, and stop. A channel avoids global event cross-talk and follows Tauri's recommended streaming path.
- Discover host tools rather than presenting assumed choices. Windows prefers PowerShell 7, Windows PowerShell, Command Prompt, Git Bash, WSL, and other shells only when their executable resolves. macOS/Linux use the configured shell and available common shells. Windows Terminal is treated as an external terminal host, not a shell to nest in a PTY; when `wt.exe` exists, the UI can open the workspace there.
- Treat every Git working tree below a workspace as an independent repository. This follows VS Code's Repositories view, Cursor's repository picker, and JetBrains' VCS-root model: discover roots, show all of them in one workspace, select one, and scope every status, diff, branch, remote, fetch, pull, and pull-request operation to that selected root.

Primary references: [Tauri commands and channels](https://tauri.app/develop/calling-rust/), [portable-pty](https://docs.rs/portable-pty/latest/portable_pty/), [xterm.js addons](https://xtermjs.org/docs/guides/using-addons/), [xterm.js security](https://xtermjs.org/docs/guides/security/), [CodeMirror reference](https://codemirror.net/docs/ref/), [node-pty](https://github.com/microsoft/node-pty), [VS Code repositories and remotes](https://code.visualstudio.com/docs/sourcecontrol/repos-remotes), [VS Code Git discovery](https://github.com/microsoft/vscode/blob/main/extensions/git/src/model.ts), [Cursor multi-root workspaces](https://cursor.com/changelog/04-24-26), [JetBrains workspaces](https://www.jetbrains.com/help/idea/workspaces.html), and [Git repository layout](https://git-scm.com/docs/gitrepository-layout).

## UX

- The existing workspace selector remains on the left. Selecting a workspace opens its Files surface first.
- The file tree loads one expanded directory at a time, sorts folders before files, exposes hidden entries, paginates unusually large directories, and supports keyboard tree navigation.
- Tree actions cover refresh, new file, new folder, rename, delete, and opening in the system shell. Creation and rename use a small inline form; recursive deletion is confirmed at the moment of action.
- Selecting text/code opens CodeMirror with syntax detection. `Ctrl/Cmd+S` saves. Markdown can switch between Edit and Preview. Images, PDF, audio, and video use bounded local asset URLs. Binary, unsupported, missing, and oversized files receive a focused unavailable state and can still be opened externally.
- A dirty marker appears beside the filename. Switching files/workspaces or closing with unsaved changes asks before discarding. Revision conflicts keep the draft and offer Reload or Overwrite.
- The terminal occupies the lower pane, can be collapsed, and has an accessible resizer. Its toolbar contains only shell selection, new/restart, stop, clear, and external-terminal actions that are currently available.
- Below Files, workspace metadata and instruction controls remain available in their established layout. When multiple Git roots are found, the Git header exposes a repository picker. Git status rows open staged, working-tree, untracked, renamed, deleted, binary, and conflicted diffs for that repository; pull requests load only when their tab is opened.

## Backend and data flow

1. `list_workspace_directory(root, path, offset)` returns a sorted bounded page of entry metadata. Directories are lazy; symlinks are identified and never recursively followed by the tree.
2. `read_workspace_file(root, path)` classifies the file and returns UTF-8 content plus a SHA-256 revision for editable text, or preview metadata for supported media.
3. `save_workspace_file(request)` compares the expected revision immediately before an atomic sibling-file replacement. A mismatch returns a conflict result instead of overwriting. A separate explicit force flag supports the conflict recovery action.
4. Create, rename, and delete commands validate a single entry name, resolve the containing directory, and never accept an arbitrary absolute destination.
5. `discover_workspace_shells()` resolves a fixed catalog against the actual OS environment. `start_workspace_terminal(request, channel)` maps a discovered ID to its fixed executable/arguments, sets only the canonical workspace as the working directory, opens a PTY, and returns a unique opaque session ID.
6. Input, resize, and stop commands address that opaque session ID. A bounded registry owns the PTY master, writer, and child killer. Reader/wait workers stream ordered output/exit events and remove completed sessions.
7. `discover_workspace_git_repositories(root)` scans below the canonical workspace without following symlinked directories or dependency/cache trees, detects `.git` directories, gitfiles used by submodules and worktrees, and `.git` symlink markers, validates candidates with `git rev-parse --show-toplevel`, and returns stable workspace-relative labels.
8. Every Git read or action carries both the workspace root and selected repository root. The backend canonicalizes both, requires the repository to be contained by the workspace, and rejects a subdirectory or outside repository before invoking Git.
9. Git status uses NUL-delimited porcelain records so whitespace and rename paths remain exact. Diff output is drained without retaining more than 128 KiB per patch, and GitHub CLI access is isolated to the pull-request tab so local status never waits on the network.

File saves, filesystem mutations, manual refreshes, and detected external changes refresh both the tree and Git state. Pulls and branch switches refresh the tree and recheck the open document; clean editors reload, while dirty editors keep their draft and enter the existing revision-conflict flow.

## Security and limits

- Canonical workspace roots must exist and be directories. Absolute relative paths, parent traversal, NUL/control characters, and paths resolving outside the root are rejected.
- Symlink targets outside the workspace cannot be listed as directories, read, edited, or used as terminal working directories. Deleting a symlink removes the link, never its target.
- Text reads and writes are UTF-8 and size-limited; media previews are allow-listed by extension; directory pages and active PTYs are bounded; terminal input and geometry are bounded.
- The shell API does not accept a program, command line, environment replacement, or startup arguments from the webview. PTYs inherit the app's current user privilege and do not elevate.
- Terminal output is untrusted data handled by xterm.js. No custom HTML rendering or automatic terminal links are enabled. Output workers use bounded backpressure, and stale terminal starts are stopped when a workspace changes or a newer lifecycle transition wins.
- Atomic writes preserve existing Unix permissions. Missing files, permission failures, stale revisions, and process failures return concise recoverable errors without leaking unrelated filesystem contents.
- Repository discovery is capped at 50,000 directories and 256 repositories, skips common generated dependency/cache directories, and isolates candidate/read failures. The UI reports a limited scan or unreadable folder so missing roots are not silent.

## Error states

- Empty directory, loading, unreadable directory, and page-limit states live in the tree.
- No selection, loading, unsupported/binary, oversized, missing, preview failure, save failure, and external-change conflict live in the content pane. Markdown local links stay contained in the workspace and local images use the same preview boundary.
- No discovered shells, startup failure, disconnected/exited process, and write/resize failure live in the terminal pane. A stopped or exited session can be restarted without leaving the workspace.
- Non-repository, unavailable-Git, clean, truncated-status, binary-diff, conflicted-diff, diff failure, unavailable-GitHub-CLI, and empty-pull-request states live in the Git surface.

## Implementation phases

1. Add and test contained filesystem primitives, revision-aware atomic saves, operations, shell discovery, and PTY lifecycle management.
2. Add typed frontend runtime adapters and deterministic browser-preview fixtures.
3. Build the accessible tree, CodeMirror/media preview, xterm.js pane, responsive split layout, and dirty/conflict guards.
4. Run Rust/TypeScript tests, lint, type checks, production builds, focused boundary and PTY checks, then inspect and refine the live preview at desktop and minimum supported sizes.
