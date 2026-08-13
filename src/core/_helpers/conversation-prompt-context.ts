import { loadUserMemorySettings } from "../env.js";
import { normalizeConversationMemoryEntries } from "../memory.js";
import type {
  ConversationHistoryEntry,
  ConversationMemoryEntry,
  TaskConversationContext,
  TaskExecutionSection,
  UiControlRuntimeInfo,
} from "../types.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import type { ConversationMemoryRuntime } from "./agent-tools-shared.js";
import { createInternalTaskModelExecution } from "../internal-task-model.js";
import {
  compactTraceText,
  createTextSection,
  limitText,
} from "./runtime-text.js";

const MAX_CONVERSATION_HISTORY_MESSAGES = 200;
const MAX_RECENT_HISTORY_MESSAGES = 8;
const MAX_RECENT_HISTORY_CHARS = 3_600;
const MAX_CONVERSATION_SUMMARY_INPUT_CHARS = 10_000;
const MAX_CONVERSATION_SUMMARY_SECTION_LINES = 12;
const MAX_MEMORY_PROMPT_ENTRIES = 10;
const MAX_WORKSPACE_RUN_CONTEXT_CHARS = 12_000;

type WorkspaceRunContext = NonNullable<TaskConversationContext["workspaceRun"]>;
type WorkspaceRunStatus = WorkspaceRunContext["configurations"][number];

const redactWorkspaceRunText = (
  value: string,
  environmentValues: readonly string[],
): string =>
  environmentValues.reduce(
    (redacted, secret) => redacted.replaceAll(secret, "<redacted>"),
    value,
  );

const redactWorkspaceRunStatus = (
  status: WorkspaceRunStatus,
): WorkspaceRunStatus => {
  if (status.configuration.kind === "composite") {
    return {
      ...status,
      children: status.children.map(redactWorkspaceRunStatus),
    };
  }
  const environmentValues = Array.from(
    new Set(
      Object.values(status.configuration.environment).filter(
        (value) => value && value !== "<redacted>",
      ),
    ),
  ).sort((left, right) => right.length - left.length);
  const redact = (value: string): string =>
    redactWorkspaceRunText(value, environmentValues);
  return {
    ...status,
    configuration: {
      ...status.configuration,
      command: redact(status.configuration.command),
      workingDirectory: redact(status.configuration.workingDirectory),
      environment: Object.fromEntries(
        Object.keys(status.configuration.environment).map((key) => [
          key,
          "<redacted>",
        ]),
      ),
      urls: status.configuration.urls.map(redact),
      ...(status.configuration.healthCheck === undefined
        ? {}
        : {
            healthCheck: status.configuration.healthCheck
              ? {
                  ...status.configuration.healthCheck,
                  ...(status.configuration.healthCheck.host === undefined
                    ? {}
                    : {
                        host:
                          status.configuration.healthCheck.host === null
                            ? null
                            : redact(status.configuration.healthCheck.host),
                      }),
                  ...(status.configuration.healthCheck.url === undefined
                    ? {}
                    : {
                        url:
                          status.configuration.healthCheck.url === null
                            ? null
                            : redact(status.configuration.healthCheck.url),
                      }),
                }
              : null,
          }),
    },
    health: status.health
      ? {
          ...status.health,
          message: status.health.message ? redact(status.health.message) : null,
        }
      : null,
    recentFailures: status.recentFailures.map((failure) => ({
      ...failure,
      message: redact(failure.message),
    })),
    logs: status.logs.map((log) => ({ ...log, line: redact(log.line) })),
    children: status.children.map(redactWorkspaceRunStatus),
  };
};

