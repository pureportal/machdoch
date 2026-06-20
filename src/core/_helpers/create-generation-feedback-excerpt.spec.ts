import { createGenerationFeedbackExcerpt } from "./create-generation-feedback-excerpt.helper.ts";

describe("createGenerationFeedbackExcerpt", () => {
  it("returns an empty string for undefined or whitespace-only feedback", () => {
    expect(createGenerationFeedbackExcerpt(undefined)).toBe("");
    expect(createGenerationFeedbackExcerpt(" \n\t ")).toBe("");
  });

  it("normalizes internal whitespace", () => {
    expect(createGenerationFeedbackExcerpt("First line\n\nSecond\tline")).toBe(
      "First line Second line",
    );
  });

  it("truncates long feedback at the generation feedback boundary", () => {
    const excerpt = createGenerationFeedbackExcerpt("x".repeat(1_205));

    expect(excerpt).toHaveLength(1_203);
    expect(excerpt.endsWith("...")).toBe(true);
  });
});
