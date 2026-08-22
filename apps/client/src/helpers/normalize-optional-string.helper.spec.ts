import { normalizeOptionalString } from "./normalize-optional-string.helper.ts";

describe("normalizeOptionalString", () => {
  it.each([
    ["plain text", "machdoch"],
    ["leading and trailing spaces", "  machdoch  "],
    ["line breaks and tabs", "\n\tmachdoch\t\n"],
    ["numeric-looking text", "  0  "],
    ["boolean-looking text", "  false  "],
  ])("trims and keeps non-empty strings: %s", (_label, value) => {
    expect(normalizeOptionalString(value)).toBe(value.trim());
  });

  it.each([
    ["empty string", ""],
    ["spaces only", "   "],
    ["line breaks only", "\n\t\r"],
  ])("collapses blank strings to undefined: %s", (_label, value) => {
    expect(normalizeOptionalString(value)).toBeUndefined();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["true", true],
    ["false", false],
    ["zero number", 0],
    ["positive number", 42],
    ["array", ["machdoch"]],
    ["object", { value: "machdoch" }],
  ])("collapses non-string values to undefined: %s", (_label, value) => {
    expect(normalizeOptionalString(value)).toBeUndefined();
  });
});
