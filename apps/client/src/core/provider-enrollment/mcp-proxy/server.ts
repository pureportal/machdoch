import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CancelTaskRequestSchema,
  GetPromptRequestSchema,
  GetTaskPayloadRequestSchema,
  GetTaskRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ListTasksRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mcpClientManager } from "../../mcp/client.js";
import { mapWithConcurrencyLimit } from "../../_helpers/task-file-change-concurrency.js";
import { runManagedStdioServer } from "../stdio-server-lifecycle.js";
import {
  listEnabledMcpServers,
  loadMcpConfig,
  loadUserMcpConfig,
} from "../../mcp/config.js";
import type {
  McpEffectiveServerConfig,
  McpOperationOptions,
  McpServerDiscovery,
} from "../../mcp/types.js";
import { sha256 } from "../digests.js";
import {
  getMcpToolProjectionPrefix,
  isMcpToolEnabledForProjection,
} from "../mcp-tool-exposure.js";

interface ProxyCatalogEntry {
  serverId: string;
  config: McpEffectiveServerConfig;
  discovery: McpServerDiscovery;
}

const TOOL_SEPARATOR = "__";
const RESOURCE_PREFIX = "machdoch-proxy://";
const MAX_EXPOSED_NAME_LENGTH = 40;

const sanitizeName = (value: string): string =>
  value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "") || "entity";

export const createProxyExposedName = (
  serverId: string,
  name: string,
  aggregate: boolean,
): string => {
  const rawBase = aggregate ? `${serverId}${TOOL_SEPARATOR}${name}` : name;
  const base = aggregate
    ? `${sanitizeName(serverId)}${TOOL_SEPARATOR}${sanitizeName(name)}`
    : sanitizeName(name);
  if (
    !aggregate &&
    base === rawBase &&
    base.length <= MAX_EXPOSED_NAME_LENGTH
  ) {
    return base;
  }
  const suffix = sha256(`${serverId}\u0000${name}`).slice(0, 10);
  return `${base.slice(0, MAX_EXPOSED_NAME_LENGTH - suffix.length - 1).replace(/_+$/u, "")}_${suffix}`;
};

const getExposedToolName = (
  entry: ProxyCatalogEntry,
  toolName: string,
  aggregate: boolean,
): string => {
  const prefix = getMcpToolProjectionPrefix(entry.config);
  return createProxyExposedName(
    entry.serverId,
    prefix ? `${prefix}${TOOL_SEPARATOR}${toolName}` : toolName,
    aggregate,
  );
};

const parseNamespacedName = (
  value: string,
  entries: readonly ProxyCatalogEntry[],
  names: (entry: ProxyCatalogEntry) => readonly string[],
  expose: (
    entry: ProxyCatalogEntry,
    name: string,
    aggregate: boolean,
  ) => string = (entry, name, aggregate) =>
    createProxyExposedName(entry.serverId, name, aggregate),
): { serverId: string; name: string } => {
  const aggregate = entries.length > 1;
  for (const entry of entries) {
    const matchedName = names(entry).find(
      (name) => expose(entry, name, aggregate) === value,
    );
    if (matchedName) return { serverId: entry.serverId, name: matchedName };
  }
  throw new Error(`Unknown Machdoch proxy entity name: ${value}.`);
};

const namespaceResourceUri = (
  serverId: string,
  uri: string,
  aggregate: boolean,
): string => {
  if (!aggregate) return uri;
  return `${RESOURCE_PREFIX}${encodeURIComponent(serverId)}/${encodeURIComponent(uri)}`;
};

const namespaceResourceTemplateUri = (
  serverId: string,
  uriTemplate: string,
  aggregate: boolean,
): string => {
  if (!aggregate) return uriTemplate;
  const encodedTemplate = encodeURIComponent(uriTemplate)
    .replaceAll("%7B", "{")
    .replaceAll("%7D", "}");
  return `${RESOURCE_PREFIX}${encodeURIComponent(serverId)}/${encodedTemplate}`;
};

const parseResourceUri = (
  uri: string,
  entries: readonly ProxyCatalogEntry[],
): { serverId: string; uri: string } => {
  if (entries.length === 1) {
    return { serverId: entries[0]?.serverId ?? "", uri };
  }
  if (!uri.startsWith(RESOURCE_PREFIX)) {
    throw new Error("Expected a Machdoch aggregate resource URI.");
  }
  const [encodedServerId, ...encodedUriParts] = uri
    .slice(RESOURCE_PREFIX.length)
    .split("/");
  if (!encodedServerId || encodedUriParts.length === 0) {
    throw new Error("Malformed Machdoch aggregate resource URI.");
  }
  return {
    serverId: decodeURIComponent(encodedServerId),
    uri: decodeURIComponent(encodedUriParts.join("/")),
  };
};

