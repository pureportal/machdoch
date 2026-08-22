import { normalizeModelId } from "./normalize-model-id.helper.ts";

describe("normalizeModelId", () => {
  it.each([
    ["plain model id", "gpt-5.5", "gpt-5.5"],
    ["mixed case", "GPT-5.5", "gpt-5.5"],
    ["leading and trailing whitespace", "  Claude-Opus-4-8  ", "claude-opus-4-8"],
    ["tabs and newlines", "\n\tGemini-3.5-Flash\r\n", "gemini-3.5-flash"],
    ["empty string", "", ""],
    ["blank string", "   ", ""],
    ["undefined", undefined, ""],
    ["null", null, ""],
  ])("normalizes %s", (_label, input, expected) => {
    expect(normalizeModelId(input)).toBe(expected);
  });
});
