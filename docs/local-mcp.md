# Local MCP

Machdoch exposes its agent tools over MCP. Delegated Codex, Claude, and Copilot CLI runs receive a `machdoch` server automatically. Calls execute in the parent Machdoch run, with its workspace, mode, memory settings, additional tools, desktop context, and cancellation signal. Memory updates are included in the task result.

For an independently configured MCP client, launch a workspace server over stdio:

```sh
machdoch mcp serve --cwd /path/to/workspace --mode ask
```

Use `--mode machdoch` to include mutations. The source equivalent is:

```sh
pnpm dev mcp serve --cwd /path/to/workspace --mode ask
```

| Area               | Operations                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflows          | List, read, validate, save, delete, run, list runs, read a run                                                                                  |
| Scheduler          | List jobs, runs, and events; create, update, pause, resume, and delete jobs; emit events; trigger jobs; cancel runs                             |
| Memory             | Search/list enabled scopes; remember session, workspace, and global facts                                                                       |
| Workspace Run      | Status, start, stop, restart when desktop control credentials are present                                                                       |
| Workspace presence | Query active agents; report unknown when the presence registry is unavailable                                                                   |
| Other agent tools  | Files, Git, packages, shell, network, browser, utilities, macros, configured MCP tools/resources/prompts, and desktop interaction where enabled |

The API and MCP paths share tool definitions, argument validation, and execution decisions. Ask mode excludes mutations and also blocks them at invocation. Workflow tools operate on the active workspace, checking block workspaces, attachments, and utility paths at execution time. Scheduler inputs cannot grant paths outside it. Saving workflows supports revision fingerprints; deletion requires one.

Tool input schemas support JSON Schema Draft-07, 2019-09, and 2020-12, selected by `$schema`. Schemas without `$schema` use 2020-12; unsupported dialects are rejected before dispatch.

`trigger_scheduled_job` queues a run. A scheduler service must be running to execute it. `cancel_scheduled_run` cancels queued runs immediately and requests cancellation of running jobs. Workflow calls run until completion, failure, or cancellation and persist their execution records.

Standalone servers load workspace and user memory settings. They have no chat session to update. Desktop interaction and Workspace Run controls require the corresponding desktop context or credentials; starting `mcp serve` alone does not create those services.

Delegated runs use an authenticated loopback MCP endpoint with session support and a stdio connection process. Credentials live in the temporary enrollment configuration, and the endpoint closes with the parent invocation. The internal `mcp connect` command requires that endpoint; it cannot select another workspace or elevate the parent mode. Existing `mcp proxy` and `mcp broker` commands continue to expose configured external servers.

The Tauri debug MCP bridge is a development facility, separate from this integration. The workspace-run bridge is initialized in release builds too. Local MCP does not depend on the debug bridge.

The tool catalog does not expose the complete desktop administration surface: global workflow-library management, workflow resume/interview controls, Fleet administration, provider credentials, and media-studio management remain outside this interface.
