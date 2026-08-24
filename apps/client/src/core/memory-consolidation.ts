import { rememberUserGlobalMemory } from "./env.js";
import { compactTraceText } from "./_helpers/runtime-text.js";
import { isAgentCliProvider } from "./_helpers/agent-cli-providers.js";
import { createInternalTaskModelExecution } from "./internal-task-model.js";
import { observeAgentModelCall } from "./model-usage.js";
import {
  MAX_SESSION_MEMORY_ENTRIES,
  normalizeConversationMemoryEntries,
  normalizeMemoryContent,
  normalizeMemoryKey,
  rememberConversationMemoryEntry,
  type ConversationMemoryMetadata,
} from "./memory.js";
import {
  loadWorkspaceMemory,
  rememberWorkspaceMemory,
} from "./workspace-memory.js";
import type {
  AgentModelAdapter,
  AgentModelToolCall,
  AgentModelToolSpec,
  ConversationMemoryKind,
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
const MAX_MEMORY_CANDIDATES = 4;
const MAX_EXISTING_MEMORY_PER_SCOPE = 6;
const MAX_EXISTING_MEMORY_CONTENT_LENGTH = 120;
const MAX_MEMORY_EXTRACTION_DURATION_MS = 10_000;
const MEMORY_DECISION_TOOL_NAME = "submit_memory_decisions";

interface MemoryCandidate extends ConversationMemoryMetadata {
  scope: ConversationMemoryScope;
  content: string;
  key: string;
  kind: ConversationMemoryKind;
  importance: number;
  confidence: number;
}

interface MemoryConsolidationOptions {
  modelAdapter?: AgentModelAdapter;
  signal?: AbortSignal;
}

interface MemoryExtractionResult {
  status: "completed" | "unavailable" | "failed" | "cancelled";
  candidates: MemoryCandidate[];
  reason?: string;
}

const upsertMemoryUpdate = (
  updates: TaskExecutionMemoryUpdate[],
  nextUpdate: TaskExecutionMemoryUpdate,
): TaskExecutionMemoryUpdate[] => {
  return [
    ...updates.filter(
      (update) =>
        !(
          update.scope === nextUpdate.scope &&
          update.entry.key === nextUpdate.entry.key
        ),
    ),
    nextUpdate,
  ];
};

const createMemoryDecisionTool = (): AgentModelToolSpec => ({
  name: MEMORY_DECISION_TOOL_NAME,
  description:
    "Report only high-signal memories that should improve future task execution.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      memories: {
        type: "array",
        maxItems: MAX_MEMORY_CANDIDATES,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            scope: {
              type: "string",
              enum: ["session", "workspace", "global"],
            },
            key: {
              type: "string",
              description:
                "A stable short concept key. Reuse an existing key to supersede stale or conflicting information.",
            },
            kind: {
              type: "string",
              enum: [
                "preference",
                "constraint",
                "decision",
                "fact",
                "workaround",
              ],
            },
            content: {
              type: "string",
              description:
                "A concise standalone fact with enough retrieval context.",
            },
            reason: { type: "string" },
            importance: {
              type: "integer",
              minimum: 1,
              maximum: 5,
            },
            confidence: {
              type: "string",
              enum: ["high", "medium", "low"],
            },
            sensitivity: {
              type: "string",
              enum: ["non-sensitive", "sensitive", "unknown"],
            },
          },
          required: [
            "scope",
            "key",
            "kind",
            "content",
            "reason",
            "importance",
            "confidence",
            "sensitivity",
          ],
        },
      },
    },
    required: ["memories"],
  },
});

