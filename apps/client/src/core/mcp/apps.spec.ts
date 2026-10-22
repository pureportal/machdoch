import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mcpAppMimeType } from "@machdoch/fleet-protocol/mcp-apps";
import { captureMcpApp, runMcpAppRequest, listMcpAppsForRun } from "./apps.ts";
import { mcpAppsEnabled } from "./app-settings.ts";
import { getUserMcpConfigPath, getWorkspaceMcpConfigPath } from "./config.ts";
import type { McpServerDiscovery, McpServerOverride } from "./types.ts";

const client = vi.hoisted(() => ({
  discoverServer:
    vi.fn<typeof import("./client.ts").mcpClientManager.discoverServer>(),
  readResource:
    vi.fn<typeof import("./client.ts").mcpClientManager.readResource>(),
  callTool: vi.fn<typeof import("./client.ts").mcpClientManager.callTool>(),
}));

vi.mock("./client.ts", () => ({ mcpClientManager: client }));

const serverId = "apps-fixture";
const appUri = "ui://reports/summary";
const html = "<!doctype html><html><body>Research report</body></html>";
let temporaryRoot: string | undefined;
let workspaceRoot: string;
let discovery: McpServerDiscovery;

const createResult = () => ({
  content: [{ type: "text", text: "Two sources found." }],
  structuredContent: { total: 2 },
  _meta: {
    "machdoch/toolUi": { resourceUri: appUri },
    source: "research",
  },
});

it("attributes proxy results to their run without mixing concurrent agents", async () => {
  const first = await captureMcpApp(
    workspaceRoot,
    serverId,
    "report",
    {},
    createResult(),
    true,
    "run-one",
  );
  const second = await captureMcpApp(
    workspaceRoot,
    serverId,
    "report",
    {},
    createResult(),
    false,
    "run-two",
  );
  expect(await listMcpAppsForRun(workspaceRoot, "run-one")).toEqual([first]);
  expect(await listMcpAppsForRun(workspaceRoot, "run-two")).toEqual([second]);
  expect(await listMcpAppsForRun(workspaceRoot, "missing")).toEqual([]);
  await runMcpAppRequest(workspaceRoot, {
    action: "set-enabled",
    enabled: false,
  });
  expect(await listMcpAppsForRun(workspaceRoot, "run-one")).toEqual([]);
});

const writeConfig = async (
  override: Partial<McpServerOverride> = {},
): Promise<void> => {
  const path = getWorkspaceMcpConfigPath(workspaceRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      servers: [
        {
          id: serverId,
          enabled: true,
          transport: {
            type: "streamable-http",
            url: "https://example.com/reports/mcp",
          },
          auth: { type: "none" },
          ...override,
        },
      ],
    }),
    "utf8",
  );
};

const capture = async (readOnly = false): Promise<string> => {
  const id = await captureMcpApp(
    workspaceRoot,
    serverId,
    "show_report",
    { query: "workspace knowledge" },
    createResult(),
    readOnly,
  );
  if (!id) throw new Error("Expected an interactive result to be captured.");
  return id;
};

const callRequest = (id: string) => ({
  action: "call-tool",
  id,
  name: "update_report",
  arguments: { title: "Updated report" },
  confirmed: true,
});

it("revokes saved apps and their actions when the original tool is disabled", async () => {
  const id = await capture();
  await writeConfig({ toolOverrides: { show_report: { enabled: false } } });
  await expect(
    runMcpAppRequest(workspaceRoot, { action: "load", id }),
  ).rejects.toThrow("This tool is disabled");
  await expect(
    runMcpAppRequest(workspaceRoot, callRequest(id)),
  ).rejects.toThrow("This tool is disabled");
  expect(client.readResource).not.toHaveBeenCalled();
  expect(client.callTool).not.toHaveBeenCalled();
});

