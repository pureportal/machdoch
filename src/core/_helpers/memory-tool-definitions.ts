import { rememberUserGlobalMemory } from "../env.js";
import {
  MAX_GLOBAL_MEMORY_ENTRIES,
  MAX_SESSION_MEMORY_ENTRIES,
  mergeConversationMemoryEntries,
  rememberConversationMemoryEntry,
} from "../memory.js";
import {
  coerceString,
  createToolErrorResult,
  type AgentToolDefinition,
  type ConversationMemoryRuntime,
} from "./agent-tools-shared.js";
import { compactTraceText } from "./runtime-text.js";

export const createMemoryToolDefinitions = (
  memory: ConversationMemoryRuntime,
): AgentToolDefinition[] => {
  const toolDefinitions: AgentToolDefinition[] = [];

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
      effect: "write",
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
                "scope: session",
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
      effect: "write",
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
                "scope: global",
                "status: saved",
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

  return toolDefinitions;
};
