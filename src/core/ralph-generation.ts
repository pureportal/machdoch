import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadRuntimeConfig } from "./config.js";
import { discoverCustomizations } from "./customizations.js";
import { executeTask } from "./execution.js";
import {
  createToolErrorResult,
  type AgentToolDefinition,
} from "./_helpers/agent-tools-shared.js";
import { FLOW_FILE_EXTENSION } from "./_helpers/ralph-flow-ids.helper.js";
import {
  createAvailableGeneratedFlowAlias,
  writeGeneratedRalphFlowWithAliasFallback,
} from "./_helpers/create-available-generated-flow-alias.helper.js";
import { createGenerationAttemptFlowPath } from "./_helpers/create-generation-attempt-flow-path.helper.js";
import { createGenerationActorResultMessage } from "./_helpers/create-generation-actor-result-message.helper.js";
import { createGenerationDidNotConvergeSummary } from "./_helpers/create-generation-did-not-converge-summary.helper.js";
import { createGenerationFeedbackExcerpt } from "./_helpers/create-generation-feedback-excerpt.helper.js";
import { createLocalGenerationValidatorResult } from "./_helpers/create-local-generation-validator-result.helper.js";
import {
  RalphFileGenerationLogger,
  createRalphGenerationLogger,
} from "./_helpers/create-ralph-generation-logger.helper.js";
import { createTaskDidNotExecuteFeedback } from "./_helpers/create-task-did-not-execute-feedback.helper.js";
import { clampRalphGenerationInterviewMaxTurns } from "./_helpers/clamp-ralph-generation-interview-max-turns.helper.js";
import { mergeRalphGenerationInterviewLines } from "./_helpers/merge-ralph-generation-interview-lines.helper.js";
import { readGeneratedRalphFlow } from "./_helpers/read-generated-ralph-flow.helper.js";
import {
  RALPH_GENERATION_INTERVIEW_INPUT_TYPES,
  RALPH_GENERATION_INTERVIEW_SECTION_TITLE,
  readRalphGenerationInterviewSubmission,
  type RalphGenerationInterviewSubmission,
} from "./_helpers/read-ralph-generation-interview-submission.helper.js";
import { validateGeneratedRalphFlowStructure } from "./_helpers/validate-generated-ralph-flow-structure.helper.js";
import { loadMcpConfigSync, loadMcpDiscoveryCacheSync } from "./mcp/config.js";
import { normalizeRalphFlowLayout } from "./ralph-layout.js";
import {
  MAX_RALPH_SIMPLE_LOG_CHARS,
  RALPH_BLOCK_TYPES,
  RALPH_FLOW_SCHEMA_VERSION,
  RALPH_UTILITY_TYPES,
  capLogText,
  createLogTimestamp,
  createRalphTaskExecutionOptions,
  createValidationResult,
  getRalphFlowPath,
  getRalphFlowStorageDirectory,
  normalizeFlowAlias,
  parseRalphFlowJson,
  sanitizeTraceValue,
  validateRalphFlow,
  type RalphBlockType,
  type RalphFlow,
  type RalphFlowScope,
  type RalphInputField,
  type RalphInputFieldType,
  type RalphInputValue,
  type RalphUtilityType,
  type RalphValidationResult,
} from "./ralph.js";
import type { ModelProvider, RuntimeConfig } from "./runtime-contract.generated.js";
import type {
  CustomizationDiscoveryResult,
  TaskActionOutput,
  TaskExecutionProgress,
  TaskExecutionProgressHandler,
  TaskExecutionResult,
} from "./types.js";

export { getRalphGenerationDirectory } from "./_helpers/create-ralph-generation-logger.helper.js";

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const DEFAULT_RALPH_GENERATION_MAX_ROUNDS = 3;
export const MAX_RALPH_GENERATION_MAX_ROUNDS = 25;
export const DEFAULT_RALPH_GENERATION_INTERVIEW_MAX_TURNS = 5;
export const MAX_RALPH_GENERATION_INTERVIEW_MAX_TURNS = 5;
const DEFAULT_RALPH_GENERATION_ACTOR_TIMEOUT_MS = 3 * 60 * 1_000;

export type RalphGenerationActor = "generator" | "validator";

export type RalphGenerationEventType =
  | "queued"
  | "started"
  | "round-start"
  | "generator-start"
  | "generator-output"
  | "actor-progress"
  | "actor-output"
  | "generator-file-written"
  | "schema-validation-start"
  | "schema-validation-result"
  | "validator-start"
  | "validator-result"
  | "retry-feedback"
  | "created"
  | "blocked"
  | "cancelled"
  | "failed";

export interface RalphGenerationEvent {
  type: RalphGenerationEventType;
  generationRunId: string;
  message: string;
  createdAt: string;
  round?: number;
  maxRounds?: number;
  actor?: RalphGenerationActor;
  provider?: ModelProvider;
  model?: string;
  flowPath?: string;
  generationFlowPath?: string;
  validationValid?: boolean;
  validationErrorCount?: number;
  validationWarningCount?: number;
  validatorDecision?: string;
  status?: "created" | "blocked";
  blockCount?: number;
  edgeCount?: number;
  durationMs?: number;
  actorState?: TaskExecutionProgress["state"];
  actionToolName?: string;
  actionStream?: TaskActionOutput["stream"];
  detail?: string;
}

export interface RalphGenerationLogPaths {
  id: string;
  directory: string;
  recordPath: string;
  simpleMarkdownPath: string;
  traceJsonlPath: string;
}

export interface RalphFlowGenerationOptions {
  name: string;
  prompt: string;
  existingFlow?: RalphFlow;
  mode?: "do-it" | "interview";
  target?: "flow" | "prompt-block" | "refactor";
  scope?: RalphFlowScope;
  config?: RuntimeConfig;
  customizations?: CustomizationDiscoveryResult;
  maxRounds?: number;
  onStateChange?: TaskExecutionProgressHandler;
  onGenerationEvent?: (event: RalphGenerationEvent) => void | Promise<void>;
  runId?: string;
  signal?: AbortSignal;
}

export interface RalphFlowGenerationResult {
  generationRunId?: string;
  status: "created" | "blocked";
  flowPath: string;
  generationLogPath?: string;
  traceLogPath?: string;
  flow?: RalphFlow;
  rounds: number;
  validation: RalphValidationResult;
  events: RalphGenerationEvent[];
  generatorResults: TaskExecutionResult[];
  validatorResults: TaskExecutionResult[];
  summary: string;
}

export type RalphGenerationInterviewTarget =
  | "flow"
  | "prompt-block"
  | "refactor";

export type RalphGenerationInterviewStatus =
  | "questions"
  | "complete"
  | "blocked";

export interface RalphGenerationInterviewAnswer {
  fieldId: string;
  label: string;
  type: RalphInputFieldType;
  value: RalphInputValue;
  comment?: string;
}

export interface RalphGenerationInterviewTranscriptTurn {
  turn: number;
  questionScope?: string;
  questions: RalphInputField[];
  answers: RalphGenerationInterviewAnswer[];
  summary?: string;
  createdAt: string;
  answeredAt?: string;
}

export interface RalphGenerationInterviewSession {
  id: string;
  prompt: string;
  scope: RalphFlowScope;
  target: RalphGenerationInterviewTarget;
  turn: number;
  maxTurns: number;
  contextSummary?: string;
  findings: string[];
  assumptions: string[];
  relevantFiles: string[];
  transcript: RalphGenerationInterviewTranscriptTurn[];
  finalSummary?: string;
}

export interface RalphGenerationInterviewOptions {
  name?: string;
  prompt: string;
  existingFlow?: RalphFlow;
  target?: RalphGenerationInterviewTarget;
  scope?: RalphFlowScope;
  config?: RuntimeConfig;
  customizations?: CustomizationDiscoveryResult;
  maxTurns?: number;
  session?: RalphGenerationInterviewSession;
  answers?: Record<string, RalphInputValue>;
  answerComments?: Record<string, string>;
  onStateChange?: TaskExecutionProgressHandler;
  runId?: string;
  signal?: AbortSignal;
}

export interface RalphGenerationInterviewResult {
  status: RalphGenerationInterviewStatus;
  session: RalphGenerationInterviewSession;
  fields: RalphInputField[];
  summary: string;
  finalPrompt?: string;
  provider?: ModelProvider;
  model?: string;
  result?: TaskExecutionResult;
}

const createExistingRalphFlowDiscoveryTarget = (
  existingFlow: RalphFlow | undefined,
  scope: RalphFlowScope,
) => {
  const id = existingFlow?.id.trim();

  return id
    ? {
        ralphFlow: {
          id,
          scope,
        },
      }
    : {};
};

interface RalphGenerationBlockContract {
  type: RalphBlockType;
  role: string;
  requiredFields: string[];
  optionalFields: string[];
  outputs: string[];
  generationNotes: string[];
}

interface RalphGenerationUtilityContract {
  type: RalphUtilityType;
  role: string;
  requiredFields: string[];
  optionalFields: string[];
  outputs: string[];
  generationNotes: string[];
}

interface RalphGeneratedFlowIdentity {
  id: string;
  alias?: string;
  name: string;
}

const RALPH_GENERATION_BLOCK_CONTRACTS: Record<
  RalphBlockType,
  RalphGenerationBlockContract
> = {
  START: {
    type: "START",
    role: "Entry point for execution.",
    requiredFields: ["id", "type", "title"],
    optionalFields: ["position", "size", "settings"],
    outputs: ["SUCCESS"],
    generationNotes: ["Use exactly one START block in every flow."],
  },
  PROMPT: {
    type: "PROMPT",
    role: "LLM work block that performs or investigates part of the requested workflow.",
    requiredFields: ["id", "type", "title", "prompt"],
    optionalFields: ["position", "size", "settings", "parentGroupId"],
    outputs: ["SUCCESS", "ERROR"],
    generationNotes: [
      "Use PROMPT blocks for agent work that benefits from model reasoning.",
      "Normal PROMPT blocks do not need RALPH_DECISION markers.",
    ],
  },
  VALIDATOR: {
    type: "VALIDATOR",
    role: "LLM validation gate that decides whether the flow should finish, continue, retry, or error.",
    requiredFields: ["id", "type", "title", "prompt"],
    optionalFields: ["position", "size", "settings", "validationScope", "parentGroupId"],
    outputs: ["DONE", "CONTINUE", "RETRY", "ERROR"],
    generationNotes: [
      "The validator prompt must instruct the model to end with RALPH_DECISION: DONE, CONTINUE, RETRY, or ERROR.",
      "VALIDATOR.CONTINUE needs an explicit edge.",
      "VALIDATOR.RETRY may omit an edge when the validator belongs to a group with a start boundary.",
    ],
  },
  DECISION: {
    type: "DECISION",
    role: "LLM classifier that chooses one label from a finite route set.",
    requiredFields: ["id", "type", "title", "prompt", "labels"],
    optionalFields: ["position", "size", "settings", "parentGroupId"],
    outputs: ["labels[]", "ERROR"],
    generationNotes: [
      "Labels become valid fromOutput values.",
      "The decision prompt must instruct the model to end with RALPH_DECISION: <LABEL>.",
    ],
  },
  PACK: {
    type: "PACK",
    role: "Context-pack selection block for workspaces that expose packs.",
    requiredFields: ["id", "type", "title", "packIds"],
    optionalFields: ["position", "size", "settings", "propagationMode", "parentGroupId"],
    outputs: ["SUCCESS", "ERROR"],
    generationNotes: [
      "Do not use PACK blocks unless workspace context lists available pack ids.",
    ],
  },
  ASK_USER: {
    type: "ASK_USER",
    role: "Human input or approval checkpoint that can pause the run until the user submits typed answers.",
    requiredFields: ["id", "type", "title", "fields"],
    optionalFields: [
      "mode",
      "prompt",
      "submitLabel",
      "cancelLabel",
      "timeoutSeconds",
      "position",
      "size",
      "settings",
      "parentGroupId",
    ],
    outputs: ["SUCCESS", "CANCELLED", "TIMEOUT", "ERROR"],
    generationNotes: [
      "Use ASK_USER blocks for mid-run human-provided values such as text, numbers, booleans, choices, paths, files, and images.",
      "Set mode to missingOnly when the block should auto-continue if required values already exist; this is the default.",
      "Set mode to alwaysAsk for a deliberate human checkpoint, or confirmOnly for a simple approval/continue prompt.",
      "Each field needs id, label, type, and should set skippable when the answer is optional.",
      "Use variableName when downstream prompts need a stable placeholder name for a field value.",
    ],
  },
  INTERVIEW: {
    type: "INTERVIEW",
    role: "AI-led clarification loop that asks the user generated typed questions until enough detail is collected.",
    requiredFields: ["id", "type", "title", "prompt"],
    optionalFields: [
      "completionCriteria",
      "maxTurns",
      "questionsPerTurn",
      "outputVariableName",
      "submitLabel",
      "cancelLabel",
      "position",
      "size",
      "settings",
      "parentGroupId",
    ],
    outputs: ["DONE", "INCOMPLETE", "CANCELLED", "ERROR"],
    generationNotes: [
      "Use INTERVIEW before implementation when requirements are ambiguous and the AI should create follow-up questions.",
      "Set completionCriteria for what makes the interview ready to continue.",
      "Route DONE to implementation and test loops; route INCOMPLETE or CANCELLED to review or END.",
    ],
  },
  UTILITY: {
    type: "UTILITY",
    role: "Deterministic local operation without an LLM.",
    requiredFields: ["id", "type", "title", "utility"],
    optionalFields: ["position", "size", "settings", "parentGroupId"],
    outputs: ["depends on utility.type"],
    generationNotes: [
      "Use utility outputs exactly as defined by the selected utility contract.",
      "Prefer utilities for deterministic checks, filesystem reads, waits, and structured transformations.",
    ],
  },
  MCP_TOOL: {
    type: "MCP_TOOL",
    role: "Call an enabled MCP server tool.",
    requiredFields: ["id", "type", "title", "serverId", "toolName"],
    optionalFields: ["arguments", "position", "size", "settings", "parentGroupId"],
    outputs: ["SUCCESS", "ERROR"],
    generationNotes: [
      "Use only MCP capabilities that are available in workspace hints or tool contract output.",
    ],
  },
  MCP_RESOURCE: {
    type: "MCP_RESOURCE",
    role: "Read an enabled MCP server resource.",
    requiredFields: ["id", "type", "title", "serverId", "uri"],
    optionalFields: ["position", "size", "settings", "parentGroupId"],
    outputs: ["SUCCESS", "ERROR"],
    generationNotes: [
      "Use for context/evidence resources exposed by MCP servers.",
    ],
  },
  MCP_PROMPT: {
    type: "MCP_PROMPT",
    role: "Run an enabled MCP server prompt.",
    requiredFields: ["id", "type", "title", "serverId", "promptName"],
    optionalFields: ["arguments", "position", "size", "settings", "parentGroupId"],
    outputs: ["SUCCESS", "ERROR"],
    generationNotes: [
      "Use only when a discovered MCP prompt materially helps the requested flow.",
    ],
  },
  NOTE: {
    type: "NOTE",
    role: "Visual annotation only.",
    requiredFields: ["id", "type", "title", "text"],
    optionalFields: ["position", "size", "tone", "tags", "collapsed", "pinnedBlockIds", "parentGroupId"],
    outputs: [],
    generationNotes: [
      "Never route execution through NOTE blocks.",
      "Put visible note body content in NOTE.text.",
    ],
  },
  GROUP: {
    type: "GROUP",
    role: "Visual organization container.",
    requiredFields: ["id", "type", "title", "childBlockIds"],
    optionalFields: [
      "position",
      "size",
      "tone",
      "description",
      "collapsed",
      "locked",
      "moveChildren",
      "maxDepth",
      "layoutMode",
      "executionBoundary",
      "parentGroupId",
    ],
    outputs: [],
    generationNotes: [
      "Never route execution through GROUP blocks.",
      "Use GROUP.childBlockIds and/or child parentGroupId membership; Ralph normalizes group bounds around children.",
    ],
  },
  END: {
    type: "END",
    role: "Terminal execution outcome.",
    requiredFields: ["id", "type", "title"],
    optionalFields: ["position", "size", "status"],
    outputs: [],
    generationNotes: ["Use one or more END blocks for terminal success/failure/review outcomes."],
  },
};

