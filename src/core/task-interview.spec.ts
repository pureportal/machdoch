import { describe, expect, it } from "vitest";
import { createTaskInterviewWithAgent } from "./task-interview.js";
import type { RuntimeConfig } from "./runtime-contract.generated.js";
import type { CustomizationDiscoveryResult } from "./types.js";

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
  });
});
