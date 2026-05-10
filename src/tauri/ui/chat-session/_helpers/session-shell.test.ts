import { createSession } from "../../chat-session.model.ts";
import { createConversationContextFromSession } from "./session-shell.ts";

describe("session shell conversation context", () => {
  it("omits generated task action prompts from conversation context", () => {
    const session = createSession({
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "Wie viel Uhr haben wir es?",
          createdAt: 1,
        },
        {
          id: "agent-1",
          role: "agent",
          content: "Aktuelle Uhrzeit fuer Europa/Berlin abgefragt.",
          createdAt: 2,
        },
        {
          id: "continue-1",
          role: "user",
          intent: "continue-task",
          content: "Continue previous task.",
          createdAt: 3,
        },
        {
          id: "continue-result",
          role: "agent",
          content: "Aktuelle Uhrzeit erneut abgefragt.",
          createdAt: 4,
        },
      ],
    });

    const context = createConversationContextFromSession(session, true);

    expect(context.history).toEqual([
      {
        role: "user",
        content: "Wie viel Uhr haben wir es?",
        createdAt: 1,
      },
      {
        role: "assistant",
        content: "Aktuelle Uhrzeit fuer Europa/Berlin abgefragt.",
        createdAt: 2,
      },
      {
        role: "assistant",
        content: "Aktuelle Uhrzeit erneut abgefragt.",
        createdAt: 4,
      },
    ]);
  });
});