const RALPH_GENERATION_UTILITY_CONTRACTS: Record<
  RalphUtilityType,
  RalphGenerationUtilityContract
> = {
  WAIT: {
    type: "WAIT",
    role: "Wait for a delay, time, or condition.",
    requiredFields: ["type", "mode"],
    optionalFields: ["delaySeconds", "runAt", "intervalSeconds", "condition"],
    outputs: ["SUCCESS"],
    generationNotes: ["Use mode=delay with delaySeconds for a simple wait."],
  },
  HTTP_FETCH: {
    type: "HTTP_FETCH",
    role: "Fetch an HTTP resource.",
    requiredFields: ["type", "url"],
    optionalFields: ["method", "headers", "body", "timeoutSeconds", "maxOutputBytes"],
    outputs: ["SUCCESS", "HTTP_ERROR", "TIMEOUT", "ERROR"],
    generationNotes: ["Use for deterministic HTTP checks or API evidence."],
  },
  POLL: {
    type: "POLL",
    role: "Repeat a condition or request until success, timeout, or error.",
    requiredFields: ["type", "condition"],
    optionalFields: ["intervalSeconds", "backoffMultiplier", "maxAttempts"],
    outputs: ["SUCCESS", "TIMEOUT", "ERROR"],
    generationNotes: [
      "TIMEOUT is only emitted when maxAttempts is finite.",
      "Use for readiness checks; do not use to start servers.",
    ],
  },
  CONDITION: {
    type: "CONDITION",
    role: "Route execution by a deterministic condition without an AI decision call.",
    requiredFields: ["type", "condition"],
    optionalFields: [],
    outputs: ["MATCH", "NO_MATCH", "ERROR"],
    generationNotes: [
      "Use for boolean flags, non-empty variable checks, previous-result checks, and other deterministic branching.",
      "Prefer CONDITION over DECISION when no reasoning is required.",
    ],
  },
  RUN_COMMAND: {
    type: "RUN_COMMAND",
    role: "Run a configured local command.",
    requiredFields: ["type", "command or fallbackCommand"],
    optionalFields: ["fallbackCommand", "cwd", "env", "timeoutSeconds", "maxOutputBytes"],
    outputs: ["SUCCESS", "ERROR"],
    generationNotes: ["Use only when the flow intentionally needs command execution."],
  },
  READ_FILE: {
    type: "READ_FILE",
    role: "Read a file at flow runtime.",
    requiredFields: ["type", "path"],
    optionalFields: ["encoding", "maxOutputBytes"],
    outputs: ["SUCCESS", "ERROR"],
    generationNotes: ["Use for deterministic runtime evidence from known file paths."],
  },
  WRITE_FILE: {
    type: "WRITE_FILE",
    role: "Write flow runtime content to a file.",
    requiredFields: ["type", "path", "content"],
    optionalFields: ["append", "encoding"],
    outputs: ["SUCCESS", "ERROR"],
    generationNotes: ["Use only when the requested flow needs a file artifact."],
  },
  READ_JSON: {
    type: "READ_JSON",
    role: "Read and parse a known JSON artifact.",
    requiredFields: ["type", "path"],
    optionalFields: ["schema"],
    outputs: ["SUCCESS", "NOT_FOUND", "INVALID", "ERROR"],
    generationNotes: ["Use for resumable state files and canonical flow artifacts."],
  },
  WRITE_JSON: {
    type: "WRITE_JSON",
    role: "Write JSON input or previous utility data to a workspace-contained file.",
    requiredFields: ["type", "path"],
    optionalFields: ["input", "content", "schema"],
    outputs: ["SUCCESS", "INVALID", "ERROR"],
    generationNotes: ["Prefer over WRITE_FILE when storing structured state."],
  },
  PATCH_JSON: {
    type: "PATCH_JSON",
    role: "Merge or replace an existing workspace-contained JSON file.",
    requiredFields: ["type", "path"],
    optionalFields: ["input", "content", "schema", "jsonPatchMode"],
    outputs: ["SUCCESS", "NOT_FOUND", "INVALID", "ERROR"],
    generationNotes: ["Use jsonPatchMode=merge for state updates unless replacement is intentional."],
  },
  APPEND_JSONL: {
    type: "APPEND_JSONL",
    role: "Append one structured JSON event to a workspace-contained JSONL file.",
    requiredFields: ["type", "path"],
    optionalFields: ["input", "content", "schema"],
    outputs: ["SUCCESS", "INVALID", "ERROR"],
    generationNotes: ["Use for completed/rejected/backlog history streams."],
  },
  READ_JSONL: {
    type: "READ_JSONL",
    role: "Read structured JSONL history entries from a known file.",
    requiredFields: ["type", "path"],
    optionalFields: ["schema", "maxResults"],
    outputs: ["SUCCESS", "EMPTY", "NOT_FOUND", "INVALID", "ERROR"],
    generationNotes: [
      "Use for durable event history instead of asking a prompt to remember prior runs.",
    ],
  },
  QUERY_JSONL: {
    type: "QUERY_JSONL",
    role: "Filter structured JSONL history entries with a deterministic condition.",
    requiredFields: ["type", "path"],
    optionalFields: ["schema", "condition", "maxResults"],
    outputs: ["SUCCESS", "EMPTY", "NOT_FOUND", "INVALID", "ERROR"],
    generationNotes: [
      "Use for duplicate detection, recent-history checks, and event-backed routing.",
      "Prefer CONDITION-style checks here before spending a PROMPT block on history analysis.",
    ],
  },
  FILE_EXISTS: {
    type: "FILE_EXISTS",
    role: "Check whether a workspace path exists.",
    requiredFields: ["type", "path"],
    optionalFields: [],
    outputs: ["EXISTS", "MISSING", "ERROR"],
    generationNotes: [
      "Use to route resume/setup paths without searching when the target path is known.",
    ],
  },
  DELETE_FILE: {
    type: "DELETE_FILE",
    role: "Delete a workspace-contained file path.",
    requiredFields: ["type", "path"],
    optionalFields: [],
    outputs: ["SUCCESS", "NOT_FOUND", "ERROR"],
    generationNotes: [
      "Use only for explicit cleanup of known files created or tracked by the flow.",
      "Do not use for directories or broad cleanup.",
    ],
  },
  MOVE_FILE: {
    type: "MOVE_FILE",
    role: "Move a workspace-contained file to another workspace-contained path.",
    requiredFields: ["type", "path", "outputPath"],
    optionalFields: [],
    outputs: ["SUCCESS", "NOT_FOUND", "ERROR"],
    generationNotes: ["Use for deterministic handoff between known state paths."],
  },
  ARCHIVE_FILE: {
    type: "ARCHIVE_FILE",
    role: "Move a workspace-contained file into an archive path or archive directory.",
    requiredFields: ["type", "path"],
    optionalFields: ["outputPath", "rootPath"],
    outputs: ["SUCCESS", "NOT_FOUND", "ERROR"],
    generationNotes: ["Prefer over DELETE_FILE for completed autonomous state."],
  },
  LOOP_COUNTER: {
    type: "LOOP_COUNTER",
    role: "Increment a persisted counter and route when a loop limit is reached.",
    requiredFields: ["type"],
    optionalFields: ["path", "counterName", "counterKey", "maxAttempts", "reset"],
    outputs: ["CONTINUE", "LIMIT_REACHED", "ERROR"],
    generationNotes: ["Use to bound autonomous or retry loops without AI judgment."],
  },
  PROMPT_JSON: {
    type: "PROMPT_JSON",
    role: "Run one AI prompt and require schema-valid JSON output.",
    requiredFields: ["type", "prompt", "schema"],
    optionalFields: ["outputPath", "maxAttempts", "structuredOutput"],
    outputs: ["SUCCESS", "INVALID", "ERROR"],
    generationNotes: [
      "Use only when deterministic utilities cannot produce the structured artifact.",
      "Follow with READ_JSON/VALIDATE_JSON when later nodes consume persisted state.",
    ],
  },
  VALIDATOR_JSON: {
    type: "VALIDATOR_JSON",
    role: "Run one AI prompt that returns a schema-valid validator decision.",
    requiredFields: ["type", "prompt"],
    optionalFields: ["schema", "maxAttempts", "structuredOutput"],
    outputs: ["DONE", "CONTINUE", "RETRY", "ERROR", "INVALID"],
    generationNotes: [
      "Use when validation needs AI judgment but the result should still be machine-routable.",
      "Prefer VALIDATE_JSON or CONDITION when code can decide without model judgment.",
    ],
  },
  SELECT_JSON_TASK: {
    type: "SELECT_JSON_TASK",
    role: "Select and mark the next task from a persisted JSON checklist.",
    requiredFields: ["type", "path"],
    optionalFields: ["jsonPath", "strategy", "schema"],
    outputs: ["SELECTED", "EMPTY", "NOT_FOUND", "INVALID", "ERROR"],
    generationNotes: [
      "Use before implementation prompts so long-running feature loops work one concrete task at a time.",
      "Keep task ids stable and use statuses todo/in_progress/done/blocked.",
    ],
  },
  MARK_JSON_TASK: {
    type: "MARK_JSON_TASK",
    role: "Mark a selected or configured JSON checklist task with a new status.",
    requiredFields: ["type", "path"],
    optionalFields: ["jsonPath", "taskId", "status", "result", "input", "schema"],
    outputs: ["SUCCESS", "NOT_FOUND", "INVALID", "ERROR"],
    generationNotes: [
      "Use after verification or structured validation to persist task progress.",
    ],
  },
  CHANGE_SCOPE_GUARD: {
    type: "CHANGE_SCOPE_GUARD",
    role: "Record whether changed git files match allowed paths/globs from the selected scope.",
    requiredFields: ["type"],
    optionalFields: ["cwd", "input", "baseline", "enforce", "maxOutputBytes"],
    outputs: ["IN_SCOPE", "OUT_OF_SCOPE", "EMPTY", "ERROR"],
    generationNotes: [
      "Use after edit passes in scoped loops when later prompts need advisory scope-change data.",
      "Pass selected scope JSON via input, for example {{data:select-scope:scope}}.",
      "Pass a GIT_SNAPSHOT result via baseline when pre-existing dirty files should not fail the guard.",
      "By default, out-of-scope files are advisory and still produce IN_SCOPE so shared workspace edits do not stop the flow. Set enforce=true only when the user explicitly wants blocking scope enforcement.",
    ],
  },
  SCAN_SCOPE_EVIDENCE: {
    type: "SCAN_SCOPE_EVIDENCE",
    role: "Deterministically scan the workspace and produce JSON scope evidence.",
    requiredFields: ["type"],
    optionalFields: ["rootPath", "excludePaths", "maxDepth", "maxResults"],
    outputs: ["SUCCESS", "EMPTY", "ERROR"],
    generationNotes: [
      "Use before UPDATE_SCOPE_REGISTRY when a flow must cover every discovered codebase scope.",
      "Keep rootPath narrow when the user configured a specific repository subtree.",
    ],
  },
  UPDATE_SCOPE_REGISTRY: {
    type: "UPDATE_SCOPE_REGISTRY",
    role: "Merge scope evidence into the canonical JSON scope registry.",
    requiredFields: ["type", "flowAlias"],
    optionalFields: [
      "registryPath",
      "path",
      "strategy",
      "input",
      "includeMarkdown",
      "outputPath",
    ],
    outputs: ["SUCCESS", "EMPTY", "ERROR"],
    generationNotes: [
      "Use after SCAN_SCOPE_EVIDENCE; blank input consumes the previous utility result.",
      "The registry JSON is the source of truth for all-scope coverage.",
    ],
  },
  SELECT_SCOPE: {
    type: "SELECT_SCOPE",
    role: "Select the next active scope from a JSON scope registry using a configured strategy.",
    requiredFields: ["type", "flowAlias"],
    optionalFields: ["registryPath", "path", "strategy", "forceNew"],
    outputs: ["SELECTED", "EMPTY", "ERROR"],
    generationNotes: [
      "Use instead of asking a PROMPT block to choose from SCOPE=ALL.",
      "SELECTED data includes scope.id, title, paths, globs, tags, risk, and priority.",
    ],
  },
  MARK_SCOPE_RESULT: {
    type: "MARK_SCOPE_RESULT",
    role: "Mark the selected scope as completed for this coverage cycle.",
    requiredFields: ["type", "flowAlias"],
    optionalFields: [
      "registryPath",
      "path",
      "scopeId",
      "result",
      "includeMarkdown",
      "outputPath",
    ],
    outputs: ["SUCCESS", "NOT_FOUND", "ERROR"],
    generationNotes: [
      "Use after a validator or verification step so SELECT_SCOPE can cover every active scope before repeating.",
    ],
  },
  SEARCH_FILES: {
    type: "SEARCH_FILES",
    role: "Search workspace files at flow runtime.",
    requiredFields: ["type", "pattern or glob"],
    optionalFields: ["rootPath", "maxResults"],
    outputs: ["SUCCESS", "EMPTY", "ERROR"],
    generationNotes: [
      "Set rootPath to the narrowest useful source root.",
      "Use pattern or glob as a single string.",
    ],
  },
  RUN_CHECK: {
    type: "RUN_CHECK",
    role: "Run a verification command with accepted exit codes.",
    requiredFields: ["type", "command or fallbackCommand"],
    optionalFields: [
      "fallbackCommand",
      "cwd",
      "env",
      "acceptedExitCodes",
      "timeoutSeconds",
      "maxOutputBytes",
    ],
    outputs: ["SUCCESS", "FAILED", "ERROR"],
    generationNotes: [
      "Prefer package-manager-aware verification commands from workspace hints.",
      "When a flow detects project commands, set fallbackCommand to the detected verification command so blank optional input does not skip validation.",
    ],
  },
  UI_ANALYZE: {
    type: "UI_ANALYZE",
    role: "Inspect UI/browser/screenshot evidence.",
    requiredFields: ["type"],
    optionalFields: [
      "adapter",
      "targetUrl",
      "screenshotPath",
      "server",
      "viewports",
      "checks",
      "fullPage",
      "waitUntil",
      "timeoutSeconds",
    ],
    outputs: ["SUCCESS", "UNAVAILABLE", "ERROR"],
    generationNotes: [
      "Use only when UI/browser/screenshot evidence materially helps the requested flow.",
      "Do not start or restart servers in generated UI_ANALYZE configs unless the user explicitly wants managed server behavior.",
      "Browser UI_ANALYZE results include per-viewport analysis for viewport meta, structure, text density, layout overflow/clipping/overlap, small interaction targets, and computed contrast samples.",
    ],
  },
  GIT_STATUS: {
    type: "GIT_STATUS",
    role: "Collect git status evidence.",
    requiredFields: ["type"],
    optionalFields: ["cwd", "maxOutputBytes"],
    outputs: ["SUCCESS", "ERROR"],
    generationNotes: ["Use for workflows that need dirty-worktree awareness."],
  },
  GIT_SNAPSHOT: {
    type: "GIT_SNAPSHOT",
    role: "Capture git head, status, and diff metadata before a change pass.",
    requiredFields: ["type"],
    optionalFields: ["cwd", "outputPath", "maxOutputBytes"],
    outputs: ["SUCCESS", "ERROR"],
    generationNotes: ["Use before autonomous edits to create a comparable baseline."],
  },
  GIT_DIFF_SUMMARY: {
    type: "GIT_DIFF_SUMMARY",
    role: "Summarize current git changes after a change pass.",
    requiredFields: ["type"],
    optionalFields: ["cwd", "outputPath", "maxOutputBytes"],
    outputs: ["SUCCESS", "EMPTY", "ERROR"],
    generationNotes: ["Use before validation/reporting so final output names actual changed files."],
  },
  DETECT_PROJECT_COMMANDS: {
    type: "DETECT_PROJECT_COMMANDS",
    role: "Inspect common project manifests and infer safe validation commands.",
    requiredFields: ["type"],
    optionalFields: ["rootPath", "cwd", "outputPath"],
    outputs: ["SUCCESS", "EMPTY", "ERROR"],
    generationNotes: [
      "Use to avoid hard-coded package manager or test framework assumptions.",
      "Do not use detected dev/start commands for verification.",
    ],
  },
  SET_VARIABLE: {
    type: "SET_VARIABLE",
    role: "Set a Ralph variable value.",
    requiredFields: ["type", "variableName", "value"],
    optionalFields: [],
    outputs: ["SUCCESS"],
    generationNotes: ["Use to carry deterministic values between blocks."],
  },
  TRANSFORM_JSON: {
    type: "TRANSFORM_JSON",
    role: "Transform JSON-like input with an expression.",
    requiredFields: ["type", "input", "expression"],
    optionalFields: [],
    outputs: ["SUCCESS", "ERROR"],
    generationNotes: ["Use for small structured transformations, not arbitrary code execution."],
  },
  VALIDATE_JSON: {
    type: "VALIDATE_JSON",
    role: "Validate JSON input against a schema.",
    requiredFields: ["type", "input", "schema"],
    optionalFields: [],
    outputs: ["SUCCESS", "INVALID", "ERROR"],
    generationNotes: ["Use when the flow needs deterministic schema validation."],
  },
  FINAL_REPORT: {
    type: "FINAL_REPORT",
    role: "Emit a structured final run report and optional markdown report artifact.",
    requiredFields: ["type"],
    optionalFields: ["path", "outputPath", "markdownPath"],
    outputs: ["SUCCESS", "ERROR"],
    generationNotes: ["Use before terminal success in starter-quality autonomous workflows."],
  },
  NOTIFY: {
    type: "NOTIFY",
    role: "Emit a notification/message at flow runtime.",
    requiredFields: ["type", "message"],
    optionalFields: ["ignoreErrors"],
    outputs: ["SUCCESS"],
    generationNotes: ["Use sparingly for operator-visible checkpoints."],
  },
};

