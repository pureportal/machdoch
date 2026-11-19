import {
  getSessionOverviewStatus,
  hasUnreadCompletedSessionResponse,
  type ShellPersistedState,
} from "../../chat-session.model";
import type { DesktopActivityState } from "../../runtime";
import { sessionNeedsInput } from "./session-needs-input";

export interface DesktopActivityIndicatorInput {
  shellState: ShellPersistedState;
  hasHydrated: boolean;
  promptEnhancementBusy: boolean;
  chatInterviewBusy: boolean;
}

export const resolveDesktopActivityState = ({
  shellState,
  hasHydrated,
  promptEnhancementBusy,
  chatInterviewBusy,
}: DesktopActivityIndicatorInput): DesktopActivityState => {
  if (!hasHydrated) {
    return "idle";
  }

  let running = promptEnhancementBusy || chatInterviewBusy;
  let hasUnreadFailure = false;
  let hasUnreadSuccess = false;

  for (const session of shellState.sessions) {
    if (sessionNeedsInput(session)) {
      return "needs-input";
    }

    if (
      getSessionOverviewStatus(session, shellState.queuedSessionMessages) ===
      "running"
    ) {
      running = true;
      continue;
    }

    if (!hasUnreadCompletedSessionResponse(session)) {
      continue;
    }

    const status = getSessionOverviewStatus(session);

    if (status === "done" || status === "cancelled") {
      hasUnreadSuccess = true;
    } else {
      hasUnreadFailure = true;
    }
  }

  if (hasUnreadFailure) {
    return "failed";
  }

  if (running) {
    return "running";
  }

  return hasUnreadSuccess ? "done" : "idle";
};
