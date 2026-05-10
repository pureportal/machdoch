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
    enabledTools: ["filesystem", "shell"],
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
  it("blocks disabled tools before checking mode", () => {
    const decision = resolveActionDecision(
      createRuntimeConfig({ enabledTools: ["filesystem"] }),
      "shell",
      "low",
    );

    expect(decision.decision).toBe("blocked");
    expect(decision.reason).toContain("not enabled");
  });

  it("always requires approval in safe mode", () => {
    const decision = resolveActionDecision(
      createRuntimeConfig({ mode: "safe" }),
      "filesystem",
      "low",
    );

    expect(decision.decision).toBe("ask");
    expect(decision.reason).toContain("Safe mode");
  });

  it("allows read-only actions and pauses writes in plan mode", () => {
    expect(
      resolveActionDecision(
        createRuntimeConfig({ mode: "plan" }),
        "filesystem",
        "low",
        { effect: "read" },
      ).decision,
    ).toBe("allow");

    const writeDecision = resolveActionDecision(
      createRuntimeConfig({ mode: "plan" }),
      "filesystem",
      "low",
      { effect: "write" },
    );

    expect(writeDecision.decision).toBe("ask");
    expect(writeDecision.reason).toContain("Plan mode");
  });

  it("allows only low-risk enabled tools in ask mode", () => {
    expect(
      resolveActionDecision(createRuntimeConfig(), "filesystem", "low")
        .decision,
    ).toBe("allow");
    expect(
      resolveActionDecision(createRuntimeConfig(), "shell", "high").decision,
    ).toBe("ask");
    expect(
      resolveActionDecision(
        createRuntimeConfig({ enabledTools: ["utilities"] }),
        "utilities",
        "low",
      ).decision,
    ).toBe("allow");
  });

  it("allows enabled tools in auto mode", () => {
    const decision = resolveActionDecision(
      createRuntimeConfig({ mode: "auto", enabledTools: ["network"] }),
      "network",
      "medium",
    );

    expect(decision.decision).toBe("allow");
    expect(decision.reason).toContain("Auto mode");
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
      "stream output",
      createRuntimeConfig(),
      {
        outputSections: [],
        traceLines: [],
      },
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
    expect(result.approvalPause).toBeUndefined();
  });
});
