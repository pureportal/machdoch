# Workspace storage

Shared files stay in `.machdoch/`: `config.json`, launch settings in `run.json`, scheduler definitions, MCP configuration, prompts, skills, macros, and RALPH flow definitions.

Desktop and headless run loading migrate version 1 `run.json` files to version 2. Migration preserves the selected primary configuration and run settings, converts snake_case fields to camelCase, and atomically saves the validated result. Per-run health timing fields are removed; global Workspace Run settings apply. Invalid documents and unsupported schema versions remain untouched. Prechecking older JSON converts it without writing a file.

Local data lives in the ignored `.machdoch/local/` subtree:

| Directory    | Data                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `state/`     | Memory, reasoning lessons, scheduler execution state, RALPH runs, checkpoints, revisions, counters, and work journals |
| `cache/`     | RALPH summaries, MCP discovery, browser profiles, and fleet payloads                                                  |
| `artifacts/` | Screenshots, diagnostics, generated flow logs, and other outputs                                                      |

CLI and desktop workspace loading use the same migration. It runs before workspace data is read, moves directories without copying their contents, preserves isolated worktree identities, updates managed path references, flow fingerprints, and checkpoint checksums, and writes a local completion marker. Subsequent loads skip the migration; calls in the same process share its result. Duplicate files are compared with streaming hashes so large logs do not need to fit in memory.

The migration preserves unknown files. Conflicting files and linked storage paths stop migration without overwriting data. Active RALPH runs must finish before their storage can move. An interrupted migration resumes on the next load. Scheduler definition changes have a local transaction record so interruption between the shared and local writes can be recovered.

RALPH Git snapshots include shared project files and exclude `.machdoch/local/`, including local files that were previously tracked. Migration updates whole-folder Machdoch ignore rules when automatic ignore management is enabled.

Workspace loading adds missing rules to `.machdoch/.gitignore` for `/local/`, `*.machdoch.lock*/`, `*.json.lock/`, and `*.tmp`. Existing rules and line endings are preserved. This is enabled by default; set `autoGitignore` to `false` in `.machdoch/config.json`, use the workspace's **Automatic .gitignore rules** setting, or run `machdoch config set workspace.auto-gitignore off`. Re-enable it with `machdoch config set workspace.auto-gitignore on`; `machdoch config unset workspace.auto-gitignore` restores the default. Disabling automatic updates leaves existing rules in place. Commit `.machdoch/.gitignore` with shared configuration. Ignore rules do not remove files already tracked by Git.
