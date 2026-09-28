import { describe, expect, it } from "vitest";
import {
  createSession,
  type ChatSessionMessage,
} from "../../chat-session.model";
import { createSessionMessageSettings } from "./session-message-settings";
import { getMessageWorkspaceRoot } from "./message-workspace";

describe("message workspace routing", () => {
  it("keeps earlier request, response, and file references in their original workspace", () => {
    const oldSession = createSession({ workspace: "C:\\Projects\\old" });
    const messages: ChatSessionMessage[] = [
      {
        id: "old-request",
        taskId: "old-task",
        role: "user",
        content: "Update the old project",
        settings: createSessionMessageSettings(oldSession),
      },
      {
        id: "old-response",
        taskId: "old-task",
        role: "agent",
        content: "Updated src/index.ts",
      },
      {
        id: "new-request",
        taskId: "new-task",
        role: "user",
        content: "Update the new project",
        settings: createSessionMessageSettings(
          createSession({ workspace: "C:\\Projects\\new" }),
        ),
      },
    ];

    expect(
      getMessageWorkspaceRoot(messages[0]!, messages, "C:\\Projects\\new"),
    ).toBe("C:\\Projects\\old");
    expect(
      getMessageWorkspaceRoot(messages[1]!, messages, "C:\\Projects\\new"),
    ).toBe("C:\\Projects\\old");
    expect(
      getMessageWorkspaceRoot(messages[2]!, messages, "C:\\Projects\\new"),
    ).toBe("C:\\Projects\\new");
  });

  it("preserves an explicit Not Set workspace for a past task", () => {
    const request: ChatSessionMessage = {
      id: "request",
      taskId: "task",
      role: "user",
      content: "General question",
      settings: createSessionMessageSettings(createSession()),
    };
    const response: ChatSessionMessage = {
      id: "response",
      taskId: "task",
      role: "agent",
      content: "No files",
    };

    expect(
      getMessageWorkspaceRoot(
        response,
        [request, response],
        "C:\\Projects\\new",
      ),
    ).toBeNull();
    expect(
      getMessageWorkspaceRoot(
        { ...response, taskId: "unrelated" },
        [request],
        "C:\\Projects\\new",
      ),
    ).toBe("C:\\Projects\\new");
  });
});
