import {
  listEnabledMcpServers,
  loadMcpConfig,
  loadMcpDiscoveryCacheSync,
} from "../../core/mcp/config.js";
import { mcpClientManager } from "../../core/mcp/client.js";
import {
  printMcpLifecycleCleanup,
  printMcpLifecycleUsage,
  recordMcpLifecycleHook,
} from "./cli-mcp-lifecycle-commands.js";
import type {
  McpDiscoveryChangeSet,
  McpDiscoveredPrompt,
  McpDiscoveredResource,
  McpDiscoveredResourceTemplate,
  McpDiscoveredTool,
  McpEffectiveConfig,
  McpServerDiscovery,
} from "../../core/mcp/types.js";
import type { McpCliOptions, ParsedCliArgs } from "./cli-args.js";
import { writeStdoutLine } from "./cli-io.js";

const fail = (message: string): never => {
  throw new Error(message);
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const printJson = (value: unknown): void => {
  writeStdoutLine(JSON.stringify(value, null, 2));
};

const parseJsonObject = (
  value: string | undefined,
  flagName: string,
): Record<string, unknown> => {
  if (!value) {
    return {};
  }

  const parsed = JSON.parse(value) as unknown;

  if (!isRecord(parsed)) {
    fail(`Expected ${flagName} to be a JSON object.`);
  }

  return parsed as Record<string, unknown>;
};

const parseStringRecord = (
  value: string | undefined,
  flagName: string,
): Record<string, string> => {
  const parsed = parseJsonObject(value, flagName);

  const entries: Array<readonly [string, string]> = [];

  for (const [key, entry] of Object.entries(parsed)) {
    const normalizedEntry =
      typeof entry === "string"
        ? entry
        : fail(`Expected ${flagName} values to be strings.`);

    entries.push([key, normalizedEntry]);
  }

  return Object.fromEntries(entries);
};

const summarizeServers = (
  config: McpEffectiveConfig,
  includeDisabled: boolean,
): Record<string, unknown> => {
  const servers = includeDisabled
    ? config.servers
    : listEnabledMcpServers(config);

  return {
    defaults: config.defaults,
    paths: {
      userConfigPath: config.userConfigPath,
      workspaceConfigPath: config.workspaceConfigPath,
      userDiscoveryCachePath: config.userDiscoveryCachePath,
      workspaceDiscoveryCachePath: config.workspaceDiscoveryCachePath,
    },
    servers: servers.map((server) => ({
      id: server.id,
      title: server.title ?? server.id,
      description: server.description ?? null,
      enabled: server.enabled,
      preset: server.preset ?? null,
      transport: server.transport.type,
      exposure: server.exposure ?? null,
      securityProfile: server.securityProfile,
      sources: server.sources,
    })),
  };
};

const summarizeDiscovery = (
  discovery: McpServerDiscovery,
): Record<string, unknown> => {
  return {
    serverId: discovery.serverId,
    discoveredAt: discovery.discoveredAt,
    protocolVersion: discovery.protocolVersion ?? null,
    serverVersion: discovery.serverVersion ?? null,
    instructions: discovery.instructions ?? null,
    transportType: discovery.transportType,
    capabilities: discovery.capabilities ?? null,
    capabilitiesHash: discovery.capabilitiesHash ?? null,
    catalogHash: discovery.catalogHash ?? null,
    toolCatalogHash: discovery.toolCatalogHash ?? null,
    resourceCatalogHash: discovery.resourceCatalogHash ?? null,
    promptCatalogHash: discovery.promptCatalogHash ?? null,
    tools: discovery.tools,
    resources: discovery.resources,
    resourceTemplates: discovery.resourceTemplates,
    prompts: discovery.prompts,
  };
};

const summarizeDiscoveryCache = (
  config: McpEffectiveConfig,
  workspaceRoot: string,
): Record<string, unknown> => {
  const cache = loadMcpDiscoveryCacheSync(workspaceRoot);

  return {
    cachePath: config.workspaceDiscoveryCachePath,
    servers: Object.fromEntries(
      Object.entries(cache.servers).map(([serverId, discovery]) => [
        serverId,
        {
          discoveredAt: discovery.discoveredAt,
          protocolVersion: discovery.protocolVersion ?? null,
          transportType: discovery.transportType,
          capabilitiesHash: discovery.capabilitiesHash ?? null,
          catalogHash: discovery.catalogHash ?? null,
          toolCatalogHash: discovery.toolCatalogHash ?? null,
          resourceCatalogHash: discovery.resourceCatalogHash ?? null,
          promptCatalogHash: discovery.promptCatalogHash ?? null,
          tools: discovery.tools.map((tool) => tool.name),
          resources: discovery.resources.map((resource) => resource.uri),
          resourceTemplates: discovery.resourceTemplates.map(
            (template) => template.uriTemplate,
          ),
          prompts: discovery.prompts.map((prompt) => prompt.name),
        },
      ]),
    ),
  };
};

const printServerLines = (
  config: McpEffectiveConfig,
  includeDisabled: boolean,
): void => {
  const summary = summarizeServers(config, includeDisabled);
  const servers = summary.servers as Array<Record<string, unknown>>;

  writeStdoutLine(`mcp servers: ${servers.length}`);
  writeStdoutLine(`user config: ${config.userConfigPath}`);
  writeStdoutLine(`workspace config: ${config.workspaceConfigPath}`);
  writeStdoutLine(`discovery cache: ${config.workspaceDiscoveryCachePath}`);

  for (const server of servers) {
    writeStdoutLine(
      `- ${String(server.id)} ${server.enabled ? "enabled" : "disabled"} ${String(server.transport)} sources=${(server.sources as string[]).join(",")}`,
    );
  }
};

const printDiscoveryLines = (
  discovery: McpServerDiscovery,
  cachePath?: string,
  changes?: McpDiscoveryChangeSet,
): void => {
  writeStdoutLine(`mcp discovery: ${discovery.serverId}`);
  writeStdoutLine(`transport: ${discovery.transportType}`);
  if (discovery.protocolVersion) {
    writeStdoutLine(`protocol: ${discovery.protocolVersion}`);
  }
  if (discovery.catalogHash) {
    writeStdoutLine(`catalog hash: ${discovery.catalogHash}`);
  }
  writeStdoutLine(`tools: ${discovery.tools.length}`);
  writeStdoutLine(`resources: ${discovery.resources.length}`);
  writeStdoutLine(`resource templates: ${discovery.resourceTemplates.length}`);
  writeStdoutLine(`prompts: ${discovery.prompts.length}`);

  if (cachePath) {
    writeStdoutLine(`cache: ${cachePath}`);
  }

  if (changes) {
    writeStdoutLine(
      `changes: ${changes.changed ? changes.changes.length : 0}${changes.previousCatalogHash ? ` from ${changes.previousCatalogHash}` : ""} to ${changes.nextCatalogHash}`,
    );

    for (const change of changes.changes.slice(0, 50)) {
      writeStdoutLine(
        `- ${change.category}:${change.name} ${change.type}${change.previousHash ? ` previous=${change.previousHash}` : ""}${change.nextHash ? ` next=${change.nextHash}` : ""}`,
      );
    }
  }

  const printNamed = <T extends { name?: string; uri?: string; uriTemplate?: string }>(
    label: string,
    values: T[],
    selector: (value: T) => string,
  ): void => {
    if (values.length === 0) {
      return;
    }

    writeStdoutLine(`${label}:`);
    for (const value of values.slice(0, 50)) {
      writeStdoutLine(`- ${selector(value)}`);
    }
  };

  printNamed<McpDiscoveredTool>("tools", discovery.tools, (tool) => tool.name);
  printNamed<McpDiscoveredResource>(
    "resources",
    discovery.resources,
    (resource) => resource.uri,
  );
  printNamed<McpDiscoveredResourceTemplate>(
    "resource templates",
    discovery.resourceTemplates,
    (template) => template.uriTemplate,
  );
  printNamed<McpDiscoveredPrompt>(
    "prompts",
    discovery.prompts,
    (prompt) => prompt.name,
  );
};

const printCacheLines = (config: McpEffectiveConfig, workspaceRoot: string): void => {
  const cache = loadMcpDiscoveryCacheSync(workspaceRoot);
  const discoveries = Object.values(cache.servers);

  writeStdoutLine(`mcp cache: ${discoveries.length}`);
  writeStdoutLine(`path: ${config.workspaceDiscoveryCachePath}`);

  for (const discovery of discoveries) {
    writeStdoutLine(
      `- ${discovery.serverId} tools=${discovery.tools.length} resources=${discovery.resources.length} prompts=${discovery.prompts.length}${discovery.catalogHash ? ` catalog=${discovery.catalogHash}` : ""}`,
    );
  }
};

const printUnknownResult = (label: string, result: unknown): void => {
  writeStdoutLine(`${label}:`);
  writeStdoutLine(JSON.stringify(result, null, 2));
};

export const printMcpSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const options: McpCliOptions = args.mcp ?? fail("No MCP action was provided.");

  try {
    switch (options.action) {
      case "servers": {
        const config = await loadMcpConfig(args.workspaceRoot);

        if (args.json) {
          printJson({
            workspaceRoot: args.workspaceRoot,
            ...summarizeServers(config, options.includeDisabled ?? false),
          });
          return;
        }

        printServerLines(config, options.includeDisabled ?? false);
        return;
      }
      case "cache": {
        const config = await loadMcpConfig(args.workspaceRoot);

        if (args.json) {
          printJson({
            workspaceRoot: args.workspaceRoot,
            ...summarizeDiscoveryCache(config, args.workspaceRoot),
          });
          return;
        }

        printCacheLines(config, args.workspaceRoot);
        return;
      }
      case "usage": {
        await printMcpLifecycleUsage(args);
        return;
      }
      case "lifecycle-hook": {
        await recordMcpLifecycleHook(args, options);
        return;
      }
      case "cleanup": {
        await printMcpLifecycleCleanup(args, options);
        return;
      }
      case "discover":
      case "refresh": {
        const serverId = options.serverId ??
          fail(`Expected a server id after \`machdoch mcp ${options.action}\`.`);
        const result = await mcpClientManager.discoverServerById(
          args.workspaceRoot,
          serverId,
          { persist: options.action === "refresh" },
        );

        if (args.json) {
          printJson({
            workspaceRoot: args.workspaceRoot,
            discovery: summarizeDiscovery(result.discovery),
            cachePath: result.cachePath ?? null,
            changes: result.changes ?? null,
          });
          return;
        }

        printDiscoveryLines(result.discovery, result.cachePath, result.changes);
        return;
      }
      case "oauth-start": {
        const serverId = options.serverId ??
          fail("Expected a server id after `machdoch mcp oauth-start`.");
        const result = await mcpClientManager.beginOAuth(args.workspaceRoot, serverId);

        if (args.json) {
          printJson({ workspaceRoot: args.workspaceRoot, result });
          return;
        }

        writeStdoutLine(`mcp oauth: ${result.serverId} ${result.status}`);
        writeStdoutLine(`path: ${result.configPath}`);

        if (result.authorizationUrl) {
          writeStdoutLine(`authorizationUrl: ${result.authorizationUrl}`);
        }

        return;
      }
      case "oauth-finish": {
        const serverId = options.serverId ??
          fail("Expected a server id after `machdoch mcp oauth-finish`.");
        const authorizationResponse = options.target ??
          fail("Expected a callback URL or code after `machdoch mcp oauth-finish <server-id>`.");
        const result = await mcpClientManager.finishOAuth(
          args.workspaceRoot,
          serverId,
          authorizationResponse,
        );

        if (args.json) {
          printJson({ workspaceRoot: args.workspaceRoot, result });
          return;
        }

        writeStdoutLine(`mcp oauth: ${result.serverId} ${result.status}`);
        writeStdoutLine(`path: ${result.configPath}`);

        if (result.stateVerified !== undefined) {
          writeStdoutLine(`stateVerified: ${result.stateVerified}`);
        }

        return;
      }
      case "call-tool": {
        const serverId = options.serverId ??
          fail("Expected a server id after `machdoch mcp call-tool`.");
        const toolName = options.target ??
          fail("Expected a tool name after `machdoch mcp call-tool <server-id>`.");
        const result = await mcpClientManager.callTool(
          args.workspaceRoot,
          serverId,
          toolName,
          parseJsonObject(options.argumentsJson, "--arguments-json"),
        );

        if (args.json) {
          printJson({ workspaceRoot: args.workspaceRoot, result });
          return;
        }

        printUnknownResult("mcp tool result", result);
        return;
      }
      case "read-resource": {
        const serverId = options.serverId ??
          fail("Expected a server id after `machdoch mcp read-resource`.");
        const uri = options.target ??
          fail("Expected a URI after `machdoch mcp read-resource <server-id>`.");
        const result = await mcpClientManager.readResource(
          args.workspaceRoot,
          serverId,
          uri,
        );

        if (args.json) {
          printJson({ workspaceRoot: args.workspaceRoot, result });
          return;
        }

        printUnknownResult("mcp resource", result);
        return;
      }
      case "get-prompt": {
        const serverId = options.serverId ??
          fail("Expected a server id after `machdoch mcp get-prompt`.");
        const promptName = options.target ??
          fail("Expected a prompt name after `machdoch mcp get-prompt <server-id>`.");
        const result = await mcpClientManager.getPrompt(
          args.workspaceRoot,
          serverId,
          promptName,
          parseStringRecord(options.argumentsJson, "--arguments-json"),
        );

        if (args.json) {
          printJson({ workspaceRoot: args.workspaceRoot, result });
          return;
        }

        printUnknownResult("mcp prompt", result);
        return;
      }
    }
  } finally {
    await mcpClientManager.closeAll();
  }
};
