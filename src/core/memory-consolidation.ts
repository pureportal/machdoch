import { rememberUserGlobalMemory } from "./env.js";
import { createProviderAdapter } from "./_helpers/provider-adapters.js";
import { compactTraceText } from "./_helpers/runtime-text.js";
import { resolveReviewModelRuntimeConfig } from "./review-model.js";
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
  RuntimeConfig,
  TaskConversationContext,
  TaskExecutionMemoryUpdate,
  TaskExecutionResult,
  TaskExecutionSection,
} from "./types.js";

const MAX_MEMORY_SOURCE_TEXT_LENGTH = 1_200;
const MAX_MEMORY_REVIEW_TEXT_LENGTH = 6_000;
const MAX_MEMORY_REVIEW_SECTION_LINES = 5;
const MAX_MEMORY_REVIEW_FACT_LENGTH = 220;
const MIN_INFERRED_PREFERENCE_LENGTH = 8;
const MEMORY_DECISION_TOOL_NAME = "submit_memory_decisions";

const SECRET_PATTERN =
  /\b(api[_\s-]?key|access[_\s-]?token|auth[_\s-]?token|bearer|client[_\s-]?secret|credential|password|passphrase|private[_\s-]?key|secret|ssh[_\s-]?key)\b/i;
const EXPLICIT_GLOBAL_PATTERN =
  /\b(global(?:ly)?|across sessions?|cross-session|future sessions?|new sessions?|always remember|remember forever|remember permanently)\b/i;
const EXPLICIT_SESSION_PATTERN =
  /\b(this session|current session|for now|temporarily|only in this chat|only for this chat)\b/i;
const REMEMBER_PATTERN =
  /\b(?:please\s+)?(?:remember|memorize|keep in memory|save (?:this|that) in memory|store (?:this|that) in memory)\b[:\s-]*(?:(?:global(?:ly)?|across sessions?|future sessions?|new sessions?|permanently|forever|this session|current session|for now|temporarily|only in this chat|only for this chat)\s+)?(?:that\s+)?(?<fact>[^.!?\n]+(?:[.!?]|$))/i;
const PREFERENCE_PATTERNS: RegExp[] = [
  /\bI prefer (?<preference>[^.!?\n]+(?:[.!?]|$))/i,
  /\bmy preference is (?<preference>[^.!?\n]+(?:[.!?]|$))/i,
  /\bfrom now on,?\s+(?<preference>[^.!?\n]+(?:[.!?]|$))/i,
  /\balways (?<preference>[^.!?\n]+(?:[.!?]|$))/i,
  /\bcall me (?<preference>[^.!?\n]+(?:[.!?]|$))/i,
];

