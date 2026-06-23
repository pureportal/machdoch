import { REASONING_MODES, VALID_MODEL_PROVIDERS } from "../../core/runtime-contract.generated.js";
import type { InstructionAudience, InstructionMode } from "../../core/types.js";
import type { ModelProvider, ReasoningMode, RunMode, UserApiProvider } from "../../core/runtime-contract.generated.js";
import type {
  CommandName,
  InstructionCliAction,
  InstructionCliScope,
  McpCliAction,
  RalphCliAction,
  RalphCliGenerationMode,
  RalphCliGenerationTarget,
  RalphCliScope,
  RalphWatchCliAction,
  SchedulerCliAction,
} from "./cli-args-types.js";

export const VALID_MODES: ReadonlySet<RunMode> = new Set([
  "ask",
  "machdoch",
]);
export const VALID_MODE_DESCRIPTION = "ask or machdoch";
export const VALID_PROVIDERS: ReadonlySet<UserApiProvider> = new Set([
  "openai",
  "anthropic",
  "google",
]);
export const VALID_RUNTIME_PROVIDERS: ReadonlySet<
  Exclude<ModelProvider, "unconfigured">
> = new Set(VALID_MODEL_PROVIDERS);
export const VALID_RUNTIME_PROVIDER_DESCRIPTION =
  "openai, anthropic, google, codex-cli, claude-cli, or copilot-cli";
export const VALID_REASONING_MODES: ReadonlySet<ReasoningMode> = new Set(
  REASONING_MODES,
);
export const VALID_REASONING_MODE_DESCRIPTION =
  "default, none, minimal, low, medium, high, xhigh, or max";
export const VALID_BOOLEAN_TOGGLE_VALUES: ReadonlySet<string> = new Set(["on", "off"]);
export const VALID_MEMORY_OVERRIDE_VALUES: ReadonlySet<string> = new Set([
  "inherit",
  "on",
  "off",
]);
export const COMMANDS_WITHOUT_POSITIONALS: ReadonlySet<CommandName> = new Set([
  "inspect",
  "config",
  "tools",
  "profiles",
  "help",
]);
export const SCHEDULER_ACTIONS: ReadonlySet<SchedulerCliAction> = new Set([
  "list",
  "create",
  "pause",
  "resume",
  "delete",
  "runs",
  "events",
  "event",
  "run-due",
  "trigger",
  "retry",
  "cancel",
  "sync-prompts",
  "service",
]);
export const SCHEDULER_ACTIONS_REQUIRING_SUBJECT: ReadonlySet<SchedulerCliAction> =
  new Set(["pause", "resume", "delete", "trigger", "retry", "cancel"]);
export const MCP_ACTIONS: ReadonlySet<McpCliAction> = new Set([
  "servers",
  "cache",
  "discover",
  "refresh",
  "oauth-start",
  "oauth-finish",
  "call-tool",
  "read-resource",
  "get-prompt",
]);
export const MCP_ACTIONS_REQUIRING_SERVER: ReadonlySet<McpCliAction> = new Set([
  "discover",
  "refresh",
  "oauth-start",
  "oauth-finish",
  "call-tool",
  "read-resource",
  "get-prompt",
]);
export const MCP_ACTIONS_REQUIRING_TARGET: ReadonlySet<McpCliAction> = new Set([
  "oauth-finish",
  "call-tool",
  "read-resource",
  "get-prompt",
]);
export const INSTRUCTION_ACTIONS: ReadonlySet<InstructionCliAction> = new Set([
  "list",
  "show",
  "validate",
  "create",
  "save",
  "generate",
]);
export const INSTRUCTION_ACTIONS_REQUIRING_SUBJECT: ReadonlySet<InstructionCliAction> =
  new Set(["show"]);
export const INSTRUCTION_SCOPES: ReadonlySet<InstructionCliScope> = new Set([
  "user",
  "workspace",
  "compatibility",
  "ralph-flow",
]);
export const INSTRUCTION_MODES: ReadonlySet<InstructionMode> = new Set([
  "always",
  "auto",
  "agent-requested",
  "manual",
  "disabled",
]);
export const INSTRUCTION_AUDIENCES: ReadonlySet<InstructionAudience> = new Set([
  "executor",
  "validator",
  "generator",
  "all",
]);
export const RALPH_ACTIONS: ReadonlySet<RalphCliAction> = new Set([
  "list",
  "show",
  "validate",
  "delete",
  "save",
  "run",
  "resume",
  "run-detail",
  "runs",
  "log",
  "revisions",
  "restore",
  "create",
  "interview",
  "watches",
]);
export const RALPH_ACTIONS_REQUIRING_SUBJECT: ReadonlySet<RalphCliAction> = new Set([
  "show",
  "validate",
  "delete",
  "save",
  "run",
  "resume",
  "run-detail",
  "log",
  "revisions",
  "restore",
]);
export const RALPH_GENERATION_MODES: ReadonlySet<RalphCliGenerationMode> = new Set([
  "do-it",
  "interview",
]);
export const RALPH_GENERATION_TARGETS: ReadonlySet<RalphCliGenerationTarget> = new Set([
  "flow",
  "prompt-block",
  "refactor",
]);
export const RALPH_SCOPES: ReadonlySet<RalphCliScope> = new Set([
  "workspace",
  "user",
]);
export const RALPH_WATCH_ACTIONS: ReadonlySet<RalphWatchCliAction> = new Set([
  "list",
  "create",
  "delete",
  "sync",
  "run",
]);
