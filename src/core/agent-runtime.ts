import Anthropic from "@anthropic-ai/sdk";
import type {
  Message as AnthropicMessage,
  MessageParam as AnthropicMessageParam,
  Tool as AnthropicTool,
} from "@anthropic-ai/sdk/resources/messages";
import {
  createPartFromFunctionResponse,
  FunctionCallingConfigMode,
  GoogleGenAI,
} from "@google/genai";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import OpenAI from "openai";
import {
  hasConfiguredValue,
  loadUserMemorySettings,
  loadWorkspaceEnv,
  rememberUserGlobalMemory,
} from "./env.js";
import {
  MAX_GLOBAL_MEMORY_ENTRIES,
  MAX_SESSION_MEMORY_ENTRIES,
  mergeConversationMemoryEntries,
  normalizeConversationMemoryEntries,
  rememberConversationMemoryEntry,
} from "./memory.js";
import type {
  AgentModelAdapter,
  AgentModelContinueParams,
  AgentModelStartParams,
  AgentModelToolCall,
  AgentModelToolResult,
  AgentModelToolSpec,
  AgentModelTurn,
  ConversationHistoryEntry,
  ConversationMemoryEntry,
  ResolvedTaskContext,
  RuntimeConfig,
  TaskAutopilotDecision,
  TaskAutopilotReport,
  TaskConversationContext,
  TaskExecutionFileReference,
  TaskExecutionMemoryUpdate,
  TaskExecutionNarrative,
  TaskExecutionProgressHandler,
  TaskExecutionResult,
  TaskExecutionSection,
  TaskExecutionState,
  ToolName,
  ToolRiskLevel,
} from "./types.js";
import {
  executeWebSearch,
  getConfiguredWebSearchProvider,
} from "./web-search.js";

const execFileAsync = promisify(execFile);

const MAX_EXECUTOR_TURNS = 16;
const MAX_AUTOPILOT_EXECUTOR_ITERATIONS = 4;
const MAX_OUTPUT_CHARS = 12_000;
const MAX_PREVIEW_LINES = 80;
const MAX_DIRECTORY_ENTRIES = 60;
const MAX_SEARCH_RESULTS = 25;
const MAX_TEXT_FILE_BYTES = 1_000_000;
const SHELL_TIMEOUT_MS = 30_000;
const TOOL_TRACE_PREVIEW_CHARS = 220;
const MAX_CONVERSATION_HISTORY_MESSAGES = 60;
const MAX_RECENT_HISTORY_MESSAGES = 8;
const MAX_RECENT_HISTORY_CHARS = 3_600;
const MAX_CONVERSATION_SUMMARY_INPUT_CHARS = 10_000;
const MAX_CONVERSATION_SUMMARY_SECTION_LINES = 12;
const MAX_MEMORY_PROMPT_ENTRIES = 10;
const IGNORED_SEARCH_DIRECTORIES = new Set([
  ".git",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "target",
]);

interface WorkspaceTarget {
  requestedPath: string;
  resolvedPath: string;
  insideWorkspace: boolean;
  workspacePath?: string;
}

interface AgentToolDefinition {
  spec: AgentModelToolSpec;
  backingTool: ToolName;
  riskLevel: ToolRiskLevel;
  execute: (
    args: Record<string, unknown>,
    context: AgentToolExecutionContext,
  ) => Promise<AgentToolExecutionResult>;
}

interface AgentToolExecutionContext {
  workspaceRoot: string;
  memory: ConversationMemoryRuntime;
}

interface AgentToolExecutionResult {
  toolResult: AgentModelToolResult;
  sections: TaskExecutionSection[];
  traceLines: string[];
  memoryUpdate?: TaskExecutionMemoryUpdate;
}

interface ApprovalPause {
  summary: string;
  reason: string;
  outputSections: TaskExecutionSection[];
}

interface AgentLoopState {
  executedTools: ToolName[];
  outputSections: TaskExecutionSection[];
  traceLines: string[];
  memoryUpdates: TaskExecutionMemoryUpdate[];
  lastAssistantText?: string;
  finalResponse?: TaskExecutionNarrative;
}

interface ConversationMemoryRuntime {
  sessionEnabled: boolean;
  sessionEntries: ConversationMemoryEntry[];
  globalEnabled: boolean;
  globalEntries: ConversationMemoryEntry[];
}

interface PreparedConversationPromptContext {
  promptBlock?: string;
  sections: TaskExecutionSection[];
  memory: ConversationMemoryRuntime;
}

interface TaskFinalResponsePayload extends TaskExecutionNarrative {
  summary: string;
}
const MAX_FINAL_RESPONSE_ITEMS = 4;

interface ModelDrivenExecutionParams {
  task: string;
  config: RuntimeConfig;
  taskContext: ResolvedTaskContext;
  contextSections: TaskExecutionSection[];
  conversationContext?: TaskConversationContext;
  modelAdapter?: AgentModelAdapter;
  monitorModelAdapter?: AgentModelAdapter;
  onStateChange?: TaskExecutionProgressHandler;
}

interface ExecutorContinuationRequest {
  continuationIndex: number;
  rationale: string;
  missingRequirements: string[];
  requiredActions: string[];
}

interface ExecutorCycleOutcome {
  loopState: AgentLoopState;
  result: TaskExecutionResult;
}

const createExecutionResult = (
  base: Omit<TaskExecutionResult, "reason">,
  reason?: string,
): TaskExecutionResult => {
  return {
    ...base,
    ...(reason ? { reason } : {}),
  };
};

const isTerminalAgentProgressState = (state: TaskExecutionState): boolean => {
  return (
    state === "completed" ||
    state === "approval-required" ||
    state === "blocked" ||
    state === "unsupported" ||
    state === "cancelled"
  );
};

const emitAgentProgress = async (
  task: string,
  config: RuntimeConfig,
  state: TaskExecutionState,
  message: string,
  loopState: AgentLoopState,
  onStateChange: TaskExecutionProgressHandler | undefined,
  result?: TaskExecutionResult,
): Promise<void> => {
  if (!onStateChange) {
    return;
  }

  await onStateChange({
    task,
    mode: config.mode,
    state,
    message,
    executedTools: result?.executedTools ?? loopState.executedTools,
    outputSections: result?.outputSections ?? loopState.outputSections,
    cancellable: !isTerminalAgentProgressState(state),
    ...(result?.reason ? { reason: result.reason } : {}),
  });
};