interface MemoryCandidate {
  scope: ConversationMemoryScope;
  content: string;
  confidence: "explicit" | "inferred" | "model";
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

const isSensitiveMemoryContent = (content: string): boolean => {
  return SECRET_PATTERN.test(content);
};

const chooseExplicitMemoryScope = (
  text: string,
  options: {
    sessionEnabled: boolean;
    globalEnabled: boolean;
  },
): ConversationMemoryScope | undefined => {
  if (EXPLICIT_GLOBAL_PATTERN.test(text)) {
    return options.globalEnabled ? "global" : undefined;
  }

  if (EXPLICIT_SESSION_PATTERN.test(text)) {
    return options.sessionEnabled ? "session" : undefined;
  }

  if (options.sessionEnabled) {
    return "session";
  }

  return options.globalEnabled ? "global" : undefined;
};

const choosePreferenceMemoryScope = (
  text: string,
  options: {
    sessionEnabled: boolean;
    globalEnabled: boolean;
  },
): ConversationMemoryScope | undefined => {
  if (EXPLICIT_SESSION_PATTERN.test(text)) {
    return options.sessionEnabled ? "session" : undefined;
  }

  if (
    options.globalEnabled &&
    (EXPLICIT_GLOBAL_PATTERN.test(text) || /\b(always|from now on|call me)\b/i.test(text))
  ) {
    return "global";
  }

  if (options.sessionEnabled) {
    return "session";
  }

  return undefined;
};

const createPreferenceMemoryContent = (
  matchedText: string,
  preference: string,
): string | undefined => {
  const normalizedPreference = normalizeMemoryFact(preference);

  if (
    !normalizedPreference ||
    normalizedPreference.length < MIN_INFERRED_PREFERENCE_LENGTH
  ) {
    return undefined;
  }

  if (/^\s*call me\b/i.test(matchedText)) {
    return normalizeMemoryFact(`The user wants to be called ${normalizedPreference}`);
  }

  if (/^\s*(?:from now on|always)\b/i.test(matchedText)) {
    return normalizeMemoryFact(`The user prefers: ${normalizedPreference}`);
  }

  return normalizeMemoryFact(`The user prefers ${normalizedPreference}`);
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
                description:
                  "Why this memory will help later task execution.",
              },
              confidence: {
                type: "string",
                enum: ["high", "medium", "low"],
                description:
                  "Confidence that the memory is durable and useful enough to save.",
              },
            },
            required: ["scope", "content", "reason", "confidence"],
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
  const memories = toolCall?.arguments.memories;

  if (!Array.isArray(memories)) {
    return [];
  }

  const candidates = memories.flatMap((memory): MemoryCandidate[] => {
    if (!memory || typeof memory !== "object") {
      return [];
    }

    const record = memory as Record<string, unknown>;
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
      isSensitiveMemoryContent(content)
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
        confidence: "model",
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
    const reviewConfig = resolveReviewModelRuntimeConfig(config);
    const adapter = await createProviderAdapter(
      reviewConfig,
      [memoryDecisionTool],
      consolidationOptions.modelAdapter,
    );

    if (!adapter) {
      return [];
    }

    const turn = await adapter.startTurn({
      model: reviewConfig.model,
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
    const decisionCall = turn.toolCalls.find(
      (call) => call.name === MEMORY_DECISION_TOOL_NAME,
    );

    return parseMemoryDecisionCandidates(decisionCall, memoryOptions);
  } catch {
    return [];
  }
};

export const extractTaskMemoryCandidates = (
  task: string,
  options: {
    sessionEnabled: boolean;
    globalEnabled: boolean;
  },
): MemoryCandidate[] => {
  const sourceText = task.slice(0, MAX_MEMORY_SOURCE_TEXT_LENGTH);

  if (
    (!options.sessionEnabled && !options.globalEnabled) ||
    isSensitiveMemoryContent(sourceText)
  ) {
    return [];
  }

  const candidates: MemoryCandidate[] = [];
  const rememberedFact = normalizeMemoryFact(
    REMEMBER_PATTERN.exec(sourceText)?.groups?.fact,
  );
  const explicitScope = chooseExplicitMemoryScope(sourceText, options);

  if (rememberedFact && explicitScope && !isSensitiveMemoryContent(rememberedFact)) {
    candidates.push({
      scope: explicitScope,
      content: rememberedFact,
      confidence: "explicit",
    });
  }

  for (const pattern of PREFERENCE_PATTERNS) {
    const match = pattern.exec(sourceText);
    const preference = match?.groups?.preference;
    const content = createPreferenceMemoryContent(match?.[0] ?? "", preference ?? "");
    const scope = choosePreferenceMemoryScope(sourceText, options);

    if (!content || !scope || isSensitiveMemoryContent(content)) {
      continue;
    }

    candidates.push({
      scope,
      content,
      confidence: "inferred",
    });
  }

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
  const candidates = [
    ...extractTaskMemoryCandidates(task, memoryOptions),
    ...(await extractModelMemoryCandidates(
      task,
      config,
      result,
      conversationContext,
      memoryOptions,
      consolidationOptions,
    )),
  ];

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