const loadCatalog = async (
  workspaceRoot: string,
  serverId?: string,
  scope?: "user",
  signal?: AbortSignal,
): Promise<ProxyCatalogEntry[]> => {
  const config =
    scope === "user"
      ? await loadUserMcpConfig()
      : await loadMcpConfig(workspaceRoot);
  const servers = listEnabledMcpServers(config).filter(
    (server) => !serverId || server.id === serverId,
  );
  if (servers.length === 0) {
    throw new Error(
      serverId
        ? `MCP server \`${serverId}\` is not configured or enabled.`
        : "No enabled MCP servers are configured.",
    );
  }
  let failure: { error: unknown } | undefined;
  let closingAfterFailure: Promise<void> | undefined;
  return await mapWithConcurrencyLimit(servers, 4, async (server) => {
    signal?.throwIfAborted();
    if (failure) throw failure.error;
    try {
      return {
        serverId: server.id,
        config: server,
        discovery: await mcpClientManager.discoverServer(workspaceRoot, server),
      };
    } catch (error) {
      failure ??= { error };
      // A failed aggregate startup cannot serve requests. Cancel other active
      // handshakes now rather than waiting for every server's timeout.
      closingAfterFailure ??= mcpClientManager.closeAll();
      await closingAfterFailure;
      throw failure.error;
    }
  });
};

const createOperationOptions = (
  entry: ProxyCatalogEntry,
): McpOperationOptions => ({
  effectiveServer: entry.config,
  authoritativeDiscovery: entry.discovery,
});

const getCatalogEntry = (
  entries: readonly ProxyCatalogEntry[],
  serverId: string,
): ProxyCatalogEntry => {
  const entry = entries.find((candidate) => candidate.serverId === serverId);
  if (!entry) throw new Error(`Unknown Machdoch proxy server: ${serverId}.`);
  return entry;
};