const normalizeWorkspacePath = (value: string): string => {
  const normalized = value
    .replace(/\\/g, "/")
    .replace(/^\.\//u, "")
    .replace(/^\/+/u, "")
    .replace(/\/+/gu, "/")
    .replace(/\/$/u, "");

  return normalized === "." ? "" : normalized;
};

const isPathInsideWorkspace = (
  workspaceRoot: string,
  candidatePath: string,
): boolean => {
  const relativePath = relative(workspaceRoot, candidatePath);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
};

const resolveWorkspaceTarget = (
  workspaceRoot: string,
  requestedPath: string,
): WorkspaceTarget => {
  const resolvedPath = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(workspaceRoot, requestedPath);
  const insideWorkspace = isPathInsideWorkspace(workspaceRoot, resolvedPath);

  return {
    requestedPath,
    resolvedPath,
    insideWorkspace,
    ...(insideWorkspace
      ? {
          workspacePath: normalizeWorkspacePath(
            relative(workspaceRoot, resolvedPath),
          ),
        }
      : {}),
  };
};

const createLinesFromText = (
  text: string,
  maxLines = MAX_PREVIEW_LINES,
  startLine = 1,
): string[] => {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const previewLines = lines
    .slice(0, maxLines)
    .map((line, index) => `${startLine + index}: ${line}`);

  if (lines.length > maxLines) {
    previewLines.push(`… truncated after ${maxLines} of ${lines.length} lines`);
  }

  return previewLines;
};

const createTextSection = (
  title: string,
  text: string,
  maxLines = MAX_PREVIEW_LINES,
  startLine = 1,
): TaskExecutionSection => {
  const previewLines = createLinesFromText(text, maxLines, startLine);

  return {
    title,
    lines: previewLines.length > 0 ? previewLines : ["(empty)"],
  };
};

const limitText = (value: string, maxChars = MAX_OUTPUT_CHARS): string => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n… truncated after ${maxChars} characters`;
};

const compactTraceText = (value: string): string => {
  const compacted = value.replace(/\s+/g, " ").trim();

  if (compacted.length <= TOOL_TRACE_PREVIEW_CHARS) {
    return compacted;
  }

  return `${compacted.slice(0, TOOL_TRACE_PREVIEW_CHARS)}…`;
};

const stringifyUnknown = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const normalizeFinalSummary = (text: string | undefined): string => {
  const normalized = text?.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "Completed the task with the model-driven execution loop.";
  }

  if (normalized.length <= 220) {
    return normalized;
  }

  return `${normalized.slice(0, 220)}…`;
};

const attachAutopilotReport = (
  result: TaskExecutionResult,
  report: TaskAutopilotReport,
): TaskExecutionResult => {
  return {
    ...result,
    outputSections: [
      ...result.outputSections,
      createAutopilotAuditSection(report),
    ],
    autopilot: report,
  };
};

const isBinaryBuffer = (buffer: Buffer): boolean => {
  return buffer.includes(0);
};

const sortEntryNames = (left: string, right: string): number => {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
};

const coerceString = (
  record: Record<string, unknown>,
  field: string,
): string | undefined => {
  const value = record[field];

  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
};

const coerceBoolean = (
  record: Record<string, unknown>,
  field: string,
): boolean | undefined => {
  const value = record[field];

  return typeof value === "boolean" ? value : undefined;
};

const coerceInteger = (
  record: Record<string, unknown>,
  field: string,
): number | undefined => {
  const value = record[field];

  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
};

const coerceStringArray = (
  record: Record<string, unknown>,
  field: string,
): string[] | undefined => {
  const value = record[field];

  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.flatMap((entry) =>
    typeof entry === "string" && entry.trim().length > 0 ? [entry.trim()] : [],
  );
};

const coerceFileReferenceArray = (
  record: Record<string, unknown>,
  field: string,
): TaskExecutionFileReference[] | undefined => {
  const value = record[field];

  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }

    const reference = entry as Record<string, unknown>;
    const path = coerceString(reference, "path");
    const description = coerceString(reference, "description");

    if (!path || !description) {
      return [];
    }

    return [{ path, description }];
  });
};

const normalizeConversationHistory = (
  history: ConversationHistoryEntry[] | undefined,
): ConversationHistoryEntry[] => {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }

      const role: ConversationHistoryEntry["role"] =
        entry.role === "assistant" ? "assistant" : "user";
      const content =
        typeof entry.content === "string" ? entry.content.trim() : "";

      if (content.length === 0) {
        return [];
      }

      return [
        {
          role,
          content,
          ...(typeof entry.createdAt === "number"
            ? { createdAt: entry.createdAt }
            : {}),
        },
      ];
    })
    .slice(-MAX_CONVERSATION_HISTORY_MESSAGES);
};

const formatConversationHistoryEntry = (
  entry: ConversationHistoryEntry,
): string => {
  return `${entry.role}: ${entry.content}`;
};

const createConversationTranscript = (
  history: ConversationHistoryEntry[],
): string => {
  return history.map(formatConversationHistoryEntry).join("\n\n");
};

const createDeterministicConversationSummary = (
  history: ConversationHistoryEntry[],
): string | undefined => {
  if (history.length === 0) {
    return undefined;
  }

  const summaryLines = history.slice(-6).map((entry) => {
    const prefix = entry.role === "assistant" ? "Assistant" : "User";
    return `- ${prefix}: ${compactTraceText(entry.content)}`;
  });

  return ["Earlier session context (fallback summary):", ...summaryLines].join(
    "\n",
  );
};

const createRecentHistoryWindow = (
  history: ConversationHistoryEntry[],
): {
  omittedHistory: ConversationHistoryEntry[];
  recentHistory: ConversationHistoryEntry[];
} => {
  const recentHistory: ConversationHistoryEntry[] = [];
  let totalChars = 0;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];

    if (!entry) {
      continue;
    }

    const nextChars = totalChars + entry.content.length;

    if (
      recentHistory.length >= MAX_RECENT_HISTORY_MESSAGES ||
      (recentHistory.length > 0 && nextChars > MAX_RECENT_HISTORY_CHARS)
    ) {
      break;
    }

    recentHistory.unshift(entry);
    totalChars = nextChars;
  }

  return {
    omittedHistory: history.slice(
      0,
      Math.max(0, history.length - recentHistory.length),
    ),
    recentHistory,
  };
};

const createMemoryLines = (entries: ConversationMemoryEntry[]): string[] => {
  return entries
    .slice(0, MAX_MEMORY_PROMPT_ENTRIES)
    .map((entry) => entry.content);
};

const summarizeConversationHistory = async (
  task: string,
  config: RuntimeConfig,
  history: ConversationHistoryEntry[],
): Promise<string | undefined> => {
  if (history.length === 0) {
    return undefined;
  }

  const adapter = await createProviderAdapter(config, [], undefined);

  if (!adapter) {
    return undefined;
  }

  const transcript = createConversationTranscript(history);

  try {
    const turn = await adapter.startTurn({
      model: config.model,
      systemPrompt: [
        "You summarize prior chat context for a coding agent.",
        "Extract only durable facts that matter for the next turn: user preferences, goals, decisions, relevant files, blockers, and unresolved follow-ups.",
        "Keep the summary compact, factual, and grounded in the transcript.",
        "Use plain Markdown bullets and do not invent anything.",
      ].join("\n"),
      userPrompt: [
        `Current task: ${task}`,
        "Summarize the earlier conversation below so the next task can continue with the right context.",
        "Transcript:",
        transcript.slice(0, MAX_CONVERSATION_SUMMARY_INPUT_CHARS),
      ].join("\n\n"),
      tools: [],
    });

    const summary = turn.text.trim();

    return summary.length > 0 ? limitText(summary, 1_500) : undefined;
  } catch {
    return undefined;
  }
};

const prepareConversationPromptContext = async (
  task: string,
  config: RuntimeConfig,
  conversationContext: TaskConversationContext | undefined,
): Promise<PreparedConversationPromptContext> => {
  const normalizedHistory = normalizeConversationHistory(
    conversationContext?.history,
  );
  const sessionEnabled = conversationContext?.sessionMemoryEnabled !== false;
  const sessionEntries = sessionEnabled
    ? normalizeConversationMemoryEntries(
        conversationContext?.sessionMemory,
        "session",
      )
    : [];
  const storedGlobalMemory = await loadUserMemorySettings();
  const globalEnabled =
    conversationContext?.globalMemoryEnabled ??
    storedGlobalMemory.globalEnabled;
  const globalEntries = globalEnabled
    ? normalizeConversationMemoryEntries(
        conversationContext?.globalMemory ?? storedGlobalMemory.entries,
        "global",
      )
    : [];
  const { omittedHistory, recentHistory } =
    createRecentHistoryWindow(normalizedHistory);
  const summary =
    omittedHistory.length > 0
      ? ((await summarizeConversationHistory(task, config, omittedHistory)) ??
        createDeterministicConversationSummary(omittedHistory))
      : undefined;
  const recentHistoryLines = recentHistory.map(formatConversationHistoryEntry);
  const sessionMemoryLines = createMemoryLines(sessionEntries);
  const globalMemoryLines = createMemoryLines(globalEntries);
  const promptSections = [
    summary
      ? [
          "<earlier_conversation_summary>",
          summary,
          "</earlier_conversation_summary>",
        ].join("\n")
      : undefined,
    recentHistoryLines.length > 0
      ? [
          "<recent_conversation>",
          ...recentHistoryLines,
          "</recent_conversation>",
        ].join("\n")
      : undefined,
    sessionMemoryLines.length > 0
      ? [
          "<session_memory>",
          ...sessionMemoryLines.map((line) => `- ${line}`),
          "</session_memory>",
        ].join("\n")
      : undefined,
    globalMemoryLines.length > 0
      ? [
          "<global_memory>",
          ...globalMemoryLines.map((line) => `- ${line}`),
          "</global_memory>",
        ].join("\n")
      : undefined,
  ].filter((section): section is string => typeof section === "string");

  return {
    ...(promptSections.length > 0
      ? {
          promptBlock: [
            "<conversation_context>",
            ...promptSections,
            "</conversation_context>",
          ].join("\n\n"),
        }
      : {}),
    sections: [
      ...(summary || recentHistoryLines.length > 0
        ? [
            {
              title: "Conversation context",
              lines: [
                `recent messages included: ${recentHistoryLines.length}`,
                `earlier messages summarized: ${summary ? "yes" : "no"}`,
                `session memory enabled: ${sessionEnabled ? "yes" : "no"}`,
                `global memory enabled: ${globalEnabled ? "yes" : "no"}`,
              ],
            },
          ]
        : []),
      ...(summary
        ? [
            createTextSection(
              "Conversation summary",
              summary,
              MAX_CONVERSATION_SUMMARY_SECTION_LINES,
            ),
          ]
        : []),
      ...(recentHistoryLines.length > 0
        ? [
            {
              title: "Recent conversation",
              lines: recentHistoryLines,
            },
          ]
        : []),
      ...(sessionMemoryLines.length > 0
        ? [
            {
              title: "Session memory",
              lines: sessionMemoryLines,
            },
          ]
        : []),
      ...(globalMemoryLines.length > 0
        ? [
            {
              title: "Global memory",
              lines: globalMemoryLines,
            },
          ]
        : []),
    ],
    memory: {
      sessionEnabled,
      sessionEntries,
      globalEnabled,
      globalEntries,
    },
  };
};

const upsertMemoryUpdate = (
  updates: TaskExecutionMemoryUpdate[],
  nextUpdate: TaskExecutionMemoryUpdate,
): TaskExecutionMemoryUpdate[] => {
  const existingWithoutScope = updates.filter(
    (update) =>
      !(
        update.scope === nextUpdate.scope &&
        update.entry.content.toLowerCase() ===
          nextUpdate.entry.content.toLowerCase()
      ),
  );

  return [...existingWithoutScope, nextUpdate];
};

const FINAL_RESPONSE_TOOL_NAME = "submit_final_response";

const createAutopilotAuditSection = (
  report: TaskAutopilotReport,
): TaskExecutionSection => {
  return {
    title: "Autopilot audit",
    lines: [
      `executor iterations: ${report.executorIterations}/${report.maxExecutorIterations}`,
      `validator passes: ${report.validatorPasses}`,
      `validator continuation requests: ${report.continuationCount}`,
      ...report.decisions.flatMap((decision) => [
        `pass ${decision.pass}: ${decision.decision} (${decision.confidence})`,
        `  rationale: ${decision.rationale}`,
        ...(decision.missingRequirements.length > 0
          ? [
              `  missing requirements: ${decision.missingRequirements.join(", ")}`,
            ]
          : []),
        ...(decision.requiredActions.length > 0
          ? [`  required actions: ${decision.requiredActions.join(", ")}`]
          : []),
      ]),
    ],
  };
};

const createFinalResponseTool = (): AgentModelToolSpec => {
  return {
    name: FINAL_RESPONSE_TOOL_NAME,
    description:
      "Submit the final user-facing response after the task is actually complete. Call this exactly once, as the only tool in the turn, when no further execution is required.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: {
          type: "string",
          description:
            "A concise plain-text completion summary for the activity feed and task card.",
        },
        markdown: {
          type: "string",
          description:
            "A compact GitHub-flavored Markdown answer for the user. Keep it brief, scannable, and grounded in actual tool results.",
        },
        highlights: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_FINAL_RESPONSE_ITEMS,
          description:
            "Short insight bullets that add value beyond the summary. Use an empty array when no extra highlights are needed.",
        },
        relatedFiles: {
          type: "array",
          maxItems: MAX_FINAL_RESPONSE_ITEMS,
          description:
            "Workspace-relative files that were changed or are especially relevant to the result.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: {
                type: "string",
                description: "Workspace-relative file path.",
              },
              description: {
                type: "string",
                description: "Short explanation of why the file matters.",
              },
            },
            required: ["path", "description"],
          },
        },
        verification: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_FINAL_RESPONSE_ITEMS,
          description:
            "Concrete checks or evidence used to verify the result. Use an empty array when verification was not possible.",
        },
        followUps: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_FINAL_RESPONSE_ITEMS,
          description:
            "Short remaining caveats or next steps. Use an empty array when none remain.",
        },
      },
      required: [
        "summary",
        "markdown",
        "highlights",
        "relatedFiles",
        "verification",
        "followUps",
      ],
    },
  };
};

const parseFinalResponsePayload = (
  record: Record<string, unknown>,
): TaskFinalResponsePayload | undefined => {
  const summary = coerceString(record, "summary");
  const markdown = coerceString(record, "markdown");
  const highlights = coerceStringArray(record, "highlights");
  const relatedFiles = coerceFileReferenceArray(record, "relatedFiles");
  const verification = coerceStringArray(record, "verification");
  const followUps = coerceStringArray(record, "followUps");

  if (
    !summary ||
    !markdown ||
    !highlights ||
    !relatedFiles ||
    !verification ||
    !followUps
  ) {
    return undefined;
  }

  return {
    summary,
    markdown,
    highlights,
    relatedFiles,
    verification,
    followUps,
  };
};

const createFinalResponseSections = (
  response: TaskExecutionNarrative,
): TaskExecutionSection[] => {
  return [
    createTextSection("Agent response", limitText(response.markdown)),
    ...(response.highlights.length > 0
      ? [
          {
            title: "Highlights",
            lines: response.highlights,
          },
        ]
      : []),
    ...(response.relatedFiles.length > 0
      ? [
          {
            title: "Related files",
            lines: response.relatedFiles.map(
              (fileReference) =>
                `${fileReference.path} — ${fileReference.description}`,
            ),
          },
        ]
      : []),
    ...(response.verification.length > 0
      ? [
          {
            title: "Verification",
            lines: response.verification,
          },
        ]
      : []),
    ...(response.followUps.length > 0
      ? [
          {
            title: "Follow-up",
            lines: response.followUps,
          },
        ]
      : []),
  ];
};

const createFinalResponseToolResult = (
  callId: string,
  output: string,
  isError = false,
): AgentModelToolResult => {
  return {
    callId,
    name: FINAL_RESPONSE_TOOL_NAME,
    output,
    ...(isError ? { isError: true } : {}),
  };
};

const createToolErrorResult = (
  callId: string,
  name: string,
  message: string,
  sections: TaskExecutionSection[] = [],
): AgentToolExecutionResult => {
  return {
    toolResult: {
      callId,
      name,
      output: message,
      isError: true,
    },
    sections,
    traceLines: [`${name}: ${message}`],
  };
};

const resolveActionDecision = (
  config: RuntimeConfig,
  tool: ToolName,
  riskLevel: ToolRiskLevel,
): { decision: "allow" | "ask" | "blocked"; reason: string } => {
  if (!config.enabledTools.includes(tool)) {
    return {
      decision: "blocked",
      reason:
        "This tool is not enabled in `.machdoch/config.json`, so the runtime refused to execute it.",
    };
  }

  if (config.mode === "safe") {
    return {
      decision: "ask",
      reason:
        "Safe mode never auto-executes tools; explicit approval is required first.",
    };
  }

  if (config.mode === "ask" && riskLevel !== "low") {
    return {
      decision: "ask",
      reason:
        "This action is medium/high risk and requires approval in ask mode before execution.",
    };
  }

  return {
    decision: "allow",
    reason:
      config.mode === "auto"
        ? "Auto mode allows enabled tools to run automatically within the workspace policy."
        : "This action is low risk and can proceed automatically in ask mode.",
  };
};

const createApprovalPause = (
  task: string,
  loopState: AgentLoopState,
  toolDefinition: AgentToolDefinition,
  call: AgentModelToolCall,
  reason: string,
): ApprovalPause => {
  const argsPreview = limitText(stringifyUnknown(call.arguments), 500);
  const approvalSections: TaskExecutionSection[] = [
    ...loopState.outputSections,
    {
      title: "Approval required",
      lines: [
        `task: ${task}`,
        `tool: ${call.name}`,
        `backing tool: ${toolDefinition.backingTool}`,
        `risk: ${toolDefinition.riskLevel}`,
        `reason: ${reason}`,
      ],
    },
    createTextSection("Requested arguments", argsPreview),
  ];

  if (loopState.traceLines.length > 0) {
    approvalSections.push({
      title: "Tool trace",
      lines: loopState.traceLines,
    });
  }

  return {
    summary: `The model requested \`${call.name}\`, but the current runtime mode requires approval before it can continue.`,
    reason,
    outputSections: approvalSections,
  };
};

