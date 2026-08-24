import { rememberUserGlobalMemory } from "../env.js";
import {
  MAX_GLOBAL_MEMORY_ENTRIES,
  MAX_SESSION_MEMORY_ENTRIES,
  MAX_WORKSPACE_MEMORY_ENTRIES,
  mergeConversationMemoryEntries,
  rememberConversationMemoryEntry,
  normalizeMemorySearchTerms,
  type ConversationMemoryMetadata,
} from "../memory.js";
import type { ConversationMemoryKind } from "../types.js";
import { rememberWorkspaceMemory } from "../workspace-memory.js";
import {
  coerceString,
  createToolErrorResult,
  type AgentToolDefinition,
  type ConversationMemoryRuntime,
} from "./agent-tools-shared.js";

const MEMORY_ARGUMENT_KEYS = [
  "fact",
  "importance",
  "kind",
  "memory_key",
  "search_terms",
  "sensitivity",
] as const;

const isMemoryKind = (value: unknown): value is ConversationMemoryKind => {
  return (
    value === "preference" ||
    value === "constraint" ||
    value === "decision" ||
    value === "fact" ||
    value === "workaround"
  );
};

const parseMemoryMetadata = (
  args: Record<string, unknown>,
): ConversationMemoryMetadata | undefined => {
  const keys = Object.keys(args).sort();
  const fact = coerceString(args, "fact");
  const memoryKey = coerceString(args, "memory_key");
  const searchTerms = normalizeMemorySearchTerms(args.search_terms);

  if (
    keys.length !== MEMORY_ARGUMENT_KEYS.length ||
    !keys.every((key, index) => key === MEMORY_ARGUMENT_KEYS[index]) ||
    !fact ||
    !memoryKey ||
    !isMemoryKind(args.kind) ||
    typeof args.importance !== "number" ||
    !Number.isInteger(args.importance) ||
    args.importance < 1 ||
    args.importance > 5 ||
    !Array.isArray(args.search_terms) ||
    searchTerms.length !== args.search_terms.length ||
    args.sensitivity !== "non-sensitive"
  ) {
    return undefined;
  }

  return {
    key: memoryKey,
    kind: args.kind,
    searchTerms,
    importance: args.importance,
    confidence: 1,
  };
};

const createMemoryInputSchema = (factDescription: string) => ({
  type: "object",
  additionalProperties: false,
  properties: {
    fact: {
      type: "string",
      description: factDescription,
    },
    memory_key: {
      type: "string",
      description:
        "A stable short concept key. Reuse the same key when correcting or superseding an earlier memory.",
    },
    kind: {
      type: "string",
      enum: ["preference", "constraint", "decision", "fact", "workaround"],
    },
    search_terms: {
      type: "array",
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 48 },
      description:
        "Short query terms that could retrieve this memory when the request uses different wording. Use an empty array when none are needed.",
    },
    importance: {
      type: "integer",
      minimum: 1,
      maximum: 5,
    },
    sensitivity: {
      type: "string",
      enum: ["non-sensitive", "sensitive", "unknown"],
    },
  },
  required: [...MEMORY_ARGUMENT_KEYS],
});

const createInvalidMemoryResult = (name: string) => {
  return createToolErrorResult(
    crypto.randomUUID(),
    name,
    "Expected a non-sensitive memory with a fact, stable key, kind, and importance from 1 to 5.",
  );
};

const createMemoryUpdateSection = (
  scope: "session" | "workspace" | "global",
  status: "saved" | "refreshed" | "replaced",
) => ({
  title: "Memory update",
  lines: [`scope: ${scope}`, `status: ${status}`],
});