const compactWorkspaceRunStatus = (
  status: WorkspaceRunStatus,
): Record<string, unknown> => ({
  id: status.configuration.id,
  name: status.configuration.name,
  kind: status.configuration.kind,
  state: status.state,
  pid: status.pid,
  exitCode: status.exitCode,
  restartCount: status.restartCount,
  health: status.health,
  ...(status.configuration.kind === "task"
    ? {
        workingDirectory: status.configuration.workingDirectory,
        hotReload: status.configuration.hotReload,
        ports: status.configuration.ports,
        urls: status.configuration.urls,
        healthCheck: status.configuration.healthCheck,
        restartPolicy: status.configuration.restartPolicy,
      }
    : {
        startOrder: status.configuration.startOrder,
      }),
  recentFailures: status.recentFailures.slice(-2),
  logs: status.logs.slice(-3),
  children: status.children.map(compactWorkspaceRunStatus),
});

const minimalWorkspaceRunStatus = (
  status: WorkspaceRunStatus,
): Record<string, unknown> => ({
  id: status.configuration.id,
  name: status.configuration.name,
  kind: status.configuration.kind,
  state: status.state,
  restartCount: status.restartCount,
  ...(status.configuration.kind === "task"
    ? { hotReload: status.configuration.hotReload }
    : {}),
  children: status.children.map((child) => ({
    id: child.configuration.id,
    state: child.state,
  })),
});

export const serializeWorkspaceRunContext = (
  context: WorkspaceRunContext,
): string => {
  const sanitized = {
    ...context,
    configurations: context.configurations.map(redactWorkspaceRunStatus),
  };
  const serialized = JSON.stringify(sanitized);
  if (serialized.length <= MAX_WORKSPACE_RUN_CONTEXT_CHARS) {
    return serialized;
  }

  const compact = JSON.stringify({
    workspaceRoot: sanitized.workspaceRoot,
    primaryConfigurationId: sanitized.primaryConfigurationId,
    configurations: sanitized.configurations.map(compactWorkspaceRunStatus),
  });
  if (compact.length <= MAX_WORKSPACE_RUN_CONTEXT_CHARS) {
    return compact;
  }

  const configurations: Record<string, unknown>[] = [];
  for (const status of sanitized.configurations) {
    configurations.push(minimalWorkspaceRunStatus(status));
    const candidate = JSON.stringify({
      workspaceRoot: sanitized.workspaceRoot.slice(0, 1_024),
      primaryConfigurationId: sanitized.primaryConfigurationId,
      configurations,
      omittedConfigurationCount:
        sanitized.configurations.length - configurations.length,
    });
    if (candidate.length > MAX_WORKSPACE_RUN_CONTEXT_CHARS) {
      configurations.pop();
      break;
    }
  }

  return JSON.stringify({
    workspaceRoot: sanitized.workspaceRoot.slice(0, 1_024),
    primaryConfigurationId: sanitized.primaryConfigurationId,
    configurations,
    omittedConfigurationCount:
      sanitized.configurations.length - configurations.length,
  });
};

export interface PreparedConversationPromptContext {
  workspace: {
    selection: "selected" | "not-set";
    root?: string;
  };
  promptBlock?: string;
  sections: TaskExecutionSection[];
  memory: ConversationMemoryRuntime;
  uiControlEnabled: boolean;
  uiControl?: UiControlRuntimeInfo;
}

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

    const boundedEntry = {
      ...entry,
      content: entry.content.slice(0, MAX_RECENT_HISTORY_CHARS),
    };
    const nextChars = totalChars + boundedEntry.content.length;

    if (
      recentHistory.length >= MAX_RECENT_HISTORY_MESSAGES ||
      (recentHistory.length > 0 && nextChars > MAX_RECENT_HISTORY_CHARS)
    ) {
      break;
    }

    recentHistory.unshift(boundedEntry);
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

const normalizeWorkspaceContext = (
  conversationContext: TaskConversationContext | undefined,
): PreparedConversationPromptContext["workspace"] => {
  const selection =
    conversationContext?.workspace?.selection === "not-set"
      ? "not-set"
      : "selected";
  const root = conversationContext?.workspace?.root?.trim();

  return {
    selection,
    ...(root ? { root } : {}),
  };
};

