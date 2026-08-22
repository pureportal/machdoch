import {
  getSessionOverviewStatus,
  hasUnreadCompletedSessionResponse,
  type ShellPersistedState,
} from "../../chat-session.model";

export interface ChatCompletionIndicatorInput {
  shellState: ShellPersistedState;
  hasHydrated: boolean;
  promptEnhancementBusy: boolean;
  chatInterviewBusy: boolean;
}

export const isChatCompletionIndicatorActive = ({
  shellState,
  hasHydrated,
  promptEnhancementBusy,
  chatInterviewBusy,
}: ChatCompletionIndicatorInput): boolean => {
  if (!hasHydrated || promptEnhancementBusy || chatInterviewBusy) {
    return false;
  }

  if (shellState.queuedSessionMessages.length > 0) {
    return false;
  }

  let hasUnreadCompletedSession = false;

  for (const session of shellState.sessions) {
    const status = getSessionOverviewStatus(session);

    if (status === "running") {
      return false;
    }

    if (hasUnreadCompletedSessionResponse(session)) {
      hasUnreadCompletedSession = true;
    }
  }

  return hasUnreadCompletedSession;
};
