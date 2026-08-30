import { CliUsageError } from "./cli-error.js";

const ROOT_HELP = `machdoch - local-first AI agent for terminal and desktop

Usage:
  machdoch                         Start interactive chat
  machdoch <task>                  Start chat with an initial task
  machdoch run <task>              Run one task and exit
  machdoch <command> [options]

Core commands:
  run            Run one task and exit
  chat           Start an interactive terminal session
  interview      Refine a task through structured questions
  config         Inspect or change user and workspace settings
  memory         List durable workspace and global memory facts
  inspect        List discovered prompts and skills
  tools          List available tool areas and model-facing functions

Automation and integration:
  ralph          Create, validate, run, and inspect RALPH flows
  scheduler      Manage scheduled and event-triggered work
  instructions   Manage central instruction files and assignments
  mcp            Inspect and use MCP servers, tools, resources, and prompts
  provider-sync  Manage delegated CLI-provider integration
  fleet          Connect this CLI host to Fleet Manager

Examples:
  machdoch run "summarize the changes in this repository"
  machdoch --mode ask --context README.md "explain the setup"
  machdoch config list
  machdoch config edit
  machdoch ralph list
  machdoch scheduler list --json

Global options:
  --cwd <path>            Use a different workspace root
  --json                  Print machine-readable JSON where supported
  --verbose, -v           Print task progress
  -h, --help              Show help for the current command

Run 'machdoch help <command>' or 'machdoch <command> --help' for details.`;

const RUN_HELP = `machdoch run - execute one task and exit

Usage:
  machdoch run <task> [options]
  machdoch --quick --task <task> [options]

Task options:
  --task -                      Read the complete UTF-8 task from stdin
  --mode <ask|machdoch>          Override the execution mode
  --runtime-provider <provider> Override the model provider
  --model <name>                Override the model
  --reasoning <mode>            default, none, minimal, low, medium, high,
                                xhigh, max, or ultra
  --context <path>              Attach a file or folder; repeatable
  --image <path>                Attach an image; repeatable
  --conversation-context-file <path>
                                Load conversation history and memory JSON
  --deterministic-action-json <json>
                                Execute one validated local action
  --session-memory <on|off>     Override session memory
  --global-memory <inherit|on|off>
                                Override global memory
  --executor-turns <count>      Override executor model/tool turns
  --autopilot-iterations <n>    Override Machdoch continuation cycles
  --infinite                    Disable both loop limits
  --json                        Print a machine-readable result
  --verbose, -v                 Print progress; structured with --json

Use -- before task text that begins with a dash.`;

const CHAT_HELP = `machdoch chat - interactive terminal conversation

Usage:
  machdoch
  machdoch <initial task>
  machdoch --task <initial task>

Chat accepts the same model, mode, context, image, and memory overrides as
machdoch run. It requires an interactive terminal and does not support --json.

Interactive commands:
  /help                 Show chat commands
  /paste [ask|machdoch] Paste multiline task text; finish with /end
  /exit, /quit          Leave interactive chat`;

const CONFIG_HELP = `machdoch config - inspect and change configuration

Usage:
  machdoch config [show] [--json]
  machdoch config list [--json]
  machdoch config get <setting> [--json]
  machdoch config set <setting> <value> [--json]
  machdoch config unset <setting> [--json]
  machdoch config edit

Commands:
  show  Print the resolved runtime configuration (default)
  list  List every CLI-configurable setting, current value, and source
  get   Show one setting with its scope, source, and accepted values
  set   Persist one user- or workspace-scoped setting
  unset Remove a saved value so its default or environment value applies
  edit  Open the arrow-key interactive configuration editor

Setting groups:
  workspace.<mode|provider|model|reasoning|offline|github-customizations>
  api.<openai|anthropic|google|langdock|quiver|recraft>.key
  agent-cli.<codex-cli|claude-cli|copilot-cli>.path
  web-search.provider
  web-search.<perplexity|tavily|serper>.key
  agent-limits.<infinite|executor-turns|autopilot-iterations>
  review-model
  memory.global
  fleet.enabled
  voice.provider
  speech-to-text.<provider|input-device>
  desktop.<setting>

Examples:
  machdoch config get workspace.model
  machdoch config set workspace.mode ask
  machdoch config set workspace.github-customizations on
  machdoch config set review-model openai:gpt-5.5-mini
  machdoch config set api.openai.key <key>

Boolean settings accept on/off, true/false, yes/no, or 1/0. API keys are never
printed by config show, list, get, or set. The interactive editor masks secret
input; direct key arguments may remain in shell history. Interactive editing
requires a TTY; use config set in scripts and CI.`;

