import { normalizeRalphWatchScope } from "./normalize-ralph-watch-scope.helper.ts";

describe("normalizeRalphWatchScope", () => {
  it.each([
    ["user", "workspace", "user"],
    ["workspace", "user", "workspace"],
  ] as const)("keeps valid scope %s", (value, fallback, expected) => {
    expect(normalizeRalphWatchScope(value, fallback)).toBe(expected);
  });

  it.each(["", "global", undefined])("uses fallback for invalid scope %#", (value) => {
    expect(normalizeRalphWatchScope(value, "workspace")).toBe("workspace");
  });
});
