import { cloneMcpPreset } from "./clone-mcp-preset.helper.ts";
import type { McpPresetDefinition } from "../types.ts";

const createPreset = (
  overrides: Partial<McpPresetDefinition["server"]> = {},
): McpPresetDefinition => ({
  id: "example-preset",
  title: "Example Preset",
  description: "Example preset for clone tests.",
  server: {
    id: "example",
    transport: {
      type: "stdio",
      command: "node",
      args: ["server.js"],
      env: {
        TOKEN: "${env:TOKEN}",
      },
    },
    cache: {
      enabled: true,
      ttlMs: 1_000,
      forceRefresh: false,
    },
    toolOverrides: {
      search: {
        effect: "external-read",
        riskLevel: "low",
      },
    },
    roots: ["/workspace"],
    ...overrides,
  },
});

describe("cloneMcpPreset", () => {
  it("copies stdio transport arrays, environment, cache, roots, and tool overrides", () => {
    const preset = createPreset();
    const cloned = cloneMcpPreset(preset);

    expect(cloned).toEqual(preset);
    expect(cloned).not.toBe(preset);
    expect(cloned.server).not.toBe(preset.server);
    expect(cloned.server.transport).not.toBe(preset.server.transport);
    expect(cloned.server.cache).not.toBe(preset.server.cache);
    expect(cloned.server.toolOverrides).not.toBe(preset.server.toolOverrides);
    expect(cloned.server.roots).not.toBe(preset.server.roots);

    if (cloned.server.transport.type !== "stdio") {
      throw new Error("expected stdio transport");
    }

    if (preset.server.transport.type !== "stdio") {
      throw new Error("expected source stdio transport");
    }

    expect(cloned.server.transport.args).not.toBe(preset.server.transport.args);
    expect(cloned.server.transport.env).not.toBe(preset.server.transport.env);
    cloned.server.transport.args?.push("--debug");
    cloned.server.transport.env.NEW_TOKEN = "new";
    cloned.server.cache!.ttlMs = 2_000;
    cloned.server.toolOverrides!.search.enabled = false;
    (cloned.server.roots as string[]).push("/other");

    expect(preset.server.transport.args).toEqual(["server.js"]);
    expect(preset.server.transport.env).toEqual({
      TOKEN: "${env:TOKEN}",
    });
    expect(preset.server.cache).toEqual({
      enabled: true,
      ttlMs: 1_000,
      forceRefresh: false,
    });
    expect(preset.server.toolOverrides?.search).toEqual({
      effect: "external-read",
      riskLevel: "low",
    });
    expect(preset.server.roots).toEqual(["/workspace"]);
  });

  it("copies streamable HTTP headers and bearer auth", () => {
    const preset = createPreset({
      transport: {
        type: "streamable-http",
        url: "https://example.test/mcp",
        headers: {
          Authorization: "Bearer ${env:TOKEN}",
        },
      },
      auth: {
        type: "bearer",
        tokenEnv: "TOKEN",
      },
    });
    const cloned = cloneMcpPreset(preset);

    if (
      cloned.server.transport.type !== "streamable-http" ||
      preset.server.transport.type !== "streamable-http"
    ) {
      throw new Error("expected streamable HTTP transport");
    }

    expect(cloned.server.transport.headers).toEqual({
      Authorization: "Bearer ${env:TOKEN}",
    });
    expect(cloned.server.transport.headers).not.toBe(
      preset.server.transport.headers,
    );
    expect(cloned.server.auth).toEqual({
      type: "bearer",
      tokenEnv: "TOKEN",
    });
    expect(cloned.server.auth).not.toBe(preset.server.auth);
  });

  it("copies SSE headers and OAuth nested state", () => {
    const preset = createPreset({
      transport: {
        type: "sse",
        url: "https://example.test/sse",
        headers: {
          "X-Workspace": "machdoch",
        },
      },
      auth: {
        type: "oauth",
        scopes: ["repo"],
        clientInformation: {
          client_id: "client",
        },
        discoveryState: {
          issuer: "https://example.test",
        },
      },
    });
    const cloned = cloneMcpPreset(preset);

    if (cloned.server.transport.type !== "sse" || preset.server.transport.type !== "sse") {
      throw new Error("expected SSE transport");
    }

    if (cloned.server.auth?.type !== "oauth" || preset.server.auth?.type !== "oauth") {
      throw new Error("expected OAuth auth");
    }

    expect(cloned.server.transport.headers).not.toBe(
      preset.server.transport.headers,
    );
    expect(cloned.server.auth.scopes).not.toBe(preset.server.auth.scopes);
    expect(cloned.server.auth.clientInformation).not.toBe(
      preset.server.auth.clientInformation,
    );
    expect(cloned.server.auth.discoveryState).not.toBe(
      preset.server.auth.discoveryState,
    );
  });

  it("copies header auth maps", () => {
    const preset = createPreset({
      auth: {
        type: "headers",
        headers: {
          Authorization: "Bearer token",
        },
        envHeaders: {
          "X-Token": "TOKEN",
        },
      },
    });
    const cloned = cloneMcpPreset(preset);

    if (cloned.server.auth?.type !== "headers" || preset.server.auth?.type !== "headers") {
      throw new Error("expected header auth");
    }

    expect(cloned.server.auth.headers).toEqual({
      Authorization: "Bearer token",
    });
    expect(cloned.server.auth.envHeaders).toEqual({
      "X-Token": "TOKEN",
    });
    expect(cloned.server.auth.headers).not.toBe(preset.server.auth.headers);
    expect(cloned.server.auth.envHeaders).not.toBe(preset.server.auth.envHeaders);
  });
});