export const createMemoryToolDefinitions = (
  memory: ConversationMemoryRuntime,
): AgentToolDefinition[] => {
  const toolDefinitions: AgentToolDefinition[] = [];

  if (memory.sessionEnabled) {
    toolDefinitions.push({
      spec: {
        name: "remember_session_memory",
        description:
          "Save or replace current-chat information in session memory. Use the narrowest useful scope and neutral wording without 'The user'.",
        inputSchema: createMemoryInputSchema(
          "A concise standalone session fact, constraint, decision, or workaround.",
        ),
      },
      backingTool: "filesystem",
      riskLevel: "low",
      effect: "write",
      execute: async (args, context) => {
        const fact = coerceString(args, "fact");
        const metadata = parseMemoryMetadata(args);

        if (!fact || !metadata) {
          return createInvalidMemoryResult("remember_session_memory");
        }

        const remembered = rememberConversationMemoryEntry(
          context.memory.sessionEntries,
          "session",
          fact,
          MAX_SESSION_MEMORY_ENTRIES,
          Date.now(),
          metadata,
        );
        const status = remembered.added
          ? "saved"
          : remembered.replaced
            ? "replaced"
            : "refreshed";
        context.memory.sessionEntries = remembered.entries;

        return {
          toolResult: {
            callId: crypto.randomUUID(),
            name: "remember_session_memory",
            output: `${status} session memory ${remembered.entry.key}`,
          },
          memoryUpdate: {
            scope: "session",
            entry: remembered.entry,
          },
          sections: [createMemoryUpdateSection("session", status)],
          traceLines: [
            `remember_session_memory(${remembered.entry.id}) -> ${status}`,
          ],
        };
      },
    });
  }

  if (memory.workspaceEnabled) {
    toolDefinitions.push({
      spec: {
        name: "remember_workspace_memory",
        description:
          "Save or replace durable project information for the active workspace only. Project-specific preferences belong here, not in global memory.",
        inputSchema: createMemoryInputSchema(
          "A concise standalone project fact, constraint, decision, or verified workaround.",
        ),
      },
      backingTool: "filesystem",
      riskLevel: "low",
      effect: "write",
      execute: async (args, context) => {
        const fact = coerceString(args, "fact");
        const metadata = parseMemoryMetadata(args);

        if (!fact || !metadata) {
          return createInvalidMemoryResult("remember_workspace_memory");
        }

        const rememberedEntry = await rememberWorkspaceMemory(
          context.workspaceRoot,
          fact,
          metadata,
        );
        context.memory.workspaceEntries = mergeConversationMemoryEntries(
          context.memory.workspaceEntries ?? [],
          [rememberedEntry],
          MAX_WORKSPACE_MEMORY_ENTRIES,
        );

        return {
          toolResult: {
            callId: crypto.randomUUID(),
            name: "remember_workspace_memory",
            output: `saved workspace memory ${rememberedEntry.key}`,
          },
          memoryUpdate: {
            scope: "workspace",
            entry: rememberedEntry,
          },
          sections: [createMemoryUpdateSection("workspace", "saved")],
          traceLines: [
            `remember_workspace_memory(${rememberedEntry.id}) -> saved`,
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
          "Save or replace a stable fact or explicit preference about the user that applies across unrelated workspaces.",
        inputSchema: createMemoryInputSchema(
          "A concise standalone stable cross-session user preference or identity fact.",
        ),
      },
      backingTool: "filesystem",
      riskLevel: "low",
      effect: "write",
      execute: async (args, context) => {
        const fact = coerceString(args, "fact");
        const metadata = parseMemoryMetadata(args);

        if (!fact || !metadata) {
          return createInvalidMemoryResult("remember_global_memory");
        }

        const rememberedEntry = await rememberUserGlobalMemory(fact, metadata);
        context.memory.globalEntries = mergeConversationMemoryEntries(
          context.memory.globalEntries,
          [rememberedEntry],
          MAX_GLOBAL_MEMORY_ENTRIES,
        );

        return {
          toolResult: {
            callId: crypto.randomUUID(),
            name: "remember_global_memory",
            output: `saved global memory ${rememberedEntry.key}`,
          },
          memoryUpdate: {
            scope: "global",
            entry: rememberedEntry,
          },
          sections: [createMemoryUpdateSection("global", "saved")],
          traceLines: [
            `remember_global_memory(${rememberedEntry.id}) -> saved`,
          ],
        };
      },
    });
  }

  return toolDefinitions;
};
