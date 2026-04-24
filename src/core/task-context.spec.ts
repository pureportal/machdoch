import { describe, expect, it } from "vitest";
import { rankTaskMatchText, tokenizeTaskMatchText } from "./task-context.ts";

describe("tokenizeTaskMatchText", () => {
  it("drops stop words, short tokens, and duplicates", () => {
    expect(
      tokenizeTaskMatchText("Update the React UI with the react task-context panel"),
    ).toEqual(["react", "task", "context", "panel"]);
  });
});

describe("rankTaskMatchText", () => {
  it("scores overlapping terms in the original task-token order", () => {
    const taskTokens = tokenizeTaskMatchText(
      "Review the React task context panel",
    );

    expect(
      rankTaskMatchText(
        taskTokens,
        "Context helpers keep the panel responsive for every React task",
      ),
    ).toEqual({
      score: 4,
      matchedTerms: ["react", "task", "context", "panel"],
    });
  });
});
