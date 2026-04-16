import { loadUserMemorySettings } from "../env.js";
import { normalizeConversationMemoryEntries } from "../memory.js";
import type {
  ConversationHistoryEntry,
  ConversationMemoryEntry,
  RuntimeConfig,
  TaskConversationContext,
  TaskExecutionSection,
} from "../types.js";
import type { ConversationMemoryRuntime } from "./agent-tools.js";
import { createProviderAdapter } from "./provider-adapters.js";
import {
  compactTraceText,
  createTextSection,
  limitText,
} from "./runtime-text.js";

const MAX_CONVERSATION_HISTORY_MESSAGES = 60;
const MAX_RECENT_HISTORY_MESSAGES = 8;
const MAX_RECENT_HISTORY_CHARS = 3_600;
const MAX_CONVERSATION_SUMMARY_INPUT_CHARS = 10_000;
const MAX_CONVERSATION_SUMMARY_SECTION_LINES = 12;
const MAX_MEMORY_PROMPT_ENTRIES = 10;

export interface PreparedConversationPromptContext {
  promptBlock?: string;
  sections: TaskExecutionSection[];
  memory: ConversationMemoryRuntime;
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

export const prepareConversationPromptContext = async (
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
