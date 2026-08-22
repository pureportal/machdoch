import { rememberUserGlobalMemory } from "./env.js";
import { compactTraceText } from "./_helpers/runtime-text.js";
import { createInternalTaskModelExecution } from "./internal-task-model.js";
import {
  MAX_SESSION_MEMORY_ENTRIES,
  mergeConversationMemoryEntries,
  normalizeConversationMemoryEntries,
  normalizeMemoryContent,
  rememberConversationMemoryEntry,
} from "./memory.js";
import type {
  AgentModelAdapter,
  AgentModelToolCall,
  AgentModelToolSpec,
  ConversationMemoryScope,
  TaskConversationContext,
  TaskExecutionMemoryUpdate,
  TaskExecutionResult,
  TaskExecutionSection,
} from "./types.js";
import type { RuntimeConfig } from "./runtime-contract.generated.js";

const MAX_MEMORY_REVIEW_TEXT_LENGTH = 6_000;
const MAX_MEMORY_REVIEW_SECTION_LINES = 5;
const MAX_MEMORY_REVIEW_FACT_LENGTH = 220;
const MEMORY_DECISION_TOOL_NAME = "submit_memory_decisions";

interface MemoryCandidate {
  scope: ConversationMemoryScope;
  content: string;
}

interface MemoryConsolidationOptions {
  modelAdapter?: AgentModelAdapter;
  signal?: AbortSignal;
}

const createMemoryKey = (content: string): string => {
  return content
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/u, "")
    .toLowerCase();
};

const hasMemoryContent = (
  updates: TaskExecutionMemoryUpdate[],
  scope: ConversationMemoryScope,
  content: string,
): boolean => {
  const key = createMemoryKey(content);

  return updates.some(
    (update) =>
      update.scope === scope && createMemoryKey(update.entry.content) === key,
  );
};

const upsertMemoryUpdate = (
  updates: TaskExecutionMemoryUpdate[],
  nextUpdate: TaskExecutionMemoryUpdate,
): TaskExecutionMemoryUpdate[] => {
  return [
    ...updates.filter(
      (update) =>
        !(
          update.scope === nextUpdate.scope &&
          createMemoryKey(update.entry.content) ===
            createMemoryKey(nextUpdate.entry.content)
        ),
    ),
    nextUpdate,
  ];
};

const normalizeMemoryFact = (value: string | undefined): string | undefined => {
  return normalizeMemoryContent(
    value
      ?.replace(/^["'`]+|["'`]+$/gu, "")
      .replace(/\s+/gu, " ")
      .trim()
      .replace(/[.!?]+$/u, ""),
  );
};

const createMemoryDecisionTool = (): AgentModelToolSpec => {
  return {
    name: MEMORY_DECISION_TOOL_NAME,
    description:
      "Report which post-task memories, if any, should be saved for future task execution.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        memories: {
          type: "array",
          description:
            "High-signal memories to save. Use an empty array when nothing is worth remembering.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              scope: {
                type: "string",
                enum: ["session", "global"],
                description:
                  "session for current-chat/project context; global for stable cross-session user preferences or identity.",
              },
              content: {
                type: "string",
                description:
                  "A short standalone third-person fact to remember. Do not include secrets, raw logs, or speculation.",
              },
              reason: {
                type: "string",
                description: "Why this memory will help later task execution.",
              },
              confidence: {
                type: "string",
                enum: ["high", "medium", "low"],
                description:
                  "Confidence that the memory is durable and useful enough to save.",
              },
              sensitivity: {
                type: "string",
                enum: ["non-sensitive", "sensitive", "unknown"],
                description:
                  "Classify the proposed memory. Only non-sensitive memories are accepted.",
              },
            },
            required: [
              "scope",
              "content",
              "reason",
              "confidence",
              "sensitivity",
            ],
          },
        },
      },
      required: ["memories"],
    },
  };
};

const createMemoryReviewSystemPrompt = (): string => {
  return [
    "You are Machdoch's post-task memory manager.",
    "Decide what, if anything, should be saved after this task so future task execution is better.",
    "Call `submit_memory_decisions` exactly once. Do not write prose.",
    "",
    "Save session memory for information useful later in this same chat or workspace task flow:",
    "- user-provided constraints, decisions, terminology, project facts, or next-step context",
    "- technical limitations encountered, blockers, resolved errors, workarounds, or commands that succeeded",
    "- integration details that are likely to matter again during this session",
    "",
    "Save global memory only for stable cross-session user preferences, identity, or workflow habits.",
    "",
    "Do not save secrets, credentials, private keys, raw logs, transient progress, generic facts, one-off completed actions, speculation, or facts already present in memory.",
    "Each memory must be concise, standalone, third-person, and useful without the original transcript.",
  ].join("\n");
};