const createAssistantAnswerSection = (text: string): TaskExecutionSection => {
  return createTextSection("Agent answer", limitText(text));
};

const stripHtmlToText = (html: string): string => {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/giu, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/giu, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
};

const createSearchScope = async (
  directoryPath: string,
  files: string[],
): Promise<string[]> => {
  const entries = await readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = resolve(directoryPath, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_SEARCH_DIRECTORIES.has(entry.name)) {
        continue;
      }

      await createSearchScope(fullPath, files);
      continue;
    }

    files.push(fullPath);
  }

  return files;
};

const createOpenAITools = (tools: AgentModelToolSpec[]) => {
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: true,
  }));
};

const createAnthropicTools = (tools: AgentModelToolSpec[]): AnthropicTool[] => {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      ...(tool.inputSchema as Record<string, unknown>),
      type: "object",
    },
    strict: true,
  }));
};

const createGeminiTools = (tools: AgentModelToolSpec[]) => {
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.inputSchema,
      })),
    },
  ];
};

class OpenAIResponsesAdapter implements AgentModelAdapter {
  private readonly client: OpenAI;
  private readonly tools: AgentModelToolSpec[];
  private previousResponseId?: string;
  private startParams?: AgentModelStartParams;

  constructor(client: OpenAI, tools: AgentModelToolSpec[]) {
    this.client = client;
    this.tools = tools;
  }

  async startTurn(params: AgentModelStartParams): Promise<AgentModelTurn> {
    this.startParams = params;

    const response = await this.client.responses.create({
      model: params.model,
      instructions: params.systemPrompt,
      input: params.userPrompt,
      tools: createOpenAITools(params.tools),
      parallel_tool_calls: false,
    });

    this.previousResponseId = response.id;
    return this.normalizeResponse(response);
  }

  async continueTurn(
    params: AgentModelContinueParams,
  ): Promise<AgentModelTurn> {
    if (!this.startParams || !this.previousResponseId) {
      throw new Error("The OpenAI adapter cannot continue before it starts.");
    }

    const response = await this.client.responses.create({
      model: this.startParams.model,
      instructions: this.startParams.systemPrompt,
      previous_response_id: this.previousResponseId,
      input: params.toolResults.map((toolResult) => ({
        type: "function_call_output" as const,
        call_id: toolResult.callId,
        output: toolResult.output,
      })),
      tools: createOpenAITools(this.tools),
      parallel_tool_calls: false,
    });

    this.previousResponseId = response.id;
    return this.normalizeResponse(response);
  }

  private normalizeResponse(response: {
    output?: Array<{
      type?: string;
      name?: string;
      arguments?: unknown;
      call_id?: string | null;
    }>;
    output_text?: string | undefined;
  }): AgentModelTurn {
    const toolCalls: AgentModelToolCall[] = [];

    for (const outputItem of response.output ?? []) {
      if (outputItem.type !== "function_call") {
        continue;
      }

      let parsedArguments: Record<string, unknown> = {};

      if (typeof outputItem.arguments === "string") {
        try {
          const parsed = JSON.parse(outputItem.arguments) as unknown;

          if (typeof parsed === "object" && parsed !== null) {
            parsedArguments = parsed as Record<string, unknown>;
          }
        } catch {
          parsedArguments = {};
        }
      }

      toolCalls.push({
        id:
          typeof outputItem.call_id === "string" &&
          outputItem.call_id.length > 0
            ? outputItem.call_id
            : crypto.randomUUID(),
        name: outputItem.name ?? "unknown_tool",
        arguments: parsedArguments,
        ...(typeof outputItem.arguments === "string"
          ? { rawArguments: outputItem.arguments }
          : {}),
      });
    }

    return {
      text: response.output_text?.trim() ?? "",
      toolCalls,
    };
  }
}

class AnthropicMessagesAdapter implements AgentModelAdapter {
  private readonly client: Anthropic;
  private readonly tools: AgentModelToolSpec[];
  private readonly messages: AnthropicMessageParam[] = [];
  private startParams?: AgentModelStartParams;

  constructor(client: Anthropic, tools: AgentModelToolSpec[]) {
    this.client = client;
    this.tools = tools;
  }

  async startTurn(params: AgentModelStartParams): Promise<AgentModelTurn> {
    this.startParams = params;
    this.messages.length = 0;
    this.messages.push({
      role: "user",
      content: params.userPrompt,
    });

    const message = await this.client.messages.create({
      model: params.model,
      max_tokens: 4_096,
      system: params.systemPrompt,
      messages: this.messages,
      tools: createAnthropicTools(params.tools),
    });

    this.messages.push({
      role: "assistant",
      content: message.content as AnthropicMessageParam["content"],
    });

    return this.normalizeResponse(message);
  }

  async continueTurn(
    params: AgentModelContinueParams,
  ): Promise<AgentModelTurn> {
    if (!this.startParams) {
      throw new Error(
        "The Anthropic adapter cannot continue before it starts.",
      );
    }

    this.messages.push({
      role: "user",
      content: params.toolResults.map((toolResult) => ({
        type: "tool_result" as const,
        tool_use_id: toolResult.callId,
        content: toolResult.output,
        ...(toolResult.isError ? { is_error: true } : {}),
      })) as AnthropicMessageParam["content"],
    });

    const message = await this.client.messages.create({
      model: this.startParams.model,
      max_tokens: 4_096,
      system: this.startParams.systemPrompt,
      messages: this.messages,
      tools: createAnthropicTools(this.tools),
    });

    this.messages.push({
      role: "assistant",
      content: message.content as AnthropicMessageParam["content"],
    });

    return this.normalizeResponse(message);
  }

  private normalizeResponse(
    message: Pick<AnthropicMessage, "content" | "stop_reason">,
  ): AgentModelTurn {
    const toolCalls: AgentModelToolCall[] = [];
    const textParts: string[] = [];

    for (const contentBlock of message.content) {
      if (
        contentBlock.type === "text" &&
        typeof contentBlock.text === "string"
      ) {
        textParts.push(contentBlock.text);
        continue;
      }

      if (contentBlock.type !== "tool_use") {
        continue;
      }

      toolCalls.push({
        id: contentBlock.id ?? crypto.randomUUID(),
        name: contentBlock.name ?? "unknown_tool",
        arguments:
          typeof contentBlock.input === "object" && contentBlock.input !== null
            ? (contentBlock.input as Record<string, unknown>)
            : {},
      });
    }

    return {
      text: textParts.join("\n").trim(),
      toolCalls,
      ...(message.stop_reason ? { stopReason: message.stop_reason } : {}),
    };
  }
}

class GeminiChatAdapter implements AgentModelAdapter {
  private readonly chat: ReturnType<GoogleGenAI["chats"]["create"]>;
  private readonly tools: AgentModelToolSpec[];
  private startParams?: AgentModelStartParams;

  private createConfig(tools: AgentModelToolSpec[]) {
    if (tools.length === 0) {
      return {
        automaticFunctionCalling: {
          disable: true,
        },
      };
    }

    return {
      tools: createGeminiTools(tools),
      toolConfig: {
        functionCallingConfig: {
          mode: FunctionCallingConfigMode.ANY,
          allowedFunctionNames: tools.map((tool) => tool.name),
        },
      },
      automaticFunctionCalling: {
        disable: true,
      },
    };
  }

  constructor(client: GoogleGenAI, model: string, tools: AgentModelToolSpec[]) {
    this.tools = tools;
    this.chat = client.chats.create({
      model,
      config: this.createConfig(tools),
    });
  }

  async startTurn(params: AgentModelStartParams): Promise<AgentModelTurn> {
    this.startParams = params;

    const response = await this.chat.sendMessage({
      message: params.userPrompt,
      config: {
        systemInstruction: params.systemPrompt,
        ...this.createConfig(params.tools),
      },
    });

    return this.normalizeResponse(response);
  }

  async continueTurn(
    params: AgentModelContinueParams,
  ): Promise<AgentModelTurn> {
    if (!this.startParams) {
      throw new Error("The Gemini adapter cannot continue before it starts.");
    }

    const response = await this.chat.sendMessage({
      message: params.toolResults.map((toolResult) =>
        createPartFromFunctionResponse(toolResult.callId, toolResult.name, {
          output: toolResult.output,
          isError: toolResult.isError === true,
        }),
      ),
      config: {
        systemInstruction: this.startParams.systemPrompt,
        ...this.createConfig(this.tools),
      },
    });

    return this.normalizeResponse(response);
  }

