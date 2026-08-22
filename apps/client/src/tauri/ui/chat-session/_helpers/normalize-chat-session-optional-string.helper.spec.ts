import { normalizeChatSessionOptionalString } from "./normalize-chat-session-optional-string.helper.ts";

describe("normalizeChatSessionOptionalString", () => {
  it.each([
    ["plain text", "machdoch"],
    ["leading and trailing spaces", "  machdoch  "],
    ["empty string", ""],
    ["spaces only", "   "],
    ["line breaks and tabs", "\n\tmachdoch\t\n"],
    ["numeric-looking text", "0"],
  ])("preserves string input exactly: %s", (_label, value) => {
    expect(normalizeChatSessionOptionalString(value)).toBe(value);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["true", true],
    ["false", false],
    ["zero number", 0],
    ["positive number", 42],
    ["nan", Number.NaN],
    ["array", ["machdoch"]],
    ["object", { value: "machdoch" }],
    ["string object", new String("machdoch")],
  ])("collapses non-primitive-string values to undefined: %s", (_label, value) => {
    expect(normalizeChatSessionOptionalString(value)).toBeUndefined();
  });
});