const formatExistingMemoryLines = (
  entries: TaskConversationContext["sessionMemory"],
  scope: ConversationMemoryScope,
): string[] => {
  const normalized = normalizeConversationMemoryEntries(entries, scope);

  if (normalized.length === 0) {
    return [`${scope}: none`];
  }

  return normalized.map((entry) => `${scope}: ${entry.content}`);
};

const formatResultSectionsForMemoryReview = (
  sections: TaskExecutionSection[],
): string[] => {
  return sections.flatMap((section) => {
    const lines = section.lines
      .slice(0, MAX_MEMORY_REVIEW_SECTION_LINES)
      .map((line) => `  - ${compactTraceText(line)}`);

    return [`${section.title}:`, ...lines];
  });
};

const createMemoryReviewUserPrompt = (
  task: string,
  result: TaskExecutionResult,
  conversationContext: TaskConversationContext | undefined,
  options: {
    sessionEnabled: boolean;
    globalEnabled: boolean;
  },
): string => {
  const existingSessionMemory = options.sessionEnabled
    ? formatExistingMemoryLines(conversationContext?.sessionMemory, "session")
    : ["session: disabled"];
  const existingGlobalMemory = options.globalEnabled
    ? formatExistingMemoryLines(conversationContext?.globalMemory, "global")
    : ["global: disabled"];
  const existingUpdates =
    result.memoryUpdates?.map(
      (update) => `${update.scope}: ${update.entry.content}`,
    ) ?? [];
  const responseLines = result.response
    ? [
        "Final response:",
        compactTraceText(result.response.markdown),
        ...result.response.verification.map(
          (line) => `verification: ${compactTraceText(line)}`,
        ),
        ...result.response.followUps.map(
          (line) => `follow-up: ${compactTraceText(line)}`,
        ),
      ]
    : [];

  return [
    "<memory_scope>",
    `session memory: ${options.sessionEnabled ? "enabled" : "disabled"}`,
    `global memory: ${options.globalEnabled ? "enabled" : "disabled"}`,
    "</memory_scope>",
    "",
    "<existing_memory>",
    ...existingSessionMemory,
    ...existingGlobalMemory,
    ...(existingUpdates.length > 0
      ? ["updates already saved this turn:", ...existingUpdates]
      : []),
    "</existing_memory>",
    "",
    "<task>",
    compactTraceText(task),
    "</task>",
    "",
    "<execution_result>",
    `status: ${result.status}`,
    `summary: ${compactTraceText(result.summary)}`,
    ...(result.reason ? [`reason: ${compactTraceText(result.reason)}`] : []),
    `executed tools: ${result.executedTools.join(", ") || "none"}`,
    ...responseLines,
    ...formatResultSectionsForMemoryReview(result.outputSections),
    "</execution_result>",
  ]
    .join("\n")
    .slice(0, MAX_MEMORY_REVIEW_TEXT_LENGTH);
};

const isConversationMemoryScope = (
  value: unknown,
): value is ConversationMemoryScope => {
  return value === "session" || value === "global";
};

const isAcceptedModelConfidence = (value: unknown): boolean => {
  return value === "high" || value === "medium";
};

