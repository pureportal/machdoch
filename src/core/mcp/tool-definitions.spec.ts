import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import {
  createMcpDirectToolMappings,
  createMcpDirectToolName,
  createMcpToolDefinitions,
} from "./tool-definitions.ts";
import { mcpClientManager } from "./client.ts";
import type { McpEffectiveConfig, McpServerDiscovery } from "./types.ts";

const workspacesToClean: string[] = [];
const originalUserConfigDir = process.env.MACHDOCH_USER_CONFIG_DIR;

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-mcp-tools-"));
  workspacesToClean.push(workspaceRoot);
  process.env.MACHDOCH_USER_CONFIG_DIR = join(workspaceRoot, ".user-config");
  return workspaceRoot;
};

const writeDiscoveryCache = async (
  workspaceRoot: string,
  discoveries: Record<string, McpServerDiscovery>,
): Promise<void> => {
  const cacheDirectory = join(workspaceRoot, ".machdoch", "mcp");

  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(
    join(cacheDirectory, "discovery-cache.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        servers: discoveries,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
};

const writeWorkspaceMcpConfig = async (workspaceRoot: string): Promise<void> => {
  const configDirectory = join(workspaceRoot, ".machdoch", "mcp");

  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    join(configDirectory, "mcp.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        servers: [
          {
            id: "github",
            enabled: true,
            transport: {
              type: "streamable-http",
              url: "https://api.githubcopilot.com/mcp/",
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
};

afterEach(async () => {
  vi.restoreAllMocks();

  if (originalUserConfigDir === undefined) {
    delete process.env.MACHDOCH_USER_CONFIG_DIR;
  } else {
    process.env.MACHDOCH_USER_CONFIG_DIR = originalUserConfigDir;
  }

  await Promise.all(
    workspacesToClean
      .splice(0)
      .map((workspaceRoot) =>
        rm(workspaceRoot, { recursive: true, force: true }),
      ),
  );
});

const createConfig = (): McpEffectiveConfig => ({
  defaults: {
    enabled: true,
    securityProfile: "weak",
    exposure: "hybrid",
    directTools: true,
    timeoutMs: 60_000,
    maxTotalTimeoutMs: 300_000,
    idleShutdownMs: 900_000,
    maxResponseChars: 60_000,
    cache: {
      enabled: true,
      ttlMs: 900_000,
      forceRefresh: false,
    },
    roots: "workspace",
    sampling: "disabled",
    tasks: "optional",
    elicitation: "disabled",
  },
  userConfigPath: "C:/config/mcp.json",
  workspaceConfigPath: "C:/workspace/.machdoch/mcp/mcp.json",
  userDiscoveryCachePath: "C:/config/mcp-discovery-cache.json",
  workspaceDiscoveryCachePath: "C:/workspace/.machdoch/mcp/discovery-cache.json",
  servers: [
    {
      id: "github",
      title: "GitHub",
      enabled: true,
      transport: {
        type: "streamable-http",
        url: "https://api.githubcopilot.com/mcp/",
      },
      exposure: {
        mode: "hybrid",
        directTools: true,
      },
      securityProfile: "weak",
      timeoutMs: 60_000,
      maxTotalTimeoutMs: 300_000,
      idleShutdownMs: 900_000,
      maxResponseChars: 60_000,
      cache: {
        enabled: true,
        ttlMs: 900_000,
        forceRefresh: false,
      },
      roots: "workspace",
      sampling: "disabled",
      tasks: "optional",
      sources: ["workspace"],
    },
  ],
});

const discovery: Record<string, McpServerDiscovery> = {
  github: {
    serverId: "github",
    discoveredAt: "2026-06-13T00:00:00.000Z",
    transportType: "streamable-http",
    tools: [
      {
        name: "search_repositories",
        description: "Search repositories.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
            },
          },
          required: ["query"],
        },
        annotations: {
          readOnlyHint: true,
          openWorldHint: true,
        },
      },
      {
        name: "create_issue",
        description: "Create an issue.",
        inputSchema: {
          type: "object",
        },
        annotations: {
          destructiveHint: true,
        },
      },
    ],
    resources: [
      {
        uri: "repo://machdoch/readme",
        name: "README",
        mimeType: "text/markdown",
      },
    ],
    resourceTemplates: [
      {
        uriTemplate: "repo://machdoch/{path}",
        name: "Repository file",
        mimeType: "text/plain",
      },
    ],
    prompts: [
      {
        name: "summarize_issue",
        description: "Summarize a GitHub issue.",
        arguments: [
          {
            name: "issue_number",
            required: true,
          },
        ],
      },
    ],
  },
};

const createExecutionContext = (workspaceRoot: string) => ({
  workspaceRoot,
  memory: {
    sessionEnabled: false,
    sessionEntries: [],
    globalEnabled: false,
    globalEntries: [],
  },
});

describe("createMcpDirectToolName", () => {
  it("creates stable model-safe direct tool names", () => {
    const name = createMcpDirectToolName(
      "github-enterprise",
      "Pull Requests: Create Review With A Very Long Name That Needs Hashing",
    );

    expect(name).toMatch(/^mcp__github_enterprise__/u);
    expect(name.length).toBeLessThanOrEqual(64);
  });
});

describe("createMcpDirectToolMappings", () => {
  it("classifies read-only and destructive discovered tools", () => {
    expect(createMcpDirectToolMappings(createConfig(), discovery)).toEqual([
      expect.objectContaining({
        exposedName: "mcp__github__search_repositories",
        remoteName: "search_repositories",
        effect: "external-read",
        riskLevel: "medium",
        readOnlyInAskMode: true,
      }),
      expect.objectContaining({
        exposedName: "mcp__github__create_issue",
        remoteName: "create_issue",
        effect: "external-side-effect",
        riskLevel: "high",
        readOnlyInAskMode: false,
      }),
    ]);
  });
});

describe("createMcpToolDefinitions", () => {
  it("exposes cached catalog navigation meta-tools", async () => {
    const workspaceRoot = await createWorkspace();
    const context = createExecutionContext(workspaceRoot);

    await writeWorkspaceMcpConfig(workspaceRoot);
    await writeDiscoveryCache(workspaceRoot, discovery);

    const definitions = createMcpToolDefinitions(workspaceRoot);
    const searchTool = definitions.find(
      (definition) => definition.spec.name === "mcp_search_tools",
    );
    const inspectTool = definitions.find(
      (definition) => definition.spec.name === "mcp_inspect_tool",
    );
    const resourcesTool = definitions.find(
      (definition) => definition.spec.name === "mcp_list_resources",
    );
    const promptsTool = definitions.find(
      (definition) => definition.spec.name === "mcp_list_prompts",
    );

    if (!searchTool || !inspectTool || !resourcesTool || !promptsTool) {
      throw new Error("Expected MCP catalog meta-tools to be registered.");
    }

    const searchResult = await searchTool.execute(
      { query: "issue" },
      context,
    );
    const inspectResult = await inspectTool.execute(
      { serverId: "github", toolName: "create_issue" },
      context,
    );
    const resourcesResult = await resourcesTool.execute(
      { serverId: "github" },
      context,
    );
    const promptsResult = await promptsTool.execute(
      { serverId: "github" },
      context,
    );

    expect(JSON.parse(searchResult.toolResult.output)).toMatchObject({
      count: 1,
      tools: [
        {
          serverId: "github",
          name: "create_issue",
          inputSchema: {
            type: "object",
          },
          inputSchemaHash: expect.stringMatching(/^sha256:/u),
          definitionHash: expect.stringMatching(/^sha256:/u),
        },
      ],
    });
    expect(JSON.parse(inspectResult.toolResult.output)).toMatchObject({
      found: true,
      tool: { name: "create_issue" },
      directTool: {
        inputSchemaHash: expect.stringMatching(/^sha256:/u),
        definitionHash: expect.stringMatching(/^sha256:/u),
      },
    });
    expect(JSON.parse(resourcesResult.toolResult.output)).toMatchObject({
      count: 2,
      resources: [
        { type: "resource", uri: "repo://machdoch/readme" },
        { type: "resource_template", uriTemplate: "repo://machdoch/{path}" },
      ],
    });
    expect(JSON.parse(promptsResult.toolResult.output)).toMatchObject({
      count: 1,
      prompts: [{ name: "summarize_issue" }],
    });
  });

  it("exposes the generic MCP call with non-strict object arguments", async () => {
    const workspaceRoot = await createWorkspace();

    const mcpCallTool = createMcpToolDefinitions(workspaceRoot).find(
      (definition) => definition.spec.name === "mcp_call_tool",
    );

    expect(mcpCallTool?.spec).toMatchObject({
      strict: false,
      inputSchema: {
        required: ["serverId", "toolName", "arguments"],
        properties: {
          arguments: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
    });
  });

  it("rejects invalid Linear get_issue arguments before remote MCP dispatch", async () => {
    const workspaceRoot = await createWorkspace();
    const context = createExecutionContext(workspaceRoot);
    const callToolSpy = vi.spyOn(mcpClientManager, "callTool");
    const mcpCallTool = createMcpToolDefinitions(workspaceRoot).find(
      (definition) => definition.spec.name === "mcp_call_tool",
    );

    if (!mcpCallTool) {
      throw new Error("Expected mcp_call_tool to be registered.");
    }

    const nullArgumentsResult = await mcpCallTool.execute(
      {
        serverId: "linear",
        toolName: "get_issue",
        arguments: null,
      },
      context,
    );
    const missingIdResult = await mcpCallTool.execute(
      {
        serverId: "linear",
        toolName: "get_issue",
        arguments: {},
      },
      context,
    );

    expect(nullArgumentsResult.toolResult).toMatchObject({
      isError: true,
    });
    expect(nullArgumentsResult.toolResult.output).toContain(
      "Expected `arguments` to be a JSON object",
    );
    expect(missingIdResult.toolResult).toMatchObject({
      isError: true,
    });
    expect(missingIdResult.toolResult.output).toContain(
      "requires `arguments.id`",
    );
    expect(callToolSpy).not.toHaveBeenCalled();
  });

  it("includes live discovery input schemas in capability summaries", async () => {
    const workspaceRoot = await createWorkspace();
    const context = createExecutionContext(workspaceRoot);
    const discoverSpy = vi
      .spyOn(mcpClientManager, "discoverServerById")
      .mockResolvedValue({
        discovery: {
          serverId: "linear",
          discoveredAt: "2026-07-03T00:00:00.000Z",
          transportType: "streamable-http",
          tools: [
            {
              name: "get_issue",
              description: "Get a Linear issue.",
              inputSchema: {
                type: "object",
                required: ["id"],
                properties: {
                  id: {
                    type: "string",
                  },
                },
              },
            },
          ],
          resources: [],
          resourceTemplates: [],
          prompts: [],
        },
      });
    const discoverTool = createMcpToolDefinitions(workspaceRoot).find(
      (definition) => definition.spec.name === "mcp_discover_capabilities",
    );

    if (!discoverTool) {
      throw new Error("Expected mcp_discover_capabilities to be registered.");
    }

    const result = await discoverTool.execute({ serverId: "linear" }, context);

    expect(discoverSpy).toHaveBeenCalledWith(
      workspaceRoot,
      "linear",
      expect.anything(),
    );
    expect(result.toolResult.output).toContain("- get_issue");
    expect(result.toolResult.output).toContain("inputSchema");
    expect(result.toolResult.output).toContain('"id"');
  });
});
