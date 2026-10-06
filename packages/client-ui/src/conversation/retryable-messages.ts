export interface RetryableMessage {
  id: string;
  role: string;
  taskId?: string | undefined;
  source?: { kind: string } | undefined;
}

export function getRetryableAgentMessageIds(
  messages: readonly RetryableMessage[],
): ReadonlySet<string> {
  const userTaskIds = new Set<string>();
  const retryable = new Set<string>();
  let hasPriorUserMessage = false;
  for (const message of messages) {
    if (message.role === "user") {
      hasPriorUserMessage = true;
      userTaskIds.add(message.taskId ?? message.id);
      continue;
    }
    if (
      message.role !== "agent" ||
      message.source?.kind === "thinking" ||
      message.source?.kind === "preview"
    )
      continue;
    if (
      (message.taskId && userTaskIds.has(message.taskId)) ||
      (!message.taskId && hasPriorUserMessage)
    )
      retryable.add(message.id);
  }
  return retryable;
}
