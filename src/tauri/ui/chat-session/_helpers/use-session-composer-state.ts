import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type {
  ChatSessionContextAttachment,
  ChatSessionRecord,
} from "../../chat-session.model";
import type { ChatSessionShellStateController } from "./use-chat-session-shell-state";

interface ComposerHistoryPreview {
  sessionId: string;
  index: number;
  draft: string;
  contextAttachments: ChatSessionContextAttachment[];
  baseComposerIdentity: string;
  historyIdentity: string;
}

const createComposerIdentity = (
  session: Pick<
    ChatSessionRecord,
    "draft" | "draftContextAttachments" | "composerUpdatedAt"
  >,
): string =>
  JSON.stringify([
    session.draft,
    session.draftContextAttachments,
    session.composerUpdatedAt ?? null,
  ]);

const cloneAttachments = (
  attachments: readonly ChatSessionContextAttachment[],
): ChatSessionContextAttachment[] =>
  attachments.map((attachment) => ({ ...attachment }));

export const useSessionComposerState = (
  state: ChatSessionShellStateController,
) => {
  const [historyPreview, setHistoryPreviewState] =
    useState<ComposerHistoryPreview | null>(null);
  const historyPreviewRef = useRef<ComposerHistoryPreview | null>(null);
  const promptHistoryIdentity = JSON.stringify([
    state.activeSession.id,
    state.activeSession.promptHistory,
    state.activeSession.promptContextHistory,
  ]);
  const previousPromptHistoryIdentityRef = useRef(promptHistoryIdentity);

  const setHistoryPreview = useCallback(
    (preview: ComposerHistoryPreview | null): void => {
      historyPreviewRef.current = preview;
      setHistoryPreviewState(preview);
    },
    [],
  );

  const resetDraftHistoryState = useCallback((): void => {
    state.setPromptHistoryIndex(null);
    state.setDraftBeforeHistory("");
    setHistoryPreview(null);
  }, [setHistoryPreview, state]);

  useEffect(() => {
    const historyIdentityChanged =
      previousPromptHistoryIdentityRef.current !== promptHistoryIdentity;
    previousPromptHistoryIdentityRef.current = promptHistoryIdentity;
    const preview = historyPreviewRef.current;

    if (!preview) {
      if (historyIdentityChanged && state.promptHistoryIndex !== null) {
        resetDraftHistoryState();
      }
      return;
    }

    if (
      preview.sessionId !== state.activeSession.id ||
      preview.historyIdentity !== promptHistoryIdentity ||
      preview.baseComposerIdentity !== createComposerIdentity(state.activeSession)
    ) {
      resetDraftHistoryState();
    }
  }, [
    promptHistoryIdentity,
    resetDraftHistoryState,
    state.activeSession,
    state.promptHistoryIndex,
  ]);

  const commitHistoryPreview = useCallback(
    (): ChatSessionRecord | null => {
      const preview = historyPreviewRef.current;

      if (!preview || preview.sessionId !== state.activeSession.id) {
        return null;
      }

      let committedSession: ChatSessionRecord | null = null;
      let didCommit = false;

      state.updateSessionById(preview.sessionId, (session) => {
        if (createComposerIdentity(session) !== preview.baseComposerIdentity) {
          return session;
        }

        const updatedAt = Date.now();
        didCommit = true;
        committedSession = {
          ...session,
          draft: preview.draft,
          draftContextAttachments: cloneAttachments(
            preview.contextAttachments,
          ),
          composerUpdatedAt: updatedAt,
          updatedAt,
        };
        return committedSession;
      });

      if (didCommit) {
        state.applyShellState((currentState) => {
          committedSession =
            currentState.sessions.find(
              (session) => session.id === preview.sessionId,
            ) ?? committedSession;
          return currentState;
        });
      }
      resetDraftHistoryState();

      return committedSession;
    }, [resetDraftHistoryState, state]);

  const handleDraftChange = useCallback(
    (value: string): void => {
      const preview = historyPreviewRef.current;

      if (preview?.sessionId === state.activeSession.id) {
        let committed = false;

        state.updateSessionById(preview.sessionId, (session) => {
          if (createComposerIdentity(session) !== preview.baseComposerIdentity) {
            return session;
          }

          committed = true;
          const updatedAt = Date.now();
          return {
            ...session,
            draft: value,
            draftContextAttachments: cloneAttachments(
              preview.contextAttachments,
            ),
            composerUpdatedAt: updatedAt,
            updatedAt,
          };
        });
        resetDraftHistoryState();

        if (committed) {
          return;
        }

        // The canonical composer changed after this preview was rendered.
        // Discard the stale DOM edit instead of overwriting the newer value.
        return;
      }

      resetDraftHistoryState();
      state.setDraftValue(value);
    },
    [resetDraftHistoryState, state],
  );

  const handleComposerHistoryNavigation = useCallback(
    (
      event: KeyboardEvent<HTMLTextAreaElement>,
      currentDraft = state.activeSession.draft,
    ): void => {
      if (
        event.nativeEvent?.isComposing ||
        event.keyCode === 229 ||
        (event.key !== "ArrowUp" && event.key !== "ArrowDown")
      ) {
        return;
      }

      const history = state.activeSession.promptHistory;
      const historyLength = history.length;
      const currentPreview = historyPreviewRef.current;
      const activePreview =
        currentPreview?.sessionId === state.activeSession.id &&
        currentPreview.historyIdentity === promptHistoryIdentity &&
        currentPreview.baseComposerIdentity ===
          createComposerIdentity(state.activeSession)
          ? currentPreview
          : null;

      if (historyLength === 0) {
        if (currentPreview || state.promptHistoryIndex !== null) {
          resetDraftHistoryState();
        }
        return;
      }

      if (!activePreview) {
        const textarea = event.currentTarget;

        if (
          event.key === "ArrowDown" ||
          textarea.selectionStart !== textarea.selectionEnd ||
          textarea.selectionStart !== 0
        ) {
          return;
        }
      }

      event.preventDefault();

      if (event.key === "ArrowUp") {
        const nextIndex = activePreview
          ? Math.max(activePreview.index - 1, 0)
          : historyLength - 1;
        const nextPrompt = history[nextIndex];

        if (nextPrompt === undefined) {
          resetDraftHistoryState();
          return;
        }

        if (!activePreview) {
          state.setDraftBeforeHistory(currentDraft);
        }

        const baseComposerSession =
          currentDraft === state.activeSession.draft
            ? state.activeSession
            : { ...state.activeSession, draft: currentDraft };

        state.setPromptHistoryIndex(nextIndex);
        setHistoryPreview({
          sessionId: state.activeSession.id,
          index: nextIndex,
          draft: nextPrompt,
          contextAttachments: cloneAttachments(
            state.activeSession.promptContextHistory[nextIndex] ?? [],
          ),
          baseComposerIdentity:
            activePreview?.baseComposerIdentity ??
            createComposerIdentity(baseComposerSession),
          historyIdentity: promptHistoryIdentity,
        });
        return;
      }

      if (!activePreview) {
        return;
      }

      const nextIndex = activePreview.index + 1;

      if (nextIndex >= historyLength) {
        resetDraftHistoryState();
        return;
      }

      const nextPrompt = history[nextIndex];

      if (nextPrompt === undefined) {
        resetDraftHistoryState();
        return;
      }

      state.setPromptHistoryIndex(nextIndex);
      setHistoryPreview({
        ...activePreview,
        index: nextIndex,
        draft: nextPrompt,
        contextAttachments: cloneAttachments(
          state.activeSession.promptContextHistory[nextIndex] ?? [],
        ),
      });
    },
    [
      promptHistoryIdentity,
      resetDraftHistoryState,
      setHistoryPreview,
      state,
    ],
  );

  const activeHistoryPreview =
    historyPreview?.sessionId === state.activeSession.id &&
    historyPreview.historyIdentity === promptHistoryIdentity &&
    historyPreview.baseComposerIdentity ===
      createComposerIdentity(state.activeSession)
      ? historyPreview
      : null;

  return {
    resetDraftHistoryState,
    commitHistoryPreview,
    handleDraftChange,
    handleComposerHistoryNavigation,
    activeDraft: activeHistoryPreview?.draft ?? state.activeSession.draft,
    activeContextAttachments:
      activeHistoryPreview?.contextAttachments ??
      state.activeSession.draftContextAttachments,
    isHistoryPreviewActive: activeHistoryPreview !== null,
  };
};
