import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { loadRuntimeConfig } from "./config.js";
import { discoverCustomizations } from "./customizations.js";
import { executeTask } from "./execution.js";
import {
  createToolErrorResult,
  type AgentToolDefinition,
} from "./_helpers/agent-tools-shared.js";
import { loadMcpConfigSync, loadMcpDiscoveryCacheSync } from "./mcp/config.js";
import { normalizeRalphFlowLayout } from "./ralph-layout.js";
import {
  FLOW_FILE_EXTENSION,
  MAX_RALPH_SIMPLE_LOG_CHARS,
  RALPH_BLOCK_TYPES,
  RALPH_FLOW_SCHEMA_VERSION,
  RALPH_UTILITY_TYPES,
  capLogText,
  createLogTimestamp,
  createRalphLogLine,
  createRalphTaskExecutionOptions,
  createValidationResult,
  getRalphFlowPath,
  getRalphFlowStorageDirectory,
  getRalphStorageDirectory,
  hasGraphCycle,
  listRalphFlows,
  normalizeFlowAlias,
  normalizeRunId,
  parseRalphFlowJson,
  sanitizeTraceValue,
  validateRalphFlow,
  writeRalphFlow,
  type RalphBlockType,
  type RalphFlow,
  type RalphFlowScope,
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

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const DEFAULT_RALPH_GENERATION_MAX_ROUNDS = 3;
export const MAX_RALPH_GENERATION_MAX_ROUNDS = 25;
const DEFAULT_RALPH_GENERATION_ACTOR_TIMEOUT_MS = 3 * 60 * 1_000;

const RALPH_GENERATION_SUBDIRECTORY = "generations";

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

export const getRalphGenerationDirectory = (
  workspaceRoot: string,
  scope: RalphFlowScope = "workspace",
): string => {
  return join(
    getRalphStorageDirectory(workspaceRoot, scope),
    RALPH_GENERATION_SUBDIRECTORY,
  );
};

const createRalphGenerationArtifactPaths = (
  generationDirectory: string,
  timestamp: string,
  preferredId?: string,
): RalphGenerationLogPaths => {
  const baseName = preferredId
    ? normalizeRunId(preferredId)
    : timestamp.replace(/[:.]/gu, "-");
  let id = baseName;
  let candidateDirectory = join(generationDirectory, id);
  let suffix = 1;

  while (existsSync(candidateDirectory)) {
    id = `${baseName}-${suffix}`;
    candidateDirectory = join(generationDirectory, id);
    suffix += 1;
  }

  return {
    id,
    directory: candidateDirectory,
    recordPath: join(candidateDirectory, "generation.json"),
    simpleMarkdownPath: join(candidateDirectory, "simple.md"),
    traceJsonlPath: join(candidateDirectory, "trace.jsonl"),
  };
};

const formatGenerationMarkdownEntry = (event: RalphGenerationEvent): string => {
  const round = event.round ? ` round ${event.round}` : "";
  const actor = event.actor ? ` ${event.actor}` : "";
  const counts =
    event.blockCount !== undefined || event.edgeCount !== undefined
      ? ` (${event.blockCount ?? 0} blocks, ${event.edgeCount ?? 0} edges)`
      : "";

  return `- ${event.createdAt}${round}${actor} ${event.message}${counts}`;
};

class RalphFileGenerationLogger {
  private pending: Promise<void> = Promise.resolve();
  private failed = false;

  public constructor(public readonly paths: RalphGenerationLogPaths) {}

  public event(event: RalphGenerationEvent): void {
    const safeEvent: RalphGenerationEvent = {
      ...event,
      message: capLogText(event.message, MAX_RALPH_SIMPLE_LOG_CHARS),
    };

    this.enqueue(async () => {
      await appendFile(this.paths.traceJsonlPath, createRalphLogLine(safeEvent), "utf8");
      await appendFile(
        this.paths.simpleMarkdownPath,
        `${formatGenerationMarkdownEntry(safeEvent)}\n`,
        "utf8",
      );
    });
  }

  public async record(result: RalphFlowGenerationResult): Promise<void> {
    await this.flush();
    await writeFile(
      this.paths.recordPath,
      `${JSON.stringify(sanitizeTraceValue(result), null, 2)}\n`,
      "utf8",
    );
  }

  public async flush(): Promise<void> {
    await this.pending.catch(() => undefined);
  }

  private enqueue(write: () => Promise<void>): void {
    if (this.failed) {
      return;
    }

    this.pending = this.pending
      .then(write)
      .catch(() => {
        this.failed = true;
      });
  }
}

const createRalphGenerationLogger = async (
  workspaceRoot: string,
  options: {
    runId: string;
    flowPath: string;
    generationFlowPath: string;
    prompt: string;
    scope?: RalphFlowScope;
  },
): Promise<RalphFileGenerationLogger> => {
  const createdAt = createLogTimestamp();
  const paths = createRalphGenerationArtifactPaths(
    getRalphGenerationDirectory(workspaceRoot, options.scope ?? "workspace"),
    createdAt,
    options.runId,
  );
  const logger = new RalphFileGenerationLogger(paths);

  await mkdir(paths.directory, { recursive: true });
  await writeFile(
    paths.simpleMarkdownPath,
    [
      `# Ralph Generation ${paths.id}`,
      "",
      `Started: ${createdAt}`,
      `Flow path: ${options.flowPath}`,
      `Temporary flow path base: ${options.generationFlowPath}`,
      "Per-round temporary flow paths append `-round-N` before the file extension.",
      "",
      "## Prompt",
      "",
      capLogText(options.prompt, MAX_RALPH_SIMPLE_LOG_CHARS),
      "",
      "## Activity",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(paths.traceJsonlPath, "", "utf8");

  return logger;
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

const MAX_RALPH_GENERATED_FLOW_ALIAS_LENGTH = 80;
const MAX_RALPH_GENERATED_FLOW_ALIAS_ATTEMPTS = 1_000;
const MAX_RALPH_GENERATED_FLOW_ALIAS_WRITE_ATTEMPTS = 5;

const isRalphFlowAliasCollisionError = (error: unknown): boolean => {
  return (
    error instanceof Error &&
    /^Ralph flow alias `[^`]+` is already used by `[^`]+`\.$/u.test(error.message)
  );
};

const createGeneratedFlowAliasCandidate = (
  baseAlias: string,
  suffix: number,
): string => {
  if (suffix === 0) {
    return baseAlias;
  }

  const suffixText = `-${suffix}`;
  const maxBaseLength = Math.max(
    1,
    MAX_RALPH_GENERATED_FLOW_ALIAS_LENGTH - suffixText.length,
  );
  const trimmedBase = baseAlias.slice(0, maxBaseLength).replace(/-+$/gu, "");
  const candidate = normalizeFlowAlias(`${trimmedBase}${suffixText}`);

  if (!candidate) {
    throw new Error("Expected a Ralph flow alias candidate.");
  }

  return candidate;
};

const collectUnavailableGeneratedFlowAliases = async (
  workspaceRoot: string,
  scope: RalphFlowScope,
  currentFlowId: string,
): Promise<Set<string>> => {
  const unavailableAliases = new Set<string>();
  const normalizedCurrentFlowId = normalizeFlowAlias(currentFlowId);
  const flowSummaries = await listRalphFlows(workspaceRoot, { scope });

  for (const summary of flowSummaries) {
    const existingId = normalizeFlowAlias(summary.id);

    if (existingId && existingId !== normalizedCurrentFlowId) {
      unavailableAliases.add(existingId);
    }

    if (summary.alias) {
      const existingAlias = normalizeFlowAlias(summary.alias);

      if (existingAlias && existingId !== normalizedCurrentFlowId) {
        unavailableAliases.add(existingAlias);
      }
    }
  }

  return unavailableAliases;
};

const createAvailableGeneratedFlowAlias = async (
  workspaceRoot: string,
  scope: RalphFlowScope,
  preferredAlias: string,
  currentFlowId: string,
): Promise<string> => {
  const baseAlias = normalizeFlowAlias(preferredAlias);

  if (!baseAlias) {
    throw new Error("Expected a Ralph flow alias before generation.");
  }

  const unavailableAliases = await collectUnavailableGeneratedFlowAliases(
    workspaceRoot,
    scope,
    currentFlowId,
  );

  for (
    let suffix = 0;
    suffix < MAX_RALPH_GENERATED_FLOW_ALIAS_ATTEMPTS;
    suffix += 1
  ) {
    const candidate = createGeneratedFlowAliasCandidate(baseAlias, suffix);

    if (!unavailableAliases.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not allocate a unique Ralph flow alias from \`${preferredAlias}\`.`,
  );
};

const writeGeneratedRalphFlowWithAliasFallback = async (
  workspaceRoot: string,
  flow: RalphFlow,
  options: {
    scope: RalphFlowScope;
    fallbackAliasBase: string;
    allowAliasFallback: boolean;
  },
): Promise<RalphFlow> => {
  let writableFlow = flow;

  for (
    let attempt = 1;
    attempt <= MAX_RALPH_GENERATED_FLOW_ALIAS_WRITE_ATTEMPTS;
    attempt += 1
  ) {
    try {
      await writeRalphFlow(workspaceRoot, writableFlow, {
        createRevision: true,
        scope: options.scope,
      });

      return writableFlow;
    } catch (error) {
      if (
        !options.allowAliasFallback ||
        !isRalphFlowAliasCollisionError(error) ||
        attempt >= MAX_RALPH_GENERATED_FLOW_ALIAS_WRITE_ATTEMPTS
      ) {
        throw error;
      }

      const fallbackAlias = await createAvailableGeneratedFlowAlias(
        workspaceRoot,
        options.scope,
        writableFlow.alias ?? options.fallbackAliasBase,
        writableFlow.id,
      );

      writableFlow = normalizeRalphFlowLayout({
        ...writableFlow,
        alias: fallbackAlias,
      });
    }
  }

  return writableFlow;
};

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
  RUN_COMMAND: {
    type: "RUN_COMMAND",
    role: "Run a configured local command.",
    requiredFields: ["type", "command"],
    optionalFields: ["cwd", "env", "timeoutSeconds", "maxOutputBytes"],
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
    requiredFields: ["type", "command"],
    optionalFields: ["cwd", "env", "acceptedExitCodes", "timeoutSeconds", "maxOutputBytes"],
    outputs: ["SUCCESS", "FAILED", "ERROR"],
    generationNotes: ["Prefer package-manager-aware verification commands from workspace hints."],
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
          "Validate a complete Ralph flow candidate without persisting it. Use this before submitting the final candidate.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            flow: {
              type: "object",
              additionalProperties: true,
            },
            flowJson: {
              type: "string",
            },
          },
          required: [],
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
          const summary = {
            valid: validation.valid && structureValidation.decision === "DONE",
            schemaErrors: validation.errors,
            schemaWarnings: validation.warnings,
            structuralIssues: structureValidation.issues,
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
          "Normalize a complete Ralph flow candidate layout and identity without persisting it.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            flow: {
              type: "object",
              additionalProperties: true,
            },
            flowJson: {
              type: "string",
            },
          },
          required: [],
        },
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
          "Submit the complete final Ralph flow candidate as structured data. This does not persist the flow; Ralph will validate and persist it after the model run.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            flow: {
              type: "object",
              additionalProperties: true,
            },
            rationale: {
              type: "string",
            },
            evidence: {
              type: "array",
              items: { type: "string" },
            },
            assumptions: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["flow", "rationale", "evidence", "assumptions"],
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

const createRalphGeneratorSystemPrompt = (): string => {
  return [
    "<ralph_generator_contract>",
    "You are Ralph Flow Generator, a specialized agent that designs executable Ralph flow graphs.",
    "Generate flows from the user's intent in any language. Do not rely on keyword matching or canned phrase triggers.",
    "Think through the requested workflow, inspect workspace context with read-only tools when it materially affects a workspace flow, and use Ralph-specific tools to check node and utility contracts when uncertain.",
    "Use the flow id and alias supplied by Ralph; do not invent or reuse identity values from other flows.",
    "Prefer a compact graph with meaningful block titles, stable kebab-case ids, explicit routes, and readable positions.",
    "Use NOTE and GROUP only for visual organization; never route execution through them.",
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
    "- Preferred: call ralph_submit_flow_candidate with one complete Ralph flow object, rationale, evidence, and assumptions.",
    "- If tool calls are unavailable, return one complete Ralph flow JSON object wrapped in <ralph_flow_json>...</ralph_flow_json> tags.",
    "- Do not include comments, trailing commas, or explanatory prose inside fallback JSON tags.",
    "- Do not write files yourself; Ralph validates and writes the parsed JSON locally.",
    "- After a successful ralph_submit_flow_candidate tool call, finish with submit_final_response and do not paste the full JSON into that final response.",
    "",
    "Ralph flow requirements:",
    "- Use graph blocks: START, PROMPT, VALIDATOR, DECISION, PACK, UTILITY, NOTE, GROUP, END.",
    "- Use the exact top-level id and alias from the schema example. Ralph owns generated flow identity and may repair aliases for uniqueness.",
    "- Use exactly one START block and one or more END blocks.",
    "- NOTE and GROUP blocks are visual organization only; do not route execution through them. Put visible note body text in NOTE.text. Use parentGroupId on executable blocks or GROUP.childBlockIds to describe group membership; Ralph normalizes group bounds around those children.",
    "- Normal PROMPT blocks route with SUCCESS and ERROR; they do not need RALPH_DECISION markers.",
    "- VALIDATOR blocks must end with RALPH_DECISION: DONE, CONTINUE, RETRY, or ERROR.",
    "- VALIDATOR.CONTINUE needs an explicit edge.",
    "- VALIDATOR.RETRY may omit an edge; Ralph falls back to the validator group start.",
    "- DECISION blocks must define labels and end with RALPH_DECISION: <LABEL>.",
    "- UTILITY blocks run deterministic operations without an LLM. Available utility.type values: WAIT, HTTP_FETCH, POLL, RUN_COMMAND, READ_FILE, WRITE_FILE, SEARCH_FILES, RUN_CHECK, UI_ANALYZE, GIT_STATUS, SET_VARIABLE, TRANSFORM_JSON, VALIDATE_JSON, NOTIFY.",
    "- Use utility outputs exactly as produced: WAIT/SET_VARIABLE/NOTIFY use SUCCESS only; HTTP_FETCH uses SUCCESS, HTTP_ERROR, TIMEOUT, ERROR; POLL uses SUCCESS, ERROR, and TIMEOUT when maxAttempts is finite; RUN_CHECK uses SUCCESS, FAILED, ERROR; UI_ANALYZE uses SUCCESS, UNAVAILABLE, ERROR; SEARCH_FILES uses SUCCESS, EMPTY, ERROR; VALIDATE_JSON uses SUCCESS, INVALID, ERROR.",
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
    "Schema example:",
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
            id: "wait-before-work",
            type: "UTILITY",
            title: "Wait before work",
            utility: { type: "WAIT", mode: "delay", delaySeconds: 0 },
            position: { x: 260, y: 0 },
          },
          {
            id: "do-work",
            type: "PROMPT",
            title: "Do work",
            prompt: "Do the requested work for {{scope:path=ALL}}.",
            settings: {
              workspace: { mode: "default" },
              reasoning: "default",
              maxIterations: 1,
            },
            position: { x: 520, y: 0 },
          },
          {
            id: "validate-work",
            type: "VALIDATOR",
            title: "Validate work",
            prompt:
              "Validate the completed work for {{scope:path=ALL}}. End with RALPH_DECISION: DONE, CONTINUE, RETRY, or ERROR.",
            validationScope: { mode: "sinceLastValidator" },
            position: { x: 780, y: 0 },
          },
          {
            id: "success",
            type: "END",
            title: "Success",
            status: "success",
            position: { x: 1040, y: 0 },
          },
          {
            id: "work-note",
            type: "NOTE",
            title: "Operator note",
            text: "Keep the loop scoped and verify before finishing.",
            pinnedBlockIds: ["do-work", "validate-work"],
            position: { x: 780, y: 190 },
          },
          {
            id: "work-group",
            type: "GROUP",
            title: "Work loop",
            description: "Main implementation and validation loop.",
            childBlockIds: ["do-work", "validate-work"],
            position: { x: 450, y: -80 },
            size: { width: 680, height: 360 },
          },
        ],
        edges: [
          { id: "start-to-wait", from: "start", fromOutput: "SUCCESS", to: "wait-before-work" },
          { id: "wait-to-work", from: "wait-before-work", fromOutput: "SUCCESS", to: "do-work" },
          { id: "work-to-validate", from: "do-work", fromOutput: "SUCCESS", to: "validate-work" },
          { id: "validate-done", from: "validate-work", fromOutput: "DONE", to: "success" },
          { id: "validate-continue", from: "validate-work", fromOutput: "CONTINUE", to: "do-work" },
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

type GeneratedRalphFlowSource =
  | "file"
  | "tagged-response"
  | "fenced-response"
  | "raw-response";

interface GeneratedRalphFlowReadResult {
  flow?: RalphFlow;
  source?: GeneratedRalphFlowSource;
  error?: string;
}

interface GeneratedRalphFlowJsonCandidate {
  source: Exclude<GeneratedRalphFlowSource, "file">;
  raw: string;
}

const RALPH_FLOW_JSON_TAG_PATTERN =
  /<ralph_flow_json>\s*([\s\S]*?)\s*<\/ralph_flow_json>/giu;
const FENCED_JSON_PATTERN = /```(?:json)?\s*([\s\S]*?)```/giu;

const looksLikeRalphFlowJsonText = (value: string): boolean => {
  const text = value.trim();

  return (
    text.includes('"schemaVersion"') &&
    text.includes('"blocks"') &&
    text.includes('"edges"')
  );
};

const getGenerationResultTextCandidates = (
  result: TaskExecutionResult,
): string[] => {
  const candidates = [
    result.response?.markdown,
    ...result.outputSections.map((section) => section.lines.join("\n")),
    result.summary,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const seen = new Set<string>();
  const uniqueCandidates: string[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }

    seen.add(candidate);
    uniqueCandidates.push(candidate);
  }

  return uniqueCandidates;
};

const extractGeneratedRalphFlowJsonCandidates = (
  text: string,
): GeneratedRalphFlowJsonCandidate[] => {
  const candidates: GeneratedRalphFlowJsonCandidate[] = [];

  for (const match of text.matchAll(RALPH_FLOW_JSON_TAG_PATTERN)) {
    const raw = match[1]?.trim();

    if (raw) {
      candidates.push({ source: "tagged-response", raw });
    }
  }

  for (const match of text.matchAll(FENCED_JSON_PATTERN)) {
    const raw = match[1]?.trim();

    if (raw && looksLikeRalphFlowJsonText(raw)) {
      candidates.push({ source: "fenced-response", raw });
    }
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{") && looksLikeRalphFlowJsonText(trimmed)) {
    candidates.push({ source: "raw-response", raw: trimmed });
  }

  return candidates;
};

const tryParseGeneratedRalphFlowJson = (
  raw: string,
): { flow?: RalphFlow; error?: string } => {
  try {
    return { flow: parseRalphFlowJson(raw) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const createGenerationAttemptFlowPath = (
  generationFlowPath: string,
  round: number,
): string => {
  const extension = extname(generationFlowPath) || FLOW_FILE_EXTENSION;
  const basePath = generationFlowPath.endsWith(extension)
    ? generationFlowPath.slice(0, -extension.length)
    : generationFlowPath;

  return `${basePath}-round-${round}${extension}`;
};

const readGeneratedRalphFlow = async (
  generationFlowPath: string,
  result: TaskExecutionResult,
): Promise<GeneratedRalphFlowReadResult> => {
  const errors: string[] = [];

  for (const text of getGenerationResultTextCandidates(result)) {
    for (const candidate of extractGeneratedRalphFlowJsonCandidates(text)) {
      const parsed = tryParseGeneratedRalphFlowJson(candidate.raw);

      if (parsed.flow) {
        return { flow: parsed.flow, source: candidate.source };
      }

      errors.push(
        `Generator ${candidate.source} JSON was invalid: ${parsed.error ?? "unknown error"}`,
      );
    }
  }

  if (existsSync(generationFlowPath)) {
    const parsed = tryParseGeneratedRalphFlowJson(
      await readFile(generationFlowPath, "utf8"),
    );

    if (parsed.flow) {
      return { flow: parsed.flow, source: "file" };
    }

    errors.push(
      `Generated file was not valid Ralph JSON: ${parsed.error ?? "unknown error"}`,
    );
  }

  return {
    error:
      errors.length > 0
        ? errors.join(" ")
        : "The generator did not create a parseable Ralph flow JSON object in its file output or final response.",
  };
};

interface RalphGenerationStructureValidation {
  decision: "DONE" | "RETRY";
  issues: string[];
}

const validateGeneratedRalphFlowStructure = (
  flow: RalphFlow,
): RalphGenerationStructureValidation => {
  const issues: string[] = [];

  if (
    hasGraphCycle(flow) &&
    flow.settings?.maxTransitions === undefined
  ) {
    issues.push(
      "The generated graph has a cycle but no settings.maxTransitions cap.",
    );
  }

  return {
    decision: issues.length === 0 ? "DONE" : "RETRY",
    issues,
  };
};

const createLocalGenerationValidatorResult = (
  task: string,
  config: RuntimeConfig,
  validation: RalphGenerationStructureValidation,
  durationMs: number,
): TaskExecutionResult => {
  const decisionLine = `RALPH_DECISION: ${validation.decision}`;
  const issueLines =
    validation.issues.length > 0
      ? validation.issues.map((issue) => `- ${issue}`)
      : ["No local structural issues found."];

  return {
    task,
    mode: config.mode,
    status: "executed",
    summary: `Local Ralph generation validator returned ${validation.decision}.`,
    executedTools: [],
    outputSections: [
      {
        title: "Local Ralph generation validator",
        lines: [
          `decision: ${validation.decision}`,
          `durationMs: ${durationMs}`,
          ...issueLines,
        ],
      },
    ],
    response: {
      markdown: [...issueLines, decisionLine].join("\n"),
      highlights: [],
      relatedFiles: [],
      verification: [],
      followUps: [],
    },
  };
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

const createTaskDidNotExecuteFeedback = (
  actor: "generator" | "validator",
  result: TaskExecutionResult,
): string => {
  return `The Ralph ${actor} did not execute successfully (${result.status}): ${
    result.reason ?? result.summary
  }`;
};

type EmitRalphGenerationEvent = (
  event: Omit<RalphGenerationEvent, "generationRunId" | "createdAt">,
) => Promise<void>;

const createGenerationActorResultMessage = (
  actor: RalphGenerationActor,
  result: TaskExecutionResult,
): string => {
  const summary = createGenerationFeedbackExcerpt(result.reason ?? result.summary);

  return result.status === "executed"
    ? `Ralph ${actor} completed.`
    : `Ralph ${actor} returned ${result.status}${summary ? `: ${summary}` : "."}`;
};

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

const createGenerationFeedbackExcerpt = (value: string | undefined): string => {
  const normalized = value?.replace(/\s+/gu, " ").trim() ?? "";

  return normalized.length > 1_200
    ? `${normalized.slice(0, 1_200)}...`
    : normalized;
};

const createGenerationDidNotConvergeSummary = (
  maxRounds: number,
  validation: RalphValidationResult,
  validatorFeedback: string | undefined,
): string => {
  const details: string[] = [];

  if (!validation.valid && validation.errors.length > 0) {
    details.push(`Last schema error: ${validation.errors[0]}`);
  }

  const feedback = createGenerationFeedbackExcerpt(validatorFeedback);

  if (feedback) {
    details.push(`Last feedback: ${feedback}`);
  }

  return [
    `Ralph flow generation did not converge after ${maxRounds} round(s).`,
    ...details,
  ].join(" ");
};

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
        config,
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