const INTERVIEW_HELP = `machdoch interview - refine a task through questions

Usage:
  machdoch interview (--prompt <text>|--prompt-file <path>) [options]

Options:
  --input-json <json>       Submit non-interactive answers
  --input-json-file <path>  Read answers from a JSON file
  --max-rounds <n>          Limit interview rounds
  --json                    Print machine-readable output`;

const MEMORY_HELP = `machdoch memory - inspect durable memory

Usage:
  machdoch memory [list] [--json]

Lists saved facts for the active workspace and global scope.
Use \`machdoch config set memory.global on|off\` to change whether global memory
is enabled for new sessions.`;

const INSPECT_HELP = `machdoch inspect - list discovered customizations

Usage:
  machdoch inspect [--json]

Lists user and workspace prompts and skills. Enable compatible .github prompt
and skill discovery with:

  machdoch config set workspace.github-customizations on`;

const TOOLS_HELP = `machdoch tools - inspect the task tool surface

Usage:
  machdoch tools [--mode <ask|machdoch>] [--json]

Ask mode exposes only read-only calls. Machdoch mode exposes the full tool
surface allowed by the runtime and current environment.`;

const INSTRUCTIONS_HELP = `machdoch instructions - manage central instruction files

Usage:
  machdoch instructions validate [--json]
  machdoch instructions resolve [--surface <api|cli>] [--path <path>] [--json]
  machdoch instructions profiles list [--include-content]
  machdoch instructions profiles show|edit|duplicate|delete <profile>
  machdoch instructions profiles create [name] (--prompt <text>|--prompt-file <path>)
  machdoch instructions assignments list
  machdoch instructions assignments set <workspace> --path <scope> --profile <uuid> [...]
  machdoch instructions assignments relink <workspace> <scope> --path <new-scope>
  machdoch instructions assignments remove <workspace> --path <scope>
  machdoch instructions workspaces list
  machdoch instructions workspaces configure [root] [--name <name>] [--metadata-json <json>]
  machdoch instructions workspaces relink <workspace> --path <absolute-root>
  machdoch instructions workspaces remove <workspace> [--confirm-assignment-removal]
  machdoch instructions transfer export [--include-workspaces]
  machdoch instructions transfer import --prompt-file <export.json> [...]
  machdoch instructions recovery status|restore|export|reset [...]

Common options:
  --name <name>                File or workspace name
  --description <text>        Optional file description; pass empty to clear
  --metadata-json <json>       File settings or workspace tags and assignments
  --profile <uuid>             Ordered profile reference; repeatable
  --path <path>                Command-specific workspace or scope path
  --prompt <text>              Instruction Markdown
  --prompt-file <path>         Read Markdown or transfer JSON from a file
  --expected-revision <n>      Reject a stale registry mutation
  --expected-digest <sha256>   Confirm a reviewed recovery file
  --include-content            Include stored instruction bodies
  --include-workspaces         Include workspace mappings in transfers
  --confirm-assignment-removal Confirm removal of assigned workspace mappings
  --json                       Print machine-readable output`;

const RALPH_HELP = `machdoch ralph - create and run durable flows

Usage:
  machdoch ralph list [--scope <user|workspace>] [--json]
  machdoch ralph show|validate <flow> [--scope <scope>] [--json]
  machdoch ralph validate-json (--flow-json <json>|--flow-json-file <path|->)
  machdoch ralph create [flow] (--prompt <text>|--prompt-file <path>) [...]
  machdoch ralph interview [flow] --prompt <text> [...]
  machdoch ralph save|delete|revisions|restore <flow> [...]
  machdoch ralph run <flow> [--param <name=value>...] [--json]
  machdoch ralph resume <run-id> (--input-json <json>|--retry-current) [...]
  machdoch ralph runs [flow] [--json]
  machdoch ralph run-detail|log <run-id> [--trace] [--json]
  machdoch ralph watches list|sync|run [--json]
  machdoch ralph watches create (--watch-json <json>|--watch-json-file <path>)
  machdoch ralph watches delete <watch-id>

Use --scope user or --scope workspace to select flow storage. Use
--max-transitions to bound a run and --json for automation.`;

