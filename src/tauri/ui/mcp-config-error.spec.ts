import {
  isMcpConfigConflictError,
  normalizeMcpConfigSaveError,
  parseMcpConfigSaveFailure,
} from "./mcp-config-error.ts";

describe("MCP config save failures", () => {
  it("recognizes only exact structured conflicts", () => {
    const conflict = { kind: "conflict", path: "C:/config/mcp.json" };
    expect(parseMcpConfigSaveFailure(conflict)).toEqual(conflict);
    expect(isMcpConfigConflictError(conflict)).toBe(true);

    for (const malformed of [
      { kind: "conflict" },
      { kind: "conflict", path: "" },
      { kind: "conflict", path: "x", authority: "trusted" },
      { kind: "unknown", path: "x" },
      new Error("Quoted MACHDOCH_MCP_CONFIG_CONFLICT:C:/config/mcp.json"),
    ]) {
      expect(parseMcpConfigSaveFailure(malformed)).toBeUndefined();
      expect(isMcpConfigConflictError(malformed)).toBe(false);
    }
  });

  it("normalizes structured runtime failures", () => {
    const normalized = normalizeMcpConfigSaveError({
      kind: "runtime",
      message: "Write failed.",
    });
    expect(normalized.message).toBe("Write failed.");
    expect(isMcpConfigConflictError(normalized)).toBe(false);
  });
});