  private normalizeResponse(response: {
    text?: string | undefined;
    functionCalls?:
      | Array<{
          id?: string | undefined;
          name?: string | undefined;
          args?: Record<string, unknown> | undefined;
        }>
      | undefined;
  }): AgentModelTurn {
    return {
      text: response.text?.trim() ?? "",
      toolCalls: (response.functionCalls ?? []).map((functionCall) => ({
        id: functionCall.id ?? crypto.randomUUID(),
        name: functionCall.name ?? "unknown_tool",
        arguments: functionCall.args ?? {},
      })),
    };
  }
}

const createProviderAdapter = async (
  config: RuntimeConfig,
  tools: AgentModelToolSpec[],
  overrideAdapter: AgentModelAdapter | undefined,
): Promise<AgentModelAdapter | undefined> => {
  if (overrideAdapter) {
    return overrideAdapter;
  }

  if (config.provider === "unconfigured" || config.offline) {
    return undefined;
  }

  const env = await loadWorkspaceEnv(config.workspaceRoot);

  switch (config.provider) {
    case "openai": {
      if (!hasConfiguredValue(env.OPENAI_API_KEY)) {
        return undefined;
      }

      return new OpenAIResponsesAdapter(
        new OpenAI({
          apiKey: env.OPENAI_API_KEY,
        }),
        tools,
      );
    }

    case "anthropic": {
      if (!hasConfiguredValue(env.ANTHROPIC_API_KEY)) {
        return undefined;
      }

      return new AnthropicMessagesAdapter(
        new Anthropic({
          apiKey: env.ANTHROPIC_API_KEY,
        }),
        tools,
      );
    }

    case "google": {
      const apiKey = env.GOOGLE_API_KEY;

      if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
        return undefined;
      }

      return new GeminiChatAdapter(
        new GoogleGenAI({ apiKey }),
        config.model,
        tools,
      );
    }
  }
};

const createExecutorSystemPrompt = (
  config: RuntimeConfig,
  taskContext: ResolvedTaskContext,
  tools: AgentModelToolSpec[],
  conversationContext: PreparedConversationPromptContext,
  continuationRequest?: ExecutorContinuationRequest,
): string => {
  const instructionLines =
    taskContext.applicableInstructions.length > 0
      ? taskContext.applicableInstructions.map(
          (instruction) => `${instruction.name}: ${instruction.body}`,
        )
      : ["No additional task-specific instructions were discovered."];
  const promptContextLines = taskContext.invokedPrompt
    ? [
        `Resolved prompt: /${taskContext.invokedPrompt.name}`,
        `Prompt body: ${taskContext.invokedPrompt.resolvedBody}`,
      ]
    : ["Resolved prompt: none"];

  return [
    "<role>You are Machdoch Executor, a local-first autonomous workspace agent responsible for doing the work rather than grading it.</role>",
    "<mission>Keep working until the task is complete, blocked by a real runtime limitation, or paused for approval. Use tools instead of guessing, and never claim a change, command, or fetched result unless a tool actually produced it.</mission>",
    "<operating_principles>Prefer low-risk inspection before edits. Before editing an existing file, inspect it first. Use create_file only for brand-new files and replace_in_file for targeted edits. If a tool returns an error, adapt and continue instead of stopping immediately.</operating_principles>",
    config.mode === "auto"
      ? "<autopilot_contract>You are running in Autopilot mode. A separate monitor agent will review every claimed completion. Before you stop, gather concrete verification evidence from tool results. If monitor feedback is provided, treat every missing requirement and required action as mandatory for the next iteration.</autopilot_contract>"
      : "<approval_contract>If a higher-risk action is necessary, call the tool anyway; the runtime will pause automatically if approval is required.</approval_contract>",
    continuationRequest
      ? [
          "<monitor_feedback>",
          `This is continuation iteration ${continuationRequest.continuationIndex}.`,
          `Rationale: ${continuationRequest.rationale}`,
          continuationRequest.missingRequirements.length > 0
            ? `Missing requirements: ${continuationRequest.missingRequirements.join(", ")}`
            : "Missing requirements: none listed",
          continuationRequest.requiredActions.length > 0
            ? `Required actions: ${continuationRequest.requiredActions.join(", ")}`
            : "Required actions: none listed",
          "You must address this feedback before claiming completion again.",
          "</monitor_feedback>",
        ].join("\n")
      : "<monitor_feedback>No prior monitor feedback has been issued for this task.</monitor_feedback>",
    [
      "<runtime>",
      `Workspace root: ${config.workspaceRoot}`,
      `Runtime mode: ${config.mode}`,
      `Selected provider: ${config.provider}`,
      `Selected model: ${config.model}`,
      `Enabled high-level tools: ${config.enabledTools.join(", ")}`,
      `Available agent tools: ${tools.map((tool) => tool.name).join(", ")}`,
      ...promptContextLines,
      "</runtime>",
    ].join("\n"),
    ["<instructions>", ...instructionLines, "</instructions>"].join("\n"),
    [
      "<memory_contract>",
      conversationContext.memory.sessionEnabled
        ? "Session memory is enabled. Use `remember_session_memory` for facts, preferences, or decisions that should matter later in this same session."
        : "Session memory is disabled for this run.",
      conversationContext.memory.globalEnabled
        ? "Global memory is enabled. Use `remember_global_memory` only for durable cross-session preferences or facts that will still matter in later sessions."
        : "Global memory is disabled for this run.",
      "Never store transient tool output, secrets, or speculative guesses as memory.",
      "</memory_contract>",
    ].join("\n"),
    "<final_response_contract>When the task is complete, call `submit_final_response` exactly once and make it the only tool call in that turn. The markdown must stay compact, use standard Markdown, prefer short bullet lists over long prose, and only mention files or checks that are grounded in actual tool output. Put workspace file references in `relatedFiles` instead of inventing inline file URLs.</final_response_contract>",
    "<completion_requirements>Only stop when the user request is actually satisfied and you have tool-grounded evidence for that conclusion. Do not end with freeform prose alone when you can return the structured final response.</completion_requirements>",
  ].join("\n\n");
};

const createExecutorUserPrompt = (
  task: string,
  taskContext: ResolvedTaskContext,
  conversationContext: PreparedConversationPromptContext,
  continuationRequest?: ExecutorContinuationRequest,
): string => {
  return [
    `<original_task>${task}</original_task>`,
    `<effective_task>${taskContext.effectiveTask}</effective_task>`,
    `<workspace_paths>${taskContext.workspacePaths.length > 0 ? taskContext.workspacePaths.join(", ") : "none"}</workspace_paths>`,
    continuationRequest
      ? `<current_goal>Continue the task and satisfy the monitor feedback from continuation ${continuationRequest.continuationIndex}.</current_goal>`
      : "<current_goal>Complete the task by using tools, checking the results, and continuing until the work is done.</current_goal>",
    ...(conversationContext.promptBlock
      ? [conversationContext.promptBlock]
      : []),
  ].join("\n");
};

const AUTOPILOT_MONITOR_TOOL_NAME = "report_autopilot_decision";

const createAutopilotMonitorTool = (): AgentModelToolSpec => {
  return {
    name: AUTOPILOT_MONITOR_TOOL_NAME,
    description:
      "Return the structured validation decision for the latest executor iteration. Call this exactly once after reviewing the grounded evidence.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        decision: {
          type: "string",
          enum: ["complete", "continue"],
          description:
            "Use `complete` only when the user request is fully satisfied with sufficient evidence. Otherwise use `continue`.",
        },
        confidence: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Your confidence in the validation judgment.",
        },
        rationale: {
          type: "string",
          description:
            "A concise explanation referencing grounded evidence or missing evidence.",
        },
        missingRequirements: {
          type: "array",
          items: { type: "string" },
          description:
            "Concrete requirements that are still unmet or not yet verified.",
        },
        requiredActions: {
          type: "array",
          items: { type: "string" },
          description:
            "Concrete next actions the executor should take before the task can be accepted.",
        },
      },
      required: [
        "decision",
        "confidence",
        "rationale",
        "missingRequirements",
        "requiredActions",
      ],
    },
  };
};

const extractJsonCandidate = (value: string): string | undefined => {
  const trimmed = value.trim();

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const startIndex = trimmed.indexOf("{");
  const endIndex = trimmed.lastIndexOf("}");

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return undefined;
  }

  return trimmed.slice(startIndex, endIndex + 1);
};

const parseAutopilotDecisionRecord = (
  record: Record<string, unknown>,
  pass: number,
): TaskAutopilotDecision | undefined => {
  const decision = coerceString(record, "decision");
  const confidence = coerceString(record, "confidence");
  const rationale = coerceString(record, "rationale");
  const missingRequirements = coerceStringArray(record, "missingRequirements");
  const requiredActions = coerceStringArray(record, "requiredActions");

  if (
    (decision !== "complete" && decision !== "continue") ||
    (confidence !== "low" &&
      confidence !== "medium" &&
      confidence !== "high") ||
    !rationale ||
    !missingRequirements ||
    !requiredActions
  ) {
    return undefined;
  }

  return {
    pass,
    decision,
    confidence,
    rationale,
    missingRequirements,
    requiredActions,
  };
};

const parseAutopilotDecisionFromTurn = (
  turn: AgentModelTurn,
  pass: number,
): TaskAutopilotDecision | undefined => {
  const toolCall = turn.toolCalls.find(
    (call) => call.name === AUTOPILOT_MONITOR_TOOL_NAME,
  );

  if (toolCall) {
    return parseAutopilotDecisionRecord(toolCall.arguments, pass);
  }

  const jsonCandidate = extractJsonCandidate(turn.text);

  if (!jsonCandidate) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(jsonCandidate) as unknown;

    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }

    return parseAutopilotDecisionRecord(
      parsed as Record<string, unknown>,
      pass,
    );
  } catch {
    return undefined;
  }
};

const createSectionTranscript = (
  sections: TaskExecutionSection[],
  maxChars = 6_000,
): string => {
  return limitText(
    sections
      .map((section) => `## ${section.title}\n${section.lines.join("\n")}`)
      .join("\n\n"),
    maxChars,
  );
};

const createAutopilotMonitorSystemPrompt = (config: RuntimeConfig): string => {
  return [
    "<role>You are Machdoch Monitor, a separate validator agent that judges whether the executor fully satisfied the user's request.</role>",
    "<review_contract>Be strict about grounded evidence. Do not accept work because it sounds plausible. If requirements are partially satisfied, not verified, or only implied, choose continue. Call the structured report_autopilot_decision tool exactly once.</review_contract>",
    "<safety_rules>Only use `complete` when the user's request is fully satisfied within the current workspace and tool policy boundaries. Prefer a continuation request over a false positive. Required actions must be concrete, minimal, and testable.</safety_rules>",
    [
      "<runtime>",
      `Workspace root: ${config.workspaceRoot}`,
      `Runtime mode: ${config.mode}`,
      `Selected provider: ${config.provider}`,
      `Selected model: ${config.model}`,
      "</runtime>",
    ].join("\n"),
  ].join("\n\n");
};

