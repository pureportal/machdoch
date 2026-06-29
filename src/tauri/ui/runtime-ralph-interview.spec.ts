import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disableInvokeMock,
  enableInvokeMock,
  invokeMock,
  isTauriMock,
} from "./test/tauri-test-mocks";
import { runRalphGenerationInterview } from "./runtime";

describe("Ralph generation interview runtime bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enableInvokeMock();
    isTauriMock.mockReturnValue(true);
  });

  afterEach(() => {
    disableInvokeMock();
  });

  it("passes interview session and answers through the Ralph command bridge", async () => {
    const session = {
      id: "interview-1",
      prompt: "Improve imports",
      scope: "workspace" as const,
      target: "refactor" as const,
      turn: 1,
      maxTurns: 5,
      findings: ["Uses pnpm"],
      assumptions: [],
      relevantFiles: ["package.json"],
      transcript: [
        {
          turn: 1,
          questions: [
            {
              id: "scope",
              label: "Scope?",
              type: "text" as const,
            },
          ],
          answers: [],
          createdAt: "2026-06-19T00:00:00.000Z",
        },
      ],
    };

    invokeMock.mockResolvedValueOnce({
      status: "questions",
      session,
      fields: [],
      summary: "Prepared.",
      finalPrompt: null,
      provider: "openai",
      model: "gpt-5.5",
      result: null,
    });

    await runRalphGenerationInterview("C:\\Project", {
      name: "refactor",
      prompt: "Improve imports",
      existingFlow: {
        schemaVersion: 1,
        id: "refactor",
        name: "Refactor",
        blocks: [],
        edges: [],
      },
      target: "refactor",
      session,
      answers: { scope: "src/core" },
      answerComments: { scope: "Limit this to core files." },
      mode: "machdoch",
      provider: "openai",
      model: "gpt-5.5",
      maxTurns: 5,
      taskId: "ralph-interview-task",
    });

    expect(invokeMock).toHaveBeenCalledWith("run_ralph_command", {
      request: {
        workspaceRoot: "C:\\Project",
        arguments: [
          "interview",
          "--mode",
          "machdoch",
          "--runtime-provider",
          "openai",
          "--model",
          "gpt-5.5",
          "--name",
          "refactor",
          "--prompt",
          "Improve imports",
          "--existing-flow-json",
          JSON.stringify({
            schemaVersion: 1,
            id: "refactor",
            name: "Refactor",
            blocks: [],
            edges: [],
          }),
          "--flow-target",
          "refactor",
          "--max-rounds",
          "5",
          "--input-json",
          JSON.stringify({
            session,
            answers: { scope: "src/core" },
            answerComments: { scope: "Limit this to core files." },
          }),
        ],
        taskId: "ralph-interview-task",
      },
    });
  });
});
