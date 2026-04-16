import { normalizeOptionalString } from "./normalize-optional-string.ts";

describe("normalizeOptionalString", () => {
  it("trims non-empty string values", () => {
    expect(normalizeOptionalString("  machdoch  ")).toBe("machdoch");
  });

  it("collapses empty or non-string values to undefined", () => {
    expect(normalizeOptionalString("   ")).toBeUndefined();
    expect(normalizeOptionalString(true)).toBeUndefined();
    expect(normalizeOptionalString(undefined)).toBeUndefined();
    expect(normalizeOptionalString(null)).toBeUndefined();
  });
});