const createAutopilotMonitorUserPrompt = (
  task: string,
  taskContext: ResolvedTaskContext,
  cycleResult: ExecutorCycleOutcome,
  priorDecisions: TaskAutopilotDecision[],
): string => {
  const priorDecisionLines =
    priorDecisions.length > 0
      ? priorDecisions.flatMap((decision) => [
          `Pass ${decision.pass}: ${decision.decision} (${decision.confidence})`,
          `Rationale: ${decision.rationale}`,
          ...(decision.missingRequirements.length > 0
            ? [
                `Missing requirements: ${decision.missingRequirements.join(", ")}`,
              ]
            : []),
          ...(decision.requiredActions.length > 0
            ? [`Required actions: ${decision.requiredActions.join(", ")}`]
            : []),
        ])
      : ["No prior validator decisions."];

  return [
    `<original_task>${task}</original_task>`,
    `<effective_task>${taskContext.effectiveTask}</effective_task>`,
    `<executor_summary>${cycleResult.result.summary}</executor_summary>`,
    `<executed_tools>${cycleResult.result.executedTools.join(", ") || "none"}</executed_tools>`,
    `<assistant_answer>${cycleResult.loopState.lastAssistantText ?? "(none)"}</assistant_answer>`,
    `<prior_validator_history>${priorDecisionLines.join("\n")}</prior_validator_history>`,
    `<grounded_evidence>${createSectionTranscript(cycleResult.result.outputSections)}</grounded_evidence>`,
    "<decision_rule>Return `continue` if any user requirement appears incomplete, unverified, or contradicted by the evidence. Return `complete` only when the evidence shows the task is done as requested.</decision_rule>",
  ].join("\n\n");
};