const createMemoryReviewSystemPrompt = (): string => {
  return [
    "You are Machdoch's post-task memory manager.",
    "Call `submit_memory_decisions` exactly once. Do not write prose.",
    "Save session memory for current-chat context that will matter on a later turn.",
    "Save workspace memory for durable project constraints, decisions, commands, integrations, and verified workarounds that should matter across sessions in this workspace.",
    "Save global memory only for stable cross-workspace user preferences or identity.",
    "Prefer updating an existing concept key over adding another version of the same fact.",
    "Do not save secrets, credentials, raw logs, transient progress, generic facts, completed actions, source code that can be read from the workspace, or speculation.",
    "Use an empty array when nothing is worth remembering.",
  ].join("\n");
};

const formatExistingMemoryLines = (
  entries: unknown,
  scope: ConversationMemoryScope,
): string[] => {
  const normalized = normalizeConversationMemoryEntries(entries, scope);

  return normalized.length > 0
    ? normalized
        .slice(0, MAX_EXISTING_MEMORY_PER_SCOPE)
        .map(
          (entry) =>
            `${scope}:${entry.id}:${entry.key}: ${entry.content.slice(0, MAX_EXISTING_MEMORY_CONTENT_LENGTH)}`,
        )
    : [`${scope}: none`];
};

const formatResultSectionsForMemoryReview = (
  sections: TaskExecutionSection[],
): string[] => {
  return sections.flatMap((section) => [
    `${section.title}:`,
    ...section.lines
      .slice(0, MAX_MEMORY_REVIEW_SECTION_LINES)
      .map((line) => `  - ${compactTraceText(line)}`),
  ]);
};

