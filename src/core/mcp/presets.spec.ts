import { getMcpPreset, listMcpPresets, MCP_PRESETS } from "./presets.ts";

describe("getMcpPreset", () => {
  it("returns a known preset by id", () => {
    expect(getMcpPreset("github-remote")).toMatchObject({
      id: "github-remote",
      server: {
        id: "github",
        transport: {
          type: "streamable-http",
          url: "https://api.githubcopilot.com/mcp/",
        },
        auth: {
          type: "bearer",
          tokenEnv: "GITHUB_PERSONAL_ACCESS_TOKEN",
        },
      },
    });
  });

  it("uses upstream GitHub Docker token environment naming", () => {
    expect(getMcpPreset("github-local-docker")).toMatchObject({
      server: {
        transport: {
          type: "stdio",
          command: "docker",
          args: [
            "run",
            "-i",
            "--rm",
            "-e",
            "GITHUB_PERSONAL_ACCESS_TOKEN",
            "ghcr.io/github/github-mcp-server",
          ],
          env: {
            GITHUB_PERSONAL_ACCESS_TOKEN: "${env:GITHUB_PERSONAL_ACCESS_TOKEN}",
          },
        },
      },
    });
  });

  it("uses an isolated Chrome DevTools profile by default", () => {
    expect(getMcpPreset("chrome-devtools")).toMatchObject({
      server: {
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "chrome-devtools-mcp@latest", "--isolated"],
        },
      },
    });
  });

  it("returns undefined for unknown, empty, null, and undefined ids", () => {
    expect(getMcpPreset("unknown")).toBeUndefined();
    expect(getMcpPreset("")).toBeUndefined();
    expect(getMcpPreset(null as unknown as string)).toBeUndefined();
    expect(getMcpPreset(undefined as unknown as string)).toBeUndefined();
  });
});

describe("listMcpPresets", () => {
  it("returns all presets in inventory order", () => {
    expect(listMcpPresets().map((preset) => preset.id)).toEqual(
      MCP_PRESETS.map((preset) => preset.id),
    );
  });

  it("returns editable preset copies without mutating the static inventory", () => {
    const listed = listMcpPresets();
    const serper = listed.find((preset) => preset.id === "serper-search");
    const source = MCP_PRESETS.find((preset) => preset.id === "serper-search");

    expect(serper).toBeDefined();
    expect(source).toBeDefined();
    expect(serper).not.toBe(source);
    expect(serper?.server).not.toBe(source?.server);
    expect(serper?.server.transport).not.toBe(source?.server.transport);
    expect(serper?.server.cache).not.toBe(source?.server.cache);

    if (serper?.server.transport.type !== "stdio") {
      throw new Error("expected serper stdio transport");
    }

    serper.server.transport.args?.push("--verbose");
    serper.server.cache!.ttlMs = 1;

    expect(source?.server.transport).toMatchObject({
      type: "stdio",
      args: ["-y", "serper-search-mcp@latest"],
    });
    expect(source?.server.cache).toMatchObject({
      enabled: true,
      ttlMs: 900_000,
      forceRefresh: false,
    });
  });

  it("returns fresh copies on every call", () => {
    const first = listMcpPresets();
    const second = listMcpPresets();

    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(first[0]?.server).not.toBe(second[0]?.server);
    expect(first[0]?.server.transport).not.toBe(second[0]?.server.transport);
  });
});