const createToolDefinitions = (
  config: RuntimeConfig,
  memory: ConversationMemoryRuntime,
): AgentToolDefinition[] => {
  const toolDefinitions: AgentToolDefinition[] = [
    {
      spec: {
        name: "list_directory",
        description:
          "List files and folders within a workspace-relative directory. Use this to explore the project before reading or editing files.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: {
              type: "string",
              description:
                "Workspace-relative path to the directory to inspect. Use '.' for the workspace root.",
            },
            maxEntries: {
              type: "integer",
              minimum: 1,
              maximum: MAX_DIRECTORY_ENTRIES,
              description: "Maximum number of entries to return.",
            },
          },
          required: ["path", "maxEntries"],
        },
      },
      backingTool: "filesystem",
      riskLevel: "low",
      execute: async (args, context) => {
        const requestedPath = coerceString(args, "path");
        const maxEntries = coerceInteger(args, "maxEntries");

        if (!requestedPath || maxEntries === undefined) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "list_directory",
            "Expected a string `path` and integer `maxEntries`.",
          );
        }

        const target = resolveWorkspaceTarget(
          context.workspaceRoot,
          requestedPath,
        );

        if (!target.insideWorkspace) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "list_directory",
            `Refusing to inspect \`${requestedPath}\` because it resolves outside the workspace.`,
          );
        }

        try {
          const targetStats = await stat(target.resolvedPath);

          if (!targetStats.isDirectory()) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "list_directory",
              `The path \`${requestedPath}\` is not a directory.`,
            );
          }

          const entries = await readdir(target.resolvedPath, {
            withFileTypes: true,
          });
          const ordered = entries.sort((left, right) => {
            const leftKind = left.isDirectory() ? 0 : 1;
            const rightKind = right.isDirectory() ? 0 : 1;

            if (leftKind !== rightKind) {
              return leftKind - rightKind;
            }

            return sortEntryNames(left.name, right.name);
          });
          const lines = ordered.slice(0, maxEntries).map((entry) => {
            const kind = entry.isDirectory() ? "dir" : "file";
            return `${kind}: ${entry.name}`;
          });

          if (ordered.length > maxEntries) {
            lines.push(
              `… truncated after ${maxEntries} of ${ordered.length} entries`,
            );
          }

          const output = [
            `Directory: ${target.workspacePath || "."}`,
            ...lines,
          ].join("\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "list_directory",
              output,
            },
            sections: [
              {
                title: "Directory target",
                lines: [
                  `requested: ${requestedPath}`,
                  `workspace path: ${target.workspacePath || "."}`,
                ],
              },
              {
                title: "Directory entries",
                lines: lines.length > 0 ? lines : ["Directory is empty."],
              },
            ],
            traceLines: [
              `list_directory(${target.workspacePath || "."}) -> ${Math.min(ordered.length, maxEntries)} entr${Math.min(ordered.length, maxEntries) === 1 ? "y" : "ies"}`,
            ],
          };
        } catch {
          return createToolErrorResult(
            crypto.randomUUID(),
            "list_directory",
            `The directory \`${requestedPath}\` could not be read from the workspace.`,
          );
        }
      },
    },
    {
      spec: {
        name: "read_file",
        description:
          "Read a workspace file with 1-based line numbers. Use this before editing an existing file.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: {
              type: "string",
              description: "Workspace-relative path to the file to read.",
            },
            startLine: {
              type: "integer",
              minimum: 1,
              description: "1-based starting line number.",
            },
            endLine: {
              type: "integer",
              minimum: 1,
              description: "1-based ending line number.",
            },
          },
          required: ["path", "startLine", "endLine"],
        },
      },
      backingTool: "filesystem",
      riskLevel: "low",
      execute: async (args, context) => {
        const requestedPath = coerceString(args, "path");
        const startLine = coerceInteger(args, "startLine");
        const endLine = coerceInteger(args, "endLine");

        if (
          !requestedPath ||
          startLine === undefined ||
          endLine === undefined
        ) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "read_file",
            "Expected `path`, `startLine`, and `endLine`.",
          );
        }

        const target = resolveWorkspaceTarget(
          context.workspaceRoot,
          requestedPath,
        );

        if (!target.insideWorkspace) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "read_file",
            `Refusing to read \`${requestedPath}\` because it resolves outside the workspace.`,
          );
        }

        try {
          const targetStats = await stat(target.resolvedPath);

          if (!targetStats.isFile()) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "read_file",
              `The path \`${requestedPath}\` is not a regular file.`,
            );
          }

          if (targetStats.size > MAX_TEXT_FILE_BYTES) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "read_file",
              `The file \`${requestedPath}\` is too large for a safe inline preview.`,
            );
          }

          const raw = await readFile(target.resolvedPath);

          if (isBinaryBuffer(raw)) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "read_file",
              `The file \`${requestedPath}\` appears to be binary.`,
            );
          }

          const text = raw
            .toString("utf8")
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n");
          const allLines = text.split("\n");
          const safeStartLine = Math.max(1, startLine);
          const safeEndLine = Math.max(safeStartLine, endLine);
          const slice = allLines.slice(safeStartLine - 1, safeEndLine);
          const preview = slice
            .map((line, index) => `${safeStartLine + index}: ${line}`)
            .join("\n");
          const output = [
            `File: ${target.workspacePath ?? requestedPath}`,
            `Selected lines: ${safeStartLine}-${Math.min(safeEndLine, allLines.length)}`,
            preview,
          ]
            .filter((part) => part.trim().length > 0)
            .join("\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "read_file",
              output: limitText(output),
            },
            sections: [
              {
                title: "File target",
                lines: [
                  `requested: ${requestedPath}`,
                  `workspace path: ${target.workspacePath ?? requestedPath}`,
                  `selected lines: ${safeStartLine}-${Math.min(safeEndLine, allLines.length)}`,
                ],
              },
              createTextSection(
                "File preview",
                slice.join("\n"),
                MAX_PREVIEW_LINES,
                safeStartLine,
              ),
            ],
            traceLines: [
              `read_file(${target.workspacePath ?? requestedPath}, ${safeStartLine}-${Math.min(safeEndLine, allLines.length)})`,
            ],
          };
        } catch {
          return createToolErrorResult(
            crypto.randomUUID(),
            "read_file",
            `The file \`${requestedPath}\` could not be read from the workspace.`,
          );
        }
      },
    },
    {
      spec: {
        name: "search_workspace",
        description:
          "Search text across workspace files and return matching file:line results. Use this to find symbols, strings, or configuration references.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: {
              type: "string",
              description: "Plain text or regex pattern to search for.",
            },
            isRegex: {
              type: "boolean",
              description:
                "Whether `query` should be interpreted as a regular expression.",
            },
            maxResults: {
              type: "integer",
              minimum: 1,
              maximum: MAX_SEARCH_RESULTS,
              description: "Maximum number of matches to return.",
            },
          },
          required: ["query", "isRegex", "maxResults"],
        },
      },
      backingTool: "filesystem",
      riskLevel: "low",
      execute: async (args, context) => {
        const query = coerceString(args, "query");
        const isRegex = coerceBoolean(args, "isRegex");
        const maxResults = coerceInteger(args, "maxResults");

        if (!query || isRegex === undefined || maxResults === undefined) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "search_workspace",
            "Expected `query`, `isRegex`, and `maxResults`.",
          );
        }

        let matcher: RegExp;

        try {
          matcher = isRegex
            ? new RegExp(query, "iu")
            : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "search_workspace",
            error instanceof Error
              ? `Invalid search pattern: ${error.message}`
              : "Invalid search pattern.",
          );
        }

        const files = await createSearchScope(context.workspaceRoot, []);
        const results: string[] = [];

        for (const filePath of files) {
          if (results.length >= maxResults) {
            break;
          }

          try {
            const fileStats = await stat(filePath);

            if (!fileStats.isFile() || fileStats.size > MAX_TEXT_FILE_BYTES) {
              continue;
            }

            const raw = await readFile(filePath);

            if (isBinaryBuffer(raw)) {
              continue;
            }

            const content = raw
              .toString("utf8")
              .replace(/\r\n/g, "\n")
              .replace(/\r/g, "\n");
            const lines = content.split("\n");
            const workspacePath = normalizeWorkspacePath(
              relative(context.workspaceRoot, filePath),
            );

            for (const [index, line] of lines.entries()) {
              if (!matcher.test(line)) {
                continue;
              }

              results.push(`${workspacePath}:${index + 1}: ${line}`);

              if (results.length >= maxResults) {
                break;
              }
            }
          } catch {
            continue;
          }
        }

        const output =
          results.length > 0
            ? [`Matches for ${query}:`, ...results].join("\n")
            : `No matches found for ${query}.`;

        return {
          toolResult: {
            callId: crypto.randomUUID(),
            name: "search_workspace",
            output: limitText(output),
          },
          sections: [
            {
              title: "Search results",
              lines: results.length > 0 ? results : ["No matches found."],
            },
          ],
          traceLines: [
            `search_workspace(${query}, regex=${isRegex ? "true" : "false"}) -> ${results.length} match${results.length === 1 ? "" : "es"}`,
          ],
        };
      },
    },
    {
      spec: {
        name: "create_file",
        description:
          "Create a brand-new workspace file. Use this only when the file does not already exist.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: {
              type: "string",
              description: "Workspace-relative path of the new file.",
            },
            content: {
              type: "string",
              description: "Full file contents to write.",
            },
          },
          required: ["path", "content"],
        },
      },
      backingTool: "filesystem",
      riskLevel: "low",
      execute: async (args, context) => {
        const requestedPath = coerceString(args, "path");
        const content =
          typeof args.content === "string" ? args.content : undefined;

        if (!requestedPath || content === undefined) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "create_file",
            "Expected `path` and `content`.",
          );
        }

        const target = resolveWorkspaceTarget(
          context.workspaceRoot,
          requestedPath,
        );

        if (!target.insideWorkspace) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "create_file",
            `Refusing to create \`${requestedPath}\` because it resolves outside the workspace.`,
          );
        }

        if (existsSync(target.resolvedPath)) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "create_file",
            `The path \`${requestedPath}\` already exists. Use replace_in_file for edits instead.`,
          );
        }

        await mkdir(dirname(target.resolvedPath), { recursive: true });
        await writeFile(target.resolvedPath, content, "utf8");

        return {
          toolResult: {
            callId: crypto.randomUUID(),
            name: "create_file",
            output: `Created ${target.workspacePath ?? requestedPath}.`,
          },
          sections: [
            {
              title: "File target",
              lines: [
                `requested: ${requestedPath}`,
                `workspace path: ${target.workspacePath ?? requestedPath}`,
              ],
            },
            createTextSection("File preview", content),
          ],
          traceLines: [`create_file(${target.workspacePath ?? requestedPath})`],
        };
      },
    },
    {
      spec: {
        name: "replace_in_file",
        description:
          "Replace exact text in an existing workspace file. Use this for targeted edits after reading the file first.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: {
              type: "string",
              description: "Workspace-relative path of the file to edit.",
            },
            oldText: {
              type: "string",
              description: "Exact existing text to replace.",
            },
            newText: {
              type: "string",
              description: "Replacement text.",
            },
            replaceAll: {
              type: "boolean",
              description:
                "Whether to replace every exact occurrence instead of only one.",
            },
          },
          required: ["path", "oldText", "newText", "replaceAll"],
        },
      },
      backingTool: "filesystem",
      riskLevel: "low",
      execute: async (args, context) => {
        const requestedPath = coerceString(args, "path");
        const oldText =
          typeof args.oldText === "string" ? args.oldText : undefined;
        const newText =
          typeof args.newText === "string" ? args.newText : undefined;
        const replaceAll = coerceBoolean(args, "replaceAll");

        if (
          !requestedPath ||
          oldText === undefined ||
          newText === undefined ||
          replaceAll === undefined
        ) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "replace_in_file",
            "Expected `path`, `oldText`, `newText`, and `replaceAll`.",
          );
        }

        if (oldText.length === 0) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "replace_in_file",
            "`oldText` must not be empty.",
          );
        }

        const target = resolveWorkspaceTarget(
          context.workspaceRoot,
          requestedPath,
        );

        if (!target.insideWorkspace) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "replace_in_file",
            `Refusing to edit \`${requestedPath}\` because it resolves outside the workspace.`,
          );
        }

        try {
          const raw = await readFile(target.resolvedPath);

          if (isBinaryBuffer(raw)) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "replace_in_file",
              `The file \`${requestedPath}\` appears to be binary and cannot be edited safely.`,
            );
          }

          const original = raw.toString("utf8");
          const candidates = [
            {
              match: oldText,
              replacement: newText,
            },
            ...(oldText.includes("\n")
              ? [
                  {
                    match: oldText.replace(/\n/g, "\r\n"),
                    replacement: newText.replace(/\n/g, "\r\n"),
                  },
                ]
              : []),
          ];
          const selectedCandidate = candidates.find(({ match }) =>
            original.includes(match),
          );

          if (!selectedCandidate) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "replace_in_file",
              `The exact text to replace was not found in \`${requestedPath}\`.`,
            );
          }

          const matchCount = original.split(selectedCandidate.match).length - 1;

          if (matchCount > 1 && !replaceAll) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "replace_in_file",
              `Found ${matchCount} matching occurrences in \`${requestedPath}\`; provide more precise text or set replaceAll=true.`,
            );
          }

          const updated = replaceAll
            ? original
                .split(selectedCandidate.match)
                .join(selectedCandidate.replacement)
            : original.replace(
                selectedCandidate.match,
                selectedCandidate.replacement,
              );

          await writeFile(target.resolvedPath, updated, "utf8");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "replace_in_file",
              output: `Updated ${target.workspacePath ?? requestedPath} by replacing ${replaceAll ? `${matchCount} occurrences` : "1 occurrence"}.`,
            },
            sections: [
              {
                title: "Edited file",
                lines: [
                  `requested: ${requestedPath}`,
                  `workspace path: ${target.workspacePath ?? requestedPath}`,
                  `replacement count: ${replaceAll ? matchCount : 1}`,
                ],
              },
              createTextSection("Updated file preview", updated),
            ],
            traceLines: [
              `replace_in_file(${target.workspacePath ?? requestedPath}) -> ${replaceAll ? `${matchCount} replacements` : "1 replacement"}`,
            ],
          };
        } catch {
          return createToolErrorResult(
            crypto.randomUUID(),
            "replace_in_file",
            `The file \`${requestedPath}\` could not be edited.`,
          );
        }
      },
    },
    {
      spec: {
        name: "run_shell_command",
        description:
          "Run a shell command inside the workspace. Use this only when filesystem tools are insufficient and you need real command output for verification or build/test steps.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            command: {
              type: "string",
              description: "The shell command to run inside the workspace.",
            },
          },
          required: ["command"],
        },
      },
      backingTool: "shell",
      riskLevel: "high",
      execute: async (args, context) => {
        const command = coerceString(args, "command");

        if (!command) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "run_shell_command",
            "Expected a non-empty `command`.",
          );
        }

        const shellArgs =
          process.platform === "win32"
            ? ["-NoProfile", "-Command", command]
            : ["-lc", command];
        const shellExecutable =
          process.platform === "win32" ? "powershell.exe" : "sh";

        try {
          const { stdout, stderr } = await execFileAsync(
            shellExecutable,
            shellArgs,
            {
              cwd: context.workspaceRoot,
              timeout: SHELL_TIMEOUT_MS,
              maxBuffer: 1_000_000,
            },
          );
          const normalizedStdout = stdout.trim();
          const normalizedStderr = stderr.trim();
          const output = [
            `Command: ${command}`,
            `Exit code: 0`,
            normalizedStdout.length > 0
              ? `STDOUT:\n${normalizedStdout}`
              : undefined,
            normalizedStderr.length > 0
              ? `STDERR:\n${normalizedStderr}`
              : undefined,
          ]
            .filter(
              (part): part is string =>
                typeof part === "string" && part.length > 0,
            )
            .join("\n\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "run_shell_command",
              output: limitText(output),
            },
            sections: [
              {
                title: "Shell command",
                lines: [`command: ${command}`, `cwd: ${context.workspaceRoot}`],
              },
              createTextSection(
                "Command output",
                [normalizedStdout, normalizedStderr]
                  .filter(Boolean)
                  .join("\n\n") || "(no output)",
              ),
            ],
            traceLines: [
              `run_shell_command(${compactTraceText(command)}) -> success`,
            ],
          };
        } catch (error) {
          const stdout =
            error instanceof Error &&
            "stdout" in error &&
            typeof error.stdout === "string"
              ? error.stdout.trim()
              : "";
          const stderr =
            error instanceof Error &&
            "stderr" in error &&
            typeof error.stderr === "string"
              ? error.stderr.trim()
              : error instanceof Error
                ? error.message
                : String(error);
          const exitCode =
            error instanceof Error &&
            "code" in error &&
            typeof error.code === "number"
              ? error.code
              : undefined;
          const output = [
            `Command: ${command}`,
            exitCode !== undefined ? `Exit code: ${exitCode}` : undefined,
            stdout.length > 0 ? `STDOUT:\n${stdout}` : undefined,
            stderr.length > 0 ? `STDERR:\n${stderr}` : undefined,
          ]
            .filter(
              (part): part is string =>
                typeof part === "string" && part.length > 0,
            )
            .join("\n\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "run_shell_command",
              output: limitText(output),
              isError: true,
            },
            sections: [
              {
                title: "Shell command",
                lines: [`command: ${command}`, `cwd: ${context.workspaceRoot}`],
              },
              createTextSection(
                "Command output",
                [stdout, stderr].filter(Boolean).join("\n\n") || "(no output)",
              ),
            ],
            traceLines: [
              `run_shell_command(${compactTraceText(command)}) -> error`,
            ],
          };
        }
      },
    },
    {
      spec: {
        name: "search_web",
        description:
          "Search the public web with the active provider and return ranked results plus concise snippets.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: {
              type: "string",
              description:
                "Focused web-search query. Keep it concise and specific.",
            },
            maxResults: {
              type: "integer",
              minimum: 1,
              maximum: 10,
              description: "Maximum number of results to return.",
            },
          },
          required: ["query"],
        },
      },
      backingTool: "network",
      riskLevel: "medium",
      execute: async (args, context) => {
        const query = coerceString(args, "query");
        const maxResults = coerceInteger(args, "maxResults");
        const activeProvider = getConfiguredWebSearchProvider(config);

        if (!query) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "search_web",
            "Expected a non-empty `query`.",
          );
        }

        if (!activeProvider) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "search_web",
            "Web search is hidden because no configured active web-search provider is available.",
          );
        }

        try {
          const response = await executeWebSearch(
            context.workspaceRoot,
            activeProvider,
            query,
            maxResults,
          );
          const resultLines = response.results.flatMap((result, index) => [
            `${index + 1}. ${result.title}`,
            `   url: ${result.url}`,
            `   snippet: ${result.snippet}`,
            ...(result.date ? [`   date: ${result.date}`] : []),
          ]);
          const output = [
            `Provider: ${response.provider}`,
            `Query: ${response.query}`,
            ...(response.summary ? [`Summary: ${response.summary}`] : []),
            ...(resultLines.length > 0
              ? resultLines
              : ["No results returned."]),
          ].join("\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "search_web",
              output: limitText(output),
            },
            sections: [
              {
                title: "Web search",
                lines: [
                  `provider: ${response.provider}`,
                  `query: ${response.query}`,
                  `results: ${response.results.length}`,
                  ...(response.summary ? [`summary: ${response.summary}`] : []),
                ],
              },
              {
                title: "Web search results",
                lines:
                  resultLines.length > 0
                    ? resultLines
                    : ["No results were returned by the active provider."],
              },
            ],
            traceLines: [
              `search_web(${response.provider}, ${compactTraceText(query)}) -> ${response.results.length} result${response.results.length === 1 ? "" : "s"}`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "search_web",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      spec: {
        name: "fetch_url",
        description:
          "Fetch an HTTP or HTTPS URL and return a text preview. Use this when the task explicitly requires a web page or remote API response.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            url: {
              type: "string",
              description: "Absolute HTTP or HTTPS URL to fetch.",
            },
          },
          required: ["url"],
        },
      },
      backingTool: "network",
      riskLevel: "medium",
      execute: async (args) => {
        const url = coerceString(args, "url");

        if (!url) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "fetch_url",
            "Expected a non-empty `url`.",
          );
        }

        let parsedUrl: URL;

        try {
          parsedUrl = new URL(url);
        } catch {
          return createToolErrorResult(
            crypto.randomUUID(),
            "fetch_url",
            `The URL \`${url}\` is not valid.`,
          );
        }

        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "fetch_url",
            `Only HTTP and HTTPS URLs are supported.`,
          );
        }

        const response = await fetch(parsedUrl, {
          headers: {
            "user-agent": "machdoch/0.1",
          },
        });

        const rawText = await response.text();
        const contentType = response.headers.get("content-type") ?? "unknown";
        const text = contentType.includes("html")
          ? stripHtmlToText(rawText)
          : rawText;
        const limitedText = limitText(text);

        return {
          toolResult: {
            callId: crypto.randomUUID(),
            name: "fetch_url",
            output: [
              `URL: ${parsedUrl.toString()}`,
              `Status: ${response.status}`,
              limitedText,
            ].join("\n\n"),
            ...(response.ok ? {} : { isError: true }),
          },
          sections: [
            {
              title: "Fetched URL",
              lines: [
                `url: ${parsedUrl.toString()}`,
                `status: ${response.status}`,
                `content type: ${contentType}`,
              ],
            },
            createTextSection("Fetched content", limitedText),
          ],
          traceLines: [
            `fetch_url(${parsedUrl.toString()}) -> ${response.status}`,
          ],
        };
      },
    },
  ];

  if (memory.sessionEnabled) {
    toolDefinitions.push({
      spec: {
        name: "remember_session_memory",
        description:
          "Save a durable note for the current chat session. Use this for preferences, decisions, or facts that should matter later in this same session.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            fact: {
              type: "string",
              description: "The session-scoped fact or preference to remember.",
            },
          },
          required: ["fact"],
        },
      },
      backingTool: "filesystem",
      riskLevel: "low",
      execute: async (args, context) => {
        const fact = coerceString(args, "fact");

        if (!fact) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "remember_session_memory",
            "Expected a non-empty `fact`.",
          );
        }

        const remembered = rememberConversationMemoryEntry(
          context.memory.sessionEntries,
          "session",
          fact,
          MAX_SESSION_MEMORY_ENTRIES,
        );

        context.memory.sessionEntries = remembered.entries;

        return {
          toolResult: {
            callId: crypto.randomUUID(),
            name: "remember_session_memory",
            output: `${remembered.added ? "Saved" : "Refreshed"} session memory: ${remembered.entry.content}`,
          },
          memoryUpdate: {
            scope: "session",
            entry: remembered.entry,
          },
          sections: [
            {
              title: "Memory update",
              lines: [
                `scope: session`,
                `status: ${remembered.added ? "saved" : "refreshed"}`,
                `fact: ${remembered.entry.content}`,
              ],
            },
          ],
          traceLines: [
            `remember_session_memory(${compactTraceText(remembered.entry.content)}) -> ${remembered.added ? "saved" : "refreshed"}`,
          ],
        };
      },
    });
  }

  if (memory.globalEnabled) {
    toolDefinitions.push({
      spec: {
        name: "remember_global_memory",
        description:
          "Save a durable note that should be available in later sessions. Use this sparingly for stable cross-session preferences or facts.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            fact: {
              type: "string",
              description: "The cross-session fact or preference to remember.",
            },
          },
          required: ["fact"],
        },
      },
      backingTool: "filesystem",
      riskLevel: "low",
      execute: async (args, context) => {
        const fact = coerceString(args, "fact");

        if (!fact) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "remember_global_memory",
            "Expected a non-empty `fact`.",
          );
        }

        const rememberedEntry = await rememberUserGlobalMemory(fact);

        context.memory.globalEntries = mergeConversationMemoryEntries(
          context.memory.globalEntries,
          [rememberedEntry],
          MAX_GLOBAL_MEMORY_ENTRIES,
        );

        return {
          toolResult: {
            callId: crypto.randomUUID(),
            name: "remember_global_memory",
            output: `Saved global memory: ${rememberedEntry.content}`,
          },
          memoryUpdate: {
            scope: "global",
            entry: rememberedEntry,
          },
          sections: [
            {
              title: "Memory update",
              lines: [
                `scope: global`,
                `status: saved`,
                `fact: ${rememberedEntry.content}`,
              ],
            },
          ],
          traceLines: [
            `remember_global_memory(${compactTraceText(rememberedEntry.content)}) -> saved`,
          ],
        };
      },
    });
  }

  if (!getConfiguredWebSearchProvider(config)) {
    return toolDefinitions.filter(
      (toolDefinition) => toolDefinition.spec.name !== "search_web",
    );
  }

  return toolDefinitions;
};