const parseRalphFlowCandidate = (value: unknown): RalphFlow => {
  if (typeof value === "string") {
    return parseRalphFlowJson(value);
  }

  return parseRalphFlowJson(JSON.stringify(value));
};

const normalizeGeneratedRalphFlowCandidate = (
  flow: RalphFlow,
  identity: RalphGeneratedFlowIdentity,
): RalphFlow => {
  const alias = identity.alias ?? flow.alias;

  return normalizeRalphFlowLayout({
    ...flow,
    id: identity.id,
    name: flow.name || identity.name,
    ...(alias ? { alias } : {}),
  });
};

type RalphGenerationJsonSchema = Record<string, unknown>;

const RALPH_GENERATION_STRING_ARRAY_SCHEMA: RalphGenerationJsonSchema = {
  type: "array",
  items: { type: "string" },
};

const RALPH_GENERATION_STRING_RECORD_SCHEMA: RalphGenerationJsonSchema = {
  type: "object",
  additionalProperties: { type: "string" },
};

const RALPH_GENERATION_FREEFORM_RECORD_SCHEMA: RalphGenerationJsonSchema = {
  type: "object",
  additionalProperties: true,
};

const RALPH_GENERATION_POSITION_SCHEMA: RalphGenerationJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    x: { type: "number" },
    y: { type: "number" },
  },
  required: ["x", "y"],
};

const RALPH_GENERATION_SIZE_SCHEMA: RalphGenerationJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    width: { type: "number" },
    height: { type: "number" },
  },
  required: ["width", "height"],
};

const RALPH_GENERATION_FLOW_CANDIDATE_SCHEMA: RalphGenerationJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "number", enum: [RALPH_FLOW_SCHEMA_VERSION] },
    id: { type: "string" },
    alias: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    settings: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxTransitions: { type: "integer" },
      },
      required: [],
    },
    variables: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          type: {
            type: "string",
            enum: [
              "string",
              "text",
              "path",
              "file",
              "files",
              "url",
              "number",
              "boolean",
              "image",
              "images",
              "model",
              "provider",
              "pack",
            ],
          },
          default: { type: "string" },
          required: { type: "boolean" },
        },
        required: ["name", "type", "required"],
      },
    },
    blocks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: RALPH_BLOCK_TYPES },
          title: { type: "string" },
          position: RALPH_GENERATION_POSITION_SCHEMA,
          size: RALPH_GENERATION_SIZE_SCHEMA,
          parentGroupId: { type: "string" },
          groupBoundary: { type: "boolean" },
          settings: {
            type: "object",
            additionalProperties: false,
            properties: {
              workspace: {
                type: "object",
                additionalProperties: false,
                properties: {
                  mode: { type: "string", enum: ["default", "custom"] },
                  path: { type: "string" },
                },
                required: ["mode"],
              },
              provider: { type: "string" },
              model: { type: "string" },
              reasoning: { type: "string" },
              webAccess: { type: "boolean" },
              fileAccess: { type: "boolean" },
              packs: RALPH_GENERATION_STRING_ARRAY_SCHEMA,
              maxIterations: { type: "integer" },
              timeoutSeconds: { type: "number" },
              temperature: { type: "number" },
              internalValidatorEnabled: { type: "boolean" },
              retry: {
                type: "object",
                additionalProperties: false,
                properties: {
                  mode: { type: "string", enum: ["infinite", "finite"] },
                  maxRetries: { type: "integer" },
                  delaySeconds: { type: "number" },
                },
                required: ["mode"],
              },
            },
            required: [],
          },
          prompt: { type: "string" },
          validationScope: {
            type: "object",
            additionalProperties: false,
            properties: {
              mode: {
                type: "string",
                enum: [
                  "sinceLastValidator",
                  "previousBlock",
                  "selectedBlocks",
                  "wholeFlow",
                ],
              },
              blockIds: RALPH_GENERATION_STRING_ARRAY_SCHEMA,
            },
            required: ["mode"],
          },
          labels: RALPH_GENERATION_STRING_ARRAY_SCHEMA,
          packIds: RALPH_GENERATION_STRING_ARRAY_SCHEMA,
          propagationMode: {
            type: "string",
            enum: ["nextBlockOnly", "untilOverridden"],
          },
          fields: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                type: {
                  type: "string",
                  enum: [
                    "text",
                    "textarea",
                    "number",
                    "boolean",
                    "select",
                    "multiselect",
                    "url",
                    "path",
                    "file",
                    "files",
                    "image",
                    "images",
                  ],
                },
                required: { type: "boolean" },
                skippable: { type: "boolean" },
                placeholder: { type: "string" },
                help: { type: "string" },
                defaultValue: {
                  anyOf: [
                    { type: "string" },
                    { type: "number" },
                    { type: "boolean" },
                    RALPH_GENERATION_STRING_ARRAY_SCHEMA,
                    { type: "null" },
                  ],
                },
                options: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      value: { type: "string" },
                      label: { type: "string" },
                    },
                    required: ["value", "label"],
                  },
                },
                validation: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    min: { type: "number" },
                    max: { type: "number" },
                    step: { type: "number" },
                    pattern: { type: "string" },
                    minLength: { type: "integer" },
                    maxLength: { type: "integer" },
                  },
                  required: [],
                },
                variableName: { type: "string" },
              },
              required: ["id", "label", "type"],
            },
          },
          submitLabel: { type: "string" },
          cancelLabel: { type: "string" },
          timeoutSeconds: { anyOf: [{ type: "number" }, { type: "null" }] },
          completionCriteria: { type: "string" },
          maxTurns: { type: "integer" },
          questionsPerTurn: { type: "integer" },
          outputVariableName: { type: "string" },
          utility: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: RALPH_UTILITY_TYPES },
              mode: {
                type: "string",
                enum: ["delay", "until-time", "condition", "poll"],
              },
              delaySeconds: { type: "number" },
              runAt: { type: "string" },
              intervalSeconds: { type: "number" },
              backoffMultiplier: { type: "number" },
              maxAttempts: { anyOf: [{ type: "integer" }, { type: "null" }] },
              condition: RALPH_GENERATION_FREEFORM_RECORD_SCHEMA,
              url: { type: "string" },
              method: { type: "string" },
              headers: RALPH_GENERATION_STRING_RECORD_SCHEMA,
              body: { type: "string" },
              outputPath: { type: "string" },
              markdownPath: { type: "string" },
              path: { type: "string" },
              registryPath: { type: "string" },
              jsonPath: { type: "string" },
              rootPath: { type: "string" },
              content: { type: "string" },
              append: { type: "boolean" },
              encoding: { type: "string" },
              pattern: { type: "string" },
              glob: { type: "string" },
              maxResults: { type: "integer" },
              maxDepth: { type: "integer" },
              excludePaths: { type: "string" },
              flowAlias: { type: "string" },
              strategy: { type: "string" },
              scopeId: { type: "string" },
              taskId: { type: "string" },
              status: { type: "string" },
              result: { type: "string" },
              includeMarkdown: { type: "boolean" },
              forceNew: { type: "boolean" },
              reset: { type: "boolean" },
              jsonPatchMode: { type: "string", enum: ["merge", "replace"] },
              counterName: { type: "string" },
              counterKey: { type: "string" },
              command: { type: "string" },
              fallbackCommand: { type: "string" },
              cwd: { type: "string" },
              env: RALPH_GENERATION_STRING_RECORD_SCHEMA,
              adapter: {
                type: "string",
                enum: ["auto", "browser", "image", "playwright-mcp", "tauri-mcp"],
              },
              targetUrl: { type: "string" },
              screenshotPath: { type: "string" },
              server: RALPH_GENERATION_FREEFORM_RECORD_SCHEMA,
              viewports: {
                type: "array",
                items: RALPH_GENERATION_FREEFORM_RECORD_SCHEMA,
              },
              checks: RALPH_GENERATION_FREEFORM_RECORD_SCHEMA,
              fullPage: { type: "boolean" },
              waitUntil: {
                type: "string",
                enum: ["load", "domcontentloaded", "networkidle", "commit"],
              },
              mcpServerId: { type: "string" },
              mcpToolName: { type: "string" },
              mcpArguments: RALPH_GENERATION_FREEFORM_RECORD_SCHEMA,
              acceptedExitCodes: {
                type: "array",
                items: { type: "integer" },
              },
              maxOutputBytes: { type: "integer" },
              variableName: { type: "string" },
              value: { type: "string" },
              input: { type: "string" },
              baseline: { type: "string" },
              expression: { type: "string" },
              prompt: { type: "string" },
              schema: RALPH_GENERATION_FREEFORM_RECORD_SCHEMA,
              structuredOutput: { type: "boolean" },
              message: { type: "string" },
              ignoreErrors: { type: "boolean" },
            },
            required: ["type"],
          },
          serverId: { type: "string" },
          toolName: { type: "string" },
          uri: { type: "string" },
          promptName: { type: "string" },
          arguments: RALPH_GENERATION_FREEFORM_RECORD_SCHEMA,
          text: { type: "string" },
          tone: {
            type: "string",
            enum: ["slate", "amber", "sky", "lime", "rose", "violet"],
          },
          tags: RALPH_GENERATION_STRING_ARRAY_SCHEMA,
          collapsed: { type: "boolean" },
          pinnedBlockIds: RALPH_GENERATION_STRING_ARRAY_SCHEMA,
          description: { type: "string" },
          childBlockIds: RALPH_GENERATION_STRING_ARRAY_SCHEMA,
          locked: { type: "boolean" },
          moveChildren: { type: "boolean" },
          maxDepth: { type: "integer" },
          layoutMode: { type: "string", enum: ["freeform", "stack", "swimlane"] },
          executionBoundary: {
            type: "object",
            additionalProperties: false,
            properties: {
              mode: {
                type: "string",
                enum: ["none", "firstExecutableChild", "selectedChild"],
              },
              blockId: { type: "string" },
            },
            required: ["mode"],
          },
          status: { type: "string", enum: ["success", "failed", "cancelled", "review"] },
        },
        required: ["id", "type", "title"],
      },
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          from: { type: "string" },
          fromOutput: { type: "string" },
          to: { type: "string" },
        },
        required: ["id", "from", "fromOutput", "to"],
      },
    },
    annotationLinks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          kind: {
            type: "string",
            enum: ["explains", "evidence", "todo", "related", "risk"],
          },
        },
        required: ["id", "from", "to", "kind"],
      },
    },
  },
  required: ["schemaVersion", "id", "name", "blocks", "edges"],
};

