# Workspace storage

Shared files stay in `.machdoch/`: `config.json`, launch settings in `run.json`, scheduler definitions, MCP configuration, prompts, skills, macros, and RALPH flow definitions.

Local data lives in the ignored `.machdoch/local/` subtree:

| Directory | Data |
| --- | --- |
| `state/` | Memory, reasoning lessons, scheduler execution state, RALPH runs, checkpoints, revisions, counters, and work journals |
| `cache/` | RALPH summaries, MCP discovery, browser profiles, and fleet payloads |
| `artifacts/` | Screenshots, diagnostics, generated flow logs, and other outputs |

CLI and desktop workspace loading use the same migration. It runs before workspace data is read, moves directories without copying their contents, updates managed path references and checkpoint checksums, and writes a local completion marker. Subsequent loads skip the migration; calls in the same process share its result.

The migration preserves unknown files. Conflicting files and linked storage paths stop migration without overwriting data. Active RALPH runs must finish before their storage can move. An interrupted migration resumes on the next load. Scheduler definition changes have a local transaction record so interruption between the shared and local writes can be recovered.

RALPH Git snapshots include shared project files and exclude `.machdoch/local/`, including local files that were previously tracked. Migration updates whole-folder Machdoch ignore rules and adds `.machdoch/.gitignore` for local data.
