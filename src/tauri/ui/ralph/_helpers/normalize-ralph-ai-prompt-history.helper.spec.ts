import {
  EMPTY_RALPH_AI_PROMPT_HISTORY,
  MAX_RALPH_AI_PROMPT_HISTORY_ENTRIES,
  addRalphAiPromptHistoryEntry,
  areRalphAiPromptHistoriesEqual,
  navigateRalphAiPromptHistory,
  normalizeRalphAiPromptHistory,
} from "./normalize-ralph-ai-prompt-history.helper";

describe("Ralph AI prompt history helpers", () => {
  it("normalizes null, undefined, empty, and whitespace-only history", () => {
    expect(EMPTY_RALPH_AI_PROMPT_HISTORY).toEqual([]);
    expect(normalizeRalphAiPromptHistory(undefined)).toEqual([]);
    expect(normalizeRalphAiPromptHistory(null)).toEqual([]);
    expect(normalizeRalphAiPromptHistory([])).toEqual([]);
    expect(normalizeRalphAiPromptHistory(["", "   ", "\n\t"])).toEqual([]);
  });

  it("trims entries without removing non-adjacent duplicates", () => {
    expect(
      normalizeRalphAiPromptHistory([
        "  create release flow  ",
        "triage issues",
        "create release flow",
      ]),
    ).toEqual([
      "create release flow",
      "triage issues",
      "create release flow",
    ]);
  });

  it("keeps only the most recent bounded history entries", () => {
    const history = Array.from(
      { length: MAX_RALPH_AI_PROMPT_HISTORY_ENTRIES + 5 },
      (_, index) => `prompt-${index}`,
    );

    const normalized = normalizeRalphAiPromptHistory(history);

    expect(normalized).toHaveLength(MAX_RALPH_AI_PROMPT_HISTORY_ENTRIES);
    expect(normalized[0]).toBe("prompt-5");
    expect(normalized.at(-1)).toBe(
      `prompt-${MAX_RALPH_AI_PROMPT_HISTORY_ENTRIES + 4}`,
    );
  });

  it("compares histories by length, order, and exact values", () => {
    expect(areRalphAiPromptHistoriesEqual([], [])).toBe(true);
    expect(areRalphAiPromptHistoriesEqual(["a"], ["a"])).toBe(true);
    expect(areRalphAiPromptHistoriesEqual(["a"], ["a", "b"])).toBe(false);
    expect(areRalphAiPromptHistoriesEqual(["a", "b"], ["b", "a"])).toBe(false);
    expect(areRalphAiPromptHistoriesEqual(["a"], [" a "])).toBe(false);
  });

  it("adds trimmed prompts to normalized history", () => {
    expect(addRalphAiPromptHistoryEntry([" existing "], "  next prompt  ")).toEqual([
      "existing",
      "next prompt",
    ]);
    expect(addRalphAiPromptHistoryEntry(null, "first")).toEqual(["first"]);
    expect(addRalphAiPromptHistoryEntry(undefined, "first")).toEqual(["first"]);
  });

  it("ignores empty prompts after preserving normalized history", () => {
    expect(addRalphAiPromptHistoryEntry([" existing ", ""], "   ")).toEqual([
      "existing",
    ]);
  });

  it("suppresses repeated adjacent prompts but allows earlier repeated prompts", () => {
    expect(addRalphAiPromptHistoryEntry(["draft", "review"], " review ")).toEqual([
      "draft",
      "review",
    ]);
    expect(addRalphAiPromptHistoryEntry(["review", "draft"], "review")).toEqual([
      "review",
      "draft",
      "review",
    ]);
  });

  it("drops the oldest entry when adding beyond the history boundary", () => {
    const history = Array.from(
      { length: MAX_RALPH_AI_PROMPT_HISTORY_ENTRIES },
      (_, index) => `prompt-${index}`,
    );

    const nextHistory = addRalphAiPromptHistoryEntry(history, "new prompt");

    expect(nextHistory).toHaveLength(MAX_RALPH_AI_PROMPT_HISTORY_ENTRIES);
    expect(nextHistory[0]).toBe("prompt-1");
    expect(nextHistory.at(-1)).toBe("new prompt");
  });

  it("navigates to the newest prompt while preserving the draft", () => {
    expect(
      navigateRalphAiPromptHistory(
        { draft: "current draft", draftBeforeHistory: "", historyIndex: null },
        ["first prompt", "newest prompt"],
        "previous",
      ),
    ).toEqual({
      draft: "newest prompt",
      draftBeforeHistory: "current draft",
      historyIndex: 1,
    });
  });

  it("clamps previous navigation at the oldest prompt", () => {
    expect(
      navigateRalphAiPromptHistory(
        {
          draft: "first prompt",
          draftBeforeHistory: "current draft",
          historyIndex: 0,
        },
        ["first prompt", "newest prompt"],
        "previous",
      ),
    ).toEqual({
      draft: "first prompt",
      draftBeforeHistory: "current draft",
      historyIndex: 0,
    });
  });

  it("moves forward through history and restores the original draft at the end", () => {
    const next = navigateRalphAiPromptHistory(
      {
        draft: "first prompt",
        draftBeforeHistory: "current draft",
        historyIndex: 0,
      },
      ["first prompt", "newest prompt"],
      "next",
    );

    expect(next).toEqual({
      draft: "newest prompt",
      draftBeforeHistory: "current draft",
      historyIndex: 1,
    });

    expect(
      navigateRalphAiPromptHistory(next, ["first prompt", "newest prompt"], "next"),
    ).toEqual({
      draft: "current draft",
      draftBeforeHistory: "",
      historyIndex: null,
    });
  });

  it("leaves navigation state unchanged without history or without an active next index", () => {
    const state = {
      draft: "current draft",
      draftBeforeHistory: "",
      historyIndex: null,
    };

    expect(navigateRalphAiPromptHistory(state, [], "previous")).toBe(state);
    expect(navigateRalphAiPromptHistory(state, ["first prompt"], "next")).toBe(
      state,
    );
  });
});
