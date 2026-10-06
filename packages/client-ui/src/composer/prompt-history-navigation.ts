export const DEFAULT_PROMPT_HISTORY_LIMIT = 40;

export const normalizePromptHistoryEntries = (
  history: readonly string[] | null | undefined,
  maxEntries = DEFAULT_PROMPT_HISTORY_LIMIT,
): string[] => {
  return (history ?? [])
    .flatMap((entry) => {
      const normalizedEntry = entry.trim();

      return normalizedEntry ? [normalizedEntry] : [];
    })
    .slice(-maxEntries);
};

export const arePromptHistoriesEqual = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
};

export const addPromptHistoryEntry = (
  history: readonly string[] | null | undefined,
  prompt: string,
  maxEntries = DEFAULT_PROMPT_HISTORY_LIMIT,
): string[] => {
  const normalizedHistory = normalizePromptHistoryEntries(history, maxEntries);
  const normalizedPrompt = prompt.trim();

  if (!normalizedPrompt || normalizedHistory.at(-1) === normalizedPrompt) {
    return normalizedHistory;
  }

  return [...normalizedHistory, normalizedPrompt].slice(-maxEntries);
};

export interface PromptHistoryNavigationState {
  draft: string;
  draftBeforeHistory: string;
  historyIndex: number | null;
}

export const navigatePromptHistory = (
  state: PromptHistoryNavigationState,
  history: readonly string[],
  direction: "previous" | "next",
): PromptHistoryNavigationState => {
  if (history.length === 0) {
    return state;
  }

  if (direction === "previous") {
    if (state.historyIndex === null) {
      const nextIndex = history.length - 1;

      return {
        draft: history[nextIndex] ?? "",
        draftBeforeHistory: state.draft,
        historyIndex: nextIndex,
      };
    }

    const nextIndex = Math.max(state.historyIndex - 1, 0);

    return {
      ...state,
      draft: history[nextIndex] ?? "",
      historyIndex: nextIndex,
    };
  }

  if (state.historyIndex === null) {
    return state;
  }

  const nextIndex = state.historyIndex + 1;

  if (nextIndex >= history.length) {
    return {
      draft: state.draftBeforeHistory,
      draftBeforeHistory: "",
      historyIndex: null,
    };
  }

  return {
    ...state,
    draft: history[nextIndex] ?? "",
    historyIndex: nextIndex,
  };
};
