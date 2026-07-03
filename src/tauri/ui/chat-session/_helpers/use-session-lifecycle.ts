import { useMemo } from "react";
import {
  canArchiveSession,
  canDeleteSession,
  canDuplicateSession,
  canPinSession,
  createSession,
  isQuickVoiceSession,
  normalizeSessionTags,
  sortSessionsByUpdatedAt,
  type ChatSessionRecord,
} from "../../chat-session.model";
import {
  getDefaultModelForProvider,
} from "../../model-catalog";
import { normalizeSessionReasoningOverride } from "./session-reasoning";
import {
  createSessionExportPayload,
  duplicateSessionRecord,
  importSessionsIntoShellState,
} from "./session-history-index";
import type { ProviderChooserState } from "./session-shell-view-model";
import type { ChatSessionShellStateController } from "./use-chat-session-shell-state";

export interface SessionLifecycleActions {
  createNewSession: () => void;
  deleteSession: (sessionId: string) => void;
  archiveSession: (sessionId: string) => void;
  togglePinnedSession: (sessionId: string) => void;
  cloneSession: (sessionId: string, mode: "duplicate" | "branch") => void;
  commitSessionTags: (tags: string[]) => void;
  toggleSessionTagFilter: (tag: string) => void;
  exportSessions: () => void;
  importSessions: (file: File) => void;
}

const isReusableNewSession = (session: ChatSessionRecord): boolean => {
  return (
    !isQuickVoiceSession(session) &&
    typeof session.archivedAt !== "number" &&
    typeof session.pinnedAt !== "number" &&
    !session.manualTitle?.trim() &&
    session.tags.length === 0 &&
    session.messages.length === 0 &&
    session.draft.trim().length === 0 &&
    session.draftContextAttachments.length === 0 &&
    session.promptHistory.length === 0 &&
    session.promptContextHistory.length === 0 &&
    session.sessionMemory.length === 0
  );
};

