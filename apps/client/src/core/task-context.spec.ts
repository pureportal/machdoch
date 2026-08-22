/// <reference types="vitest/globals" />
import { rankTaskMatchText, tokenizeTaskMatchText } from "./task-context.ts";

describe("tokenizeTaskMatchText", () => {
  it("drops stop words, short tokens, and duplicates", () => {
    expect(
      tokenizeTaskMatchText(
        "Update the scheduler core with the scheduler task-context service",
      ),
    ).toEqual(["scheduler", "core", "task", "context", "service"]);
  });
});

describe("rankTaskMatchText", () => {
  it("scores overlapping terms in the original task-token order", () => {
    const taskTokens = tokenizeTaskMatchText(
      "Review the scheduler task context service",
    );

    expect(
      rankTaskMatchText(
        taskTokens,
        "Context helpers keep the service reliable for every scheduler task",
      ),
    ).toEqual({
      score: 4,
      matchedTerms: ["scheduler", "task", "context", "service"],
    });
  });
});