const parseMemoryDecisionCandidates = (
  toolCall: AgentModelToolCall | undefined,
  options: {
    sessionEnabled: boolean;
    globalEnabled: boolean;
  },
): MemoryCandidate[] => {
  if (
    !toolCall ||
    Object.keys(toolCall.arguments).length !== 1 ||
    !Object.hasOwn(toolCall.arguments, "memories")
  ) {
    return [];
  }
  const memories = toolCall?.arguments.memories;

  if (!Array.isArray(memories)) {
    return [];
  }

  const candidates = memories.flatMap((memory): MemoryCandidate[] => {
    if (!memory || typeof memory !== "object") {
      return [];
    }

    const record = memory as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (
      keys.length !== 5 ||
      keys[0] !== "confidence" ||
      keys[1] !== "content" ||
      keys[2] !== "reason" ||
      keys[3] !== "scope" ||
      keys[4] !== "sensitivity" ||
      typeof record.reason !== "string" ||
      record.reason.trim().length === 0
    ) {
      return [];
    }
    const scope = record.scope;
    const content = normalizeMemoryFact(
      typeof record.content === "string"
        ? record.content.slice(0, MAX_MEMORY_REVIEW_FACT_LENGTH)
        : undefined,
    );

    if (
      !isConversationMemoryScope(scope) ||
      !content ||
      !isAcceptedModelConfidence(record.confidence) ||
      record.sensitivity !== "non-sensitive"
    ) {
      return [];
    }

    if (scope === "session" && !options.sessionEnabled) {
      return [];
    }

    if (scope === "global" && !options.globalEnabled) {
      return [];
    }

    return [
      {
        scope,
        content,
      },
    ];
  });

  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    const key = `${candidate.scope}:${createMemoryKey(candidate.content)}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
};

const extractModelMemoryCandidates = async (
  task: string,
  config: RuntimeConfig,
  result: TaskExecutionResult,
  conversationContext: TaskConversationContext | undefined,
  memoryOptions: {
    sessionEnabled: boolean;
    globalEnabled: boolean;
  },
  consolidationOptions: MemoryConsolidationOptions,
): Promise<MemoryCandidate[]> => {
  if (
    (!memoryOptions.sessionEnabled && !memoryOptions.globalEnabled) ||
    consolidationOptions.signal?.aborted
  ) {
    return [];
  }

  try {
    const memoryDecisionTool = createMemoryDecisionTool();
    const execution = await createInternalTaskModelExecution(
      config,
      [memoryDecisionTool],
      consolidationOptions.modelAdapter,
    );

    if (!execution) {
      return [];
    }

    const turn = await execution.adapter.startTurn({
      model: execution.config.model,
      systemPrompt: createMemoryReviewSystemPrompt(),
      userPrompt: createMemoryReviewUserPrompt(
        task,
        result,
        conversationContext,
        memoryOptions,
      ),
      tools: [memoryDecisionTool],
      ...(consolidationOptions.signal
        ? { signal: consolidationOptions.signal }
        : {}),
    });
    const decisionCall =
      turn.toolCalls.length === 1 &&
      turn.toolCalls[0]?.name === MEMORY_DECISION_TOOL_NAME
        ? turn.toolCalls[0]
        : undefined;

    return parseMemoryDecisionCandidates(decisionCall, memoryOptions);
  } catch {
    return [];
  }
};

const createAutomaticMemorySection = (
  updates: TaskExecutionMemoryUpdate[],
): TaskExecutionSection => {
  return {
    title: "Memory consolidation",
    lines: updates.flatMap((update) => [
      `scope: ${update.scope}`,
      `fact: ${update.entry.content}`,
    ]),
  };
};

export const consolidateTaskExecutionMemory = async (
  task: string,
  config: RuntimeConfig,
  result: TaskExecutionResult,
  conversationContext: TaskConversationContext | undefined,
  consolidationOptions: MemoryConsolidationOptions = {},
): Promise<TaskExecutionResult> => {
  if (
    config.mode === "ask" ||
    result.status === "cancelled" ||
    result.status === "unsupported"
  ) {
    return result;
  }

  const sessionEnabled =
    conversationContext !== undefined &&
    conversationContext.sessionMemoryEnabled !== false;
  const globalEnabled = conversationContext?.globalMemoryEnabled === true;
  const memoryOptions = {
    sessionEnabled,
    globalEnabled,
  };
  const candidates = await extractModelMemoryCandidates(
    task,
    config,
    result,
    conversationContext,
    memoryOptions,
    consolidationOptions,
  );

  if (candidates.length === 0) {
    return result;
  }

  let memoryUpdates = result.memoryUpdates ?? [];
  const automaticUpdates: TaskExecutionMemoryUpdate[] = [];
  let sessionEntries = mergeConversationMemoryEntries(
    normalizeConversationMemoryEntries(
      conversationContext?.sessionMemory,
      "session",
    ),
    memoryUpdates
      .filter((update) => update.scope === "session")
      .map((update) => update.entry),
    MAX_SESSION_MEMORY_ENTRIES,
  );

  for (const candidate of candidates) {
    if (hasMemoryContent(memoryUpdates, candidate.scope, candidate.content)) {
      continue;
    }

    if (candidate.scope === "session") {
      const remembered = rememberConversationMemoryEntry(
        sessionEntries,
        "session",
        candidate.content,
        MAX_SESSION_MEMORY_ENTRIES,
      );
      const update = {
        scope: "session" as const,
        entry: remembered.entry,
      };

      sessionEntries = remembered.entries;
      memoryUpdates = upsertMemoryUpdate(memoryUpdates, update);
      automaticUpdates.push(update);
      continue;
    }

    const rememberedEntry = await rememberUserGlobalMemory(candidate.content);
    const update = {
      scope: "global" as const,
      entry: rememberedEntry,
    };

    memoryUpdates = upsertMemoryUpdate(memoryUpdates, update);
    automaticUpdates.push(update);
  }

  if (automaticUpdates.length === 0) {
    return result;
  }

  return {
    ...result,
    memoryUpdates,
    outputSections: [
      ...result.outputSections,
      createAutomaticMemorySection(automaticUpdates),
    ],
  };
};
