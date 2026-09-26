import { loadWorkspaceConfigFile } from "../config.js";
import { loadUserMemorySettings } from "../env.js";
import {
  retrieveConversationMemory,
  tokenizeMemoryText,
} from "../memory-retrieval.js";
import type { AdaptiveExecutionPlan } from "../adaptive-controller.js";
import {
  normalizeConversationMemoryEntries,
  resolveWorkspaceMemoryEnabled,
} from "../memory.js";
import { loadWorkspaceMemory } from "../workspace-memory.js";
import {
  createLocalReasoningBank,
  isReasoningBankEnabled,
  retrieveReasoningLessons,
} from "../reasoning-bank.js";
import type {
  ConversationHistoryEntry,
  TaskConversationContext,
  TaskExecutionSection,
  UiControlRuntimeInfo,
} from "../types.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import type { ConversationMemoryRuntime } from "./agent-tools-shared.js";
import {
  executeInternalTaskModelInference,
  resolveInternalTaskRuntimeConfig,
} from "../internal-task-model.js";
import { observeAgentModelCall } from "../model-usage.js";
import { sliceUtf16PrefixAtCodePointBoundary } from "../../shared/unicode.js";
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
  maxCharacters = MAX_WORKSPACE_RUN_CONTEXT_CHARS,
): string => {
  const rootLimit = Math.min(1_024, Math.floor(maxCharacters / 4));
  const sanitized = {
    ...context,
    configurations: context.configurations.map(redactWorkspaceRunStatus),
  };
  const serialized = JSON.stringify(sanitized);
  if (serialized.length <= maxCharacters) {
    return serialized;
  }

  const compact = JSON.stringify({
    workspaceRoot: sanitized.workspaceRoot,
    primaryConfigurationId: sanitized.primaryConfigurationId,
    configurations: sanitized.configurations.map(compactWorkspaceRunStatus),
  });
  if (compact.length <= maxCharacters) {
    return compact;
  }

  const configurations: Record<string, unknown>[] = [];
  for (const status of sanitized.configurations) {
    configurations.push(minimalWorkspaceRunStatus(status));
    const candidate = JSON.stringify({
      workspaceRoot: sanitized.workspaceRoot.slice(0, rootLimit),
      primaryConfigurationId: sanitized.primaryConfigurationId,
      configurations,
      omittedConfigurationCount:
        sanitized.configurations.length - configurations.length,
    });
    if (candidate.length > maxCharacters) {
      configurations.pop();
      break;
    }
  }

  return JSON.stringify({
    workspaceRoot: sanitized.workspaceRoot.slice(0, rootLimit),
    primaryConfigurationId: sanitized.primaryConfigurationId,
    configurations,
    omittedConfigurationCount:
      sanitized.configurations.length - configurations.length,
  });
};