const executeToolCall = async (
  task: string,
  config: RuntimeConfig,
  loopState: AgentLoopState,
  memory: ConversationMemoryRuntime,
  toolDefinitions: Map<string, AgentToolDefinition>,
  call: AgentModelToolCall,
): Promise<{
  result?: AgentToolExecutionResult;
  approvalPause?: ApprovalPause;
}> => {
  const toolDefinition = toolDefinitions.get(call.name);

  if (!toolDefinition) {
    return {
      result: createToolErrorResult(
        call.id,
        call.name,
        `The tool \`${call.name}\` is not registered in this runtime.`,
      ),
    };
  }

  const actionDecision = resolveActionDecision(
    config,
    toolDefinition.backingTool,
    toolDefinition.riskLevel,
  );

  if (actionDecision.decision === "ask") {
    return {
      approvalPause: createApprovalPause(
        task,
        loopState,
        toolDefinition,
        call,
        actionDecision.reason,
      ),
    };
  }

  if (actionDecision.decision === "blocked") {
    return {
      result: createToolErrorResult(call.id, call.name, actionDecision.reason),
    };
  }

  const result = await toolDefinition.execute(call.arguments, {
    workspaceRoot: config.workspaceRoot,
    memory,
  });

  return {
    result: {
      ...result,
      toolResult: {
        ...result.toolResult,
        callId: call.id,
        name: call.name,
      },
      traceLines: [
        `tool_call: ${call.name}(${compactTraceText(stringifyUnknown(call.arguments))})`,
        ...result.traceLines,
      ],
    },
  };
};

const finalizeExecutedResult = (
  task: string,
  config: RuntimeConfig,
  loopState: AgentLoopState,
  summaryOverride?: string,
): TaskExecutionResult => {
  const outputSections = [...loopState.outputSections];

  if (loopState.finalResponse) {
    outputSections.push(
      ...createFinalResponseSections(loopState.finalResponse),
    );
  } else if (loopState.lastAssistantText?.trim()) {
    outputSections.push(
      createAssistantAnswerSection(loopState.lastAssistantText),
    );
  }

  if (loopState.traceLines.length > 0) {
    outputSections.push({
      title: "Tool trace",
      lines: loopState.traceLines,
    });
  }

  return createExecutionResult({
    task,
    mode: config.mode,
    status: "executed",
    summary:
      summaryOverride?.trim() ||
      normalizeFinalSummary(
        loopState.finalResponse?.markdown ?? loopState.lastAssistantText,
      ),
    executedTools: loopState.executedTools,
    outputSections,
    ...(loopState.memoryUpdates.length > 0
      ? { memoryUpdates: loopState.memoryUpdates }
      : {}),
    ...(loopState.finalResponse ? { response: loopState.finalResponse } : {}),
  });
};

const finalizeBlockedResult = (
  task: string,
  config: RuntimeConfig,
  loopState: AgentLoopState,
  summary: string,
  reason: string,
): TaskExecutionResult => {
  const outputSections = [...loopState.outputSections];

  if (loopState.finalResponse) {
    outputSections.push(
      ...createFinalResponseSections(loopState.finalResponse),
    );
  } else if (loopState.lastAssistantText?.trim()) {
    outputSections.push(
      createAssistantAnswerSection(loopState.lastAssistantText),
    );
  }

  if (loopState.traceLines.length > 0) {
    outputSections.push({
      title: "Tool trace",
      lines: loopState.traceLines,
    });
  }

  return createExecutionResult(
    {
      task,
      mode: config.mode,
      status: "blocked",
      summary,
      executedTools: loopState.executedTools,
      outputSections,
      ...(loopState.memoryUpdates.length > 0
        ? { memoryUpdates: loopState.memoryUpdates }
        : {}),
      ...(loopState.finalResponse ? { response: loopState.finalResponse } : {}),
    },
    reason,
  );
};

const finalizeApprovalResult = (
  task: string,
  config: RuntimeConfig,
  loopState: AgentLoopState,
  pause: ApprovalPause,
): TaskExecutionResult => {
  return createExecutionResult(
    {
      task,
      mode: config.mode,
      status: "approval-required",
      summary: pause.summary,
      executedTools: loopState.executedTools,
      outputSections: pause.outputSections,
    },
    pause.reason,
  );
};

