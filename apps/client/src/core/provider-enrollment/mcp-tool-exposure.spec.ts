import { describe, expect, it } from "vitest";
import type { McpEffectiveServerConfig } from "../mcp/types.js";
import {
  getMcpToolProjectionPrefix,
  isMcpToolEnabledForProjection,
} from "./mcp-tool-exposure.js";

const createServer = (
  overrides: Partial<McpEffectiveServerConfig> = {},
): McpEffectiveServerConfig => ({
  id: "fixture",
  enabled: true,
  transport: { type: "stdio", command: "fixture" },
  exposure: { mode: "hybrid", directTools: true },
  securityProfile: "weak",
  timeoutMs: 60_000,
  maxTotalTimeoutMs: 300_000,
  idleShutdownMs: 0,
  maxResponseChars: 60_000,
  cache: { enabled: false, ttlMs: 0, forceRefresh: false },
  roots: "workspace",
  sampling: "disabled",
  tasks: "optional",
  sources: ["override"],
  ...overrides,
});

describe("provider MCP tool exposure", () => {
  it("enforces disabled direct tools and per-tool overrides", () => {
    expect(
      isMcpToolEnabledForProjection(
        createServer({ exposure: { mode: "meta-tools", directTools: true } }),
        "search",
      ),
    ).toBe(false);
    expect(
      isMcpToolEnabledForProjection(
        createServer({ toolOverrides: { search: { enabled: false } } }),
        "search",
      ),
    ).toBe(false);
  });

  it("enforces include and exclude filters consistently", () => {
    const server = createServer({
      exposure: {
        mode: "hybrid",
        directTools: {
          include: ["search", "read"],
          exclude: ["read"],
          namespacePrefix: "linear",
        },
      },
    });

    expect(isMcpToolEnabledForProjection(server, "search")).toBe(true);
    expect(isMcpToolEnabledForProjection(server, "read")).toBe(false);
    expect(isMcpToolEnabledForProjection(server, "write")).toBe(false);
    expect(getMcpToolProjectionPrefix(server)).toBe("linear");
  });
});