const RALPH_GENERATION_FLOW_INPUT_SCHEMA: RalphGenerationJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    flow: RALPH_GENERATION_FLOW_CANDIDATE_SCHEMA,
    flowJson: { type: "string" },
  },
  required: [],
};

const createRalphGenerationToolDefinitions = (
  identity: RalphGeneratedFlowIdentity,
  config: RuntimeConfig,
): AgentToolDefinition[] => {
  const parseToolFlow = (args: Record<string, unknown>): RalphFlow => {
    const rawFlow = args.flow ?? args.flowJson;

    if (rawFlow === undefined) {
      throw new Error("Expected `flow` or `flowJson`.");
    }

    return normalizeGeneratedRalphFlowCandidate(
      parseRalphFlowCandidate(rawFlow),
      identity,
    );
  };

  const createContractToolResult = (
    name: string,
    title: string,
    value: unknown,
  ): Awaited<ReturnType<AgentToolDefinition["execute"]>> => {
    const json = JSON.stringify(value, null, 2);

    return {
      toolResult: {
        callId: randomUUID(),
        name,
        output: json,
      },
      sections: [{ title, audience: "internal", lines: json.split("\n") }],
      traceLines: [`${name} -> returned Ralph generation contract data`],
    };
  };

  return [
    {
      spec: {
        name: "ralph_submit_generation_plan",
        description:
          "Submit a concise Ralph generation plan before the final flow candidate. Use this for non-trivial requests after gathering enough context.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            intent: { type: "string" },
            evidence: {
              type: "array",
              items: { type: "string" },
            },
            selectedNodes: {
              type: "array",
              items: { type: "string" },
            },
            variables: {
              type: "array",
              items: { type: "string" },
            },
            risks: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["intent", "evidence", "selectedNodes", "variables", "risks"],
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      effect: "read",
      execute: async (args) => {
        const intent =
          typeof args.intent === "string" && args.intent.trim()
            ? args.intent.trim()
            : "No intent provided.";
        const coerceLines = (field: string): string[] =>
          Array.isArray(args[field])
            ? args[field].flatMap((entry) =>
                typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
              )
            : [];
        const evidence = coerceLines("evidence");
        const selectedNodes = coerceLines("selectedNodes");
        const variables = coerceLines("variables");
        const risks = coerceLines("risks");
        const lines = [
          `Intent: ${intent}`,
          "Evidence:",
          ...(evidence.length > 0 ? evidence : ["none"]),
          "Selected nodes:",
          ...(selectedNodes.length > 0 ? selectedNodes : ["none"]),
          "Variables:",
          ...(variables.length > 0 ? variables : ["none"]),
          "Risks:",
          ...(risks.length > 0 ? risks : ["none"]),
        ];

        return {
          toolResult: {
            callId: randomUUID(),
            name: "ralph_submit_generation_plan",
            output: lines.join("\n"),
          },
          sections: [
            {
              title: "Ralph generation plan",
              audience: "internal",
              lines,
            },
          ],
          traceLines: ["ralph_submit_generation_plan -> recorded plan"],
        };
      },
    },
    {
      spec: {
        name: "ralph_list_node_types",
        description: "List Ralph graph node types and short generation contracts.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
          required: [],
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      effect: "read",
      execute: async () =>
        createContractToolResult("ralph_list_node_types", "Ralph node types", {
          blockTypes: RALPH_BLOCK_TYPES,
          contracts: RALPH_BLOCK_TYPES.map((type) => ({
            type,
            role: RALPH_GENERATION_BLOCK_CONTRACTS[type].role,
            outputs: RALPH_GENERATION_BLOCK_CONTRACTS[type].outputs,
          })),
        }),
    },
    {
      spec: {
        name: "ralph_get_node_contract",
        description: "Get the full generation contract for one Ralph node type.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            blockType: {
              type: "string",
              enum: RALPH_BLOCK_TYPES,
            },
          },
          required: ["blockType"],
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      effect: "read",
      execute: async (args) => {
        const blockType = args.blockType;

        if (
          typeof blockType !== "string" ||
          !RALPH_BLOCK_TYPES.includes(blockType as RalphBlockType)
        ) {
          return createToolErrorResult(
            randomUUID(),
            "ralph_get_node_contract",
            "Expected `blockType` to be a Ralph block type.",
          );
        }

        return createContractToolResult(
          "ralph_get_node_contract",
          "Ralph node contract",
          RALPH_GENERATION_BLOCK_CONTRACTS[blockType as RalphBlockType],
        );
      },
    },
    {
      spec: {
        name: "ralph_list_utility_types",
        description: "List Ralph UTILITY types and short generation contracts.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
          required: [],
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      effect: "read",
      execute: async () =>
        createContractToolResult("ralph_list_utility_types", "Ralph utility types", {
          utilityTypes: RALPH_UTILITY_TYPES,
          contracts: RALPH_UTILITY_TYPES.map((type) => ({
            type,
            role: RALPH_GENERATION_UTILITY_CONTRACTS[type].role,
            outputs: RALPH_GENERATION_UTILITY_CONTRACTS[type].outputs,
          })),
        }),
    },
    {
      spec: {
        name: "ralph_get_utility_contract",
        description: "Get the full generation contract for one Ralph UTILITY type.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            utilityType: {
              type: "string",
              enum: RALPH_UTILITY_TYPES,
            },
          },
          required: ["utilityType"],
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      effect: "read",
      execute: async (args) => {
        const utilityType = args.utilityType;

        if (
          typeof utilityType !== "string" ||
          !RALPH_UTILITY_TYPES.includes(utilityType as RalphUtilityType)
        ) {
          return createToolErrorResult(
            randomUUID(),
            "ralph_get_utility_contract",
            "Expected `utilityType` to be a Ralph utility type.",
          );
        }

        return createContractToolResult(
          "ralph_get_utility_contract",
          "Ralph utility contract",
          RALPH_GENERATION_UTILITY_CONTRACTS[utilityType as RalphUtilityType],
        );
      },
    },
    {
      spec: {
        name: "ralph_validate_candidate_flow",
        description:
          "Validate a complete Ralph flow candidate without persisting it. Use this after drafting the graph and before final submission when you want schema errors, structural issues, visual-block warnings, block count, and edge count. Provide either `flow` as structured JSON or `flowJson` as a string when the candidate needs free-form nested JSON that is awkward for tool arguments.",
        inputSchema: RALPH_GENERATION_FLOW_INPUT_SCHEMA,
      },
      backingTool: "utilities",
      riskLevel: "low",
      effect: "read",
      execute: async (args) => {
        try {
          const flow = parseToolFlow(args);
          const validation = validateRalphFlow(flow, { config });
          const structureValidation = validateGeneratedRalphFlowStructure(flow);
          const summary = {
            valid: validation.valid && structureValidation.decision === "DONE",
            schemaErrors: validation.errors,
            schemaWarnings: validation.warnings,
            structuralIssues: structureValidation.issues,
            qualityWarnings: structureValidation.warnings,
            blockCount: flow.blocks.length,
            edgeCount: flow.edges.length,
          };
          const json = JSON.stringify(summary, null, 2);

          return {
            toolResult: {
              callId: randomUUID(),
              name: "ralph_validate_candidate_flow",
              output: json,
              ...(summary.valid ? {} : { isError: true }),
            },
            sections: [{ title: "Ralph candidate validation", audience: "internal", lines: json.split("\n") }],
            traceLines: [
              `ralph_validate_candidate_flow -> ${summary.valid ? "valid" : "invalid"} (${flow.blocks.length} blocks, ${flow.edges.length} edges)`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            randomUUID(),
            "ralph_validate_candidate_flow",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      spec: {
        name: "ralph_normalize_layout",
        description:
          "Normalize a complete Ralph flow candidate layout and identity without persisting it. Use this when graph positions, group bounds, or generated flow identity may be inconsistent; it returns the normalized flow JSON for the next validation or submission call.",
        inputSchema: RALPH_GENERATION_FLOW_INPUT_SCHEMA,
      },
      backingTool: "utilities",
      riskLevel: "low",
      effect: "read",
      execute: async (args) => {
        try {
          const flow = parseToolFlow(args);
          const json = JSON.stringify(flow, null, 2);

          return {
            toolResult: {
              callId: randomUUID(),
              name: "ralph_normalize_layout",
              output: json,
            },
            sections: [{ title: "Normalized Ralph candidate", audience: "internal", lines: json.split("\n") }],
            traceLines: [
              `ralph_normalize_layout -> normalized ${flow.blocks.length} blocks and ${flow.edges.length} edges`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            randomUUID(),
            "ralph_normalize_layout",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      spec: {
        name: "ralph_submit_flow_candidate",
        description:
          "Submit the complete final Ralph flow candidate. This does not persist the flow directly; Ralph validates and persists it after the model run. Use this once the graph is complete and candidate validation has no blocking errors. Prefer `flow` for ordinary candidates; use `flowJson` only when complex nested utility or MCP arguments are easier to represent as a JSON string.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            flow: RALPH_GENERATION_FLOW_CANDIDATE_SCHEMA,
            flowJson: { type: "string" },
            rationale: { type: "string" },
            evidence: {
              type: "array",
              items: { type: "string" },
            },
            assumptions: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["rationale", "evidence", "assumptions"],
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      effect: "read",
      execute: async (args) => {
        try {
          const flow = parseToolFlow(args);
          const validation = validateRalphFlow(flow, { config });
          const structureValidation = validateGeneratedRalphFlowStructure(flow);

          if (!validation.valid || structureValidation.decision !== "DONE") {
            return createToolErrorResult(
              randomUUID(),
              "ralph_submit_flow_candidate",
              [
                "The submitted Ralph flow candidate is invalid.",
                ...validation.errors,
                ...structureValidation.issues,
              ].join("\n"),
            );
          }

          const json = JSON.stringify(flow, null, 2);
          const evidence = Array.isArray(args.evidence)
            ? args.evidence.flatMap((entry) =>
                typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
              )
            : [];
          const assumptions = Array.isArray(args.assumptions)
            ? args.assumptions.flatMap((entry) =>
                typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
              )
            : [];
          const rationale =
            typeof args.rationale === "string" && args.rationale.trim()
              ? args.rationale.trim()
              : "No rationale provided.";

          return {
            toolResult: {
              callId: randomUUID(),
              name: "ralph_submit_flow_candidate",
              output: [
                "Submitted valid Ralph flow candidate.",
                `<ralph_flow_json>\n${json}\n</ralph_flow_json>`,
              ].join("\n"),
            },
            sections: [
              {
                title: "Ralph generation rationale",
                audience: "internal",
                lines: [
                  rationale,
                  ...(evidence.length > 0 ? ["", "Evidence:", ...evidence] : []),
                  ...(assumptions.length > 0
                    ? ["", "Assumptions:", ...assumptions]
                    : []),
                ],
              },
              {
                title: "Submitted Ralph flow candidate",
                audience: "internal",
                lines: ["<ralph_flow_json>", ...json.split("\n"), "</ralph_flow_json>"],
              },
            ],
            traceLines: [
              `ralph_submit_flow_candidate -> valid (${flow.blocks.length} blocks, ${flow.edges.length} edges)`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            randomUUID(),
            "ralph_submit_flow_candidate",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
  ];
};

const createRalphGenerationInterviewToolDefinitions =
  (): AgentToolDefinition[] => [
    {
      spec: {
        name: "ralph_submit_generation_interview_round",
        description:
          "Submit the current Ralph generation interview decision. Ask typed questions only when more information would materially improve the generated flow or prompt block; otherwise mark complete.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            complete: { type: "boolean" },
            summary: { type: "string" },
            questionScope: { type: "string" },
            contextSummary: { type: "string" },
            findings: RALPH_GENERATION_STRING_ARRAY_SCHEMA,
            assumptions: RALPH_GENERATION_STRING_ARRAY_SCHEMA,
            relevantFiles: RALPH_GENERATION_STRING_ARRAY_SCHEMA,
            questions: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string" },
                  label: { type: "string" },
                  question: { type: "string" },
                  type: {
                    type: "string",
                    enum: RALPH_GENERATION_INTERVIEW_INPUT_TYPES,
                  },
                  required: { type: "boolean" },
                  skippable: { type: "boolean" },
                  placeholder: { type: "string" },
                  help: { type: "string" },
                  variableName: { type: "string" },
                  defaultValue: {},
                  options: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        value: { type: "string" },
                        label: { type: "string" },
                      },
                      required: ["value", "label"],
                    },
                  },
                  validation: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      min: { type: "number" },
                      max: { type: "number" },
                      step: { type: "number" },
                      pattern: { type: "string" },
                      minLength: { type: "number" },
                      maxLength: { type: "number" },
                    },
                    required: [],
                  },
                },
                required: ["label", "type"],
              },
            },
          },
          required: [
            "complete",
            "summary",
            "contextSummary",
            "findings",
            "assumptions",
            "relevantFiles",
            "questions",
          ],
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      effect: "read",
      execute: async (args) => {
        const json = JSON.stringify(args, null, 2);

        return {
          toolResult: {
            callId: randomUUID(),
            name: "ralph_submit_generation_interview_round",
            output: json,
          },
          sections: [
            {
              title: RALPH_GENERATION_INTERVIEW_SECTION_TITLE,
              audience: "internal",
              lines: json.split("\n"),
            },
          ],
          traceLines: [
            "ralph_submit_generation_interview_round -> returned interview contract",
          ],
        };
      },
    },
  ];

const createRalphGenerationInterviewSession = (
  options: RalphGenerationInterviewOptions,
  scope: RalphFlowScope,
  maxTurns: number,
): RalphGenerationInterviewSession => {
  if (options.session) {
    return {
      ...options.session,
      prompt: options.session.prompt || options.prompt,
      scope,
      target: options.target ?? options.session.target ?? "flow",
      maxTurns,
      turn: Math.min(Math.max(options.session.turn, 0), maxTurns),
      findings: options.session.findings ?? [],
      assumptions: options.session.assumptions ?? [],
      relevantFiles: options.session.relevantFiles ?? [],
      transcript: options.session.transcript ?? [],
    };
  }

  return {
    id: options.runId ?? `ralph-generation-interview-${randomUUID()}`,
    prompt: options.prompt,
    scope,
    target: options.target ?? "flow",
    turn: 0,
    maxTurns,
    findings: [],
    assumptions: [],
    relevantFiles: [],
    transcript: [],
  };
};

const applyRalphGenerationInterviewAnswers = (
  session: RalphGenerationInterviewSession,
  answers: Record<string, RalphInputValue> | undefined,
  answerComments: Record<string, string> | undefined,
): RalphGenerationInterviewSession => {
  const hasAnswerComments = Object.values(answerComments ?? {}).some(
    (comment) => comment.trim().length > 0,
  );

  if ((!answers && !hasAnswerComments) || session.transcript.length === 0) {
    return session;
  }

  const latestTurn = session.transcript[session.transcript.length - 1];

  if (!latestTurn || latestTurn.answers.length > 0) {
    return session;
  }

  const answerList: RalphGenerationInterviewAnswer[] = latestTurn.questions.map(
    (field) => {
      const comment = answerComments?.[field.id]?.trim();

      return {
        fieldId: field.id,
        label: field.label,
        type: field.type,
        value: answers?.[field.id] ?? null,
        ...(comment ? { comment } : {}),
      };
    },
  );

  return {
    ...session,
    transcript: [
      ...session.transcript.slice(0, -1),
      {
        ...latestTurn,
        answers: answerList,
        answeredAt: createLogTimestamp(),
      },
    ],
  };
};

const formatRalphGenerationInterviewValue = (
  value: RalphInputValue,
): string => {
  if (value === null) {
    return "Skipped";
  }

  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "Skipped";
  }

  return String(value);
};

const formatRalphGenerationInterviewTranscript = (
  session: RalphGenerationInterviewSession,
): string[] => {
  if (session.transcript.length === 0) {
    return ["No previous interview turns."];
  }

  return session.transcript.flatMap((turn) => [
    `Turn ${turn.turn}:`,
    ...(turn.questionScope ? [`Question scope: ${turn.questionScope}`] : []),
    ...(turn.summary ? [`Summary: ${turn.summary}`] : []),
    ...turn.questions.map((field) => `Question: ${field.label} (${field.type})`),
    ...(turn.answers.length > 0
      ? turn.answers.flatMap((answer) => [
          `Answer: ${answer.label} = ${formatRalphGenerationInterviewValue(answer.value)}`,
          ...(answer.comment
            ? [`Answer comment for ${answer.label}: ${answer.comment}`]
            : []),
        ])
      : ["Answers: pending"]
    ),
    "",
  ]);
};

const createRalphGenerationInterviewSystemPrompt = (): string => {
  return [
    "<ralph_generation_interviewer_contract>",
    "You are Ralph Generation Interviewer. Your job is to improve context before Ralph flow generation.",
    "Inspect requirements and, when useful, read relevant workspace files, package metadata, configuration, existing Ralph flows, or MCP/tool capability data using only read-only tools.",
    "When the prompt references external context such as a Linear issue, first use read-only MCP catalog/discovery/resource tools or mcp_call_readonly_tool to gather the details if available, then ask questions based on the gathered context.",
    "Do not edit files, start servers, run destructive commands, mutate external systems, or perform broad scans unrelated to the request.",
    "Ask questions only when the answer would materially change the generated flow, improve an existing flow, or improve the selected prompt block.",
    "Ask multiple concise questions in one round when useful. Use rich field types: select, multiselect, number, boolean, text, textarea, url, path, file, files, image, or images.",
    "When asking questions, optionally set questionScope to a short group name such as \"UI Questions\", \"Data Inputs\", or \"Deployment\".",
    "For every question, set help to one short reason phrase explaining why the answer matters. Keep help under 140 characters; do not write paragraphs.",
    "For string answers that need a format, include validation.pattern. For numbers, include min, max, or step when helpful.",
    "Keep questions skippable unless missing information would block correctness.",
    `Never exceed ${MAX_RALPH_GENERATION_INTERVIEW_MAX_TURNS} question rounds. If enough context is available, mark complete and summarize the generation-ready requirements.`,
    "Return the contract by calling ralph_submit_generation_interview_round. If tool calling is unavailable, return only JSON inside <ralph_generation_interview> tags with the same fields.",
    "</ralph_generation_interviewer_contract>",
  ].join("\n");
};

const createRalphGenerationInterviewTask = (
  workspaceRoot: string,
  options: RalphGenerationInterviewOptions,
  session: RalphGenerationInterviewSession,
  nextTurn: number,
): string => {
  const existingFlowJson = options.existingFlow
    ? JSON.stringify(sanitizeTraceValue(options.existingFlow), null, 2)
    : "";
  const cappedExistingFlowJson =
    existingFlowJson.length > 30_000
      ? `${existingFlowJson.slice(0, 30_000)}\n...truncated...`
      : existingFlowJson;

  return [
    "Prepare the next Ralph generation interview step.",
    "",
    `Workspace root: ${workspaceRoot}`,
    `Scope: ${session.scope}`,
    `Target: ${session.target}`,
    ...(options.name ? [`Flow name/alias: ${options.name}`] : []),
    `Interview turn to prepare: ${nextTurn} of ${session.maxTurns}`,
    "",
    "Original generation request:",
    session.prompt,
    "",
    "Accumulated context summary:",
    session.contextSummary ?? "None yet.",
    "",
    "Findings:",
    ...(session.findings.length > 0 ? session.findings : ["None yet."]),
    "",
    "Assumptions:",
    ...(session.assumptions.length > 0 ? session.assumptions : ["None yet."]),
    "",
    "Relevant files:",
    ...(session.relevantFiles.length > 0 ? session.relevantFiles : ["None yet."]),
    "",
    "Interview transcript so far:",
    ...formatRalphGenerationInterviewTranscript(session),
    ...(cappedExistingFlowJson
      ? [
          "",
          "Current Ralph flow JSON:",
          "```json",
          cappedExistingFlowJson,
          "```",
        ]
      : []),
    "",
    "Decide whether to complete the interview or ask the next round.",
    "If asking questions, return no more than 6 fields and make each field useful for the final generation.",
    "If complete, include a summary that can be used directly by the generator.",
  ].join("\n");
};

const createRalphGenerationPromptFromInterview = (
  session: RalphGenerationInterviewSession,
  finalSummary?: string,
): string => [
  session.prompt,
  "",
  "Interview context for generation:",
  finalSummary ?? session.finalSummary ?? session.contextSummary ?? "No final summary.",
  "",
  "Findings:",
  ...(session.findings.length > 0 ? session.findings.map((entry) => `- ${entry}`) : ["- None"]),
  "",
  "Assumptions:",
  ...(session.assumptions.length > 0
    ? session.assumptions.map((entry) => `- ${entry}`)
    : ["- None"]),
  "",
  "Relevant files/config:",
  ...(session.relevantFiles.length > 0
    ? session.relevantFiles.map((entry) => `- ${entry}`)
    : ["- None"]),
  "",
  "Interview answers:",
  ...session.transcript.flatMap((turn) => [
    turn.questionScope ? `${turn.questionScope}:` : `Turn ${turn.turn}:`,
    ...turn.answers.map(
      (answer) =>
        [
          `- ${answer.label}: ${formatRalphGenerationInterviewValue(answer.value)}`,
          ...(answer.comment ? [`  Comment: ${answer.comment}`] : []),
        ].join("\n"),
    ),
    ...(turn.answers.length === 0 ? ["- No answers collected."] : []),
  ]),
].join("\n");

const createRalphGeneratorSystemPrompt = (): string => {
  return [
    "<ralph_generator_contract>",
    "You are Ralph Flow Generator, a specialized agent that designs executable Ralph flow graphs.",
    "Generate flows from the user's intent in any language. Do not rely on keyword matching or canned phrase triggers.",
    "Think through the requested workflow, inspect workspace context with read-only tools when it materially affects a workspace flow, and use Ralph-specific tools to check node and utility contracts when uncertain.",
    "Use the flow id and alias supplied by Ralph; do not invent or reuse identity values from other flows.",
    "Prefer a compact graph with meaningful block titles, stable kebab-case ids, explicit routes, and readable positions.",
    "Omit NOTE and GROUP blocks by default. Add zero, one, or multiple visual blocks only when they materially improve readability for a complex graph; never route execution through them.",
    "Set settings.maxTransitions on any cyclic graph.",
    "Use UI_ANALYZE, MCP blocks, package checks, and command utilities only when they materially help satisfy the requested workflow.",
    "For non-trivial requests, call ralph_submit_generation_plan before submitting the final flow candidate.",
    "Call ralph_validate_candidate_flow or ralph_submit_flow_candidate with the complete flow before your final response.",
    "After ralph_submit_flow_candidate succeeds, call submit_final_response with a short completion message. Do not paste the full JSON into the final response.",
    "</ralph_generator_contract>",
  ].join("\n");
};

const createFlowGenerationTask = (
  flowPath: string,
  id: string,
  alias: string | undefined,
  name: string,
  prompt: string,
  target: RalphFlowGenerationOptions["target"],
  mode: RalphFlowGenerationOptions["mode"],
  scope: RalphFlowScope,
  existingFlow: RalphFlow | undefined,
  validatorFeedback: string | undefined,
  workspaceHints: string,
): string => {
  return [
    "Create or update a Ralph flow graph.",
    "",
    "Ralph will persist the finished flow locally after parsing your response.",
    "Target workspace path:",
    flowPath,
    "",
    "Output contract:",
    "- Preferred: call ralph_submit_flow_candidate with one complete Ralph flow candidate plus rationale, evidence, and assumptions. Use either the structured flow argument or flowJson.",
    "- If tool calls are unavailable, return one complete Ralph flow JSON object wrapped in <ralph_flow_json>...</ralph_flow_json> tags.",
    "- Do not include comments, trailing commas, or explanatory prose inside fallback JSON tags.",
    "- Do not write files yourself; Ralph validates and writes the parsed JSON locally.",
    "- After a successful ralph_submit_flow_candidate tool call, finish with submit_final_response and do not paste the full JSON into that final response.",
    "",
    "Ralph flow requirements:",
    "- Use graph blocks: START, PROMPT, VALIDATOR, DECISION, PACK, UTILITY, NOTE, GROUP, END.",
    "- Use the exact top-level id and alias shown in the minimal schema example. Ralph owns generated flow identity and may repair aliases for uniqueness.",
    "- Use exactly one START block and one or more END blocks.",
    "- Visual organization policy: omit NOTE and GROUP blocks by default. Add them only when the graph is complex enough that annotations or containers materially improve readability. A generated flow may have zero, one, or multiple NOTE/GROUP blocks depending on the request. Put visible note body text in NOTE.text. Use parentGroupId on executable blocks or GROUP.childBlockIds to describe group membership; Ralph normalizes group bounds around those children.",
    "- Normal PROMPT blocks route with SUCCESS and ERROR; they do not need RALPH_DECISION markers.",
    "- VALIDATOR blocks must end with RALPH_DECISION: DONE, CONTINUE, RETRY, or ERROR.",
    "- VALIDATOR.CONTINUE needs an explicit edge.",
    "- VALIDATOR.RETRY may omit an edge; Ralph falls back to the validator group start.",
    "- DECISION blocks must define labels and end with RALPH_DECISION: <LABEL>.",
    "- UTILITY blocks usually run deterministic operations without an LLM. PROMPT_JSON is the explicit exception and must be used only when structured AI output is genuinely needed. Available utility.type values come from the utilityTypes contract list.",
    "- Use utility outputs exactly as produced: WAIT/SET_VARIABLE/NOTIFY use SUCCESS only; HTTP_FETCH uses SUCCESS, HTTP_ERROR, TIMEOUT, ERROR; POLL uses SUCCESS, ERROR, and TIMEOUT when maxAttempts is finite; CONDITION uses MATCH, NO_MATCH, ERROR; RUN_CHECK uses SUCCESS, FAILED, ERROR; UI_ANALYZE uses SUCCESS, UNAVAILABLE, ERROR; FILE_EXISTS uses EXISTS, MISSING, ERROR; DELETE_FILE/MOVE_FILE/ARCHIVE_FILE use SUCCESS, NOT_FOUND, ERROR; READ_JSON uses SUCCESS, NOT_FOUND, INVALID, ERROR; READ_JSONL/QUERY_JSONL use SUCCESS, EMPTY, NOT_FOUND, INVALID, ERROR; WRITE_JSON/APPEND_JSONL/PROMPT_JSON/VALIDATE_JSON use SUCCESS, INVALID, ERROR; PATCH_JSON uses SUCCESS, NOT_FOUND, INVALID, ERROR; VALIDATOR_JSON uses DONE, CONTINUE, RETRY, ERROR, INVALID; SELECT_JSON_TASK uses SELECTED, EMPTY, NOT_FOUND, INVALID, ERROR; MARK_JSON_TASK uses SUCCESS, NOT_FOUND, INVALID, ERROR; CHANGE_SCOPE_GUARD uses IN_SCOPE, OUT_OF_SCOPE, EMPTY, ERROR, but OUT_OF_SCOPE requires enforce=true; LOOP_COUNTER uses CONTINUE, LIMIT_REACHED, ERROR; SCAN_SCOPE_EVIDENCE, UPDATE_SCOPE_REGISTRY, SEARCH_FILES, GIT_DIFF_SUMMARY, and DETECT_PROJECT_COMMANDS use SUCCESS, EMPTY, ERROR; SELECT_SCOPE uses SELECTED, EMPTY, ERROR; MARK_SCOPE_RESULT uses SUCCESS, NOT_FOUND, ERROR.",
    "- Add variables directly in prompts using {{name:type=default}}, for example {{scope:path=ALL}}.",
    "- Use block result placeholders such as {{lastResult}}, {{summary:block-id}}, and {{result:block-id}} where useful.",
    "- Use structured utility data placeholders such as {{data:block-id:path.to.value}} where useful.",
    "- Set settings.maxTransitions on flows with cycles.",
    "- Keep generated flows compact: prefer one useful loop with meaningful nodes, and combine related steps when that keeps the graph readable.",
    "- Decide from the user's request, in whichever language it uses, whether UI/browser/screenshot evidence is relevant. Use UI_ANALYZE only when it materially helps satisfy that request; do not add UI_ANALYZE just to satisfy validation.",
    "- UI_ANALYZE must not start or restart servers. Use server.mode=existing with a healthUrl/targetUrl for already-running apps, or server.mode=none for screenshots/static evidence.",
    "- If the request needs evidence that is not directly available, expose variables such as {{targetUrl:url=}}, {{screenshotPath:path=}}, or {{visualEvidence:text=}} and fall back to deterministic code-level checks.",
    "- Do not use PACK blocks or block settings.packs unless the workspace hints list available packs; pack ids are metadata-only without backing context injection.",
    "- Use package-manager-aware commands from the workspace hints. Do not default to npm when another package manager is detected.",
    "- For SEARCH_FILES, use rootPath for the narrowest source root that fits the request and set pattern or glob as a single string; avoid scanning the workspace root when possible.",
    "- For repository-wide coverage, use SCAN_SCOPE_EVIDENCE -> UPDATE_SCOPE_REGISTRY -> SELECT_SCOPE -> focused work -> MARK_SCOPE_RESULT instead of a prompt-only SCOPE=ALL convention.",
    "- Keep block ids stable kebab-case.",
    "- Store graph positions so the canvas is readable.",
    "- Use Ralph-specific tools for node contracts, utility contracts, candidate validation, layout normalization, and structured candidate submission.",
    "- Use tools only when they materially reduce uncertainty. For simple self-contained requests, produce the flow directly from this prompt.",
    "- If needed, inspect workspace files or run short read-only commands to understand local conventions.",
    "- Do not write files, modify code, start or restart servers, install packages, run long-running commands, or perform broad verification yourself. Ralph performs parsing, validation, and persistence after your response.",
    "",
    `Generation target: ${target ?? "flow"}.`,
    `Generation mode: ${mode ?? "do-it"}.`,
    `Generation scope: ${scope}.`,
    "",
    workspaceHints,
    "",
    target === "prompt-block"
      ? "- Add or improve one focused PROMPT block in the existing graph, including routes needed to make it reachable and useful."
      : undefined,
    target === "refactor"
      ? "- Refactor or improve the existing graph while preserving its intent, ids, variables, and useful routes unless the user asks to change them."
      : undefined,
    mode === "interview"
      ? "- If the request is underspecified, prefer variables with defaults and validator/decision blocks that make assumptions explicit in the graph."
      : undefined,
    "",
    "Minimal schema example:",
    "This example is intentionally small and has no NOTE or GROUP blocks. Do not copy its block ids or shape unless they fit the request; choose request-specific ids and nodes.",
    JSON.stringify(
      {
        schemaVersion: RALPH_FLOW_SCHEMA_VERSION,
        id,
        ...(alias ? { alias } : {}),
        name,
        description: "Short description",
        settings: { maxTransitions: 30 },
        blocks: [
          { id: "start", type: "START", title: "Start", position: { x: 0, y: 0 } },
          {
            id: "main-task",
            type: "PROMPT",
            title: "Main Task",
            prompt: "Do the requested work for {{scope:path=ALL}}.",
            settings: {
              workspace: { mode: "default" },
              reasoning: "default",
              maxIterations: 1,
            },
            position: { x: 260, y: 0 },
          },
          {
            id: "review-result",
            type: "VALIDATOR",
            title: "Review Result",
            prompt:
              "Validate the completed work for {{scope:path=ALL}}. End with RALPH_DECISION: DONE, CONTINUE, RETRY, or ERROR.",
            validationScope: { mode: "sinceLastValidator" },
            position: { x: 520, y: 0 },
          },
          {
            id: "success",
            type: "END",
            title: "Success",
            status: "success",
            position: { x: 780, y: 0 },
          },
        ],
        edges: [
          { id: "start-to-main-task", from: "start", fromOutput: "SUCCESS", to: "main-task" },
          { id: "main-task-to-review", from: "main-task", fromOutput: "SUCCESS", to: "review-result" },
          { id: "review-done", from: "review-result", fromOutput: "DONE", to: "success" },
          { id: "review-continue", from: "review-result", fromOutput: "CONTINUE", to: "main-task" },
        ],
      },
      null,
      2,
    ),
    "",
    existingFlow
      ? `<existing_flow>\n${JSON.stringify(existingFlow, null, 2)}\n</existing_flow>`
      : undefined,
    validatorFeedback
      ? `<validator_feedback>\n${validatorFeedback}\n</validator_feedback>`
      : undefined,
    "<user_request>",
    prompt,
    "</user_request>",
    "",
    "Before submitting the final response, validate the graph against the rules above.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
};

const UI_VERIFICATION_SCRIPT_PRIORITY = [
  "typecheck:ui",
  "build:ui",
  "test:ui",
  "lint",
  "typecheck",
  "build",
] as const;

const parsePackageManagerName = (value: string | undefined): string => {
  const normalized = value?.trim();

  if (!normalized) {
    return "npm";
  }

  const atIndex = normalized.indexOf("@");

  return atIndex > 0 ? normalized.slice(0, atIndex) : normalized;
};

const createPackageScriptCommand = (
  packageManager: string,
  scriptName: string,
): string => {
  if (packageManager === "npm") {
    return `npm run ${scriptName}`;
  }

  if (packageManager === "bun") {
    return `bun run ${scriptName}`;
  }

  return `${packageManager} ${scriptName}`;
};

const createPackageVerificationHints = async (
  workspaceRoot: string,
): Promise<string[]> => {
  const packageJsonPath = join(workspaceRoot, "package.json");

  if (!existsSync(packageJsonPath)) {
    return [
      "- No package.json was found; generated flows should keep verification commands configurable.",
    ];
  }

  try {
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;

    if (!isRecord(parsed)) {
      return ["- package.json is not an object; keep verification commands configurable."];
    }

    const scripts = isRecord(parsed.scripts) ? parsed.scripts : {};
    const scriptNames = Object.keys(scripts).filter(
      (scriptName) => typeof scripts[scriptName] === "string",
    );
    const packageManager = parsePackageManagerName(
      typeof parsed.packageManager === "string" ? parsed.packageManager : undefined,
    );
    const recommendedScripts = UI_VERIFICATION_SCRIPT_PRIORITY.filter((scriptName) =>
      scriptNames.includes(scriptName),
    );
    const recommendedCommands = recommendedScripts.map((scriptName) =>
      createPackageScriptCommand(packageManager, scriptName),
    );

    return [
      `- Detected package manager: ${packageManager}.`,
      scriptNames.length > 0
        ? `- Detected package scripts: ${scriptNames.sort().join(", ")}.`
        : "- package.json has no scripts.",
      recommendedCommands.length > 0
        ? `- Prefer verification commands in this order: ${recommendedCommands.join(" && ")}.`
        : "- No obvious verification scripts were found; use configurable RUN_CHECK commands.",
    ];
  } catch (error) {
    return [
      `- package.json could not be inspected: ${error instanceof Error ? error.message : String(error)}.`,
    ];
  }
};

const formatMcpDescription = (description: string | undefined): string => {
  const normalizedDescription = description?.replace(/\s+/gu, " ").trim();

  if (!normalizedDescription) {
    return "";
  }

  return normalizedDescription.length > 160
    ? ` (${normalizedDescription.slice(0, 157)}...)`
    : ` (${normalizedDescription})`;
};

const createMcpCapabilityHints = (workspaceRoot: string): string[] => {
  try {
    const config = loadMcpConfigSync(workspaceRoot);
    const discoveryCache = loadMcpDiscoveryCacheSync(workspaceRoot);
    const lines: string[] = [];

    for (const server of config.servers.filter((candidate) => candidate.enabled)) {
      const discovery = discoveryCache.servers[server.id];

      if (!discovery) {
        lines.push(
          `- MCP server ${server.id} is enabled, but no cached discovery is available.`,
        );
        continue;
      }

      for (const tool of discovery.tools) {
        lines.push(
          `- MCP_TOOL candidate: serverId=${server.id}, toolName=${tool.name}${formatMcpDescription(tool.description)}`,
        );
      }

      for (const resource of discovery.resources) {
        lines.push(
          `- MCP_RESOURCE candidate: serverId=${server.id}, uri=${resource.uri}${formatMcpDescription(resource.description)}`,
        );
      }

      for (const resourceTemplate of discovery.resourceTemplates) {
        lines.push(
          `- MCP_RESOURCE_TEMPLATE candidate: serverId=${server.id}, uriTemplate=${resourceTemplate.uriTemplate}${formatMcpDescription(resourceTemplate.description)}`,
        );
      }

      for (const prompt of discovery.prompts) {
        lines.push(
          `- MCP_PROMPT candidate: serverId=${server.id}, promptName=${prompt.name}${formatMcpDescription(prompt.description)}`,
        );
      }
    }

    return lines.length > 0
      ? lines.slice(0, 24)
      : ["- No discovered MCP capabilities were found."];
  } catch (error) {
    return [
      `- MCP capability hints unavailable: ${error instanceof Error ? error.message : String(error)}.`,
    ];
  }
};

const createFlowGenerationWorkspaceHints = async (
  workspaceRoot: string,
): Promise<string> => {
  const packageHints = await createPackageVerificationHints(workspaceRoot);
  const mcpHints = createMcpCapabilityHints(workspaceRoot);

  return [
    "Workspace-specific generation hints:",
    "",
    "Verification commands:",
    ...packageHints,
    "",
    "Available MCP capabilities:",
    ...mcpHints,
    "Use these capabilities only when they materially help satisfy the user's request.",
  ].join("\n");
};

const createBlockedGenerationResult = (
  flowPath: string,
  validation: RalphValidationResult,
  summary?: string,
): RalphFlowGenerationResult => {
  return {
    status: "blocked",
    flowPath,
    rounds: 0,
    validation,
    events: [],
    generatorResults: [],
    validatorResults: [],
    summary: summary ?? validation.errors[0] ?? "Invalid Ralph flow generation options.",
  };
};

type EmitRalphGenerationEvent = (
  event: Omit<RalphGenerationEvent, "generationRunId" | "createdAt">,
) => Promise<void>;

const createGenerationActorRuntimeConfig = (
  config: RuntimeConfig,
  actor: RalphGenerationActor,
): RuntimeConfig => {
  if (actor !== "generator") {
    return config;
  }

  return {
    ...config,
    mode: "ask",
    reasoning: config.reasoning === "default" ? "medium" : config.reasoning,
  };
};

const createGenerationAttemptConfigs = (
  config: RuntimeConfig,
): RuntimeConfig[] => [config];

interface RalphGenerationActorTracePaths {
  flowPath: string;
  generationFlowPath: string;
}

interface RalphGenerationAgentRuntime {
  systemPromptSections: string[];
  toolDefinitions: AgentToolDefinition[];
}

const executeGenerationActorWithFallback = async (
  actor: "generator" | "validator",
  task: string,
  customizations: CustomizationDiscoveryResult,
  options: RalphFlowGenerationOptions,
  attemptConfigs: readonly RuntimeConfig[],
  results: TaskExecutionResult[],
  round: number,
  maxRounds: number,
  emitGenerationEvent: EmitRalphGenerationEvent,
  paths: RalphGenerationActorTracePaths,
  agentRuntime?: RalphGenerationAgentRuntime,
): Promise<TaskExecutionResult> => {
  for (let attemptIndex = 0; attemptIndex < attemptConfigs.length; attemptIndex += 1) {
    const attemptConfig = attemptConfigs[attemptIndex];

    if (!attemptConfig) {
      continue;
    }

    const actorConfig = createGenerationActorRuntimeConfig(attemptConfig, actor);
    const startedAt = Date.now();

    await emitGenerationEvent({
      type: actor === "generator" ? "generator-start" : "validator-start",
      actor,
      round,
      maxRounds,
      provider: actorConfig.provider,
      model: actorConfig.model,
      message: `Starting Ralph ${actor} with ${actorConfig.provider}/${actorConfig.model}.`,
    });

    const executionOptions = await createRalphTaskExecutionOptions(options, actorConfig);
    const baseOnStateChange = executionOptions.onStateChange;
    const baseOnActionOutput = executionOptions.onActionOutput;
    let lastProgressSignature = "";

    const result = await executeTask(task, actorConfig, customizations, {
      ...executionOptions,
      onStateChange: async (progress) => {
        await baseOnStateChange?.(progress);

        const message =
          progress.message.trim() ||
          progress.timelineEvent?.label ||
          `Ralph ${actor} reported ${progress.state}.`;
        const detail =
          progress.reason ??
          progress.timelineEvent?.detail ??
          progress.assistantText ??
          progress.modelStream?.content;
        const signature = [
          progress.state,
          message,
          detail ? detail.slice(0, 240) : "",
        ].join("\n");

        if (signature === lastProgressSignature) {
          return;
        }

        lastProgressSignature = signature;
        await emitGenerationEvent({
          type: "actor-progress",
          actor,
          round,
          maxRounds,
          provider: actorConfig.provider,
          model: actorConfig.model,
          flowPath: paths.flowPath,
          generationFlowPath: paths.generationFlowPath,
          durationMs: Date.now() - startedAt,
          actorState: progress.state,
          ...(detail ? { detail: capLogText(detail, MAX_RALPH_SIMPLE_LOG_CHARS) } : {}),
          message: `Ralph ${actor} ${progress.state}: ${createGenerationFeedbackExcerpt(message)}`,
        });
      },
      onActionOutput: async (output) => {
        await baseOnActionOutput?.(output);

        const safeOutput: TaskActionOutput = {
          ...output,
          chunk: capLogText(output.chunk, MAX_RALPH_SIMPLE_LOG_CHARS),
        };
        const excerpt = createGenerationFeedbackExcerpt(safeOutput.chunk);

        await emitGenerationEvent({
          type: "actor-output",
          actor,
          round,
          maxRounds,
          provider: actorConfig.provider,
          model: actorConfig.model,
          flowPath: paths.flowPath,
          generationFlowPath: paths.generationFlowPath,
          durationMs: Date.now() - startedAt,
          actionToolName: safeOutput.toolName,
          actionStream: safeOutput.stream,
          detail: safeOutput.chunk,
          message: `Ralph ${actor} ${safeOutput.toolName} ${safeOutput.stream}${excerpt ? `: ${excerpt}` : "."}`,
        });
      },
      maxDurationMs:
        executionOptions.maxDurationMs ?? DEFAULT_RALPH_GENERATION_ACTOR_TIMEOUT_MS,
      instructionAudience: actor,
      ...(actor === "generator" && agentRuntime
        ? {
            additionalToolDefinitions: agentRuntime.toolDefinitions,
            systemPromptSections: agentRuntime.systemPromptSections,
          }
        : {}),
    });
    results.push(result);

    await emitGenerationEvent({
      type: actor === "generator" ? "generator-output" : "validator-result",
      actor,
      round,
      maxRounds,
      provider: actorConfig.provider,
      model: actorConfig.model,
      durationMs: Date.now() - startedAt,
      message: createGenerationActorResultMessage(actor, result),
    });

    if (result.status === "executed") {
      return result;
    }

    return result;
  }

  return {
    task,
    mode: attemptConfigs[0]?.mode ?? "ask",
    status: "blocked",
    summary: `Ralph ${actor} could not start because no configured provider was selected.`,
    executedTools: [],
    reason:
      "Select and configure a model provider before starting Ralph generation.",
    outputSections: [],
  };
};

export const createRalphGenerationInterviewWithAgent = async (
  workspaceRoot: string,
  options: RalphGenerationInterviewOptions,
): Promise<RalphGenerationInterviewResult> => {
  const prompt = options.prompt.trim();
  const scope = options.scope ?? "workspace";
  const maxTurns = clampRalphGenerationInterviewMaxTurns(options.maxTurns, {
    defaultMaxTurns: DEFAULT_RALPH_GENERATION_INTERVIEW_MAX_TURNS,
    maxTurns: MAX_RALPH_GENERATION_INTERVIEW_MAX_TURNS,
  });
  const baseSession = createRalphGenerationInterviewSession(
    { ...options, prompt },
    scope,
    maxTurns,
  );
  const session = applyRalphGenerationInterviewAnswers(
    baseSession,
    options.answers,
    options.answerComments,
  );
  const config =
    options.config ??
    (await loadRuntimeConfig(workspaceRoot, "machdoch", undefined, undefined, undefined));
  const interviewerConfig: RuntimeConfig = {
    ...config,
    mode: "ask",
    reasoning: config.reasoning === "default" ? "medium" : config.reasoning,
  };

  if (!prompt) {
    return {
      status: "blocked",
      session,
      fields: [],
      summary: "Expected a prompt before starting a Ralph generation interview.",
      provider: interviewerConfig.provider,
      model: interviewerConfig.model,
    };
  }

  if (session.turn >= session.maxTurns) {
    const finalSummary =
      session.finalSummary ??
      "The interview reached the maximum number of question rounds.";
    const completedSession: RalphGenerationInterviewSession = {
      ...session,
      finalSummary,
    };

    return {
      status: "complete",
      session: completedSession,
      fields: [],
      summary: finalSummary,
      finalPrompt: createRalphGenerationPromptFromInterview(
        completedSession,
        finalSummary,
      ),
      provider: interviewerConfig.provider,
      model: interviewerConfig.model,
    };
  }

  const customizations =
    options.customizations ??
    (await discoverCustomizations(workspaceRoot, {
      discoverUserCustomizations: true,
      discoverGithubCustomizations:
        Boolean(config.compatibility.discoverGithubCustomizations),
      includeDiagnostics: true,
      ...createExistingRalphFlowDiscoveryTarget(options.existingFlow, session.scope),
    }));
  const nextTurn = session.turn + 1;
  const executionOptions = await createRalphTaskExecutionOptions(
    options,
    interviewerConfig,
  );
  const result = await executeTask(
    createRalphGenerationInterviewTask(
      workspaceRoot,
      options,
      session,
      nextTurn,
    ),
    interviewerConfig,
    customizations,
    {
      ...executionOptions,
      additionalToolDefinitions: createRalphGenerationInterviewToolDefinitions(),
      systemPromptSections: [createRalphGenerationInterviewSystemPrompt()],
      instructionAudience: "generator",
      maxDurationMs:
        executionOptions.maxDurationMs ?? DEFAULT_RALPH_GENERATION_ACTOR_TIMEOUT_MS,
    },
  );

  if (result.status !== "executed") {
    return {
      status: "blocked",
      session,
      fields: [],
      summary:
        result.reason ??
        result.summary ??
        "The Ralph generation interviewer could not complete.",
      provider: interviewerConfig.provider,
      model: interviewerConfig.model,
      result,
    };
  }

  let submission: RalphGenerationInterviewSubmission;
  try {
    submission = readRalphGenerationInterviewSubmission(result);
  } catch (error) {
    return {
      status: "blocked",
      session,
      fields: [],
      summary: error instanceof Error ? error.message : String(error),
      provider: interviewerConfig.provider,
      model: interviewerConfig.model,
      result,
    };
  }

  const contextSummary =
    submission.contextSummary ?? session.contextSummary ?? submission.summary;
  const updatedSessionBase: RalphGenerationInterviewSession = {
    ...session,
    ...(contextSummary ? { contextSummary } : {}),
    findings: mergeRalphGenerationInterviewLines(
      session.findings,
      submission.findings,
    ),
    assumptions: mergeRalphGenerationInterviewLines(
      session.assumptions,
      submission.assumptions,
    ),
    relevantFiles: mergeRalphGenerationInterviewLines(
      session.relevantFiles,
      submission.relevantFiles,
    ),
  };

  const shouldComplete =
    submission.complete ||
    submission.fields.length === 0 ||
    nextTurn > updatedSessionBase.maxTurns;

  if (shouldComplete) {
    const finalSummary =
      submission.summary ??
      updatedSessionBase.contextSummary ??
      "The interview collected enough context for generation.";
    const completedSession: RalphGenerationInterviewSession = {
      ...updatedSessionBase,
      finalSummary,
    };

    return {
      status: "complete",
      session: completedSession,
      fields: [],
      summary: finalSummary,
      finalPrompt: createRalphGenerationPromptFromInterview(
        completedSession,
        finalSummary,
      ),
      provider: interviewerConfig.provider,
      model: interviewerConfig.model,
      result,
    };
  }

  const nextSession: RalphGenerationInterviewSession = {
    ...updatedSessionBase,
    turn: nextTurn,
    transcript: [
      ...updatedSessionBase.transcript,
      {
        turn: nextTurn,
        questions: submission.fields,
        answers: [],
        ...(submission.questionScope
          ? { questionScope: submission.questionScope }
          : {}),
        ...(submission.summary ? { summary: submission.summary } : {}),
        createdAt: createLogTimestamp(),
      },
    ],
  };

  return {
    status: "questions",
    session: nextSession,
    fields: submission.fields,
    summary:
      submission.summary ??
      `Prepared interview round ${nextTurn} of ${nextSession.maxTurns}.`,
    provider: interviewerConfig.provider,
    model: interviewerConfig.model,
    result,
  };
};

export const createRalphFlowWithAgent = async (
  workspaceRoot: string,
  options: RalphFlowGenerationOptions,
): Promise<RalphFlowGenerationResult> => {
  const scope = options.scope ?? "workspace";
  const alias = normalizeFlowAlias(options.name);
  const id = options.existingFlow?.id ?? randomUUID();
  const displayName = options.existingFlow?.name ?? options.name.trim();
  const flowPath = id
    ? getRalphFlowPath(workspaceRoot, id, scope)
    : join(getRalphFlowStorageDirectory(workspaceRoot, scope), "flow.json");
  const generationFlowPath = join(
    getRalphFlowStorageDirectory(workspaceRoot, scope),
    `.${id}-generation-${randomUUID()}${FLOW_FILE_EXTENSION}`,
  );
  const maxRounds = options.maxRounds ?? DEFAULT_RALPH_GENERATION_MAX_ROUNDS;
  const generationRunId = options.runId ?? `ralph-generation-${id}-${randomUUID()}`;
  const generationEvents: RalphGenerationEvent[] = [];
  const generationLoggerRef: { current?: RalphFileGenerationLogger } = {};
  const emitGenerationEvent: EmitRalphGenerationEvent = async (event) => {
    const completedEvent: RalphGenerationEvent = {
      ...event,
      generationRunId,
      createdAt: createLogTimestamp(),
    };

    generationEvents.push(completedEvent);
    generationLoggerRef.current?.event(completedEvent);
    try {
      await options.onGenerationEvent?.(completedEvent);
    } catch {
      // Generation events are observability side effects. Generation must continue.
    }
  };
  const finalizeGenerationResult = async (
    result: Omit<
      RalphFlowGenerationResult,
      "generationRunId" | "generationLogPath" | "traceLogPath" | "events"
    >,
  ): Promise<RalphFlowGenerationResult> => {
    const completedResult: RalphFlowGenerationResult = {
      generationRunId,
      ...(generationLoggerRef.current?.paths.simpleMarkdownPath
        ? { generationLogPath: generationLoggerRef.current.paths.simpleMarkdownPath }
        : {}),
      ...(generationLoggerRef.current?.paths.traceJsonlPath
        ? { traceLogPath: generationLoggerRef.current.paths.traceJsonlPath }
        : {}),
      ...result,
      events: generationEvents,
    };

    await generationLoggerRef.current?.record(completedResult).catch(() => undefined);

    return completedResult;
  };

  if (!alias) {
    return createBlockedGenerationResult(
      flowPath,
      createValidationResult([
        {
          code: "flow-id-required",
          message: "Expected a Ralph flow name before generation.",
        },
      ]),
    );
  }

  if (!options.prompt.trim()) {
    return createBlockedGenerationResult(
      flowPath,
      createValidationResult([
        {
          code: "prompt-required",
          message: "Expected a prompt before generating a Ralph flow.",
        },
      ]),
    );
  }

  if (
    !Number.isInteger(maxRounds) ||
    maxRounds < 1 ||
    maxRounds > MAX_RALPH_GENERATION_MAX_ROUNDS
  ) {
    return createBlockedGenerationResult(
      flowPath,
      createValidationResult([
        {
          code: "max-rounds-invalid",
          message: `maxRounds must be an integer from 1 to ${MAX_RALPH_GENERATION_MAX_ROUNDS}.`,
        },
      ]),
    );
  }

  const config =
    options.config ??
    (await loadRuntimeConfig(workspaceRoot, "machdoch", undefined, undefined, undefined));
  const customizations =
    options.customizations ??
    (await discoverCustomizations(workspaceRoot, {
      discoverUserCustomizations: true,
      discoverGithubCustomizations:
        Boolean(config.compatibility.discoverGithubCustomizations),
      includeDiagnostics: true,
      ...createExistingRalphFlowDiscoveryTarget(options.existingFlow, scope),
    }));
  const generatorResults: TaskExecutionResult[] = [];
  const validatorResults: TaskExecutionResult[] = [];
  const attemptConfigs = createGenerationAttemptConfigs(config);
  const temporaryGenerationFlowPaths = new Set<string>([generationFlowPath]);
  const requestedGenerationAlias = options.existingFlow?.alias ?? alias;
  const generationAlias = options.existingFlow?.alias
    ? requestedGenerationAlias
    : await createAvailableGeneratedFlowAlias(
      workspaceRoot,
      scope,
      requestedGenerationAlias,
      id,
    );
  const generationIdentity: RalphGeneratedFlowIdentity = {
    id,
    alias: generationAlias,
    name: displayName,
  };
  const generationAgentRuntime: RalphGenerationAgentRuntime = {
    systemPromptSections: [createRalphGeneratorSystemPrompt()],
    toolDefinitions: createRalphGenerationToolDefinitions(generationIdentity, config),
  };
  let latestGenerationFlowPath = generationFlowPath;
  let validatorFeedback: string | undefined;
  let latestValidation = createValidationResult([]);
  let workspaceHints: string | undefined;

  await mkdir(getRalphFlowStorageDirectory(workspaceRoot, scope), { recursive: true });
  const generationLogger = await createRalphGenerationLogger(workspaceRoot, {
    runId: generationRunId,
    flowPath,
    generationFlowPath,
    prompt: options.prompt,
    scope,
  }).catch(() => undefined);

  if (generationLogger) {
    generationLoggerRef.current = generationLogger;
  }

  await emitGenerationEvent({
    type: "started",
    maxRounds,
    provider: config.provider,
    model: config.model,
    flowPath,
    generationFlowPath,
    message: `Started Ralph flow generation for \`${displayName}\`.`,
  });

  try {
    for (let round = 1; round <= maxRounds; round += 1) {
      const roundGenerationFlowPath = createGenerationAttemptFlowPath(
        generationFlowPath,
        round,
      );
      latestGenerationFlowPath = roundGenerationFlowPath;
      temporaryGenerationFlowPaths.add(roundGenerationFlowPath);
      await unlink(roundGenerationFlowPath).catch(() => undefined);

      await emitGenerationEvent({
        type: "round-start",
        round,
        maxRounds,
        provider: config.provider,
        model: config.model,
        flowPath,
        generationFlowPath: roundGenerationFlowPath,
        message: `Starting generation round ${round} of ${maxRounds}.`,
      });

      const generatorResult = await executeGenerationActorWithFallback(
        "generator",
        createFlowGenerationTask(
          roundGenerationFlowPath,
          id,
          generationIdentity.alias,
          displayName,
          options.prompt,
          options.target,
          options.mode,
          scope,
          options.existingFlow,
          validatorFeedback,
          workspaceHints ??
            (workspaceHints = await createFlowGenerationWorkspaceHints(workspaceRoot)),
        ),
        customizations,
        { ...options, runId: generationRunId },
        attemptConfigs,
        generatorResults,
        round,
        maxRounds,
        emitGenerationEvent,
        { flowPath, generationFlowPath: roundGenerationFlowPath },
        generationAgentRuntime,
      );

      if (generatorResult.status !== "executed") {
        await emitGenerationEvent({
          type: "blocked",
          round,
          maxRounds,
          status: "blocked",
          flowPath,
          generationFlowPath: roundGenerationFlowPath,
          message: createTaskDidNotExecuteFeedback("generator", generatorResult),
        });

        return await finalizeGenerationResult({
          status: "blocked",
          flowPath,
          rounds: round,
          validation: latestValidation,
          generatorResults,
          validatorResults,
          summary: createTaskDidNotExecuteFeedback("generator", generatorResult),
        });
      }

      let flow: RalphFlow;
      try {
        await emitGenerationEvent({
          type: "schema-validation-start",
          round,
          maxRounds,
          flowPath,
          generationFlowPath: roundGenerationFlowPath,
          message: "Reading generated Ralph flow JSON from file output or generator response.",
        });
        const generatedFlow = await readGeneratedRalphFlow(
          roundGenerationFlowPath,
          generatorResult,
        );

        if (!generatedFlow.flow) {
          throw new Error(generatedFlow.error ?? "Generated Ralph flow JSON was missing.");
        }

        flow = normalizeGeneratedRalphFlowCandidate(
          generatedFlow.flow,
          generationIdentity,
        );
      } catch (error) {
        validatorFeedback = `The generator did not produce valid Ralph JSON: ${error instanceof Error ? error.message : String(error)}`;
        await emitGenerationEvent({
          type: "schema-validation-result",
          round,
          maxRounds,
          flowPath,
          generationFlowPath: roundGenerationFlowPath,
          validationValid: false,
          validationErrorCount: 1,
          validationWarningCount: 0,
          message: validatorFeedback,
        });
        await emitGenerationEvent({
          type: "retry-feedback",
          round,
          maxRounds,
          flowPath,
          generationFlowPath: roundGenerationFlowPath,
          message: "Retrying with feedback about invalid generated JSON.",
        });
        continue;
      }

      latestValidation = validateRalphFlow(flow, { config });
      await emitGenerationEvent({
        type: "schema-validation-result",
        round,
        maxRounds,
        flowPath,
        generationFlowPath: roundGenerationFlowPath,
        validationValid: latestValidation.valid,
        validationErrorCount: latestValidation.errors.length,
        validationWarningCount: latestValidation.warnings.length,
        blockCount: flow.blocks.length,
        edgeCount: flow.edges.length,
        message: latestValidation.valid
          ? `Generated flow passed schema validation with ${flow.blocks.length} block(s) and ${flow.edges.length} edge(s).`
          : `Generated flow failed schema validation: ${latestValidation.errors[0] ?? "unknown error"}`,
      });
      if (!latestValidation.valid) {
        validatorFeedback = `The generated flow is invalid: ${latestValidation.errors.join(" ")}`;
        await emitGenerationEvent({
          type: "retry-feedback",
          round,
          maxRounds,
          flowPath,
          generationFlowPath: roundGenerationFlowPath,
          validationValid: false,
          validationErrorCount: latestValidation.errors.length,
          validationWarningCount: latestValidation.warnings.length,
          message: createGenerationFeedbackExcerpt(validatorFeedback),
        });
        continue;
      }

      await writeFile(
        roundGenerationFlowPath,
        `${JSON.stringify(flow, null, 2)}\n`,
        "utf8",
      );
      await emitGenerationEvent({
        type: "generator-file-written",
        round,
        maxRounds,
        flowPath,
        generationFlowPath: roundGenerationFlowPath,
        validationValid: true,
        validationErrorCount: 0,
        validationWarningCount: latestValidation.warnings.length,
        blockCount: flow.blocks.length,
        edgeCount: flow.edges.length,
        message: `Wrote validated generated flow to ${roundGenerationFlowPath}.`,
      });

      await emitGenerationEvent({
        type: "validator-start",
        actor: "validator",
        round,
        maxRounds,
        flowPath,
        generationFlowPath: roundGenerationFlowPath,
        message: "Running bounded local Ralph generation validator.",
      });
      const localValidatorStartedAt = Date.now();
      const structureValidation = validateGeneratedRalphFlowStructure(flow);
      const localValidatorDurationMs = Date.now() - localValidatorStartedAt;
      const validatorResult = createLocalGenerationValidatorResult(
        `Validate generated Ralph flow ${roundGenerationFlowPath}.`,
        config.mode,
        structureValidation,
        localValidatorDurationMs,
      );
      validatorResults.push(validatorResult);
      const validatorDecision = structureValidation.decision;

      await emitGenerationEvent({
        type: "validator-result",
        round,
        maxRounds,
        actor: "validator",
        flowPath,
        generationFlowPath: roundGenerationFlowPath,
        validatorDecision,
        blockCount: flow.blocks.length,
        edgeCount: flow.edges.length,
        durationMs: localValidatorDurationMs,
        message: `Local Ralph generation validator returned ${validatorDecision}.`,
      });

      if (validatorDecision === "DONE") {
        flow = await writeGeneratedRalphFlowWithAliasFallback(workspaceRoot, flow, {
          scope,
          fallbackAliasBase: generationIdentity.alias ?? alias,
          allowAliasFallback: true,
        });
        latestValidation = validateRalphFlow(flow, { config });
        await emitGenerationEvent({
          type: "created",
          round,
          maxRounds,
          status: "created",
          flowPath,
          generationFlowPath: roundGenerationFlowPath,
          validationValid: latestValidation.valid,
          validationErrorCount: latestValidation.errors.length,
          validationWarningCount: latestValidation.warnings.length,
          blockCount: flow.blocks.length,
          edgeCount: flow.edges.length,
          message: `Created Ralph flow \`${flow.name}\` at ${flowPath}.`,
        });

        return await finalizeGenerationResult({
          status: "created",
          flowPath,
          flow,
          rounds: round,
          validation: latestValidation,
          generatorResults,
          validatorResults,
          summary: `Created Ralph flow \`${flow.name}\` at ${flowPath}.`,
        });
      }

      const validatorMarkdown =
        validatorResult.response?.markdown ??
        validatorResult.reason ??
        validatorResult.summary;
      validatorFeedback = `The local Ralph generation validator returned ${validatorDecision}. ${validatorMarkdown}`;
      await emitGenerationEvent({
        type: "retry-feedback",
        round,
        maxRounds,
        flowPath,
        generationFlowPath: roundGenerationFlowPath,
        validatorDecision,
        message: createGenerationFeedbackExcerpt(validatorFeedback),
      });
    }

    const summary = createGenerationDidNotConvergeSummary(
      maxRounds,
      latestValidation,
      validatorFeedback,
    );

    await emitGenerationEvent({
      type: "blocked",
      maxRounds,
      status: "blocked",
      flowPath,
      generationFlowPath: latestGenerationFlowPath,
      validationValid: latestValidation.valid,
      validationErrorCount: latestValidation.errors.length,
      validationWarningCount: latestValidation.warnings.length,
      message: summary,
    });

    return await finalizeGenerationResult({
      status: "blocked",
      flowPath,
      rounds: maxRounds,
      validation: latestValidation,
      generatorResults,
      validatorResults,
      summary,
    });
  } catch (error) {
    await emitGenerationEvent({
      type: options.signal?.aborted ? "cancelled" : "failed",
      maxRounds,
      status: "blocked",
      flowPath,
      generationFlowPath: latestGenerationFlowPath,
      message: error instanceof Error ? error.message : String(error),
    });

    throw error;
  } finally {
    await Promise.all(
      [...temporaryGenerationFlowPaths].map((temporaryGenerationFlowPath) =>
        unlink(temporaryGenerationFlowPath).catch(() => undefined),
      ),
    );
  }
};
