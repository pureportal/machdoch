import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disableInvokeMock,
  enableInvokeMock,
  invokeMock,
  isTauriMock,
} from "./test/tauri-test-mocks";
import { runTaskInterview } from "./runtime";

describe("task interview runtime bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enableInvokeMock();
    isTauriMock.mockReturnValue(true);
  });

  afterEach(() => {
    disableInvokeMock();
  });

  it("passes interview session and answers through the task interview command bridge", async () => {
    const session = {
      id: "interview-1",
      prompt: "Improve chat composer",
      turn: 1,
      maxTurns: 5,
      findings: ["Uses React"],
      assumptions: [],
      relevantFiles: ["src/tauri/ui/chat-session-shell.tsx"],
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
          createdAt: "2026-07-01T00:00:00.000Z",
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

    await runTaskInterview("C:\\Project", {
      prompt: "Improve chat composer",
      session,
      contextNotes: ["Attached file: src/tauri/ui/chat-session-shell.tsx"],
      answers: { scope: "main composer only" },
      answerComments: { scope: "Skip quick chat." },
      mode: "machdoch",
      provider: "openai",
      model: "gpt-5.5",
      maxTurns: 5,
      taskId: "task-interview-local-id",
    });

    expect(invokeMock).toHaveBeenCalledWith("run_task_interview_command", {
      request: {
        workspaceRoot: "C:\\Project",
        taskId: "task-interview-local-id",
        arguments: [
          "--prompt",
          "Improve chat composer",
          "--mode",
          "machdoch",
          "--runtime-provider",
          "openai",
          "--model",
          "gpt-5.5",
          "--max-rounds",
          "5",
          "--input-json",
          JSON.stringify({
            session,
            contextNotes: ["Attached file: src/tauri/ui/chat-session-shell.tsx"],
            answers: { scope: "main composer only" },
            answerComments: { scope: "Skip quick chat." },
          }),
        ],
      },
    });
  });
});