export interface PreparedConversationPromptContext {
  adaptivePlan?: AdaptiveExecutionPlan;
  wasQueued: boolean;
  workspace: {
    selection: "selected" | "not-set";
    root?: string;
  };
  promptBlock?: string;
  sections: TaskExecutionSection[];
  memory: ConversationMemoryRuntime;
  memoryRetrieval?: ReturnType<
    typeof retrieveConversationMemory
  >["diagnostics"] & {
    workspaceLoadFailed: boolean;
  };
  reasoningBankRetrievedIds?: string[];
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
  maxMessages = MAX_RECENT_HISTORY_MESSAGES,
  maxCharacters = MAX_RECENT_HISTORY_CHARS,
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
      content: entry.content.slice(0, maxCharacters),
    };
    const nextChars = totalChars + boundedEntry.content.length;

    if (
      recentHistory.length >= maxMessages ||
      (recentHistory.length > 0 && nextChars > maxCharacters)
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

const selectRelevantEarlierHistory = (
  task: string,
  history: ConversationHistoryEntry[],
  maxCharacters: number,
): {
  selected: ConversationHistoryEntry[];
  remaining: ConversationHistoryEntry[];
} => {
  const terms = new Set(tokenizeMemoryText(task));
  const ranked = history
    .map((entry, index) => ({
      index,
      score: [...new Set(tokenizeMemoryText(entry.content))].filter((term) =>
        terms.has(term),
      ).length,
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) => right.score - left.score || right.index - left.index,
    );
  const selectedIndices = new Set<number>();
  let usedCharacters = 0;
  for (const candidate of ranked) {
    const entry = history[candidate.index];
    if (!entry || usedCharacters + entry.content.length > maxCharacters)
      continue;
    selectedIndices.add(candidate.index);
    usedCharacters += entry.content.length;
  }
  return {
    selected: history.filter((_, index) => selectedIndices.has(index)),
    remaining: history.filter((_, index) => !selectedIndices.has(index)),
  };
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
    const internalConfig = resolveInternalTaskRuntimeConfig(config);

    if (!internalConfig) {
      return undefined;
    }

    const transcript = createConversationTranscript(history);
    const systemPrompt = [
      "You summarize prior chat context for a coding agent.",
      "Extract only durable facts that matter for the next turn: user preferences, goals, decisions, relevant files, blockers, and unresolved follow-ups.",
      "Keep the summary compact, factual, and grounded in the transcript.",
      "Use plain Markdown bullets and do not invent anything.",
    ].join("\n");
    const userPrompt = [
      `Current task: ${task}`,
      "Summarize the earlier conversation below so the next task can continue with the right context.",
      "Transcript:",
      transcript.slice(-MAX_CONVERSATION_SUMMARY_INPUT_CHARS),
    ].join("\n\n");
    const turn = await observeAgentModelCall(
      {
        stage: "conversation-summary",
        provider: internalConfig.provider,
        model: internalConfig.model,
        operation: "summarizeConversationHistory",
        requestPayload: { systemPrompt, userPrompt, tools: [] },
      },
      async (onRequestAttempt) =>
        await executeInternalTaskModelInference(config, {
          systemPrompt,
          userPrompt,
          ...(signal ? { signal } : {}),
          ...(onRequestAttempt ? { onRequestAttempt } : {}),
        }),
    );

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
  adaptivePlan?: AdaptiveExecutionPlan,
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
  const workspaceRoot = config.workspaceRoot;
  const workspaceMemoryOverride =
    workspace.selection === "selected"
      ? (await loadWorkspaceConfigFile(workspaceRoot)).config
          .workspaceMemoryEnabled
      : undefined;
  const workspaceEnabled =
    workspace.selection === "selected" &&
    resolveWorkspaceMemoryEnabled(
      storedGlobalMemory.workspaceDefaultEnabled,
      workspaceMemoryOverride,
    ) &&
    conversationContext?.workspaceMemoryEnabled !== false;
  let workspaceLoadFailed = false;
  const storedWorkspaceEntries = workspaceEnabled
    ? await loadWorkspaceMemory(workspaceRoot).catch(() => {
        workspaceLoadFailed = true;
        return [];
      })
    : [];
  const workspaceEntries = workspaceEnabled
    ? normalizeConversationMemoryEntries(storedWorkspaceEntries, "workspace")
    : [];
  const retrieval = retrieveConversationMemory(
    task,
    [...sessionEntries, ...workspaceEntries, ...globalEntries],
    adaptivePlan
      ? {
          maxEntries: adaptivePlan.memoryEntries,
          maxCharacters: adaptivePlan.memoryCharacters,
          ...(adaptivePlan.level === "deep"
            ? { scopeQuotas: { session: 5, workspace: 6, global: 3 } }
            : {}),
        }
      : {},
  );
  const retrievedSessionEntries = retrieval.entries.filter(
    (entry) => entry.scope === "session",
  );
  const retrievedWorkspaceEntries = retrieval.entries.filter(
    (entry) => entry.scope === "workspace",
  );
  const retrievedGlobalEntries = retrieval.entries.filter(
    (entry) => entry.scope === "global",
  );
  const { omittedHistory, recentHistory } = createRecentHistoryWindow(
    normalizedHistory,
    adaptivePlan?.historyMessages,
    adaptivePlan
      ? Math.floor(adaptivePlan.historyCharacters * 0.75)
      : undefined,
  );
  const recentHistoryCharacters = recentHistory.reduce(
    (total, entry) => total + entry.content.length,
    0,
  );
  const earlierHistory = adaptivePlan
    ? selectRelevantEarlierHistory(
        task,
        omittedHistory,
        Math.floor(
          (adaptivePlan.historyCharacters - recentHistoryCharacters) / 2,
        ),
      )
    : { selected: [], remaining: omittedHistory };
  const summaryText =
    earlierHistory.remaining.length > 0
      ? ((adaptivePlan?.level === "simple" ||
        (adaptivePlan?.level === "standard" &&
          earlierHistory.remaining.length <= 6)
          ? undefined
          : await summarizeConversationHistory(
              task,
              config,
              earlierHistory.remaining,
              signal,
            )) ??
        createDeterministicConversationSummary(earlierHistory.remaining))
      : undefined;
  const summaryCharacters = adaptivePlan
    ? adaptivePlan.historyCharacters -
      recentHistoryCharacters -
      earlierHistory.selected.reduce(
        (total, entry) => total + entry.content.length,
        0,
      )
    : undefined;
  const summary =
    summaryText && summaryCharacters !== undefined
      ? sliceUtf16PrefixAtCodePointBoundary(
          summaryText,
          summaryCharacters,
        ).trim()
      : summaryText;
  const recentHistoryLines = recentHistory.map(formatConversationHistoryEntry);
  const relevantHistoryLines = earlierHistory.selected.map(
    formatConversationHistoryEntry,
  );
  const sessionMemoryLines = retrievedSessionEntries.map(
    (entry) => entry.content,
  );
  const workspaceMemoryLines = retrievedWorkspaceEntries.map(
    (entry) => entry.content,
  );
  const globalMemoryLines = retrievedGlobalEntries.map(
    (entry) => entry.content,
  );
  const reasoningBankEnabled =
    config.mode === "machdoch" &&
    (await isReasoningBankEnabled(
      workspaceRoot,
      workspace.selection === "selected" || conversationContext === undefined,
    ));
  const reasoningLessons = reasoningBankEnabled
    ? retrieveReasoningLessons(
        task,
        await createLocalReasoningBank(workspaceRoot)
          .load()
          .catch((error) => {
            console.error("ReasoningBank could not be loaded", error);
            return [];
          }),
        adaptivePlan
          ? {
              maxLessons: adaptivePlan.experienceLessons,
              maxCharacters: adaptivePlan.experienceCharacters,
            }
          : {},
      )
    : [];
  if (reasoningLessons.length > 0) {
    await createLocalReasoningBank(workspaceRoot)
      .recordRetrieval(reasoningLessons.map((lesson) => lesson.id))
      .catch((error) => {
        console.error("ReasoningBank retrieval could not be recorded", error);
      });
  }
  const workspaceRunContext = conversationContext?.workspaceRun;
  const promptSections = [
    conversationContext?.chatType === "pose"
      ? "This is a dedicated Pose chat. Create and refine OpenPose skeleton scenes, including multiple characters. Call pose_scene_get, then save the requested scene with pose_scene_replace or the pose_person_* and pose_joint_set tools. Make every figure's visible joint geometry match the requested action; a standing base pose with merely raised arms is not a climbing pose. Use climbing for climbers and vary the limbs and placement for multiple figures. Use reference images to reconstruct body positions. Do not generate a final image or call an image generation tool. A written pose scene is the deliverable; do not claim success unless a pose tool saved it. Briefly describe the saved pose and invite edits."
      : undefined,
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
    workspaceMemoryLines.length > 0
      ? [
          "<workspace_memory>",
          ...workspaceMemoryLines.map((line) => `- ${line}`),
          "</workspace_memory>",
        ].join("\n")
      : undefined,
    globalMemoryLines.length > 0
      ? [
          "<global_memory>",
          ...globalMemoryLines.map((line) => `- ${line}`),
          "</global_memory>",
        ].join("\n")
      : undefined,
    relevantHistoryLines.length > 0
      ? [
          "<relevant_earlier_conversation>",
          ...relevantHistoryLines,
          "</relevant_earlier_conversation>",
        ].join("\n")
      : undefined,
    reasoningLessons.length > 0
      ? [
          "<reasoning_bank>",
          "Past strategies are advisory; apply them only when relevant to the current task.",
          ...reasoningLessons.map(
            (lesson) => `- ${lesson.title}: ${lesson.content}`,
          ),
          "</reasoning_bank>",
        ].join("\n")
      : undefined,
    workspaceRunContext
      ? [
          "<workspace_run_context>",
          serializeWorkspaceRunContext(
            workspaceRunContext,
            adaptivePlan?.workspaceRunCharacters,
          ),
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
    ...(adaptivePlan ? { adaptivePlan } : {}),
    wasQueued: conversationContext?.wasQueued === true,
    workspace,
    ...(reasoningLessons.length > 0
      ? {
          reasoningBankRetrievedIds: reasoningLessons.map(
            (lesson) => lesson.id,
          ),
        }
      : {}),
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
                `workspace memory enabled: ${workspaceEnabled ? "yes" : "no"}`,
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
      ...(retrieval.diagnostics.candidateCount > 0 || workspaceLoadFailed
        ? [
            {
              title: "Memory retrieval",
              lines: [
                `candidates: ${retrieval.diagnostics.candidateCount}`,
                `selected: ${retrieval.diagnostics.selectedCount}`,
                `session selected: ${retrieval.diagnostics.selectedByScope.session}`,
                `workspace selected: ${retrieval.diagnostics.selectedByScope.workspace}`,
                `global selected: ${retrieval.diagnostics.selectedByScope.global}`,
                `context characters: ${retrieval.diagnostics.contextCharacters}`,
                `selection signals: ${retrieval.diagnostics.selectionSignals.join(", ") || "none"}`,
                ...(workspaceLoadFailed
                  ? ["workspace store: unavailable"]
                  : []),
              ],
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
      ...(conversationContext?.sessionId
        ? { sourceSessionId: conversationContext.sessionId }
        : {}),
      ...(conversationContext?.chatType === "pose"
        ? { poseScene: conversationContext.poseScene }
        : {}),
      sessionEnabled,
      sessionEntries,
      workspaceEnabled,
      workspaceEntries,
      globalEnabled,
      globalEntries,
    },
    memoryRetrieval: {
      ...retrieval.diagnostics,
      workspaceLoadFailed,
    },
    uiControlEnabled,
    ...(uiControl ? { uiControl } : {}),
  };
};
