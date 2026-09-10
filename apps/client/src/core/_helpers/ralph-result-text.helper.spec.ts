import { describe, expect, it } from "vitest";
import { createExecutionResult } from "../__test__/ralph-test-helpers.js";
import {
  getRalphResultMarkdown,
  getRalphResultText,
} from "./ralph-result-text.helper.js";

describe("Ralph result text", () => {
  it.each([15_999, 16_000, 16_001, 32_000])(
    "preserves all %i response characters and caps only presentation",
    (length) => {
      const text = "a".repeat(length);
      const result = createExecutionResult({
        summary: "Short summary.",
        response: {
          markdown: text,
          highlights: [],
          relatedFiles: [],
          verification: [],
          followUps: [],
        },
      });

      expect(getRalphResultText(result)).toBe(text);
      if (length <= 16_000) {
        expect(getRalphResultMarkdown(result)).toBe(text);
      } else {
        expect(getRalphResultMarkdown(result)).toBe(
          `${text.slice(0, 8_000)}\n[Ralph result truncated at 16000 characters.]\n${text.slice(-8_000)}`,
        );
      }
    },
  );

  it("preserves the complete summary when no response narrative exists", () => {
    const summary = "s".repeat(32_000);
    const result = createExecutionResult({ summary });
    delete result.response;
    expect(getRalphResultText(result)).toBe(summary);
    expect(getRalphResultText(undefined)).toBe("");
    expect(
      getRalphResultText(
        createExecutionResult({
          response: {
            markdown: "",
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        }),
      ),
    ).toBe("");
  });
});