const createMemoryReviewUserPrompt = (
  task: string,
  result: TaskExecutionResult,
  existingEntries: Record<
    ConversationMemoryScope,
    ConversationMemoryEntryLike[]
  >,
  enabled: Record<ConversationMemoryScope, boolean>,
): string => {
  const existingUpdates =
    result.memoryUpdates?.map(
      (update) =>
        `${update.scope}:${update.entry.key}: ${update.entry.content}`,
    ) ?? [];
  const responseLines = result.response
    ? [
        "Final response:",
        compactTraceText(result.response.markdown),
        ...result.response.verification.map(
          (line) => `verification: ${compactTraceText(line)}`,
        ),
      ]
    : [];

  return [
    "<memory_scope>",
    ...(["session", "workspace", "global"] as const).map(
      (scope) => `${scope}: ${enabled[scope] ? "enabled" : "disabled"}`,
    ),
    "</memory_scope>",
    "",
    "<existing_memory>",
    ...(["session", "workspace", "global"] as const).flatMap((scope) =>
      enabled[scope]
        ? formatExistingMemoryLines(existingEntries[scope], scope)
        : [`${scope}: disabled`],
    ),
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

type ConversationMemoryEntryLike = NonNullable<
  TaskConversationContext["sessionMemory"]
>[number];

const isMemoryScope = (value: unknown): value is ConversationMemoryScope => {
  return value === "session" || value === "workspace" || value === "global";
};

const isMemoryKind = (value: unknown): value is ConversationMemoryKind => {
  return (
    value === "preference" ||
    value === "constraint" ||
    value === "decision" ||
    value === "fact" ||
    value === "workaround"
  );
};

const parseMemoryDecisionCandidates = (
  toolCall: AgentModelToolCall | undefined,
  enabled: Record<ConversationMemoryScope, boolean>,
): MemoryCandidate[] => {
  if (
    !toolCall ||
    Object.keys(toolCall.arguments).length !== 1 ||
    !Object.hasOwn(toolCall.arguments, "memories") ||
    !Array.isArray(toolCall.arguments.memories)
  ) {
    return [];
  }

  const candidates = toolCall.arguments.memories
    .slice(0, MAX_MEMORY_CANDIDATES)
    .flatMap((memory): MemoryCandidate[] => {
      if (!memory || typeof memory !== "object") {
        return [];
      }

      const record = memory as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const expectedKeys = [
        "confidence",
        "content",
        "importance",
        "key",
        "kind",
        "reason",
        "scope",
        "sensitivity",
      ];
      const scope = record.scope;
      const content = normalizeMemoryContent(
        typeof record.content === "string"
          ? record.content.slice(0, MAX_MEMORY_REVIEW_FACT_LENGTH)
          : undefined,
      );

      if (
        keys.length !== expectedKeys.length ||
        !keys.every((key, index) => key === expectedKeys[index]) ||
        !isMemoryScope(scope) ||
        !enabled[scope] ||
        !isMemoryKind(record.kind) ||
        !content ||
        typeof record.key !== "string" ||
        typeof record.reason !== "string" ||
        record.reason.trim().length === 0 ||
        typeof record.importance !== "number" ||
        !Number.isInteger(record.importance) ||
        record.importance < 1 ||
        record.importance > 5 ||
        (record.confidence !== "high" && record.confidence !== "medium") ||
        record.sensitivity !== "non-sensitive"
      ) {
        return [];
      }

      return [
        {
          scope,
          key: normalizeMemoryKey(record.key, content),
          kind: record.kind,
          content,
          importance: record.importance,
          confidence: record.confidence === "high" ? 1 : 0.75,
        },
      ];
    });
  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    const key = `${candidate.scope}:${candidate.key}`;

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
  existingEntries: Record<
    ConversationMemoryScope,
    ConversationMemoryEntryLike[]
  >,
  enabled: Record<ConversationMemoryScope, boolean>,
  options: MemoryConsolidationOptions,
): Promise<MemoryExtractionResult> => {
  if (options.signal?.aborted) {
    return { status: "cancelled", candidates: [], reason: "signal-aborted" };
  }

  try {
    const decisionTool = createMemoryDecisionTool();
    const execution = await createInternalTaskModelExecution(
      config,
      [decisionTool],
      options.modelAdapter,
    );

    if (!execution) {
      return {
        status: "unavailable",
        candidates: [],
        reason: "internal-model-adapter-unavailable",
      };
    }

    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort("memory-extraction-timeout"),
      MAX_MEMORY_EXTRACTION_DURATION_MS,
    );
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal;
    const aborted = new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("Memory extraction was aborted.")),
        { once: true },
      );
    });
    const systemPrompt = createMemoryReviewSystemPrompt();
    const userPrompt = createMemoryReviewUserPrompt(
      task,
      result,
      existingEntries,
      enabled,
    );
    let turn;

    try {
      turn = await Promise.race([
        observeAgentModelCall(
          {
            stage: "memory-consolidation",
            provider: execution.config.provider,
            model: execution.config.model,
            operation: "extractMemoryCandidates",
            requestPayload: {
              systemPrompt,
              userPrompt,
              tools: [decisionTool],
            },
            toolDefinitions: [decisionTool],
          },
          async (onRequestAttempt) =>
            await execution.adapter.startTurn({
              model: execution.config.model,
              systemPrompt,
              userPrompt,
              tools: [decisionTool],
              signal,
              ...(onRequestAttempt ? { onRequestAttempt } : {}),
            }),
        ),
        aborted,
      ]);
    } finally {
      clearTimeout(timeout);
    }
    const decisionCall =
      turn.toolCalls.length === 1 &&
      turn.toolCalls[0]?.name === MEMORY_DECISION_TOOL_NAME
        ? turn.toolCalls[0]
        : undefined;

    return {
      status: "completed",
      candidates: parseMemoryDecisionCandidates(decisionCall, enabled),
    };
  } catch (error) {
    console.error("Post-task memory extraction failed", error);
    const timedOut =
      !options.signal?.aborted &&
      error instanceof Error &&
      error.message === "Memory extraction was aborted.";
    return {
      status: options.signal?.aborted ? "cancelled" : "failed",
      candidates: [],
      reason: options.signal?.aborted
        ? "signal-aborted"
        : timedOut
          ? "extraction-timeout"
          : "model-call-failed",
    };
  }
};

