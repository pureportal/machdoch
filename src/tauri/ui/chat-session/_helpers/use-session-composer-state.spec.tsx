import { act, renderHook } from "@testing-library/react";
import type { KeyboardEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { createSession } from "../../chat-session.model";
import { useSessionComposerState } from "./use-session-composer-state";
import type { ChatSessionShellStateController } from "./use-chat-session-shell-state";

const createController = (
  selectionDraft: string,
): ChatSessionShellStateController => {
  const activeSession = createSession({
    id: "composer-history-session",
    draft: selectionDraft,
    promptHistory: ["Previous prompt"],
  });

  return {
    activeSession,
    promptHistoryIndex: null,
    draftBeforeHistory: "",
    setDraftValue: vi.fn(),
    setPromptHistoryIndex: vi.fn(),
    setDraftBeforeHistory: vi.fn(),
    updateActiveSession: vi.fn(),
    updateSessionById: vi.fn(),
  } as Partial<ChatSessionShellStateController> as ChatSessionShellStateController;
};

const createArrowEvent = (
  value: string,
  selectionStart: number,
): KeyboardEvent<HTMLTextAreaElement> => {
  return {
    key: "ArrowUp",
    keyCode: 38,
    nativeEvent: { isComposing: false },
    currentTarget: {
      value,
      selectionStart,
      selectionEnd: selectionStart,
    },
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent<HTMLTextAreaElement>;
};

describe("useSessionComposerState", () => {
  it("ignores history navigation while an IME candidate is composing", () => {
    const state = createController("編集中");
    const { result } = renderHook(() => useSessionComposerState(state));
    const event = createArrowEvent(state.activeSession.draft, 0);
    Object.assign(event.nativeEvent, { isComposing: true });

    act(() => result.current.handleComposerHistoryNavigation(event));

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(state.setPromptHistoryIndex).not.toHaveBeenCalled();
  });

  it("leaves ArrowUp available for normal caret movement inside a draft", () => {
    const state = createController("First line\nSecond line");
    const { result } = renderHook(() => useSessionComposerState(state));
    const event = createArrowEvent(state.activeSession.draft, 12);

    act(() => result.current.handleComposerHistoryNavigation(event));

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(state.setDraftValue).not.toHaveBeenCalled();
    expect(state.setPromptHistoryIndex).not.toHaveBeenCalled();
  });

  it("opens history when ArrowUp is pressed at the start of the draft", () => {
    const state = createController("Current draft");
    const { result } = renderHook(() => useSessionComposerState(state));
    const event = createArrowEvent(state.activeSession.draft, 0);

    act(() => result.current.handleComposerHistoryNavigation(event));

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(state.setDraftBeforeHistory).toHaveBeenCalledWith("Current draft");
    expect(state.setPromptHistoryIndex).toHaveBeenCalledWith(0);
    expect(state.setDraftValue).not.toHaveBeenCalled();
    expect(result.current.activeDraft).toBe("Previous prompt");
  });

  it("keeps the canonical draft when switching sessions while browsing", () => {
    const firstState = createController("Original draft");
    const secondState = {
      ...createController("Second draft"),
      activeSession: createSession({
        id: "second-session",
        draft: "Second draft",
        promptHistory: ["Second history"],
      }),
    };
    const { result, rerender } = renderHook(
      ({ state }) => useSessionComposerState(state),
      { initialProps: { state: firstState } },
    );

    act(() =>
      result.current.handleComposerHistoryNavigation(
        createArrowEvent("Original draft", 0),
      ),
    );
    expect(result.current.activeDraft).toBe("Previous prompt");

    rerender({ state: secondState });

    expect(result.current.activeDraft).toBe("Second draft");
    expect(firstState.activeSession.draft).toBe("Original draft");
    expect(firstState.updateActiveSession).not.toHaveBeenCalled();
    expect(firstState.updateSessionById).not.toHaveBeenCalled();
  });

  it("resets a stale history cursor when shared history is cleared", () => {
    const initialState = createController("Current draft");
    initialState.promptHistoryIndex = 0;
    const { result, rerender } = renderHook(
      ({ state }) => useSessionComposerState(state),
      { initialProps: { state: initialState } },
    );
    const clearedState = {
      ...initialState,
      activeSession: {
        ...initialState.activeSession,
        promptHistory: [],
        promptContextHistory: [],
      },
    };

    rerender({ state: clearedState });

    expect(clearedState.setPromptHistoryIndex).toHaveBeenCalledWith(null);

    act(() =>
      result.current.handleComposerHistoryNavigation(
        createArrowEvent("Current draft", 0),
      ),
    );

    expect(clearedState.setDraftValue).not.toHaveBeenCalledWith(undefined);
  });
});
