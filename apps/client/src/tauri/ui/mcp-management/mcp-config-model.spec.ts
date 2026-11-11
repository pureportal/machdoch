import { describe, expect, it } from "vitest";
import {
  createTransport,
  describeServerConnection,
  getFirstMcpServerId,
  getServerKey,
  getServerStatus,
  groupMcpPresets,
  parseDraft,
  validateServers,
} from "./mcp-config-model";

const preset = (id: string) => ({
  id,
  title: id,
  description: "",
  serverId: id,
  serverTitle: id,
});

describe("MCP config model", () => {
  it("parses server maps into server records with ids", () => {
    const parsed = parseDraft(
      JSON.stringify({
        schemaVersion: 1,
        servers: { docs: { transport: { type: "sse", url: "https://a.dev" } } },
      }),
    );

    expect(parsed.error).toBeNull();
    expect(parsed.servers).toEqual([
      { id: "docs", transport: { type: "sse", url: "https://a.dev" } },
    ]);
  });

  it("rejects drafts with another schema version", () => {
    expect(parseDraft('{"schemaVersion":2,"servers":[]}').error).toBe(
      "schemaVersion must be 1. Recreate this configuration.",
    );
  });

  it("finds the first configured server id", () => {
    expect(
      getFirstMcpServerId('{"schemaVersion":1,"servers":[{"id":"first"}]}'),
    ).toBe("first");
    expect(getFirstMcpServerId('{"schemaVersion":1,"servers":[]}')).toBeNull();
    expect(getFirstMcpServerId("not json")).toBeNull();
  });

  it("reports missing transports, invalid URLs, duplicates, and weak bearer auth", () => {
    const servers = [
      { id: "local", transport: { type: "stdio", command: "" } },
      { id: "remote", transport: { type: "sse", url: "ftp://host" } },
      {
        id: "remote",
        transport: { type: "streamable-http", url: "https://host/mcp" },
        auth: { type: "bearer" },
      },
    ];

    expect(
      validateServers(servers).map(({ tone, text }) => [tone, text]),
    ).toEqual([
      ["error", "Stdio transport requires a command."],
      ["error", 'Server ID "remote" is used more than once.'],
      ["error", "Remote transport URL must use HTTP or HTTPS."],
      ["error", 'Server ID "remote" is used more than once.'],
      ["warning", "Bearer auth should use a token env var or token."],
    ]);
  });

  it("derives server status from validation errors and the enabled flag", () => {
    const server = { id: "a", enabled: false, transport: { type: "stdio" } };
    const issues = validateServers([server]);

    expect(getServerStatus(server, issues)).toBe("needs-setup");
    expect(
      getServerStatus({ ...server, transport: { command: "npx" } }, []),
    ).toBe("disabled");
    expect(getServerStatus({ id: "b" }, [])).toBe("enabled");
    expect(issues[0]?.serverKey).toBe(getServerKey(server, 0));
  });

  it("keeps only fields that belong to the new transport", () => {
    expect(
      createTransport("streamable-http", {
        type: "stdio",
        command: "npx",
        args: ["-y"],
        headers: { A: "1" },
      }),
    ).toEqual({ type: "streamable-http", url: "", headers: { A: "1" } });
  });

  it("describes the connection target of a server", () => {
    expect(
      describeServerConnection({
        transport: { type: "stdio", command: "npx", args: ["-y", "pkg"] },
      }),
    ).toBe("npx -y pkg");
    expect(
      describeServerConnection({
        transport: { type: "sse", url: "https://host/sse" },
      }),
    ).toBe("https://host/sse");
    expect(describeServerConnection({ transport: { type: "sse" } })).toBe(
      "sse",
    );
  });

  it("groups presets by category and keeps unknown presets last", () => {
    expect(
      groupMcpPresets([
        preset("unknown"),
        preset("github-remote"),
        preset("serper-search"),
      ]).map((group) => [group.label, group.presets.map(({ id }) => id)]),
    ).toEqual([
      ["Web & Search", ["serper-search"]],
      ["Code & CI", ["github-remote"]],
      ["More", ["unknown"]],
    ]);
  });
});
