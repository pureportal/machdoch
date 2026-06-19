export const MAX_RALPH_AI_PROMPT_HISTORY_ENTRIES = 40;

export const EMPTY_RALPH_AI_PROMPT_HISTORY: readonly string[] = [];

export const normalizeRalphAiPromptHistory = (
  history: readonly string[] | null | undefined,
): string[] => {
  return (history ?? [])
    .flatMap((entry) => {
      const normalizedEntry = entry.trim();

      return normalizedEntry ? [normalizedEntry] : [];
    })
    .slice(-MAX_RALPH_AI_PROMPT_HISTORY_ENTRIES);
};

export const areRalphAiPromptHistoriesEqual = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
};

export const addRalphAiPromptHistoryEntry = (
  history: readonly string[] | null | undefined,
  prompt: string,
): string[] => {
  const normalizedHistory = normalizeRalphAiPromptHistory(history);
  const normalizedPrompt = prompt.trim();

  if (!normalizedPrompt) {
    return normalizedHistory;
  }

  if (normalizedHistory.at(-1) === normalizedPrompt) {
    return normalizedHistory;
  }

  return [...normalizedHistory, normalizedPrompt].slice(
    -MAX_RALPH_AI_PROMPT_HISTORY_ENTRIES,
  );
};
