import { describe, expect, it } from "vitest";
import {
  allowedRepositoriesSchema,
  connectorToolName,
  maximumMcpConnectors,
  mcpConnectorInputSchema,
} from "./agent-personalization";
import { handoffModel, handoffWhere } from "./agent-handoff";

describe("mcpConnectorInputSchema", () => {
  it("accepts a named https connector with an optional token", () => {
    expect(
      mcpConnectorInputSchema.parse({
        name: " docs-1 ",
        url: "https://mcp.example.com/mcp",
        token: null,
      }),
    ).toEqual({
      name: "docs-1",
      url: "https://mcp.example.com/mcp",
      token: null,
    });
  });

  it.each([
    { name: "Docs", url: "https://mcp.example.com", token: null },
    { name: "-docs", url: "https://mcp.example.com", token: null },
    { name: "a".repeat(25), url: "https://mcp.example.com", token: null },
    { name: "docs", url: "http://mcp.example.com", token: null },
    { name: "docs", url: "https://user:pass@mcp.example.com", token: null },
    { name: "docs", url: "https://mcp.example.com/#tools", token: null },
    { name: "docs", url: "https://mcp.example.com", token: " " },
  ])("rejects %o", (input) => {
    expect(mcpConnectorInputSchema.safeParse(input).success).toBe(false);
  });

  it("caps connectors and allowed repositories", () => {
    expect(maximumMcpConnectors).toBe(8);
    expect(
      allowedRepositoriesSchema.safeParse({ repositoryIds: ["main"] }).success,
    ).toBe(false);
  });
});

describe("connectorToolName", () => {
  it("prefixes tools with their connector and keeps names within 64 characters", () => {
    expect(connectorToolName("team-docs", "search.pages")).toBe(
      "mcp_team_docs_search_pages",
    );
    expect(connectorToolName("docs", "t".repeat(55))).toBe(
      `mcp_docs_${"t".repeat(55)}`,
    );
    expect(connectorToolName("docs", "t".repeat(56))).toBeNull();
  });
});

describe("handoff defaults", () => {
  const options = {
    profiles: [
      { id: "pool", name: "Pool", target: "client-linux" as const },
      { id: "sandbox", name: "Sandbox", target: "cloud" as const },
    ],
    devices: [{ id: "laptop", name: "Laptop", profileId: "devices" }],
  };

  it("preselects where a handoff runs from the personal placement", () => {
    expect(handoffWhere(null, options)).toBe("automatic");
    expect(handoffWhere("automatic", options)).toBe("automatic");
    expect(handoffWhere("sandbox", options)).toBe("profile:sandbox");
    expect(handoffWhere("runner_pool", options)).toBe("profile:pool");
    expect(handoffWhere("client", options)).toBe("device:laptop");
    expect(handoffWhere("client", { ...options, devices: [] })).toBe(
      "automatic",
    );
    expect(handoffWhere("sandbox", { ...options, profiles: [] })).toBe(
      "automatic",
    );
  });

  it("preselects the personal model when the harness offers it", () => {
    expect(handoffModel("b", ["a", "b"], "turn")).toBe("b");
    expect(handoffModel("c", ["a", "b"], "turn")).toBe("a");
    expect(handoffModel(null, [], "turn")).toBe("turn");
  });
});