const runExecutorCycle = async (
  task: string,
  config: RuntimeConfig,
  taskContext: ResolvedTaskContext,
  contextSections: TaskExecutionSection[],
  conversationContext: PreparedConversationPromptContext,
  overrideAdapter: AgentModelAdapter | undefined,
  continuationRequest: ExecutorContinuationRequest | undefined,
  onStateChange: TaskExecutionProgressHandler | undefined,
): Promise<ExecutorCycleOutcome> => {
  const toolDefinitions = createToolDefinitions(
    config,
    conversationContext.memory,
  );
  const finalResponseTool = createFinalResponseTool();
  const toolSpecs = [
    ...toolDefinitions.map((toolDefinition) => toolDefinition.spec),
    finalResponseTool,
  ];
  const toolMap = new Map(
    toolDefinitions.map((toolDefinition) => [
      toolDefinition.spec.name,
      toolDefinition,
    ]),
  );
  const loopState: AgentLoopState = {
    executedTools: [],
    outputSections: [...contextSections, ...conversationContext.sections],
    traceLines: [],
    memoryUpdates: [],
  };
  const executorIteration = continuationRequest
    ? continuationRequest.continuationIndex + 1
    : 1;
  const systemPrompt = createExecutorSystemPrompt(
    config,
    taskContext,
    toolSpecs,
    conversationContext,
    continuationRequest,
  );
  const userPrompt = createExecutorUserPrompt(
    task,
    taskContext,
    conversationContext,
    continuationRequest,
  );
  const adapter = await createProviderAdapter(
    config,
    toolSpecs,
    overrideAdapter,
  );

  if (!adapter) {
    return {
      loopState,
      result: finalizeBlockedResult(
        task,
        config,
        loopState,
        "Model-driven execution could not start because no executor model adapter is available.",
        "No executor model adapter is available for the current provider and runtime configuration.",
      ),
    };
  }

  await emitAgentProgress(
    task,
    config,
    "executing",
    continuationRequest
      ? `Executor iteration ${executorIteration} started with monitor feedback from continuation ${continuationRequest.continuationIndex}.`
      : "Executor iteration 1 started.",
    loopState,
    onStateChange,
  );

  let turn = await adapter.startTurn({
    model: config.model,
    systemPrompt,
    userPrompt,
    tools: toolSpecs,
  });

  for (let turnIndex = 0; turnIndex < MAX_EXECUTOR_TURNS; turnIndex += 1) {
    if (turn.text.trim()) {
      loopState.lastAssistantText = turn.text.trim();
      loopState.traceLines.push(`assistant: ${compactTraceText(turn.text)}`);
    }

    if (turn.toolCalls.length === 0) {
      await emitAgentProgress(
        task,
        config,
        "verifying",
        `Executor iteration ${executorIteration} produced a candidate completion for validation.`,
        loopState,
        onStateChange,
      );

      return {
        loopState,
        result: finalizeExecutedResult(task, config, loopState),
      };
    }

    const finalResponseCall = turn.toolCalls.find(
      (call) => call.name === FINAL_RESPONSE_TOOL_NAME,
    );

    if (finalResponseCall) {
      if (turn.toolCalls.length !== 1) {
        const toolResults = [
          createFinalResponseToolResult(
            finalResponseCall.id,
            "`submit_final_response` must be the only tool call in its turn.",
            true,
          ),
        ];

        loopState.traceLines.push(
          `${FINAL_RESPONSE_TOOL_NAME}: rejected because additional tool calls were present in the same turn.`,
        );
        turn = await adapter.continueTurn({ toolResults });
        continue;
      }

      if (
        typeof finalResponseCall.arguments !== "object" ||
        finalResponseCall.arguments === null ||
        Array.isArray(finalResponseCall.arguments)
      ) {
        const toolResults = [
          createFinalResponseToolResult(
            finalResponseCall.id,
            "`submit_final_response` requires an object payload that matches the schema.",
            true,
          ),
        ];

        loopState.traceLines.push(
          `${FINAL_RESPONSE_TOOL_NAME}: rejected invalid payload shape.`,
        );
        turn = await adapter.continueTurn({ toolResults });
        continue;
      }

      const parsedPayload = parseFinalResponsePayload(
        finalResponseCall.arguments as Record<string, unknown>,
      );

      if (!parsedPayload) {
        const toolResults = [
          createFinalResponseToolResult(
            finalResponseCall.id,
            "`submit_final_response` payload was missing one or more required fields.",
            true,
          ),
        ];

        loopState.traceLines.push(
          `${FINAL_RESPONSE_TOOL_NAME}: rejected incomplete payload.`,
        );
        turn = await adapter.continueTurn({ toolResults });
        continue;
      }

      loopState.finalResponse = {
        markdown: parsedPayload.markdown,
        highlights: parsedPayload.highlights,
        relatedFiles: parsedPayload.relatedFiles,
        verification: parsedPayload.verification,
        followUps: parsedPayload.followUps,
      };
      loopState.lastAssistantText = parsedPayload.markdown;
      loopState.traceLines.push(
        `${FINAL_RESPONSE_TOOL_NAME}: ${compactTraceText(parsedPayload.summary)}`,
      );

      await emitAgentProgress(
        task,
        config,
        "verifying",
        `Executor iteration ${executorIteration} submitted a structured final response for validation.`,
        loopState,
        onStateChange,
      );

      return {
        loopState,
        result: finalizeExecutedResult(
          task,
          config,
          loopState,
          parsedPayload.summary,
        ),
      };
    }

    const toolResults: AgentModelToolResult[] = [];

    for (const call of turn.toolCalls) {
      const executionOutcome = await executeToolCall(
        task,
        config,
        loopState,
        conversationContext.memory,
        toolMap,
        call,
      );

      if (executionOutcome.approvalPause) {
        return {
          loopState,
          result: finalizeApprovalResult(
            task,
            config,
            loopState,
            executionOutcome.approvalPause,
          ),
        };
      }

      const result = executionOutcome.result;

      if (!result) {
        continue;
      }

      toolResults.push(result.toolResult);
      loopState.traceLines.push(...result.traceLines);
      loopState.outputSections.push(...result.sections);

      if (result.memoryUpdate) {
        loopState.memoryUpdates = upsertMemoryUpdate(
          loopState.memoryUpdates,
          result.memoryUpdate,
        );
      }

      const toolDefinition = toolMap.get(call.name);

      if (
        toolDefinition &&
        !loopState.executedTools.includes(toolDefinition.backingTool) &&
        !result.toolResult.isError
      ) {
        loopState.executedTools.push(toolDefinition.backingTool);
      }
    }

    turn = await adapter.continueTurn({ toolResults });
  }

  return {
    loopState,
    result: finalizeBlockedResult(
      task,
      config,
      loopState,
      "The model-driven execution loop hit its turn limit before reaching a final answer.",
      `Stopped after ${MAX_EXECUTOR_TURNS} turns to avoid an infinite loop.`,
    ),
  };
};

const runAutopilotMonitorPass = async (
  task: string,
  config: RuntimeConfig,
  taskContext: ResolvedTaskContext,
  cycleResult: ExecutorCycleOutcome,
  priorDecisions: TaskAutopilotDecision[],
  overrideMonitorAdapter: AgentModelAdapter | undefined,
  onStateChange: TaskExecutionProgressHandler | undefined,
): Promise<TaskAutopilotDecision> => {
  const monitorPass = priorDecisions.length + 1;
  const monitorTool = createAutopilotMonitorTool();
  const adapter = await createProviderAdapter(
    config,
    [monitorTool],
    overrideMonitorAdapter,
  );

  if (!adapter) {
    throw new Error(
      "Autopilot validation could not start because no monitor model adapter is available.",
    );
  }

  await emitAgentProgress(
    task,
    config,
    "monitoring",
    `Validator pass ${monitorPass} is reviewing executor iteration ${priorDecisions.filter((decision) => decision.decision === "continue").length + 1}.`,
    cycleResult.loopState,
    onStateChange,
  );

  const turn = await adapter.startTurn({
    model: config.model,
    systemPrompt: createAutopilotMonitorSystemPrompt(config),
    userPrompt: createAutopilotMonitorUserPrompt(
      task,
      taskContext,
      cycleResult,
      priorDecisions,
    ),
    tools: [monitorTool],
  });

  const decision = parseAutopilotDecisionFromTurn(turn, monitorPass);

  if (!decision) {
    throw new Error(
      "Autopilot validation did not return a structured decision.",
    );
  }

  await emitAgentProgress(
    task,
    config,
    "monitoring",
    decision.decision === "complete"
      ? `Validator pass ${monitorPass} accepted the task as complete.`
      : `Validator pass ${monitorPass} requested continuation: ${decision.rationale}`,
    cycleResult.loopState,
    onStateChange,
  );

  return decision;
};

const runModelDrivenLoop = async (
  task: string,
  config: RuntimeConfig,
  taskContext: ResolvedTaskContext,
  contextSections: TaskExecutionSection[],
  conversationContext: PreparedConversationPromptContext,
  executorAdapter: AgentModelAdapter | undefined,
  monitorAdapter: AgentModelAdapter | undefined,
  onStateChange: TaskExecutionProgressHandler | undefined,
): Promise<TaskExecutionResult> => {
  let cycleResult = await runExecutorCycle(
    task,
    config,
    taskContext,
    contextSections,
    conversationContext,
    executorAdapter,
    undefined,
    onStateChange,
  );
  let executorIterations = 1;
  const decisions: TaskAutopilotDecision[] = [];

  if (config.mode !== "auto" || cycleResult.result.status !== "executed") {
    return cycleResult.result;
  }

  while (true) {
    const buildAutopilotReport = (): TaskAutopilotReport => ({
      executorIterations,
      validatorPasses: decisions.length,
      continuationCount: decisions.filter(
        (decision) => decision.decision === "continue",
      ).length,
      maxExecutorIterations: MAX_AUTOPILOT_EXECUTOR_ITERATIONS,
      decisions: [...decisions],
    });

    let decision: TaskAutopilotDecision;

    try {
      decision = await runAutopilotMonitorPass(
        task,
        config,
        taskContext,
        cycleResult,
        decisions,
        monitorAdapter,
        onStateChange,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return attachAutopilotReport(
        finalizeBlockedResult(
          task,
          config,
          cycleResult.loopState,
          "Autopilot validation could not complete because the monitor step failed.",
          message,
        ),
        buildAutopilotReport(),
      );
    }

    decisions.push(decision);
    const autopilotReport = buildAutopilotReport();

    if (decision.decision === "complete") {
      return attachAutopilotReport(cycleResult.result, autopilotReport);
    }

    if (executorIterations >= MAX_AUTOPILOT_EXECUTOR_ITERATIONS) {
      return attachAutopilotReport(
        finalizeBlockedResult(
          task,
          config,
          cycleResult.loopState,
          "Autopilot reached its continuation limit before the monitor could verify completion.",
          `The monitor requested more work after ${executorIterations} executor iteration(s). Last rationale: ${decision.rationale}`,
        ),
        autopilotReport,
      );
    }

    cycleResult = await runExecutorCycle(
      task,
      config,
      taskContext,
      contextSections,
      conversationContext,
      executorAdapter,
      {
        continuationIndex: autopilotReport.continuationCount,
        rationale: decision.rationale,
        missingRequirements: decision.missingRequirements,
        requiredActions: decision.requiredActions,
      },
      onStateChange,
    );
    executorIterations += 1;

    if (cycleResult.result.status !== "executed") {
      return attachAutopilotReport(cycleResult.result, buildAutopilotReport());
    }
  }
};

const shouldAttemptModelExecution = (
  config: RuntimeConfig,
  overrideAdapter: AgentModelAdapter | undefined,
): boolean => {
  if (overrideAdapter) {
    return true;
  }

  if (config.offline || config.provider === "unconfigured") {
    return false;
  }

  return config.providerAvailability.some(
    (entry) => entry.provider === config.provider && entry.configured,
  );
};

export const maybeExecuteModelDrivenTask = async (
  params: ModelDrivenExecutionParams,
): Promise<TaskExecutionResult | undefined> => {
  if (!shouldAttemptModelExecution(params.config, params.modelAdapter)) {
    return undefined;
  }

  try {
    const preparedConversationContext = await prepareConversationPromptContext(
      params.task,
      params.config,
      params.conversationContext,
    );

    return await runModelDrivenLoop(
      params.task,
      params.config,
      params.taskContext,
      params.contextSections,
      preparedConversationContext,
      params.modelAdapter,
      params.monitorModelAdapter,
      params.onStateChange,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return createExecutionResult(
      {
        task: params.task,
        mode: params.config.mode,
        status: "blocked",
        summary:
          "Model-driven execution could not start or continue because the provider request failed.",
        executedTools: [],
        outputSections: [
          ...params.contextSections,
          {
            title: "Model runtime error",
            lines: [message],
          },
        ],
      },
      message,
    );
  }
};