export const useSessionLifecycle = (options: {
  state: ChatSessionShellStateController;
  providerChooserState: ProviderChooserState;
}): SessionLifecycleActions => {
  const { providerChooserState, state } = options;
  const defaultNewSessionWorkspace =
    state.shellState.recentWorkspaces[0] ?? state.activeSession.workspace;

  return useMemo(
    () => ({
      createNewSession: (): void => {
        let nextActiveSessionId = state.activeSessionId;

        state.applyShellState((prev) => {
          const currentActiveSession =
            prev.sessions.find((session) => session.id === state.activeSessionId) ??
            prev.sessions.find((session) => session.id === prev.activeSessionId);
          const reusableSession =
            (currentActiveSession && isReusableNewSession(currentActiveSession)
              ? currentActiveSession
              : undefined) ??
            sortSessionsByUpdatedAt(prev.sessions).find(isReusableNewSession);

          if (reusableSession) {
            nextActiveSessionId = reusableSession.id;

            if (prev.activeSessionId === reusableSession.id) {
              return prev;
            }

            return {
              ...prev,
              activeSessionId: reusableSession.id,
            };
          }

          const provider =
            providerChooserState.chooserProviders.find(
              (entry) => entry === prev.lastSelectedProvider,
            ) ??
            providerChooserState.chooserProviders[0] ??
              prev.lastSelectedProvider;
          const model =
            prev.lastSelectedModelByProvider[provider] ??
            getDefaultModelForProvider(provider);
          const reasoning = normalizeSessionReasoningOverride(
            prev.lastSelectedReasoning,
            provider,
            model,
          );
          const session = createSession({
            workspace:
              prev.recentWorkspaces[0] ??
              currentActiveSession?.workspace ??
              defaultNewSessionWorkspace,
            provider,
            ...(prev.lastSelectedMode ? { mode: prev.lastSelectedMode } : {}),
            ...(reasoning ? { reasoning } : {}),
            model,
          });

          nextActiveSessionId = session.id;

          return {
            ...prev,
            activeSessionId: session.id,
            sessions: [session, ...prev.sessions],
          };
        });
        state.setActiveSessionId(nextActiveSessionId);
      },
      deleteSession: (sessionId: string): void => {
        let nextActiveSessionId = state.activeSessionId;

        state.applyShellState((prev) => {
          const targetSession = prev.sessions.find(
            (session) => session.id === sessionId,
          );

          if (targetSession && !canDeleteSession(targetSession)) {
            return prev;
          }

          const remainingSessions = prev.sessions.filter(
            (session) => session.id !== sessionId,
          );

          if (remainingSessions.length === 0) {
            const provider = prev.lastSelectedProvider;
            const model =
              prev.lastSelectedModelByProvider[provider] ??
              getDefaultModelForProvider(provider);
            const reasoning = normalizeSessionReasoningOverride(
              prev.lastSelectedReasoning,
              provider,
              model,
            );
            const replacement = createSession({
              workspace: defaultNewSessionWorkspace,
              provider,
              ...(prev.lastSelectedMode ? { mode: prev.lastSelectedMode } : {}),
              ...(reasoning ? { reasoning } : {}),
              model,
            });
            nextActiveSessionId = replacement.id;

            return {
              ...prev,
              activeSessionId: replacement.id,
              sessions: [replacement],
            };
          }

          if (state.activeSessionId === sessionId) {
            nextActiveSessionId = sortSessionsByUpdatedAt(remainingSessions)[0].id;
          }

          return {
            ...prev,
            activeSessionId:
              prev.activeSessionId === sessionId
                ? sortSessionsByUpdatedAt(remainingSessions)[0].id
                : prev.activeSessionId,
            sessions: remainingSessions,
          };
        });

        if (nextActiveSessionId !== state.activeSessionId) {
          state.setActiveSessionId(nextActiveSessionId);
        }
      },
      archiveSession: (sessionId: string): void => {
        state.updateSessionById(sessionId, (session) => {
          if (!canArchiveSession(session)) {
            return session;
          }

          return {
            ...session,
            archivedAt: Date.now(),
          };
        });
      },
      togglePinnedSession: (sessionId: string): void => {
        state.updateSessionById(sessionId, (session) => {
          if (!canPinSession(session)) {
            return session;
          }

          const nextSession = { ...session, updatedAt: Date.now() };

          if (typeof session.pinnedAt === "number") {
            delete nextSession.pinnedAt;
          } else {
            nextSession.pinnedAt = Date.now();
          }

          return nextSession;
        });
      },
      cloneSession: (
        sessionId: string,
        mode: "duplicate" | "branch",
      ): void => {
        let nextSessionId: string | null = null;

        state.applyShellState((prev) => {
          const sourceSession = prev.sessions.find(
            (session) => session.id === sessionId,
          );

          if (!sourceSession || !canDuplicateSession(sourceSession)) {
            return prev;
          }

          const clonedSession = duplicateSessionRecord(sourceSession, mode);
          nextSessionId = clonedSession.id;

          return {
            ...prev,
            activeSessionId: clonedSession.id,
            sessions: [clonedSession, ...prev.sessions],
          };
        });

        if (nextSessionId) {
          state.setActiveSessionId(nextSessionId);
        }
      },
      commitSessionTags: (tags: string[]): void => {
        const normalizedTags = normalizeSessionTags(tags);

        state.updateActiveSession((session) => {
          const currentTags = session.tags.map((tag) => tag.toLowerCase());
          const nextTags = normalizedTags.map((tag) => tag.toLowerCase());

          if (
            currentTags.length === nextTags.length &&
            currentTags.every((tag, index) => tag === nextTags[index])
          ) {
            return session;
          }

          return {
            ...session,
            tags: normalizedTags,
            updatedAt: Date.now(),
          };
        });
      },
      toggleSessionTagFilter: (tag: string): void => {
        state.setSessionTagFilters((prev) => {
          const tagKey = tag.toLowerCase();
          const selected = prev.some((entry) => entry.toLowerCase() === tagKey);

          return selected
            ? prev.filter((entry) => entry.toLowerCase() !== tagKey)
            : [...prev, tag];
        });
      },
      exportSessions: (): void => {
        const payload = createSessionExportPayload(
          state.shellState,
          state.filteredSessions.map((session) => session.id),
        );

        if (payload.sessions.length === 0) {
          return;
        }

        const blob = new Blob([JSON.stringify(payload, null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        const date = new Date().toISOString().slice(0, 10);

        anchor.href = url;
        anchor.download = `machdoch-sessions-${date}.json`;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      },
      importSessions: (file: File): void => {
        void file
          .text()
          .then((text) => JSON.parse(text) as unknown)
          .then((payload) => {
            state.applyShellState((prev) =>
              importSessionsIntoShellState(prev, payload),
            );
          })
          .catch((error) => {
            console.error("Failed to import sessions:", error);
          });
      },
    }),
    [defaultNewSessionWorkspace, providerChooserState.chooserProviders, state],
  );
};
