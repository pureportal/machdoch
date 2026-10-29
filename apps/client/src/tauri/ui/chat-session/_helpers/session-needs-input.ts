import type { AgentLiveQuestion } from "@machdoch/fleet-protocol/task-thinking";
import type { ChatSessionRecord } from "../../chat-session.model";

/** The question a running turn in the session is waiting on, if any. */
export const findPendingAgentQuestion = (
  session: Pick<ChatSessionRecord, "messages">,
): AgentLiveQuestion | undefined => {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const source = session.messages[index]?.source;
    if (source?.kind !== "thinking") continue;
    const question = source.thinking.agentLive?.question;
    return source.thinking.status === "running" && question?.status === "pending"
      ? question
      : undefined;
  }
  return undefined;
};

/** True while a running turn in the session waits for the user to answer a question. */
export const sessionNeedsInput = (session: Pick<ChatSessionRecord, "messages">): boolean =>
  findPendingAgentQuestion(session) !== undefined;

/** Uses a typed message as the answer to every part of a pending question. */
export const answerQuestionWithMessage = (
  question: AgentLiveQuestion,
  message: string,
): Record<string, string> =>
  Object.fromEntries(question.items.map((item) => [item.id, message]));