const attachCaptureDiagnostics = (
  result: TaskExecutionResult,
  extraction: MemoryExtractionResult,
  storedCount: number,
  failedCount: number,
): TaskExecutionResult => ({
  ...result,
  metadata: {
    ...(result.metadata ?? {}),
    memoryCapture: {
      status: extraction.status,
      candidateCount: extraction.candidates.length,
      candidatesByScope: extraction.candidates.reduce(
        (counts, candidate) => ({
          ...counts,
          [candidate.scope]: counts[candidate.scope] + 1,
        }),
        { session: 0, workspace: 0, global: 0 },
      ),
      storedCount,
      failedCount,
      ...(extraction.reason ? { reason: extraction.reason } : {}),
    },
  },
});

export const consolidateTaskExecutionMemory = async (
  task: string,
  config: RuntimeConfig,
  result: TaskExecutionResult,
  conversationContext: TaskConversationContext | undefined,
  options: MemoryConsolidationOptions = {},
): Promise<TaskExecutionResult> => {
  if (
    config.mode === "ask" ||
    result.status === "cancelled" ||
    result.status === "unsupported" ||
    result.memoryUpdates?.length
  ) {
    return result;
  }

  if (!options.modelAdapter && !isAgentCliProvider(config.provider)) {
    return result;
  }

  const workspaceEnabled =
    conversationContext?.workspace?.selection !== "not-set";
  const workspaceRoot = config.workspaceRoot;
  const enabled: Record<ConversationMemoryScope, boolean> = {
    session:
      conversationContext !== undefined &&
      conversationContext.sessionMemoryEnabled !== false,
    workspace: workspaceEnabled,
    global: conversationContext?.globalMemoryEnabled === true,
  };
  const workspaceEntries = workspaceEnabled
    ? await loadWorkspaceMemory(workspaceRoot).catch((error) => {
        console.error("Workspace memory could not be loaded", error);
        return [];
      })
    : [];
  const existingEntries: Record<
    ConversationMemoryScope,
    ConversationMemoryEntryLike[]
  > = {
    session: normalizeConversationMemoryEntries(
      conversationContext?.sessionMemory,
      "session",
    ),
    workspace: normalizeConversationMemoryEntries(
      workspaceEntries,
      "workspace",
    ),
    global: normalizeConversationMemoryEntries(
      conversationContext?.globalMemory,
      "global",
    ),
  };
  const extraction = await extractModelMemoryCandidates(
    task,
    config,
    result,
    existingEntries,
    enabled,
    options,
  );

  if (extraction.candidates.length === 0) {
    return attachCaptureDiagnostics(result, extraction, 0, 0);
  }

  let memoryUpdates = result.memoryUpdates ?? [];
  let sessionEntries = existingEntries.session;
  let storedCount = 0;
  let failedCount = 0;

  for (const candidate of extraction.candidates) {
    try {
      let entry;

      if (candidate.scope === "session") {
        const remembered = rememberConversationMemoryEntry(
          sessionEntries,
          "session",
          candidate.content,
          MAX_SESSION_MEMORY_ENTRIES,
          Date.now(),
          candidate,
        );
        sessionEntries = remembered.entries;
        entry = remembered.entry;
      } else if (candidate.scope === "workspace") {
        entry = await rememberWorkspaceMemory(
          workspaceRoot,
          candidate.content,
          candidate,
        );
      } else {
        entry = await rememberUserGlobalMemory(candidate.content, candidate);
      }

      memoryUpdates = upsertMemoryUpdate(memoryUpdates, {
        scope: candidate.scope,
        entry,
      });
      storedCount += 1;
    } catch (error) {
      failedCount += 1;
      console.error(`Failed to persist ${candidate.scope} memory`, error);
    }
  }

  return attachCaptureDiagnostics(
    {
      ...result,
      ...(memoryUpdates.length > 0 ? { memoryUpdates } : {}),
    },
    extraction,
    storedCount,
    failedCount,
  );
};
