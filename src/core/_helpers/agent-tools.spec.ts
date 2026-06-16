/// <reference types="vitest/globals" />
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import {
  createToolDefinitions,
  executeToolCall,
  resolveActionDecision,
} from "./agent-tools.ts";
import type {
  AgentToolDefinition,
  ConversationMemoryRuntime,
} from "./agent-tools-shared.ts";
import {
  createMacroRecorderToolDefinitions,
  resetMacroRecordingsForTests,
} from "./macro-recorder-tool-definitions.ts";

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
    reviewModel: {
      mode: "base",
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

describe("createToolDefinitions", () => {
  it("exposes scheduler reads in ask mode and mutations in machdoch mode", () => {
    const askToolNames = createToolDefinitions(
      createRuntimeConfig({ mode: "ask" }),
      memory,
    ).map((definition) => definition.spec.name);
    const machdochToolNames = createToolDefinitions(
      createRuntimeConfig({ mode: "machdoch" }),
      memory,
    ).map((definition) => definition.spec.name);

    expect(askToolNames).toContain("list_scheduled_jobs");
    expect(askToolNames).toContain("list_scheduled_runs");
    expect(askToolNames).toContain("list_scheduler_events");
    expect(askToolNames).not.toContain("create_scheduled_job");
    expect(askToolNames).not.toContain("update_scheduled_job");
    expect(askToolNames).not.toContain("emit_scheduler_event");
    expect(machdochToolNames).toContain("create_scheduled_job");
    expect(machdochToolNames).toContain("update_scheduled_job");
    expect(machdochToolNames).toContain("emit_scheduler_event");
  });
});

describe("executeToolCall", () => {
  afterEach(() => {
    resetMacroRecordingsForTests();
  });

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

  it("records successful browser tool calls while a macro recording is active", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "machdoch-agent-macro-"),
    );
    const typedBrowserTool: AgentToolDefinition = {
      spec: {
        name: "type_browser_text",
        description: "Types into a browser field.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
      backingTool: "browser",
      riskLevel: "high",
      effect: "external-side-effect",
      execute: async () => {
        return {
          toolResult: {
            callId: "browser-call",
            name: "type_browser_text",
            output: "Filled locator: label=Password",
          },
          sections: [],
          traceLines: ["type_browser_text() -> success"],
        };
      },
    };
    const toolDefinitions = new Map<string, AgentToolDefinition>([
      ...createMacroRecorderToolDefinitions().map((tool) => [
        tool.spec.name,
        tool,
      ] as const),
      ["type_browser_text", typedBrowserTool],
    ]);

    try {
      await executeToolCall(
        createRuntimeConfig({ mode: "machdoch", workspaceRoot }),
        memory,
        undefined,
        toolDefinitions,
        {
          id: "start",
          name: "start_macro_recording",
          arguments: {
            recordingId: "form",
            name: "Form flow",
            scope: "browser",
          },
        },
      );

      await executeToolCall(
        createRuntimeConfig({ mode: "machdoch", workspaceRoot }),
        memory,
        undefined,
        toolDefinitions,
        {
          id: "type",
          name: "type_browser_text",
          arguments: {
            sessionId: "form",
            locatorType: "label",
            locatorValue: "Password",
            text: "top-secret",
          },
        },
      );

      const saveResult = await executeToolCall(
        createRuntimeConfig({ mode: "machdoch", workspaceRoot }),
        memory,
        undefined,
        toolDefinitions,
        {
          id: "save",
          name: "save_macro_recording",
          arguments: {
            recordingId: "form",
            kind: "prompt",
            name: "Form Flow",
          },
        },
      );
      const promptContent = await readFile(
        join(workspaceRoot, ".machdoch", "prompts", "form-flow.prompt.md"),
        "utf8",
      );

      expect(saveResult.result?.toolResult.isError).toBeUndefined();
      expect(promptContent).toContain("1. Run `type_browser_text`.");
      expect(promptContent).toContain("${input:step_1_text:Text for step 1}");
      expect(promptContent).not.toContain("top-secret");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
