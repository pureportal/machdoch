import {
  getSessionOverviewStatus,
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

  let hasCompletedSession = false;

  for (const session of shellState.sessions) {
    const status = getSessionOverviewStatus(session);

    if (status === "running") {
      return false;
    }

    if (status === "done") {
      hasCompletedSession = true;
    }
  }

  return hasCompletedSession;
};