const summarizeConversationHistory = async (
  task: string,
  config: RuntimeConfig,
  history: ConversationHistoryEntry[],
  signal: AbortSignal | undefined,
): Promise<string | undefined> => {
  if (history.length === 0) {
    return undefined;
  }

  try {
    const execution = await createInternalTaskModelExecution(config);

    if (!execution) {
      return undefined;
    }

    const transcript = createConversationTranscript(history);
    const turn = await execution.adapter.startTurn({
      model: execution.config.model,
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
      ...(signal ? { signal } : {}),
    });

    const summary = turn.text.trim();

    return summary.length > 0 ? limitText(summary, 1_500) : undefined;
  } catch {
    return undefined;
  }
};

export const prepareConversationPromptContext = async (
  task: string,
  config: RuntimeConfig,
  conversationContext: TaskConversationContext | undefined,
  signal?: AbortSignal,
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
  const uiControlEnabled = conversationContext?.uiControlEnabled === true;
  const uiControl = conversationContext?.uiControl;
  const workspace = normalizeWorkspaceContext(conversationContext);
  const { omittedHistory, recentHistory } =
    createRecentHistoryWindow(normalizedHistory);
  const summary =
    omittedHistory.length > 0
      ? ((await summarizeConversationHistory(
          task,
          config,
          omittedHistory,
          signal,
        )) ?? createDeterministicConversationSummary(omittedHistory))
      : undefined;
  const recentHistoryLines = recentHistory.map(formatConversationHistoryEntry);
  const sessionMemoryLines = createMemoryLines(sessionEntries);
  const globalMemoryLines = createMemoryLines(globalEntries);
  const workspaceRunContext = conversationContext?.workspaceRun;
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
    workspaceRunContext
      ? [
          "<workspace_run_context>",
          serializeWorkspaceRunContext(workspaceRunContext),
          "</workspace_run_context>",
        ].join("\n")
      : undefined,
    uiControlEnabled
      ? [
          "<ui_control>",
          "Desktop UI control is enabled for this run.",
          `available: ${uiControl?.available === true ? "yes" : "no"}`,
          `platform: ${uiControl?.platform ?? "unknown"}`,
          `screenshots: ${uiControl?.supportsScreenshots === true ? "yes" : "no"}`,
          `window enumeration: ${uiControl?.supportsWindowEnumeration === true ? "yes" : "no"}`,
          `mouse and keyboard input: ${uiControl?.supportsInput === true ? "yes" : "no"}`,
          `window handles: ${uiControl?.supportsWindowHandles === true ? "yes" : "no"}`,
          ...(uiControl?.reason ? [`reason: ${uiControl.reason}`] : []),
          "Prefer a capture → act → wait/re-capture loop for GUI tasks.",
          "</ui_control>",
        ].join("\n")
      : undefined,
  ].filter((section): section is string => typeof section === "string");

  return {
    workspace,
    ...(promptSections.length > 0
      ? {
          promptBlock: [
            "<conversation_context>",
            "Earlier conversation is background only. The current task outside this block is authoritative and may supersede it.",
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
      ...(uiControlEnabled
        ? [
            {
              title: "UI control",
              lines: [
                `enabled: yes`,
                `available: ${uiControl?.available === true ? "yes" : "no"}`,
                `platform: ${uiControl?.platform ?? "unknown"}`,
                `screenshots: ${uiControl?.supportsScreenshots === true ? "yes" : "no"}`,
                `window enumeration: ${uiControl?.supportsWindowEnumeration === true ? "yes" : "no"}`,
                `mouse and keyboard input: ${uiControl?.supportsInput === true ? "yes" : "no"}`,
                `window handles: ${uiControl?.supportsWindowHandles === true ? "yes" : "no"}`,
                ...(uiControl?.reason ? [`reason: ${uiControl.reason}`] : []),
              ],
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
    uiControlEnabled,
    ...(uiControl ? { uiControl } : {}),
  };
};
