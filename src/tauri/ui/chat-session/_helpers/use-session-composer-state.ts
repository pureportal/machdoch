import {
  useCallback,
  useState,
  type KeyboardEvent,
} from "react";
import type {
  ChatSessionContextAttachment,
} from "../../chat-session.model";
import type { ChatSessionShellStateController } from "./use-chat-session-shell-state";

export const useSessionComposerState = (
  state: ChatSessionShellStateController,
) => {
  const [
    draftContextAttachmentsBeforeHistory,
    setDraftContextAttachmentsBeforeHistory,
  ] = useState<ChatSessionContextAttachment[]>([]);

  const resetDraftHistoryState = useCallback((): void => {
    state.setPromptHistoryIndex(null);
    state.setDraftBeforeHistory("");
    setDraftContextAttachmentsBeforeHistory([]);
  }, [state]);

  const handleDraftChange = useCallback(
    (value: string): void => {
      resetDraftHistoryState();
      state.setDraftValue(value);
    },
    [resetDraftHistoryState, state],
  );

  const handleComposerHistoryNavigation = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
        return;
      }

      if (state.activeSession.promptHistory.length === 0) {
        return;
      }

      event.preventDefault();

      if (event.key === "ArrowUp") {
        if (state.promptHistoryIndex === null) {
          state.setDraftBeforeHistory(state.activeSession.draft);
          setDraftContextAttachmentsBeforeHistory(
            state.activeSession.draftContextAttachments,
          );

          const nextIndex = state.activeSession.promptHistory.length - 1;

          state.setPromptHistoryIndex(nextIndex);
          state.setDraftValue(state.activeSession.promptHistory[nextIndex]);
          state.updateActiveSession((session) => {
            const updatedAt = Date.now();

            return {
              ...session,
              draftContextAttachments:
                session.promptContextHistory[nextIndex] ?? [],
              composerUpdatedAt: updatedAt,
              updatedAt,
            };
          });
          return;
        }

        const nextIndex = Math.max(state.promptHistoryIndex - 1, 0);

        state.setPromptHistoryIndex(nextIndex);
        state.setDraftValue(state.activeSession.promptHistory[nextIndex]);
        state.updateActiveSession((session) => {
          const updatedAt = Date.now();

          return {
            ...session,
            draftContextAttachments: session.promptContextHistory[nextIndex] ?? [],
            composerUpdatedAt: updatedAt,
            updatedAt,
          };
        });
        return;
      }

      if (state.promptHistoryIndex === null) {
        return;
      }

      const nextIndex = state.promptHistoryIndex + 1;

      if (nextIndex >= state.activeSession.promptHistory.length) {
        state.setPromptHistoryIndex(null);
        state.setDraftValue(state.draftBeforeHistory);
        state.setDraftBeforeHistory("");
        state.updateActiveSession((session) => {
          const updatedAt = Date.now();

          return {
            ...session,
            draftContextAttachments: draftContextAttachmentsBeforeHistory,
            composerUpdatedAt: updatedAt,
            updatedAt,
          };
        });
        setDraftContextAttachmentsBeforeHistory([]);
        return;
      }

      state.setPromptHistoryIndex(nextIndex);
      state.setDraftValue(state.activeSession.promptHistory[nextIndex]);
      state.updateActiveSession((session) => {
        const updatedAt = Date.now();

        return {
          ...session,
          draftContextAttachments: session.promptContextHistory[nextIndex] ?? [],
          composerUpdatedAt: updatedAt,
          updatedAt,
        };
      });
    },
    [draftContextAttachmentsBeforeHistory, state],
  );

  return {
    resetDraftHistoryState,
    handleDraftChange,
    handleComposerHistoryNavigation,
  };
};
