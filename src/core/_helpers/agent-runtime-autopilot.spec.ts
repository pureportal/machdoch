/// <reference types="vitest/globals" />
import type {
  ResolvedTaskContext,
  RuntimeConfig,
  TaskExecutionResult,
} from "../types.js";
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
    availableProfiles: [],
    mode: "machdoch",
    provider: "openai",
    model: "gpt-5.5",
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
    instructionContextText: "",
    workspacePaths: ["src/core/agent-runtime.ts"],
    suggestedTools: ["filesystem", "network"],
    applicableInstructions: [],
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
    const prompt = createAutopilotMonitorSystemPrompt(createRuntimeConfig());

    expect(prompt).toContain("<review_dimensions>");
    expect(prompt).toContain("Request coverage");
    expect(prompt).toContain("Grounded evidence");
    expect(prompt).toContain("repeated identical failing tool calls");
  });

  it("includes validator-targeted instruction context in the system prompt", () => {
    const prompt = createAutopilotMonitorSystemPrompt(
      createRuntimeConfig(),
      createTaskContext({
        applicableValidatorInstructions: [
          {
            kind: "conditional",
            name: "Strict validation",
            path: ".machdoch/instructions/strict-validation.instructions.md",
            priority: 80,
            reason: "Matched terms: review",
            body: "Reject completion without concrete verification output.",
          },
        ],
      }),
    );

    expect(prompt).toContain("<validator_instructions>");
    expect(prompt).toContain("Strict validation");
    expect(prompt).toContain("Reject completion without concrete verification output.");
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
    expect(prompt).toContain(
      "current external guidance or best-practice research",
    );
    expect(prompt).toContain("<verification_expectation>");
    expect(prompt).toContain("concrete verification evidence");
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
});
