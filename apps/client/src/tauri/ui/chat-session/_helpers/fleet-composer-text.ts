import type {
  ChatSessionRecord,
  ShellPersistedState,
} from "../../chat-session.model";
import type { ChatSessionContextAttachment } from "@machdoch/client-ui/composer/model";
import type { FleetShellAttachmentSnapshot } from "../../runtime";
import { getBlockingRequestIteration } from "./request-iterations";

export function createFleetComposerText(
  state: ShellPersistedState,
  session: ChatSessionRecord,
  projectAttachment: (
    attachment: ChatSessionContextAttachment,
  ) => FleetShellAttachmentSnapshot,
  historyPromptLimit?: number,
  queueLimit = 512,
) {
  return {
    sessionId: session.id,
    draft: session.draft,
    draftRevision: session.draftUpdatedAt,
    history: session.promptHistory
      .flatMap((prompt, index) => {
        const attachments = session.promptContextHistory[index] ?? [];
        return (historyPromptLimit === undefined ||
          prompt.length <= historyPromptLimit) &&
          attachments.length <= 64 &&
          index <= 10_000
          ? [
              {
                index,
                prompt,
                attachments: attachments.map(projectAttachment),
              },
            ]
          : [];
      })
      .slice(historyPromptLimit === undefined ? -100 : -30),
    queuedMessages: state.queuedSessionMessages
      .filter((message) => message.sessionId === session.id)
      .sort(
        (left, right) =>
          left.orderRank - right.orderRank || left.createdAt - right.createdAt,
      )
      .slice(0, queueLimit)
      .map((message) => ({
        id: message.id,
        content: message.visibleMessageContent ?? message.task,
        status: message.status,
        createdAt: message.createdAt,
        attachments: message.contextAttachments.map(projectAttachment),
        ...(getBlockingRequestIteration(message, state.queuedSessionMessages)
          ?.iteration?.index
          ? {
              waitingForIteration: getBlockingRequestIteration(
                message,
                state.queuedSessionMessages,
              )!.iteration!.index,
            }
          : {}),
        ...(message.iteration
          ? {
              iteration: {
                ...message.iteration,
                mode: message.iteration.mode ?? "continue",
              },
            }
          : {}),
        ...(message.promptEnhancementRequest
          ? { promptEnhancementMode: message.promptEnhancementRequest.mode }
          : {}),
        ...(message.failureMessage
          ? { failureMessage: message.failureMessage }
          : {}),
      })),
  };
}
