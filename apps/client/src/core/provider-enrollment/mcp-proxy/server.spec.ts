import { describe, expect, it } from "vitest";
import { createProxyExposedName } from "./server.js";

describe("MCP compatibility proxy names", () => {
  it("creates deterministic provider-safe names within the Copilot limit", () => {
    const first = createProxyExposedName(
      "server with spaces",
      "tool/with/a/very/long/name/that/would/exceed/the/provider/combined/name/limit",
      true,
    );
    const second = createProxyExposedName(
      "server with spaces",
      "tool/with/a/very/long/name/that/would/exceed/the/provider/combined/name/limit",
      true,
    );
    expect(first).toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(first.length).toBeLessThanOrEqual(40);
    expect(first).toMatch(/_[a-f0-9]{10}$/u);
  });

  it("keeps simple per-server names unchanged", () => {
    expect(createProxyExposedName("linear", "read_issue", false)).toBe(
      "read_issue",
    );
  });

  it("does not collapse distinct names during sanitization or aggregation", () => {
    expect(createProxyExposedName("linear", "tool/a", false)).not.toBe(
      createProxyExposedName("linear", "tool a", false),
    );
    expect(createProxyExposedName("a", "b__c", true)).not.toBe(
      createProxyExposedName("a__b", "c", true),
    );
  });
});
