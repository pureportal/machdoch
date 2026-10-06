import { expect, it } from "vitest";
import { getRetryableAgentMessageIds } from "./retryable-messages";

it("offers replay only for replies with a matching prior native request", () => {
  const messages = [
    { id: "orphan", role: "agent" },
    { id: "user", role: "user", taskId: "task" },
    { id: "reply", role: "agent", taskId: "task" },
    { id: "other-task", role: "agent", taskId: "other" },
    {
      id: "thinking",
      role: "agent",
      taskId: "task",
      source: { kind: "thinking" },
    },
    {
      id: "preview",
      role: "agent",
      taskId: "task",
      source: { kind: "preview" },
    },
    { id: "ordinary-reply", role: "agent" },
  ];
  expect([...getRetryableAgentMessageIds(messages)]).toEqual([
    "reply",
    "ordinary-reply",
  ]);
});
