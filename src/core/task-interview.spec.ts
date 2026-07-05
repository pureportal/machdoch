import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTask } from "./execution.js";
import { createTaskInterviewWithAgent } from "./task-interview.js";
import type { RuntimeConfig } from "./runtime-contract.generated.js";
import type { CustomizationDiscoveryResult } from "./types.js";

vi.mock("./execution.js", () => ({
  executeTask: vi.fn(),
}));

const runtimeConfig: RuntimeConfig = {
  workspaceRoot: "C:/workspace",
  mode: "machdoch",
  provider: "openai",
  model: "gpt-5.5",
  reasoning: "default",
  offline: false,
  agentLimits: {
    executorTurns: 64,
    autopilotExecutorIterations: 16,
  },
  compatibility: {
    discoverGithubCustomizations: false,
  },
  providerAvailability: [
    {
      provider: "openai",
      configured: true,
      source: "env",
    },
  ],
  webSearch: {
    activeProvider: "none",
    providerAvailability: [],
  },
  reviewModel: {
    mode: "base",
  },
};

const customizations: CustomizationDiscoveryResult = {
  workspaceRoot: "C:/workspace",
  instructions: [],
  prompts: [],
  skills: [],
};

describe("createTaskInterviewWithAgent", () => {
  beforeEach(() => {
    vi.mocked(executeTask).mockReset();
  });

  it("turns a maxed interview session into an enriched final prompt", async () => {
    const result = await createTaskInterviewWithAgent("C:/workspace", {
      prompt: "Add billing settings.",
      config: runtimeConfig,
      customizations,
      maxTurns: 1,
      session: {
        id: "interview-1",
        prompt: "Add billing settings.",
        turn: 1,
        maxTurns: 1,
        contextSummary: "Billing settings need account-level controls.",
        findings: ["Settings UI uses React components."],
        assumptions: ["Keep existing route structure."],
        relevantFiles: ["src/settings.tsx"],
        transcript: [
          {
            turn: 1,
            questionScope: "Scope",
            questions: [
              {
                id: "roles",
                label: "Which roles?",
                type: "text",
              },
            ],
            answers: [
              {
                fieldId: "roles",
                label: "Which roles?",
                type: "text",
                value: "Admins only",
                comment: "Use existing permissions.",
              },
            ],
            createdAt: "2026-07-01T00:00:00.000Z",
            answeredAt: "2026-07-01T00:01:00.000Z",
          },
        ],
      },
    });

    expect(result.status).toBe("complete");
    expect(result.finalPrompt).toContain("Add billing settings.");
    expect(result.finalPrompt).toContain(
      "Billing settings need account-level controls.",
    );
    expect(result.finalPrompt).toContain(
      "- Which roles?: Admins only\n  Comment: Use existing permissions.",
    );
    expect(executeTask).not.toHaveBeenCalled();
  });

  it("runs the interviewer in ask mode with read-only MCP context guidance", async () => {
    vi.mocked(executeTask).mockResolvedValue({
      task: "interview",
      mode: "ask",
      status: "executed",
      summary: "Need one clarification.",
      executedTools: [],
      outputSections: [],
      response: {
        markdown: [
          "<machdoch_task_interview>",
          JSON.stringify({
            complete: false,
            summary: "Need one clarification.",
            contextSummary:
              "Linear ticket details were gathered before asking questions.",
            findings: ["CLOUD-1781 references billing settings."],
            assumptions: ["Use existing implementation conventions."],
            relevantFiles: ["src/billing.ts"],
            questions: [
              {
                id: "rollout",
                label: "Rollout scope?",
                type: "text",
                skippable: true,
              },
            ],
          }),
          "</machdoch_task_interview>",
        ].join("\n"),
        highlights: [],
        relatedFiles: [],
        verification: [],
        followUps: [],
      },
    });

    const result = await createTaskInterviewWithAgent("C:/workspace", {
      prompt: "Linear: CLOUD-1781\nImplement the bug fix.",
      config: runtimeConfig,
      customizations,
    });
    const executeCall = vi.mocked(executeTask).mock.calls[0];
    const executionConfig = executeCall?.[1];
    const executionOptions = executeCall?.[3];

    expect(result.status).toBe("questions");
    expect(executionConfig).toEqual(
      expect.objectContaining({
        mode: "ask",
        reasoning: "medium",
      }),
    );
    expect(executeCall?.[0]).toContain("Linear: CLOUD-1781");
    expect(executionOptions?.systemPromptSections?.[0]).toContain(
      "mcp_call_readonly_tool",
    );
    expect(executionOptions?.systemPromptSections?.[0]).toContain(
      "using only read-only tools",
    );
    expect(
      executionOptions?.additionalToolDefinitions?.map(
        (definition) => definition.spec.name,
      ),
    ).toContain("machdoch_submit_task_interview_round");
  });
});
