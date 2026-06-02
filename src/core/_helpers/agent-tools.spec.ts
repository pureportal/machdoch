/// <reference types="vitest/globals" />
import type { RuntimeConfig } from "../types.js";
import { executeToolCall, resolveActionDecision } from "./agent-tools.ts";
import type {
  AgentToolDefinition,
  ConversationMemoryRuntime,
} from "./agent-tools-shared.ts";

const createRuntimeConfig = (
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig => {
  return {
    workspaceRoot: "c:/Development/machdoch",
    availableProfiles: [],
    mode: "ask",
    provider: "unconfigured",
    model: "gpt-5.5",
    offline: false,
    compatibility: {
      discoverGithubCustomizations: false,
    },
    providerAvailability: [],
    webSearch: {
      activeProvider: "none",
      providerAvailability: [],
    },
    ...overrides,
  };
};

const memory: ConversationMemoryRuntime = {
  sessionEnabled: false,
  sessionEntries: [],
  globalEnabled: false,
  globalEntries: [],
};

describe("resolveActionDecision", () => {
  it("allows read-only actions and blocks writes in ask mode", () => {
    expect(
      resolveActionDecision(
        createRuntimeConfig({ mode: "ask" }),
        "filesystem",
        "low",
        { effect: "read" },
      ).decision,
    ).toBe("allow");

    const writeDecision = resolveActionDecision(
      createRuntimeConfig({ mode: "ask" }),
      "filesystem",
      "low",
      { effect: "write" },
    );

    expect(writeDecision.decision).toBe("blocked");
    expect(writeDecision.reason).toContain("Ask mode");
  });

  it("allows side-effecting function calls in machdoch mode", () => {
    const decision = resolveActionDecision(
      createRuntimeConfig({ mode: "machdoch" }),
      "network",
      "medium",
      { effect: "external-side-effect" },
    );

    expect(decision.decision).toBe("allow");
    expect(decision.reason).toContain("Machdoch mode");
  });
});

describe("executeToolCall", () => {
  it("does not let action-output handler failures fail the tool call", async () => {
    const streamingTool: AgentToolDefinition = {
      spec: {
        name: "streaming_tool",
        description: "Streams output.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
      backingTool: "shell",
      riskLevel: "low",
      effect: "read",
      execute: async (_args, context) => {
        context.onOutput?.({ stream: "stdout", chunk: "first chunk\n" });

        return {
          toolResult: {
            callId: "tool-call",
            name: "streaming_tool",
            output: "done",
          },
          sections: [],
          traceLines: ["streaming_tool() -> success"],
        };
      },
    };
    const toolDefinitions = new Map<string, AgentToolDefinition>([
      ["streaming_tool", streamingTool],
    ]);

    const result = await executeToolCall(
      createRuntimeConfig(),
      memory,
      undefined,
      toolDefinitions,
      {
        id: "call-1",
        name: "streaming_tool",
        arguments: {},
      },
      () => {
        throw new Error("progress sink failed");
      },
    );

    expect(result.result?.toolResult.output).toBe("done");
  });
});