const registerHandlers = (
  server: Server,
  workspaceRoot: string,
  entries: readonly ProxyCatalogEntry[],
): void => {
  const aggregate = entries.length > 1;
  const taskTargets = new Map<string, { serverId: string; name: string }>();
  const taskEntries = entries.filter(
    (entry) =>
      entry.config.tasks !== "disabled" &&
      entry.discovery.capabilities &&
      "tasks" in entry.discovery.capabilities,
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: entries.flatMap((entry) =>
      entry.discovery.tools
        .filter((tool) =>
          isMcpToolEnabledForProjection(entry.config, tool.name),
        )
        .map((tool) => ({
          name: getExposedToolName(entry, tool.name, aggregate),
          ...(entry.config.toolOverrides?.[tool.name]?.title || tool.title
            ? {
                title:
                  entry.config.toolOverrides?.[tool.name]?.title ?? tool.title,
              }
            : {}),
          ...(entry.config.toolOverrides?.[tool.name]?.description ||
          tool.description
            ? {
                description:
                  entry.config.toolOverrides?.[tool.name]?.description ??
                  tool.description,
              }
            : {}),
          inputSchema: tool.inputSchema,
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        })),
    ),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const target = parseNamespacedName(
      request.params.name,
      entries,
      (entry) =>
        entry.discovery.tools
          .filter((tool) =>
            isMcpToolEnabledForProjection(entry.config, tool.name),
          )
          .map((tool) => tool.name),
      getExposedToolName,
    );
    return await mcpClientManager.callTool(
      workspaceRoot,
      target.serverId,
      target.name,
      request.params.arguments ?? {},
      createOperationOptions(getCatalogEntry(entries, target.serverId)),
    );
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: entries.flatMap((entry) =>
      entry.discovery.resources.map((resource) => ({
        ...resource,
        uri: namespaceResourceUri(entry.serverId, resource.uri, aggregate),
        name: createProxyExposedName(entry.serverId, resource.name, aggregate),
      })),
    ),
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: entries.flatMap((entry) =>
      entry.discovery.resourceTemplates.map((template) => ({
        ...template,
        uriTemplate: namespaceResourceTemplateUri(
          entry.serverId,
          template.uriTemplate,
          aggregate,
        ),
        name: createProxyExposedName(entry.serverId, template.name, aggregate),
      })),
    ),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const target = parseResourceUri(request.params.uri, entries);
    return await mcpClientManager.readResource(
      workspaceRoot,
      target.serverId,
      target.uri,
      createOperationOptions(getCatalogEntry(entries, target.serverId)),
    );
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: entries.flatMap((entry) =>
      entry.discovery.prompts.map((prompt) => ({
        ...prompt,
        name: createProxyExposedName(entry.serverId, prompt.name, aggregate),
      })),
    ),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const target = parseNamespacedName(request.params.name, entries, (entry) =>
      entry.discovery.prompts.map((prompt) => prompt.name),
    );
    return await mcpClientManager.getPrompt(
      workspaceRoot,
      target.serverId,
      target.name,
      request.params.arguments ?? {},
      createOperationOptions(getCatalogEntry(entries, target.serverId)),
    );
  });

  if (taskEntries.length > 0) {
    server.setRequestHandler(ListTasksRequestSchema, async () => {
      const results = await Promise.all(
        taskEntries.map(async (entry) => ({
          serverId: entry.serverId,
          result: await mcpClientManager.listTasks(
            workspaceRoot,
            entry.serverId,
            undefined,
            createOperationOptions(entry),
          ),
        })),
      );
      return {
        tasks: results.flatMap(({ serverId, result }) =>
          result.tasks.map((task) => {
            const taskId = createProxyExposedName(
              serverId,
              task.taskId,
              aggregate,
            );
            taskTargets.set(taskId, { serverId, name: task.taskId });
            return { ...task, taskId };
          }),
        ),
      };
    });
    server.setRequestHandler(GetTaskRequestSchema, async (request) => {
      const target = taskTargets.get(request.params.taskId);
      if (!target)
        throw new Error(
          `Unknown Machdoch proxy task: ${request.params.taskId}.`,
        );
      const result = await mcpClientManager.getTask(
        workspaceRoot,
        target.serverId,
        target.name,
        createOperationOptions(getCatalogEntry(taskEntries, target.serverId)),
      );
      return {
        ...result,
        taskId: createProxyExposedName(
          target.serverId,
          result.taskId,
          aggregate,
        ),
      };
    });
    server.setRequestHandler(GetTaskPayloadRequestSchema, async (request) => {
      const target = taskTargets.get(request.params.taskId);
      if (!target)
        throw new Error(
          `Unknown Machdoch proxy task: ${request.params.taskId}.`,
        );
      return await mcpClientManager.getTaskResult(
        workspaceRoot,
        target.serverId,
        target.name,
        createOperationOptions(getCatalogEntry(taskEntries, target.serverId)),
      );
    });
    server.setRequestHandler(CancelTaskRequestSchema, async (request) => {
      const target = taskTargets.get(request.params.taskId);
      if (!target)
        throw new Error(
          `Unknown Machdoch proxy task: ${request.params.taskId}.`,
        );
      const result = await mcpClientManager.cancelTask(
        workspaceRoot,
        target.serverId,
        target.name,
        createOperationOptions(getCatalogEntry(taskEntries, target.serverId)),
      );
      return {
        ...result,
        taskId: createProxyExposedName(
          target.serverId,
          result.taskId,
          aggregate,
        ),
      };
    });
  }
};

export const runMcpStdioProxy = async (
  workspaceRoot: string,
  serverId?: string,
  scope?: "user",
): Promise<void> => {
  await runManagedStdioServer(
    async (signal) => {
      const entries = await loadCatalog(workspaceRoot, serverId, scope, signal);
      signal.throwIfAborted();
      const aggregate = entries.length > 1;
      const instructions = entries
        .flatMap((entry) =>
          entry.discovery.instructions
            ? [`${entry.serverId}: ${entry.discovery.instructions}`]
            : [],
        )
        .join("\n\n");
      const supportsTasks = entries.some(
        (entry) =>
          entry.config.tasks !== "disabled" &&
          entry.discovery.capabilities &&
          "tasks" in entry.discovery.capabilities,
      );
      const server = new Server(
        {
          name: aggregate
            ? "machdoch-compat"
            : `machdoch-proxy-${entries[0]?.serverId ?? "mcp"}`,
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
            ...(supportsTasks ? { tasks: { list: {}, cancel: {} } } : {}),
          },
          ...(instructions ? { instructions } : {}),
        },
      );
      registerHandlers(server, workspaceRoot, entries);
      return server;
    },
    { cleanup: () => mcpClientManager.closeAll() },
  );
};
