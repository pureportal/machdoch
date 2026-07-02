import { describe, expect, it } from "vitest";
import type { ChatSessionRecord } from "../../chat-session.model";
import { createTaskInterviewContextNotes } from "./chat-interview";

const createSession = (
  overrides: Partial<ChatSessionRecord> = {},
): ChatSessionRecord => ({
  id: "session-1",
  createdAt: 1,
  updatedAt: 1,
  workspace: "C:/workspace",
  provider: "openai",
  model: "gpt-5.5",
  draft: "",
  draftContextAttachments: [],
  tags: [],
  messages: [],
  promptHistory: [],
  promptContextHistory: [],
  sessionMemoryEnabled: true,
  useGlobalMemory: true,
  uiControlEnabled: false,
  sessionMemory: [],
  ...overrides,
});

describe("createTaskInterviewContextNotes", () => {
  it("includes recent chat history and current attachments for interview context", () => {
    const notes = createTaskInterviewContextNotes(
      {
        sessionSnapshot: createSession({
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "Earlier request that should fall out of the compact context.",
              createdAt: 1,
            },
            {
              id: "agent-1",
              role: "agent",
              content: "Settings live in src/settings.tsx.",
              createdAt: 2,
            },
            {
              id: "user-2",
              role: "user",
              content: "Use account-level billing controls.",
              createdAt: 3,
            },
          ],
        }),
        contextAttachments: [
          {
            id: "attachment-1",
            kind: "file",
            name: "settings.tsx",
            path: "src/settings.tsx",
          },
        ],
      },
      2,
    );

    expect(notes).toEqual([
      "Recent chat assistant message: Settings live in src/settings.tsx.",
      "Recent chat user message: Use account-level billing controls.",
      "Attached file (settings.tsx): src/settings.tsx",
    ]);
  });
});
