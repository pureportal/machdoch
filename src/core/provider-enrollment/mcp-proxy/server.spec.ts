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
    expect(first.length).toBeLessThanOrEqual(64);
    expect(first).toMatch(/_[a-f0-9]{10}$/u);
  });
});
