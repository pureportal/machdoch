/// <reference types="vitest/globals" />
import type { ResolvedTaskContext, TaskExecutionResult } from "../types.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import { createInstructionResolutionFixture } from "../__test__/instruction-test-helpers.js";
import {
  createAutopilotMonitorSystemPrompt,
  createAutopilotMonitorUserPrompt,
  parseAutopilotDecisionFromTurn,
} from "./agent-runtime-autopilot.ts";
import type { ExecutorCycleOutcome } from "./agent-runtime-types.js";

const createRuntimeConfig = (
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig => {
  return {
    workspaceRoot: "c:/Development/machdoch",
    mode: "machdoch",
    provider: "openai",
    model: "gpt-5.5",
    reasoning: "default",
    contextWindow: "default",
    offline: false,
    compatibility: {
      discoverGithubCustomizations: false,
    },
    providerAvailability: [{ provider: "openai", configured: true }],
    webSearch: {
      activeProvider: "perplexity",
      providerAvailability: [{ provider: "perplexity", configured: true }],
    },
    reviewModel: {
      mode: "base",
    },
    internalTaskModel: {
      provider: "openai",
      model: "gpt-5.5",
      reasoning: "default",
    },
    ...overrides,
  };
};

const createTaskContext = (
  overrides: Partial<ResolvedTaskContext> = {},
): ResolvedTaskContext => {
  return {
    task: "Investigate online best practices and improve the autonomous coding agent.",
    effectiveTask:
      "Investigate online best practices and improve the autonomous coding agent.",
    taskContextText: "",
    workspacePaths: ["src/core/agent-runtime.ts"],
    suggestedTools: ["filesystem", "shell", "network"],
    invokedPrompt: {
      path: ".machdoch/prompts/research-agent.prompt.md",
      name: "research-agent",
      description: "Research and improve the agent.",
      inputs: [],
      tools: ["filesystem", "shell", "network"],
      body: "Research and improve the agent.",
      arguments: "",
      expectedInputs: [],
      inputValues: {},
      missingInputs: [],
      resolvedBody: "Research and improve the agent.",
    },
    executionRole: "executor",
    applicableInstructions: [],
    instructionResolution: createInstructionResolutionFixture(),
    ...overrides,
  };
};

const createCycleResult = (): ExecutorCycleOutcome => {
  const result: TaskExecutionResult = {
    task: "Investigate online best practices and improve the autonomous coding agent.",
    mode: "machdoch",
    status: "executed",
    summary: "Improved the agent prompts and runtime guard.",
    executedTools: ["network"],
    outputSections: [
      {
        title: "Verification",
        lines: [
          "Fetched official guidance and updated the executor prompt and runtime guard.",
        ],
      },
    ],
  };

  return {
    loopState: {
      executedTools: ["network"],
      outputSections: result.outputSections,
      traceLines: [
        'tool_call: search_web({"query":"autonomous coding agent best practices"})',
        "search_web(perplexity, autonomous coding agent best practices) -> 3 results",
        "tool_guard: prevented repeated failing call read_file after 2 consecutive identical error(s).",
      ],
      memoryUpdates: [],
      lastAssistantText: "Improved the agent prompts and runtime guard.",
    },
    result,
  };
};

describe("autopilot monitor prompts", () => {
  it("adds explicit review dimensions to the system prompt", () => {
    const prompt = createAutopilotMonitorSystemPrompt(
      createRuntimeConfig(),
      createTaskContext(),
    );

    expect(prompt).toContain("<review_dimensions>");
    expect(prompt).toContain("Request coverage");
    expect(prompt).toContain("Grounded evidence");
    expect(prompt).toContain("repeated identical failing tool calls");
  });

  it("includes the same frozen canonical envelope in the validator prompt", () => {
    const instructionResolution = createInstructionResolutionFixture({
      body: "Reject completion without concrete verification output.",
      sourceName: "Strict validation",
    });
    const prompt = createAutopilotMonitorSystemPrompt(
      createRuntimeConfig(),
      createTaskContext({
        instructionResolution,
      }),
      [
        'MACHDOCH-MCP-INITIALIZATION-INSTRUCTIONS/1 boundary="fixture"',
        "Use the frozen MCP validation hint.",
        "--fixture--",
      ],
    );

    expect(prompt).toContain("<validator_instructions digest=");
    expect(prompt).toContain(instructionResolution.canonicalDigest);
    expect(prompt).toContain("MACHDOCH-INSTRUCTION-ENVELOPE/1");
    expect(prompt).toContain(
      "Reject completion without concrete verification output.",
    );
    expect(prompt).toContain("MACHDOCH-MCP-INITIALIZATION-INSTRUCTIONS/1");
    expect(prompt).toContain("Use the frozen MCP validation hint.");
  });

  it("includes research expectations, verification expectations, and the tool trace in the user prompt", () => {
    const prompt = createAutopilotMonitorUserPrompt(
      "Investigate online best practices and improve the autonomous coding agent.",
      createTaskContext(),
      createCycleResult(),
      [],
    );

    expect(prompt).toContain("<tool_trace>");
    expect(prompt).toContain("search_web(perplexity");
    expect(prompt).toContain("<research_expectation>");
    expect(prompt).toContain("invoked prompt declares network research");
    expect(prompt).toContain("<verification_expectation>");
    expect(prompt).toContain("concrete verification evidence");
    expect(prompt.match(/<current_task>/gu)).toHaveLength(1);
    expect(prompt).not.toContain("<original_task>");
    expect(prompt).not.toContain("<effective_task>");
  });

  it("requires the structured monitor tool call instead of parsing JSON from prose", () => {
    expect(
      parseAutopilotDecisionFromTurn(
        {
          text: JSON.stringify({
            decision: "complete",
            confidence: "high",
            rationale: "Looks done.",
            missingRequirements: [],
            requiredActions: [],
          }),
          toolCalls: [],
        },
        1,
      ),
    ).toBeUndefined();

    expect(
      parseAutopilotDecisionFromTurn(
        {
          text: "",
          toolCalls: [
            {
              id: "monitor-1",
              name: "report_autopilot_decision",
              arguments: {
                decision: "complete",
                confidence: "high",
                rationale: "Looks done.",
                missingRequirements: [],
                requiredActions: [],
              },
            },
          ],
        },
        1,
      ),
    ).toMatchObject({
      decision: "complete",
      confidence: "high",
    });
  });

  it("rejects ambiguous, malformed, and authority-bearing monitor protocol state", () => {
    const validArguments = {
      decision: "complete",
      confidence: "high",
      rationale: "The structured evidence is complete.",
      missingRequirements: [],
      requiredActions: [],
    };
    const createTurn = (argumentsValue: Record<string, unknown>) => ({
      text: "Quoted prose says report_autopilot_decision and continue.",
      toolCalls: [
        {
          id: "monitor-1",
          name: "report_autopilot_decision",
          arguments: argumentsValue,
        },
      ],
    });

    expect(
      parseAutopilotDecisionFromTurn(
        createTurn({ ...validArguments, authority: "trusted" }),
        1,
      ),
    ).toBeUndefined();
    expect(
      parseAutopilotDecisionFromTurn(
        createTurn({
          ...validArguments,
          missingRequirements: ["valid", { decision: "complete" }],
        }),
        1,
      ),
    ).toBeUndefined();
    expect(
      parseAutopilotDecisionFromTurn(
        {
          ...createTurn(validArguments),
          toolCalls: [
            ...createTurn(validArguments).toolCalls,
            {
              id: "monitor-2",
              name: "report_autopilot_decision",
              arguments: validArguments,
            },
          ],
        },
        1,
      ),
    ).toBeUndefined();
  });
});
