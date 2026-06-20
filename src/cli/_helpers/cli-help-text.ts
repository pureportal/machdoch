export const CLI_HELP_TEXT = (): string => {
  return `machdoch

Usage:
  machdoch [--mode <ask|machdoch>]
  machdoch <task>
  machdoch --task <task> [--mode <ask|machdoch>]
  machdoch run <task>
  machdoch --quick --task <task> [--mode <ask|machdoch>]
  machdoch --set-api --provider <openai|anthropic|google> --key <value>
  machdoch --set-global-memory <on|off>
  machdoch --runtime-provider <openai|anthropic|google|codex-cli|claude-cli|copilot-cli>
  machdoch --model <name>
  machdoch --reasoning <default|none|minimal|low|medium|high|xhigh|max>
  machdoch --default-model <name>
  machdoch inspect [--json]
  machdoch config [--json]
  machdoch config set <setting> <value> [--json]
  machdoch tools [--json]
  machdoch profiles [--json]
  machdoch instructions list|validate [--scope <user|workspace|compatibility>] [--json]
  machdoch instructions show <name-or-path> [--scope <user|workspace|compatibility>] [--json]
  machdoch instructions create [name] --prompt <text> [--scope <user|workspace>] [--apply-to <glob>] [--json]
  machdoch instructions save [name] --prompt <text> [--path <file>] [--scope <user|workspace>] [--apply-to <glob>] [--json]
  machdoch instructions generate [name] --prompt <wish> [--path <file>] [--scope <user|workspace>] [--apply-to <glob>] [--max-rounds <n>] [--json]
  machdoch ralph list [--scope <user|workspace>] [--json]
  machdoch ralph show|validate|delete <flow> [--scope <user|workspace>] [--json]
  machdoch ralph revisions <flow> [--scope <user|workspace>] [--json]
  machdoch ralph restore <flow> --revision <revision-id> [--scope <user|workspace>] [--json]
  machdoch ralph save <flow> --flow-json <json> [--scope <user|workspace>] [--json]
  machdoch ralph run <flow> [--scope <user|workspace>] [--param <name=value>] [--json]
  machdoch ralph resume <run-id> (--input-json <json>|--input-json-file <path>) [--scope <user|workspace>] [--json]
  machdoch ralph runs [flow] [--scope <user|workspace>] [--json]
  machdoch ralph run-detail <run-id> [--scope <user|workspace>] [--json]
  machdoch ralph log <run-id> [--scope <user|workspace>] [--trace] [--json]
  machdoch ralph create [flow] --prompt <text> [--scope <user|workspace>] [--name <flow>] [--flow-target <flow|prompt-block|refactor>] [--generation-mode <do-it|interview>] [--max-rounds <n>] [--json]
  machdoch ralph interview [flow] --prompt <text> [--scope <user|workspace>] [--name <flow>] [--flow-target <flow|prompt-block|refactor>] [--existing-flow-json <json>] [--input-json <json>] [--max-rounds <n>] [--json]
  machdoch ralph watches list|sync|run [--json]
  machdoch ralph watches create (--watch-json <json>|--watch-json-file <path>) [--json]
  machdoch ralph watches delete <watch-id> [--json]
  machdoch mcp servers [--include-disabled] [--json]
  machdoch mcp cache [--json]
  machdoch mcp discover|refresh <server-id> [--json]
  machdoch mcp oauth-start <server-id> [--json]
  machdoch mcp oauth-finish <server-id> <callback-url-or-code> [--json]
  machdoch mcp call-tool <server-id> <tool-name> [--arguments-json <json>] [--json]
  machdoch mcp read-resource <server-id> <uri> [--json]
  machdoch mcp get-prompt <server-id> <prompt-name> [--arguments-json <json>] [--json]
  machdoch scheduler list [--json]
  machdoch scheduler create (--cron <expr>|--trigger <kind:event>) --prompt <text> [--timezone <iana>] [--json]
  machdoch scheduler pause|resume|delete|trigger <job-id> [--json]
  machdoch scheduler runs [job-id] [--json]
  machdoch scheduler events [--json]
  machdoch scheduler event --event-type <type> [--event-kind <kind>] [--json]
  machdoch scheduler run-due [--json]
  machdoch scheduler retry|cancel <run-id> [--json]
  machdoch scheduler sync-prompts [--json]

Options:
  --mode <ask|machdoch>
                          Override the runtime mode for this command or chat session.
  --quick                 Force a one-shot task run that exits at a terminal state. Use --mode to choose ask or machdoch.
  --set-api               Save a provider API key into the user-scoped Machdoch config file.
  --provider <name>       Provider name for --set-api (openai, anthropic, google).
  --runtime-provider <name>
                          Override the runtime provider for this command or chat session.
  --key <value>           API key value for --set-api.
  --task <text>           Provide the task text explicitly instead of positionals.
  --model <name>          Override the active model for this run or chat session.
  --reasoning <mode>      Override model reasoning effort for this run or chat session.
  --default-model <name>  Persist the workspace default model to .machdoch/config.json.
  --set-global-memory <on|off>
                          Persist whether cross-session global memory is enabled.
  --session-memory <on|off>
                          Enable or disable per-session memory for this run or chat session.
  --global-memory <inherit|on|off>
                          Override cross-session global memory for this run or chat session.
  --executor-turns <count>
                          Override the per-executor model turn limit.
  --autopilot-iterations <count>
                          Override the Machdoch continuation limit.
  --infinite              Disable executor turn and Machdoch continuation limits. The wall-clock safety timeout still applies.
  --conversation-context-file <path>
                          Load conversation history and memory context from a JSON file.
  --context <path>        Add a file or folder path as task context. Repeat for multiple paths.
  --image <path>          Attach an image for a vision-capable model to read. Repeat for multiple images.
  --profile <name>        Use a named profile from .machdoch/config.json.
  --cwd <path>            Use a different workspace root.
  --cron <expr>           Scheduler cron expression for \`scheduler create\`.
  --trigger <kind:event>  Add an event trigger for \`scheduler create\`, for example workspace-file:workspace-file.created. Repeat for multiple triggers.
  --trigger-filter <path=value>
                          Add an activation filter such as payload.path=*.pdf or payload.usedPercent>=90. Repeat for multiple filters.
  --trigger-recovery-filter <path=value>
                          Add a recovery filter for stateful triggers, for example payload.usedPercent<=80.
  --trigger-firing-mode <event|state>
                          Use state for threshold/condition triggers that repeat only after cooldown/recovery.
  --trigger-cooldown-ms <ms>
                          Minimum time between runs fired by an event trigger.
  --trigger-repeat-ms <ms>
                          Repeat interval for stateful triggers while the condition remains active.
  --trigger-debounce-ms <ms>
                          Debounce window for bursty event sources.
  --trigger-dedupe-key-template <template>
                          Event run dedupe template such as file:{payload.path}:{payload.mtime}.
  --trigger-max-events <n>
                          Maximum trigger firings allowed per trigger window.
  --trigger-window-ms <ms>
                          Rolling window used with --trigger-max-events.
  --interval-ms <ms>      Scheduler interval in milliseconds for \`scheduler create\`.
  --delay-ms <ms>         Scheduler one-shot delay in milliseconds for \`scheduler create\`.
  --run-at <epoch-ms>     Scheduler one-shot absolute run time in epoch milliseconds.
  --timezone <iana>       IANA timezone for cron schedules.
  --prompt <text>         Scheduled task prompt text.
  --prompt-file <path>    Read scheduled task prompt text from a file.
  --scope <user|workspace|compatibility>
                          Instruction or Ralph scope. Compatibility only applies to instructions.
  --path <file>           Instruction file path for explicit save or generation updates.
  --apply-to <glob>       Workspace glob that auto-attaches an instruction. Repeat for multiple globs.
  --exclude <glob>        Workspace glob that prevents an instruction from attaching. Repeat for multiple globs.
  --keyword <term>        Keyword that auto-attaches an instruction. Repeat for multiple terms.
  --instruction-mode <mode>
                          Instruction activation: always, auto, agent-requested, manual, or disabled.
  --audience <target>     Instruction audience: executor, validator, generator, or all.
  --priority <integer>    Instruction ordering priority.
  --flow-json <json>      Save a complete Ralph flow JSON document for \`ralph save\`.
  --watch-json <json>     Save a Ralph watch definition for \`ralph watches create\`.
  --watch-json-file <path>
                          Read a Ralph watch definition from a JSON file.
  --existing-flow-json <json>
                          Provide the current Ralph flow JSON to \`ralph create\` for AI-assisted edits.
  --revision <id>         Ralph flow revision id for \`ralph restore\`.
  --flow-target <target>  Ralph generation target: flow, prompt-block, or refactor.
  --generation-mode <mode>
                          Ralph generation style: do-it or interview.
  --param <name=value>    Set a Ralph flow variable for \`ralph run\`. Repeat for multiple variables.
  --input-json <json>     Submit answers for \`ralph resume\`. Use either a values object or a full input response.
  --input-json-file <path>
                          Read Ralph resume answers from a JSON file.
  --max-rounds <n>        Maximum rounds for \`ralph create\`, \`ralph interview\`, or \`instructions generate\`.
  --max-transitions <n>   Stop a Ralph run or resume after this many graph transitions.
  --trace                 Show the detailed JSONL trace for \`ralph log\`.
  --include-disabled      Include disabled preset and configured MCP servers in \`mcp servers\`.
  --arguments-json <json> JSON object arguments for \`mcp call-tool\` or \`mcp get-prompt\`.
  --context-pack <json>   Add a scheduled context-pack snapshot as JSON. Repeat for multiple packs.
  --macro <name|prompt>   Add a saved macro reference or prompt invocation. Repeat for multiple macros.
  --missed-run-policy <skip|enqueue-latest|enqueue-all>
                          Control catch-up behavior after downtime.
  --retry-attempts <n>    Maximum scheduler attempts for a run.
  --ttl-ms <ms>           Expire queued runs that do not start within this duration.
  --max-duration-ms <ms>  Abort scheduled runs that exceed this duration.
  --event-type <type>     Event type for \`scheduler event\`, for example workspace-file.created.
  --event-kind <kind>     Event trigger category for \`scheduler event\`.
  --event-source <source> Event source for \`scheduler event\`.
  --event-payload-json <json>
                          JSON payload for \`scheduler event\`.
  --event-dedupe-key <key>
                          Stable source event key for \`scheduler event\`.
  --event-occurred-at <epoch-ms>
                          Event occurrence time in epoch milliseconds.
  --dedupe-key <key>      Stable key used to update an existing schedule instead of creating a duplicate.
  --concurrency-key <key> Share queue capacity across related scheduled jobs.
  --concurrency-limit <n> Maximum actively running jobs for the queue key.
  --json                  Print machine-readable JSON.
  --verbose, -v           Print compact progress updates during \`machdoch run\`.
  -h, --help              Show help.

Config settings accepted by \`machdoch config set\`:
  api.<openai|anthropic|google>.key
  agent-cli.<codex-cli|claude-cli|copilot-cli>.path
  web-search.provider
  web-search.<perplexity|tavily|serper>.key
  voice.provider
  speech-to-text.<provider|input-device>
  desktop.<setting>
  memory.global
  agent-limits.<infinite|executor-turns|autopilot-iterations>
  workspace.<model|provider|mode|reasoning|offline>

Default CLI mode is interactive and keeps running until /exit, /quit, or Ctrl+C.
\`machdoch <task>\` and \`machdoch --task <text>\` start interactive chat with an initial task.
Use \`/paste\` in interactive chat to submit multiline task text; finish with a line containing only \`/end\`.
Use \`machdoch run <task>\` or \`machdoch --quick --task <text>\` for one-shot execution that exits.
During a task run, press Ctrl+C to request cancellation after the current execution step.
`;
};

export const getHelpText = CLI_HELP_TEXT;
