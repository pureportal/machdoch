import {
  addPromptHistoryEntry,
  arePromptHistoriesEqual,
  navigatePromptHistory,
  normalizePromptHistoryEntries,
  type PromptHistoryNavigationState,
} from "../../_helpers/prompt-history-navigation.helper";

export const MAX_RALPH_AI_PROMPT_HISTORY_ENTRIES = 40;

export const EMPTY_RALPH_AI_PROMPT_HISTORY: readonly string[] = [];

export const normalizeRalphAiPromptHistory = (
  history: readonly string[] | null | undefined,
): string[] => {
  return normalizePromptHistoryEntries(
    history,
    MAX_RALPH_AI_PROMPT_HISTORY_ENTRIES,
  );
};

export const areRalphAiPromptHistoriesEqual = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  return arePromptHistoriesEqual(left, right);
};

export const addRalphAiPromptHistoryEntry = (
  history: readonly string[] | null | undefined,
  prompt: string,
): string[] => {
  return addPromptHistoryEntry(
    history,
    prompt,
    MAX_RALPH_AI_PROMPT_HISTORY_ENTRIES,
  );
};

export type RalphAiPromptHistoryNavigationState =
  PromptHistoryNavigationState;

export const navigateRalphAiPromptHistory = (
  state: RalphAiPromptHistoryNavigationState,
  history: readonly string[],
  direction: "previous" | "next",
): RalphAiPromptHistoryNavigationState => {
  return navigatePromptHistory(state, history, direction);
};