beforeEach(async () => {
  vi.resetAllMocks();
  temporaryRoot = await mkdtemp(join(tmpdir(), "machdoch-mcp-apps-"));
  workspaceRoot = join(temporaryRoot, "workspace");
  await mkdir(workspaceRoot);
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(temporaryRoot, "user-config"));
  discovery = {
    serverId,
    discoveredAt: "2026-10-22T00:00:00.000Z",
    transportType: "streamable-http",
    tools: [
      {
        name: "show_report",
        title: "Research report",
        inputSchema: { type: "object" },
        _meta: { ui: { resourceUri: appUri } },
      },
      {
        name: "update_report",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: false },
        _meta: { ui: { visibility: ["app"] } },
      },
    ],
    resources: [],
    resourceTemplates: [],
    prompts: [],
  };
  client.discoverServer.mockResolvedValue(discovery);
  client.readResource.mockResolvedValue({
    contents: [
      {
        uri: appUri,
        mimeType: mcpAppMimeType,
        text: html,
        _meta: {
          ui: { csp: { connectDomains: ["https://example.com"] } },
        },
      },
    ],
  });
  client.callTool.mockResolvedValue({
    content: [{ type: "text", text: "Updated." }],
  });
  await writeConfig();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  if (temporaryRoot) {
    await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

describe("MCP Apps settings and persistence", () => {
  it("enables apps by default without creating a settings file", async () => {
    expect(mcpAppsEnabled()).toBe(true);
    await expect(
      runMcpAppRequest(workspaceRoot, { action: "settings" }),
    ).resolves.toEqual({ enabled: true });
    await expect(
      readFile(join(dirname(getUserMcpConfigPath()), "mcp-apps.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(client.discoverServer).not.toHaveBeenCalled();
  });

  it("persists global disablement and gates capture, loading, and tool calls", async () => {
    const id = await capture();
    const otherWorkspace = join(temporaryRoot!, "other-workspace");
    await mkdir(otherWorkspace);

    await expect(
      runMcpAppRequest(workspaceRoot, {
        action: "set-enabled",
        enabled: false,
      }),
    ).resolves.toEqual({ enabled: false });
    expect(mcpAppsEnabled()).toBe(false);
    expect(
      JSON.parse(
        await readFile(
          join(dirname(getUserMcpConfigPath()), "mcp-apps.json"),
          "utf8",
        ),
      ),
    ).toEqual({ enabled: false });
    await expect(
      runMcpAppRequest(otherWorkspace, { action: "settings" }),
    ).resolves.toEqual({ enabled: false });
    await expect(
      captureMcpApp(
        otherWorkspace,
        serverId,
        "show_report",
        {},
        createResult(),
        false,
      ),
    ).resolves.toBeUndefined();
    for (const request of [{ action: "load", id }, callRequest(id)]) {
      await expect(runMcpAppRequest(workspaceRoot, request)).rejects.toThrow(
        "MCP Apps is disabled",
      );
    }
    expect(client.discoverServer).not.toHaveBeenCalled();
    expect(client.readResource).not.toHaveBeenCalled();
    expect(client.callTool).not.toHaveBeenCalled();

    await expect(
      runMcpAppRequest(otherWorkspace, {
        action: "set-enabled",
        enabled: true,
      }),
    ).resolves.toEqual({ enabled: true });
    await expect(
      runMcpAppRequest(workspaceRoot, { action: "load", id }),
    ).resolves.toMatchObject({ id, html });
  });

  it("loads a persisted invocation after module reload without leaking internal metadata", async () => {
    const args = { query: "workspace knowledge" };
    const result = createResult();
    const id = await captureMcpApp(
      workspaceRoot,
      serverId,
      "show_report",
      args,
      result,
      false,
    );
    expect(id).toEqual(expect.any(String));
    expect(result._meta["machdoch/toolUi"]).toEqual({ resourceUri: appUri });
    args.query = "changed after capture";
    result.structuredContent.total = 99;

    vi.resetModules();
    const reloaded = await import("./apps.ts");
    await expect(
      reloaded.runMcpAppRequest(workspaceRoot, { action: "load", id }),
    ).resolves.toEqual({
      id,
      title: "Research report",
      html,
      csp: {
        connectDomains: ["https://example.com"],
        resourceDomains: [],
        frameDomains: [],
        baseUriDomains: [],
      },
      arguments: { query: "workspace knowledge" },
      result: {
        content: [{ type: "text", text: "Two sources found." }],
        structuredContent: { total: 2 },
        _meta: { source: "research" },
      },
    });
    expect(client.discoverServer).toHaveBeenCalledWith(
      workspaceRoot,
      expect.objectContaining({ id: serverId }),
    );
    expect(client.readResource).toHaveBeenCalledExactlyOnceWith(
      workspaceRoot,
      serverId,
      appUri,
    );
    expect(client.callTool).not.toHaveBeenCalled();

    const otherWorkspace = join(temporaryRoot!, "other-workspace");
    await mkdir(otherWorkspace);
    await expect(
      reloaded.runMcpAppRequest(otherWorkspace, { action: "load", id }),
    ).rejects.toThrow("This interactive result is unavailable");
    expect(client.discoverServer).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "an error result", result: { ...createResult(), isError: true } },
    { label: "missing UI metadata", result: { content: [] } },
    {
      label: "an invalid resource URI",
      result: {
        _meta: { "machdoch/toolUi": { resourceUri: "https://example.com" } },
      },
    },
  ])("does not capture $label", async ({ result }) => {
    await expect(
      captureMcpApp(workspaceRoot, serverId, "show_report", {}, result, false),
    ).resolves.toBeUndefined();
    expect(client.discoverServer).not.toHaveBeenCalled();
  });
});

describe("MCP App authorization", () => {
  it.each([
    {
      label: "transport changes",
      override: {
        transport: {
          type: "streamable-http",
          url: "https://example.com/changed/mcp",
        },
      },
    },
    {
      label: "authentication changes",
      override: { auth: { type: "bearer", token: "fixture-token" } },
    },
    { label: "server disablement", override: { enabled: false } },
  ] satisfies { label: string; override: Partial<McpServerOverride> }[])(
    "rejects saved apps after $label before contacting the server",
    async ({ override }) => {
      const id = await capture();
      await writeConfig(override);
      for (const request of [{ action: "load", id }, callRequest(id)]) {
        await expect(runMcpAppRequest(workspaceRoot, request)).rejects.toThrow(
          "The MCP server configuration changed",
        );
      }
      expect(client.discoverServer).not.toHaveBeenCalled();
      expect(client.readResource).not.toHaveBeenCalled();
      expect(client.callTool).not.toHaveBeenCalled();
    },
  );

  it("rejects a saved app when the original tool changes its resource URI", async () => {
    const id = await capture();
    discovery.tools[0]!._meta = {
      ui: { resourceUri: "ui://reports/replacement" },
    };
    for (const request of [{ action: "load", id }, callRequest(id)]) {
      await expect(runMcpAppRequest(workspaceRoot, request)).rejects.toThrow(
        "This tool no longer exposes the saved app",
      );
    }
    expect(client.readResource).not.toHaveBeenCalled();
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it.each([
    { label: "app-only visibility", meta: { ui: { visibility: ["app"] } } },
    {
      label: "shared visibility",
      meta: { ui: { visibility: ["model", "app"] } },
    },
    { label: "default visibility", meta: {} },
  ])(
    "calls a confirmed tool with $label using authoritative discovery",
    async ({ meta }) => {
      const id = await capture();
      discovery.tools[1]!._meta = meta;
      await expect(
        runMcpAppRequest(workspaceRoot, callRequest(id)),
      ).resolves.toEqual({ content: [{ type: "text", text: "Updated." }] });
      expect(client.callTool).toHaveBeenCalledExactlyOnceWith(
        workspaceRoot,
        serverId,
        "update_report",
        { title: "Updated report" },
        { authoritativeDiscovery: discovery, caller: "app" },
      );
      expect(client.readResource).not.toHaveBeenCalled();
    },
  );

  it("rejects tools visible only to the model", async () => {
    const id = await capture();
    discovery.tools[1]!._meta = { ui: { visibility: ["model"] } };
    await expect(
      runMcpAppRequest(workspaceRoot, callRequest(id)),
    ).rejects.toThrow("This tool is not available to apps");
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("rejects tools absent from the current discovery", async () => {
    const id = await capture();
    discovery.tools.pop();
    await expect(
      runMcpAppRequest(workspaceRoot, callRequest(id)),
    ).rejects.toThrow("This tool is not available to apps");
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("honors tool disablement added after capture", async () => {
    const id = await capture();
    await writeConfig({ toolOverrides: { update_report: { enabled: false } } });
    await expect(
      runMcpAppRequest(workspaceRoot, callRequest(id)),
    ).rejects.toThrow("This tool is disabled");
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("rejects confirmed writes from an Ask-mode invocation", async () => {
    const id = await capture(true);
    await expect(
      runMcpAppRequest(workspaceRoot, callRequest(id)),
    ).rejects.toThrow("This conversation only permits read-only app tools");
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("allows an advertised read-only tool in Ask mode", async () => {
    const id = await capture(true);
    discovery.tools[1]!.annotations = { readOnlyHint: true };
    await expect(
      runMcpAppRequest(workspaceRoot, callRequest(id)),
    ).resolves.toEqual({ content: [{ type: "text", text: "Updated." }] });
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it("allows a tool explicitly configured as external-read in Ask mode", async () => {
    const id = await capture(true);
    await writeConfig({
      toolOverrides: { update_report: { effect: "external-read" } },
    });
    await expect(
      runMcpAppRequest(workspaceRoot, callRequest(id)),
    ).resolves.toEqual({ content: [{ type: "text", text: "Updated." }] });
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it.each(["write", "external-side-effect"] as const)(
    "rejects a %s override in Ask mode even when the server advertises readOnlyHint",
    async (effect) => {
      const id = await capture(true);
      discovery.tools[1]!.annotations = { readOnlyHint: true };
      await writeConfig({ toolOverrides: { update_report: { effect } } });
      await expect(
        runMcpAppRequest(workspaceRoot, callRequest(id)),
      ).rejects.toThrow("This conversation only permits read-only app tools");
      expect(client.callTool).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: "omitted", confirmation: {} },
    { label: "false", confirmation: { confirmed: false } },
    { label: "a string", confirmation: { confirmed: "true" } },
    { label: "a number", confirmation: { confirmed: 1 } },
    { label: "null", confirmation: { confirmed: null } },
  ])(
    "rejects confirmation that is $label before any server call",
    async ({ confirmation }) => {
      const id = await capture();
      await expect(
        runMcpAppRequest(workspaceRoot, {
          action: "call-tool",
          id,
          name: "update_report",
          arguments: {},
          ...confirmation,
        }),
      ).rejects.toMatchObject({
        name: "ZodError",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ["confirmed"] }),
        ]),
      });
      expect(client.discoverServer).not.toHaveBeenCalled();
      expect(client.readResource).not.toHaveBeenCalled();
      expect(client.callTool).not.toHaveBeenCalled();
    },
  );
});

describe("MCP App HTML resources", () => {
  it.each([
    { label: "missing HTML", contents: [] },
    {
      label: "a different URI",
      contents: [
        { uri: "ui://reports/other", mimeType: mcpAppMimeType, text: html },
      ],
    },
    {
      label: "an incorrect MIME type",
      contents: [{ uri: appUri, mimeType: "text/html", text: html }],
    },
  ])("rejects $label", async ({ contents }) => {
    const id = await capture();
    client.readResource.mockResolvedValue({ contents });
    await expect(
      runMcpAppRequest(workspaceRoot, { action: "load", id }),
    ).rejects.toThrow("The MCP App must provide an HTML resource");
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("loads base64-encoded HTML resources", async () => {
    const id = await capture();
    client.readResource.mockResolvedValue({
      contents: [
        {
          uri: appUri,
          mimeType: mcpAppMimeType,
          blob: Buffer.from(html).toString("base64"),
        },
      ],
    });
    await expect(
      runMcpAppRequest(workspaceRoot, { action: "load", id }),
    ).resolves.toMatchObject({ html });
  });

  it.each([
    { label: "ASCII", text: "x".repeat(2 * 1024 * 1024 + 1) },
    { label: "multibyte UTF-8", text: "é".repeat(1024 * 1024 + 1) },
  ])("rejects $label HTML exceeding 2 MiB in bytes", async ({ text }) => {
    const id = await capture();
    client.readResource.mockResolvedValue({
      contents: [{ uri: appUri, mimeType: mcpAppMimeType, text }],
    });
    await expect(
      runMcpAppRequest(workspaceRoot, { action: "load", id }),
    ).rejects.toThrow("The MCP App must provide HTML smaller than 2 MiB");
    expect(client.callTool).not.toHaveBeenCalled();
  });
});