const MCP_HELP = `machdoch mcp - inspect and use MCP integrations

Usage:
  machdoch mcp servers [--include-disabled] [--json]
  machdoch mcp cache [--json]
  machdoch mcp discover|refresh <server-id> [--json]
  machdoch mcp oauth-authorize|oauth-start <server-id> [--json]
  machdoch mcp oauth-finish <server-id> <callback-url-or-code> [--json]
  machdoch mcp call-tool <server-id> <tool> [--arguments-json <json>]
  machdoch mcp read-resource <server-id> <uri> [--json]
  machdoch mcp get-prompt <server-id> <name> [--arguments-json <json>]
  machdoch mcp usage [--json]
  machdoch mcp cleanup [--unused-days <n>] [--apply] [--json]
  machdoch mcp proxy <server-id> [--cwd <path>]
  machdoch mcp broker [--cwd <path>]`;

const PROVIDER_SYNC_HELP = `machdoch provider-sync - delegated CLI-provider integration

Usage:
  machdoch provider-sync plan [--provider <provider>] [--json]
  machdoch provider-sync enable|status|disable|refresh|doctor [--json]
  machdoch provider-sync daemon

Providers: codex-cli, claude-cli, copilot-cli. The daemon is an internal
long-running process normally managed by provider-sync enable.`;

const FLEET_HELP = `machdoch fleet - connect this CLI host to Fleet Manager

Usage:
  machdoch fleet status [--json]
  machdoch fleet enroll --manager-url <origin> --enrollment-key <key> \\
    --display-name <name> [--json]
  machdoch fleet enable|disable [--json]
  machdoch fleet reset [--json]
  machdoch fleet service [--cwd <workspace>] [--json]

The service stays in the foreground for an operating-system service manager.
Run one Fleet host gateway for an enrollment at a time.`;

const SCHEDULER_HELP = `machdoch scheduler - scheduled and event-triggered tasks

Usage:
  machdoch scheduler list [--json]
  machdoch scheduler create <schedule> --prompt <text> [options]
  machdoch scheduler create <schedule> --scheduler-target ralph-flow \\
    --scheduled-ralph-flow <id> [options]
  machdoch scheduler pause|resume|delete|trigger <job-id> [--json]
  machdoch scheduler runs [job-id] [--json]
  machdoch scheduler events [--json]
  machdoch scheduler event --event-type <type> [options]
  machdoch scheduler run-due|run-all-due|poll-all [--json]
  machdoch scheduler retry|cancel <run-id> [--json]
  machdoch scheduler service|service-all [options]

Schedule one of:
  --cron <expr>             Cron expression
  --interval-ms <ms>       Fixed interval
  --delay-ms <ms>          One-shot delay
  --run-at <epoch-ms>      One-shot absolute time
  --trigger <kind:event>   Event trigger; repeatable

Use --timezone for cron schedules, --prompt-file for file input, and --json for
automation. Run 'machdoch scheduler create --help' to return to this reference.`;

const HELP_BY_TOPIC: Readonly<Record<string, string>> = {
  run: RUN_HELP,
  chat: CHAT_HELP,
  config: CONFIG_HELP,
  memory: MEMORY_HELP,
  interview: INTERVIEW_HELP,
  inspect: INSPECT_HELP,
  tools: TOOLS_HELP,
  instructions: INSTRUCTIONS_HELP,
  ralph: RALPH_HELP,
  mcp: MCP_HELP,
  "provider-sync": PROVIDER_SYNC_HELP,
  fleet: FLEET_HELP,
  scheduler: SCHEDULER_HELP,
};

const HELP_TOPIC_ALIASES: Readonly<Record<string, string>> = {
  configuration: "config",
  task: "run",
};

export const getHelpText = (topic?: string): string => {
  const normalizedTopic = topic?.trim().toLowerCase();
  if (!normalizedTopic) return ROOT_HELP;

  const resolvedTopic = HELP_TOPIC_ALIASES[normalizedTopic] ?? normalizedTopic;
  const help = HELP_BY_TOPIC[resolvedTopic];
  if (help) return help;

  throw new CliUsageError(
    `Unknown help topic \`${topic}\`. Available topics: ${Object.keys(HELP_BY_TOPIC).join(", ")}.`,
  );
};

export const CLI_HELP_TEXT = (): string => getHelpText();
