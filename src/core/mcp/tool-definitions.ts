import { createHash, randomUUID } from "node:crypto";
import type {
  AgentModelToolImageContent,
  AgentModelToolResultContent,
  ToolCallEffect,
  ToolRiskLevel,
} from "../types.js";
import {
  coerceBoolean,
  coerceInteger,
  coerceString,
  createToolErrorResult,
  type AgentToolDefinition,
  type AgentToolExecutionContext,
  type AgentToolExecutionResult,
} from "../_helpers/agent-tools-shared.js";
import {
  compactTraceText,
  createTextSection,
  limitText,
  stringifyUnknown,
} from "../_helpers/runtime-text.js";
import {
  getEnabledMcpServer,
  listEnabledMcpServers,
  loadMcpConfig,
  loadMcpConfigSync,
  loadMcpDiscoveryCacheSync,
} from "./config.js";
import { mcpClientManager } from "./client.js";
import { mcpRunCacheManager } from "./run-cache.js";
import type {
  McpDirectToolMapping,
  McpDiscoveryChangeSet,
  McpDiscoveredPrompt,
  McpDiscoveredResource,
  McpDiscoveredResourceTemplate,
  McpDiscoveredTool,
  McpEffectiveConfig,
  McpEffectiveServerConfig,
  McpOperationCacheOptions,
  McpOperationOptions,
  McpServerDiscovery,
} from "./types.js";

const MAX_TOOL_NAME_LENGTH = 64;
const MCP_OUTPUT_MAX_CHARS = 60_000;
const MCP_SECTION_MAX_LINES = 120;
const MCP_CATALOG_MAX_RESULTS = 100;
const VALID_IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const coerceRecord = (
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown> => {
  const value = record[field];
  return isRecord(value) ? value : {};
};

const coerceStringRecord = (
  record: Record<string, unknown>,
  field: string,
): Record<string, string> => {
  const value = record[field];

  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      typeof entry === "string" ? [[key, entry] as const] : [],
    ),
  );
};

const sanitizeToolNameSegment = (value: string): string => {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .replace(/_+/gu, "_");

  return sanitized || "tool";
};

export const createMcpDirectToolName = (
  serverId: string,
  remoteToolName: string,
  namespacePrefix = "mcp",
): string => {
  const prefix = sanitizeToolNameSegment(namespacePrefix);
  const server = sanitizeToolNameSegment(serverId);
  const tool = sanitizeToolNameSegment(remoteToolName);
  const base = `${prefix}__${server}__${tool}`;

  if (base.length <= MAX_TOOL_NAME_LENGTH) {
    return base;
  }

  const hash = createHash("sha1")
    .update(`${serverId}:${remoteToolName}`)
    .digest("hex")
    .slice(0, 8);
  const head = base.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1).replace(/_+$/u, "");

  return `${head}_${hash}`;
};

const normalizeJsonSchema = (schema: unknown): Record<string, unknown> => {
  if (isRecord(schema) && schema.type === "object") {
    return schema;
  }

  return {
    type: "object",
    additionalProperties: true,
  };
};

const resolveToolEffect = (
  server: McpEffectiveServerConfig,
  tool: McpDiscoveredTool,
): ToolCallEffect => {
  const override = server.toolOverrides?.[tool.name];

  if (override?.effect) {
    return override.effect;
  }

  if (tool.annotations?.readOnlyHint === true) {
    return "external-read";
  }

  return "external-side-effect";
};

const resolveToolRisk = (
  server: McpEffectiveServerConfig,
  tool: McpDiscoveredTool,
  effect: ToolCallEffect,
): ToolRiskLevel => {
  const override = server.toolOverrides?.[tool.name];

  if (override?.riskLevel) {
    return override.riskLevel;
  }

  if (tool.annotations?.destructiveHint === true) {
    return "high";
  }

  if (effect === "external-read") {
    return tool.annotations?.openWorldHint === true ? "medium" : "low";
  }

  return tool.annotations?.idempotentHint === true ? "medium" : "high";
};

const isDirectToolEnabled = (
  server: McpEffectiveServerConfig,
  toolName: string,
): boolean => {
  if (server.toolOverrides?.[toolName]?.enabled === false) {
    return false;
  }

  const directTools = server.exposure?.directTools;
  const include =
    isRecord(directTools) && Array.isArray(directTools.include)
      ? directTools.include
      : undefined;
  const exclude =
    isRecord(directTools) && Array.isArray(directTools.exclude)
      ? directTools.exclude
      : undefined;

  if (include && !include.includes(toolName)) {
    return false;
  }

  return !exclude?.includes(toolName);
};

const getDirectToolNamespace = (
  server: McpEffectiveServerConfig,
): string | undefined => {
  const directTools = server.exposure?.directTools;

  return isRecord(directTools) && typeof directTools.namespacePrefix === "string"
    ? directTools.namespacePrefix
    : undefined;
};

const shouldExposeDirectTools = (server: McpEffectiveServerConfig): boolean => {
  if (!server.enabled) {
    return false;
  }

  const mode = server.exposure?.mode ?? "hybrid";
  const directTools = server.exposure?.directTools;
  const directEnabled =
    typeof directTools === "boolean"
      ? directTools
      : !isRecord(directTools) || directTools.enabled !== false;

  return directEnabled && (mode === "direct-tools" || mode === "hybrid");
};

export const createMcpDirectToolMappings = (
  config: McpEffectiveConfig,
  discovery: Record<string, McpServerDiscovery>,
): McpDirectToolMapping[] => {
  const exposedNames = new Set<string>();
  const mappings: McpDirectToolMapping[] = [];

  for (const server of listEnabledMcpServers(config)) {
    if (!shouldExposeDirectTools(server)) {
      continue;
    }

    const serverDiscovery = discovery[server.id];

    if (!serverDiscovery) {
      continue;
    }

    for (const tool of serverDiscovery.tools) {
      if (!isDirectToolEnabled(server, tool.name)) {
        continue;
      }

      const effect = resolveToolEffect(server, tool);
      const riskLevel = resolveToolRisk(server, tool, effect);
      let exposedName = createMcpDirectToolName(
        server.id,
        tool.name,
        getDirectToolNamespace(server),
      );

      if (exposedNames.has(exposedName)) {
        exposedName = createMcpDirectToolName(
          server.id,
          `${tool.name}_${createHash("sha1")
            .update(`${server.id}:${tool.name}`)
            .digest("hex")
            .slice(0, 8)}`,
          getDirectToolNamespace(server),
        );
      }

      exposedNames.add(exposedName);
      mappings.push({
        exposedName,
        serverId: server.id,
        remoteName: tool.name,
        ...(server.toolOverrides?.[tool.name]?.title ?? tool.title
          ? { title: server.toolOverrides?.[tool.name]?.title ?? tool.title }
          : {}),
        ...(server.toolOverrides?.[tool.name]?.description ?? tool.description
          ? {
              description:
                server.toolOverrides?.[tool.name]?.description ??
                tool.description,
            }
          : {}),
        inputSchema: normalizeJsonSchema(tool.inputSchema),
        ...(tool.inputSchemaHash ? { inputSchemaHash: tool.inputSchemaHash } : {}),
        ...(tool.outputSchemaHash ? { outputSchemaHash: tool.outputSchemaHash } : {}),
        ...(tool.descriptionHash ? { descriptionHash: tool.descriptionHash } : {}),
        ...(tool.definitionHash ? { definitionHash: tool.definitionHash } : {}),
        riskLevel,
        effect,
        readOnlyInAskMode:
          server.toolOverrides?.[tool.name]?.readOnlyInAskMode ??
          effect === "external-read",
      });
    }
  }

  return mappings;
};

const createProgressHandler = (
  context: AgentToolExecutionContext,
): ((message: string) => void) => {
  return (message: string): void => {
    context.onOutput?.({
      stream: "stdout",
      chunk: `MCP progress: ${message}\n`,
    });
  };
};

const createMcpOperationCacheOptions = (
  context: AgentToolExecutionContext,
  operation: McpOperationCacheOptions["operation"],
  readOnly = true,
): McpOperationCacheOptions | undefined => {
  return context.runId
    ? {
        runId: context.runId,
        operation,
        readOnly,
      }
    : undefined;
};

const createMcpOperationOptions = (
  context: AgentToolExecutionContext,
  operation?: McpOperationCacheOptions["operation"],
  readOnly = true,
): McpOperationOptions => {
  const cache = operation
    ? createMcpOperationCacheOptions(context, operation, readOnly)
    : undefined;

  return {
    onProgress: createProgressHandler(context),
    ...(cache ? { cache } : {}),
  };
};

const createSuccessfulResult = (
  toolName: string,
  output: string,
  trace: string,
  content?: AgentModelToolResultContent[],
): AgentToolExecutionResult => {
  return {
    toolResult: {
      callId: randomUUID(),
      name: toolName,
      output: limitText(output, MCP_OUTPUT_MAX_CHARS),
      ...(content && content.length > 0 ? { content } : {}),
    },
    sections: [createTextSection("MCP result", output, MCP_SECTION_MAX_LINES)],
    traceLines: [trace],
  };
};

const formatJson = (value: unknown): string => {
  return JSON.stringify(value, null, 2);
};

const normalizeSearchTerm = (value: string): string => {
  return value.trim().toLowerCase();
};

const resolveCatalogLimit = (
  args: Record<string, unknown>,
  fallback = 25,
): number => {
  const requested = coerceInteger(args, "maxResults") ?? fallback;

  return Math.min(Math.max(requested, 1), MCP_CATALOG_MAX_RESULTS);
};

const getFilteredDiscoveries = (
  discoveries: Record<string, McpServerDiscovery>,
  serverId: string | undefined,
): McpServerDiscovery[] => {
  if (!serverId) {
    return Object.values(discoveries);
  }

  return discoveries[serverId] ? [discoveries[serverId]] : [];
};

const matchesCatalogQuery = (
  query: string,
  values: Array<string | undefined>,
): boolean => {
  return values.some((value) => value?.toLowerCase().includes(query));
};

const searchCachedTools = (
  discoveries: Record<string, McpServerDiscovery>,
  args: Record<string, unknown>,
): string | undefined => {
  const rawQuery = coerceString(args, "query");

  if (!rawQuery) {
    return undefined;
  }

  const query = normalizeSearchTerm(rawQuery);
  const serverId = coerceString(args, "serverId");
  const maxResults = resolveCatalogLimit(args);
  const matches = getFilteredDiscoveries(discoveries, serverId)
    .flatMap((discovery) =>
      discovery.tools
        .filter((tool) =>
          matchesCatalogQuery(query, [
            discovery.serverId,
            tool.name,
            tool.title,
            tool.description,
          ]),
        )
        .map((tool) => ({
          serverId: discovery.serverId,
          name: tool.name,
          ...(tool.title ? { title: tool.title } : {}),
          ...(tool.description ? { description: tool.description } : {}),
          ...(tool.inputSchemaHash ? { inputSchemaHash: tool.inputSchemaHash } : {}),
          ...(tool.outputSchemaHash ? { outputSchemaHash: tool.outputSchemaHash } : {}),
          ...(tool.descriptionHash ? { descriptionHash: tool.descriptionHash } : {}),
          ...(tool.definitionHash ? { definitionHash: tool.definitionHash } : {}),
          annotations: tool.annotations ?? {},
        })),
    )
    .slice(0, maxResults);

  return formatJson({
    query: rawQuery,
    ...(serverId ? { serverId } : {}),
    count: matches.length,
    tools: matches,
  });
};

const inspectCachedTool = (
  config: McpEffectiveConfig,
  discoveries: Record<string, McpServerDiscovery>,
  args: Record<string, unknown>,
): string | undefined => {
  const serverId = coerceString(args, "serverId");
  const toolName = coerceString(args, "toolName");

  if (!serverId || !toolName) {
    return undefined;
  }

  const discovery = discoveries[serverId];
  const tool = discovery?.tools.find((candidate) => candidate.name === toolName);

  if (!discovery || !tool) {
    return formatJson({
      serverId,
      toolName,
      found: false,
      message: "Tool was not found in the cached MCP discovery metadata.",
    });
  }

  const directMapping = createMcpDirectToolMappings(config, discoveries).find(
    (mapping) =>
      mapping.serverId === serverId && mapping.remoteName === toolName,
  );

  return formatJson({
    serverId,
    discoveredAt: discovery.discoveredAt,
    found: true,
    tool,
    ...(directMapping
      ? {
          directTool: {
            name: directMapping.exposedName,
            riskLevel: directMapping.riskLevel,
            effect: directMapping.effect,
            readOnlyInAskMode: directMapping.readOnlyInAskMode,
            ...(directMapping.inputSchemaHash
              ? { inputSchemaHash: directMapping.inputSchemaHash }
              : {}),
            ...(directMapping.outputSchemaHash
              ? { outputSchemaHash: directMapping.outputSchemaHash }
              : {}),
            ...(directMapping.descriptionHash
              ? { descriptionHash: directMapping.descriptionHash }
              : {}),
            ...(directMapping.definitionHash
              ? { definitionHash: directMapping.definitionHash }
              : {}),
          },
        }
      : {}),
  });
};

const listCachedResources = (
  discoveries: Record<string, McpServerDiscovery>,
  args: Record<string, unknown>,
): string => {
  const serverId = coerceString(args, "serverId");
  const maxResults = resolveCatalogLimit(args, 50);
  const resources = getFilteredDiscoveries(discoveries, serverId)
    .flatMap((discovery) => [
      ...discovery.resources.map((resource) => ({
        serverId: discovery.serverId,
        type: "resource" as const,
        uri: resource.uri,
        name: resource.name,
        ...(resource.title ? { title: resource.title } : {}),
        ...(resource.description ? { description: resource.description } : {}),
        ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        ...(typeof resource.size === "number" ? { size: resource.size } : {}),
      })),
      ...discovery.resourceTemplates.map((template) => ({
        serverId: discovery.serverId,
        type: "resource_template" as const,
        uriTemplate: template.uriTemplate,
        name: template.name,
        ...(template.title ? { title: template.title } : {}),
        ...(template.description ? { description: template.description } : {}),
        ...(template.mimeType ? { mimeType: template.mimeType } : {}),
      })),
    ])
    .slice(0, maxResults);

  return formatJson({
    ...(serverId ? { serverId } : {}),
    count: resources.length,
    resources,
  });
};

const listCachedPrompts = (
  discoveries: Record<string, McpServerDiscovery>,
  args: Record<string, unknown>,
): string => {
  const serverId = coerceString(args, "serverId");
  const maxResults = resolveCatalogLimit(args, 50);
  const prompts = getFilteredDiscoveries(discoveries, serverId)
    .flatMap((discovery) =>
      discovery.prompts.map((prompt) => ({
        serverId: discovery.serverId,
        name: prompt.name,
        ...(prompt.title ? { title: prompt.title } : {}),
        ...(prompt.description ? { description: prompt.description } : {}),
        ...(prompt.arguments ? { arguments: prompt.arguments } : {}),
      })),
    )
    .slice(0, maxResults);

  return formatJson({
    ...(serverId ? { serverId } : {}),
    count: prompts.length,
    prompts,
  });
};

const isSupportedImageMediaType = (
  mimeType: string,
): mimeType is AgentModelToolImageContent["mediaType"] => {
  return VALID_IMAGE_MEDIA_TYPES.has(mimeType);
};

const formatMcpContentItems = (
  value: unknown,
): { text: string; content: AgentModelToolResultContent[] } => {
  if (!Array.isArray(value)) {
    return {
      text: formatJson(value),
      content: [],
    };
  }

  const lines: string[] = [];
  const content: AgentModelToolResultContent[] = [];

  for (const item of value) {
    if (!isRecord(item)) {
      lines.push(formatJson(item));
      continue;
    }

    if (item.type === "text" && typeof item.text === "string") {
      lines.push(item.text);
      content.push({ type: "text", text: item.text });
      continue;
    }

    if (
      item.type === "image" &&
      typeof item.data === "string" &&
      typeof item.mimeType === "string"
    ) {
      lines.push(`[image: ${item.mimeType}, ${item.data.length} base64 chars]`);

      if (isSupportedImageMediaType(item.mimeType)) {
        content.push({
          type: "image",
          mediaType: item.mimeType,
          data: item.data,
        });
      }
      continue;
    }

    if (item.type === "resource" && isRecord(item.resource)) {
      const resource = item.resource;
      const uri = typeof resource.uri === "string" ? resource.uri : "resource";

      if (typeof resource.text === "string") {
        lines.push(`Resource ${uri}\n${resource.text}`);
        content.push({ type: "text", text: resource.text });
      } else if (typeof resource.blob === "string") {
        lines.push(
          `Resource ${uri}: blob (${resource.mimeType ?? "unknown type"}, ${resource.blob.length} base64 chars)`,
        );
      } else {
        lines.push(formatJson(resource));
      }
      continue;
    }

    if (item.type === "resource_link" && typeof item.uri === "string") {
      lines.push(
        `Resource link: ${item.title ?? item.name ?? item.uri}\n${item.uri}`,
      );
      continue;
    }

    if (item.type === "audio") {
      lines.push(
        `[audio: ${typeof item.mimeType === "string" ? item.mimeType : "unknown type"}]`,
      );
      continue;
    }

    lines.push(formatJson(item));
  }

  return {
    text: lines.join("\n\n"),
    content,
  };
};

const formatCallToolOutput = (
  result: unknown,
): { output: string; content: AgentModelToolResultContent[]; isError: boolean } => {
  if (!isRecord(result)) {
    return {
      output: formatJson(result),
      content: [],
      isError: false,
    };
  }

  if ("toolResult" in result) {
    return {
      output: formatJson(result.toolResult),
      content: [],
      isError: false,
    };
  }

  const formattedContent = formatMcpContentItems(result.content);
  const structuredContent = isRecord(result.structuredContent)
    ? `\n\nStructured content:\n${formatJson(result.structuredContent)}`
    : "";

  return {
    output: `${formattedContent.text}${structuredContent}`.trim(),
    content: formattedContent.content,
    isError: result.isError === true,
  };
};

const formatResourceOutput = (result: unknown): string => {
  if (!isRecord(result) || !Array.isArray(result.contents)) {
    return formatJson(result);
  }

  return result.contents
    .map((content) => {
      if (!isRecord(content)) {
        return formatJson(content);
      }

      const uri = typeof content.uri === "string" ? content.uri : "resource";
      const mimeType =
        typeof content.mimeType === "string" ? ` (${content.mimeType})` : "";

      if (typeof content.text === "string") {
        return `${uri}${mimeType}\n${content.text}`;
      }

      if (typeof content.blob === "string") {
        return `${uri}${mimeType}\n[blob: ${content.blob.length} base64 chars]`;
      }

      return formatJson(content);
    })
    .join("\n\n");
};

const formatPromptOutput = (result: unknown): string => {
  if (!isRecord(result) || !Array.isArray(result.messages)) {
    return formatJson(result);
  }

  const description =
    typeof result.description === "string" ? `${result.description}\n\n` : "";

  return `${description}${result.messages
    .map((message) => {
      if (!isRecord(message) || !isRecord(message.content)) {
        return formatJson(message);
      }

      const role = typeof message.role === "string" ? message.role : "message";
      const content = message.content;

      if (content.type === "text" && typeof content.text === "string") {
        return `${role}: ${content.text}`;
      }

      if (
        content.type === "resource" &&
        isRecord(content.resource) &&
        typeof content.resource.text === "string"
      ) {
        return `${role}: resource ${content.resource.uri ?? ""}\n${content.resource.text}`;
      }

      if (content.type === "image") {
        return `${role}: [image ${content.mimeType ?? "unknown type"}]`;
      }

      if (content.type === "audio") {
        return `${role}: [audio ${content.mimeType ?? "unknown type"}]`;
      }

      return `${role}: ${formatJson(content)}`;
    })
    .join("\n\n")}`;
};

const summarizeDiscovery = (
  discovery: McpServerDiscovery,
  cachePath?: string,
  changes?: McpDiscoveryChangeSet,
): string => {
  return [
    `Server: ${discovery.serverId}`,
    `Transport: ${discovery.transportType}`,
    discovery.protocolVersion ? `Protocol: ${discovery.protocolVersion}` : undefined,
    discovery.catalogHash ? `Catalog hash: ${discovery.catalogHash}` : undefined,
    discovery.capabilitiesHash
      ? `Capabilities hash: ${discovery.capabilitiesHash}`
      : undefined,
    `Tools: ${discovery.tools.length}`,
    `Resources: ${discovery.resources.length}`,
    `Resource templates: ${discovery.resourceTemplates.length}`,
    `Prompts: ${discovery.prompts.length}`,
    cachePath ? `Cache: ${cachePath}` : undefined,
    changes
      ? `Changes: ${changes.changed ? changes.changes.length : 0}${changes.previousCatalogHash ? ` from ${changes.previousCatalogHash}` : ""} to ${changes.nextCatalogHash}`
      : undefined,
    changes && changes.changes.length > 0
      ? `Changed entries:\n${changes.changes
          .slice(0, 50)
          .map(
            (change) =>
              `- ${change.category}:${change.name} ${change.type}${change.previousHash ? ` previous=${change.previousHash}` : ""}${change.nextHash ? ` next=${change.nextHash}` : ""}`,
          )
          .join("\n")}`
      : undefined,
    "",
    discovery.tools.length > 0
      ? `Tools:\n${discovery.tools
          .map((tool) => `- ${tool.name}${tool.description ? `: ${tool.description}` : ""}`)
          .join("\n")}`
      : "Tools: none",
    discovery.resources.length > 0
      ? `\nResources:\n${discovery.resources
          .slice(0, 50)
          .map((resource) => `- ${resource.uri}${resource.description ? `: ${resource.description}` : ""}`)
          .join("\n")}`
      : "",
    discovery.prompts.length > 0
      ? `\nPrompts:\n${discovery.prompts
          .map((prompt) => `- ${prompt.name}${prompt.description ? `: ${prompt.description}` : ""}`)
          .join("\n")}`
      : "",
  ]
    .filter((line): line is string => line !== undefined && line.length > 0)
    .join("\n");
};

const createServerSummary = (
  config: McpEffectiveConfig,
  includeDisabled: boolean,
): string => {
  const servers = includeDisabled
    ? config.servers
    : config.servers.filter((server) => server.enabled);

  return formatJson({
    defaults: config.defaults,
    paths: {
      userConfigPath: config.userConfigPath,
      workspaceConfigPath: config.workspaceConfigPath,
      userDiscoveryCachePath: config.userDiscoveryCachePath,
      workspaceDiscoveryCachePath: config.workspaceDiscoveryCachePath,
    },
    servers: servers.map((server) => ({
      id: server.id,
      title: server.title,
      enabled: server.enabled,
      preset: server.preset,
      transport: server.transport.type,
      exposure: server.exposure,
      securityProfile: server.securityProfile,
      sources: server.sources,
    })),
  });
};

const listCapabilityNames = (
  discoveries: Record<string, McpServerDiscovery>,
): string => {
  return formatJson(
    Object.fromEntries(
      Object.entries(discoveries).map(([serverId, discovery]) => [
        serverId,
        {
          protocolVersion: discovery.protocolVersion ?? null,
          catalogHash: discovery.catalogHash ?? null,
          capabilitiesHash: discovery.capabilitiesHash ?? null,
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
  );
};

const executeMcpCall = async (
  toolName: string,
  args: Record<string, unknown>,
  context: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult> => {
  const serverId = coerceString(args, "serverId");
  const remoteToolName = coerceString(args, "toolName");

  if (!serverId || !remoteToolName) {
    return createToolErrorResult(
      randomUUID(),
      toolName,
      "Expected non-empty `serverId` and `toolName`.",
    );
  }

  try {
    const result = await mcpClientManager.callTool(
      context.workspaceRoot,
      serverId,
      remoteToolName,
      coerceRecord(args, "arguments"),
      { onProgress: createProgressHandler(context) },
    );
    const formatted = formatCallToolOutput(result);

    return {
      ...createSuccessfulResult(
        toolName,
        formatted.output,
        `mcp_call_tool: ${serverId}.${remoteToolName} -> ${compactTraceText(formatted.output)}`,
        formatted.content,
      ),
      toolResult: {
        callId: randomUUID(),
        name: toolName,
        output: limitText(formatted.output, MCP_OUTPUT_MAX_CHARS),
        ...(formatted.content.length > 0 ? { content: formatted.content } : {}),
        ...(formatted.isError ? { isError: true } : {}),
      },
    };
  } catch (error) {
    return createToolErrorResult(
      randomUUID(),
      toolName,
      error instanceof Error ? error.message : String(error),
    );
  }
};

const createMetaToolDefinitions = (): AgentToolDefinition[] => [
  {
    spec: {
      name: "mcp_list_servers",
      description:
        "List configured MCP servers, their transport types, exposure settings, config paths, and whether they are enabled.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          includeDisabled: {
            type: "boolean",
            description: "Include disabled preset and configured servers.",
          },
        },
      },
    },
    backingTool: "mcp",
    riskLevel: "low",
    effect: "read",
    execute: async (args, context) => {
      const config = await loadMcpConfig(context.workspaceRoot);
      const output = createServerSummary(
        config,
        coerceBoolean(args, "includeDisabled") ?? false,
      );

      return createSuccessfulResult(
        "mcp_list_servers",
        output,
        "mcp_list_servers -> success",
      );
    },
  },
  {
    spec: {
      name: "mcp_list_cached_capabilities",
      description:
        "List cached MCP tools, resources, resource templates, and prompts discovered for this workspace.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    backingTool: "mcp",
    riskLevel: "low",
    effect: "read",
    execute: async (_args, context) => {
      const cache = loadMcpDiscoveryCacheSync(context.workspaceRoot);
      const output = listCapabilityNames(cache.servers);

      return createSuccessfulResult(
        "mcp_list_cached_capabilities",
        output,
        "mcp_list_cached_capabilities -> success",
      );
    },
  },
  {
    spec: {
      name: "mcp_search_tools",
      description:
        "Search cached MCP tool names, titles, and descriptions without opening a live MCP connection.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "Case-insensitive search text.",
          },
          serverId: {
            type: "string",
            description: "Optional configured MCP server id to search within.",
          },
          maxResults: {
            type: "integer",
            minimum: 1,
            maximum: MCP_CATALOG_MAX_RESULTS,
            description: "Maximum number of matching tools to return.",
          },
        },
      },
    },
    backingTool: "mcp",
    riskLevel: "low",
    effect: "read",
    execute: async (args, context) => {
      const cache = loadMcpDiscoveryCacheSync(context.workspaceRoot);
      const output = searchCachedTools(cache.servers, args);

      if (!output) {
        return createToolErrorResult(
          randomUUID(),
          "mcp_search_tools",
          "Expected a non-empty `query`.",
        );
      }

      return createSuccessfulResult(
        "mcp_search_tools",
        output,
        `mcp_search_tools -> ${compactTraceText(output)}`,
      );
    },
  },
  {
    spec: {
      name: "mcp_inspect_tool",
      description:
        "Inspect one cached MCP tool schema, annotations, and direct-tool mapping details.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["serverId", "toolName"],
        properties: {
          serverId: {
            type: "string",
            description: "Configured MCP server id.",
          },
          toolName: {
            type: "string",
            description: "Remote MCP tool name.",
          },
        },
      },
    },
    backingTool: "mcp",
    riskLevel: "low",
    effect: "read",
    execute: async (args, context) => {
      const config = loadMcpConfigSync(context.workspaceRoot);
      const cache = loadMcpDiscoveryCacheSync(context.workspaceRoot);
      const output = inspectCachedTool(config, cache.servers, args);

      if (!output) {
        return createToolErrorResult(
          randomUUID(),
          "mcp_inspect_tool",
          "Expected non-empty `serverId` and `toolName`.",
        );
      }

      return createSuccessfulResult(
        "mcp_inspect_tool",
        output,
        `mcp_inspect_tool -> ${compactTraceText(output)}`,
      );
    },
  },
  {
    spec: {
      name: "mcp_list_resources",
      description:
        "List cached MCP resources and resource templates, optionally filtered by server id.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          serverId: {
            type: "string",
            description: "Optional configured MCP server id.",
          },
          maxResults: {
            type: "integer",
            minimum: 1,
            maximum: MCP_CATALOG_MAX_RESULTS,
            description: "Maximum number of resources and templates to return.",
          },
        },
      },
    },
    backingTool: "mcp",
    riskLevel: "low",
    effect: "read",
    execute: async (args, context) => {
      const cache = loadMcpDiscoveryCacheSync(context.workspaceRoot);
      const output = listCachedResources(cache.servers, args);

      return createSuccessfulResult(
        "mcp_list_resources",
        output,
        `mcp_list_resources -> ${compactTraceText(output)}`,
      );
    },
  },
  {
    spec: {
      name: "mcp_list_prompts",
      description:
        "List cached MCP prompts and prompt arguments, optionally filtered by server id.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          serverId: {
            type: "string",
            description: "Optional configured MCP server id.",
          },
          maxResults: {
            type: "integer",
            minimum: 1,
            maximum: MCP_CATALOG_MAX_RESULTS,
            description: "Maximum number of prompts to return.",
          },
        },
      },
    },
    backingTool: "mcp",
    riskLevel: "low",
    effect: "read",
    execute: async (args, context) => {
      const cache = loadMcpDiscoveryCacheSync(context.workspaceRoot);
      const output = listCachedPrompts(cache.servers, args);

      return createSuccessfulResult(
        "mcp_list_prompts",
        output,
        `mcp_list_prompts -> ${compactTraceText(output)}`,
      );
    },
  },
  {
    spec: {
      name: "mcp_list_connections",
      description:
        "List currently pooled MCP connections in this agent runtime process, including active operation counts and idle shutdown times.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    backingTool: "mcp",
    riskLevel: "low",
    effect: "read",
    execute: async () => {
      const output = formatJson(mcpClientManager.listConnections());

      return createSuccessfulResult(
        "mcp_list_connections",
        output,
        "mcp_list_connections -> success",
      );
    },
  },
  {
    spec: {
      name: "mcp_list_tasks",
      description:
        "List long-running MCP tasks for an enabled server when that server supports the MCP tasks capability.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["serverId"],
        properties: {
          serverId: {
            type: "string",
            description: "Configured MCP server id.",
          },
          cursor: {
            type: "string",
            description: "Optional pagination cursor returned by a previous tasks list.",
          },
        },
      },
    },
    backingTool: "mcp",
    riskLevel: "low",
    effect: "external-read",
    execute: async (args, context) => {
      const serverId = coerceString(args, "serverId");

      if (!serverId) {
        return createToolErrorResult(
          randomUUID(),
          "mcp_list_tasks",
          "Expected a non-empty `serverId`.",
        );
      }

      try {
        const result = await mcpClientManager.listTasks(
          context.workspaceRoot,
          serverId,
          coerceString(args, "cursor"),
          createMcpOperationOptions(context),
        );
        const output = formatJson(result);

        return createSuccessfulResult(
          "mcp_list_tasks",
          output,
          `mcp_list_tasks: ${serverId} -> ${compactTraceText(output)}`,
        );
      } catch (error) {
        return createToolErrorResult(
          randomUUID(),
          "mcp_list_tasks",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  },
  {
    spec: {
      name: "mcp_get_task",
      description:
        "Get the current status and metadata for one long-running MCP task.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["serverId", "taskId"],
        properties: {
          serverId: {
            type: "string",
            description: "Configured MCP server id.",
          },
          taskId: {
            type: "string",
            description: "MCP task id.",
          },
        },
      },
    },
    backingTool: "mcp",
    riskLevel: "low",
    effect: "external-read",
    execute: async (args, context) => {
      const serverId = coerceString(args, "serverId");
      const taskId = coerceString(args, "taskId");

      if (!serverId || !taskId) {
        return createToolErrorResult(
          randomUUID(),
          "mcp_get_task",
          "Expected non-empty `serverId` and `taskId`.",
        );
      }

      try {
        const result = await mcpClientManager.getTask(
          context.workspaceRoot,
          serverId,
          taskId,
          createMcpOperationOptions(context),
        );
        const output = formatJson(result);

        return createSuccessfulResult(
          "mcp_get_task",
          output,
          `mcp_get_task: ${serverId}.${taskId} -> ${compactTraceText(output)}`,
        );
      } catch (error) {
        return createToolErrorResult(
          randomUUID(),
          "mcp_get_task",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  },
  {
    spec: {
      name: "mcp_get_task_result",
      description:
        "Fetch the final result payload for a completed long-running MCP task.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["serverId", "taskId"],
        properties: {
          serverId: {
            type: "string",
            description: "Configured MCP server id.",
          },
          taskId: {
            type: "string",
            description: "MCP task id.",
          },
        },
      },
    },
    backingTool: "mcp",
    riskLevel: "low",
    effect: "external-read",
    execute: async (args, context) => {
      const serverId = coerceString(args, "serverId");
      const taskId = coerceString(args, "taskId");

      if (!serverId || !taskId) {
        return createToolErrorResult(
          randomUUID(),
          "mcp_get_task_result",
          "Expected non-empty `serverId` and `taskId`.",
        );
      }

      try {
        const result = await mcpClientManager.getTaskResult(
          context.workspaceRoot,
          serverId,
          taskId,
          createMcpOperationOptions(context),
        );
        const output = formatJson(result);

        return createSuccessfulResult(
          "mcp_get_task_result",
          output,
          `mcp_get_task_result: ${serverId}.${taskId} -> ${compactTraceText(output)}`,
        );
      } catch (error) {
        return createToolErrorResult(
          randomUUID(),
          "mcp_get_task_result",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  },
  {
    spec: {
      name: "mcp_cancel_task",
      description:
        "Cancel one long-running MCP task for an enabled server when cancellation is supported.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["serverId", "taskId"],
        properties: {
          serverId: {
            type: "string",
            description: "Configured MCP server id.",
          },
          taskId: {
            type: "string",
            description: "MCP task id.",
          },
        },
      },
    },
    backingTool: "mcp",
    riskLevel: "medium",
    effect: "external-side-effect",
    execute: async (args, context) => {
      const serverId = coerceString(args, "serverId");
      const taskId = coerceString(args, "taskId");

      if (!serverId || !taskId) {
        return createToolErrorResult(
          randomUUID(),
          "mcp_cancel_task",
          "Expected non-empty `serverId` and `taskId`.",
        );
      }

      try {
        const result = await mcpClientManager.cancelTask(
          context.workspaceRoot,
          serverId,
          taskId,
          createMcpOperationOptions(context),
        );
        const output = formatJson(result);

        return createSuccessfulResult(
          "mcp_cancel_task",
          output,
          `mcp_cancel_task: ${serverId}.${taskId} -> ${compactTraceText(output)}`,
        );
      } catch (error) {
        return createToolErrorResult(
          randomUUID(),
          "mcp_cancel_task",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  },
  {
    spec: {
      name: "mcp_run_cache_status",
      description:
        "Inspect the process-local MCP run cache used for read-only tools, resources, and prompts.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    backingTool: "mcp",
    riskLevel: "low",
    effect: "read",
    execute: async (_args, context) => {
      const output = formatJson({
        entries: mcpRunCacheManager.size(),
        runId: context.runId ?? null,
      });

      return createSuccessfulResult(
        "mcp_run_cache_status",
        output,
        "mcp_run_cache_status -> success",
      );
    },
  },
  {
    spec: {
      name: "mcp_clear_run_cache",
      description:
        "Clear process-local MCP run cache entries. Pass a runId to clear one run, or omit it to clear all MCP run cache entries.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          runId: {
            type: "string",
            description: "Optional run id to clear. Omit to clear all run cache entries.",
          },
        },
      },
    },
    backingTool: "mcp",
    riskLevel: "medium",
    effect: "write",
    execute: async (args) => {
      const runId = coerceString(args, "runId");
      const deleted = runId
        ? mcpRunCacheManager.deleteRun(runId)
        : mcpRunCacheManager.size();

      if (!runId) {
        mcpRunCacheManager.clear();
      }

      const output = formatJson({
        runId: runId ?? null,
        deleted,
        entries: mcpRunCacheManager.size(),
      });

      return createSuccessfulResult(
        "mcp_clear_run_cache",
        output,
        `mcp_clear_run_cache -> ${deleted} deleted`,
      );
    },
  },
  {
    spec: {
      name: "mcp_close_server_connection",
      description:
        "Close pooled MCP connections for one configured server in this workspace. The next MCP operation reconnects automatically.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["serverId"],
        properties: {
          serverId: {
            type: "string",
            description: "Configured MCP server id.",
          },
        },
      },
    },
    backingTool: "mcp",
    riskLevel: "medium",
    effect: "write",
    execute: async (args, context) => {
      const serverId = coerceString(args, "serverId");

      if (!serverId) {
        return createToolErrorResult(
          randomUUID(),
          "mcp_close_server_connection",
          "Expected a non-empty `serverId`.",
        );
      }

      await mcpClientManager.closeServer(context.workspaceRoot, serverId);

      return createSuccessfulResult(
        "mcp_close_server_connection",
        `Closed MCP connections for ${serverId}.`,
        `mcp_close_server_connection: ${serverId} -> success`,
      );
    },
  },
  {
    spec: {
      name: "mcp_close_all_connections",
      description:
        "Close every pooled MCP connection in this agent runtime process. The next MCP operation reconnects automatically.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    backingTool: "mcp",
    riskLevel: "medium",
    effect: "write",
    execute: async () => {
      await mcpClientManager.closeAll();

      return createSuccessfulResult(
        "mcp_close_all_connections",
        "Closed all MCP connections.",
        "mcp_close_all_connections -> success",
      );
    },
  },
  {
    spec: {
      name: "mcp_discover_capabilities",
      description:
        "Connect to an enabled MCP server and discover its current tools, resources, resource templates, prompts, instructions, and server capabilities without writing the discovery cache.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["serverId"],
        properties: {
          serverId: {
            type: "string",
            description: "Configured MCP server id.",
          },
        },
      },
    },
    backingTool: "mcp",
    riskLevel: "medium",
    effect: "external-read",
    execute: async (args, context) => {
      const serverId = coerceString(args, "serverId");

      if (!serverId) {
        return createToolErrorResult(
          randomUUID(),
          "mcp_discover_capabilities",
          "Expected a non-empty `serverId`.",
        );
      }

      try {
        const { discovery } = await mcpClientManager.discoverServerById(
          context.workspaceRoot,
          serverId,
          createMcpOperationOptions(context),
        );
        const output = summarizeDiscovery(discovery);

        return createSuccessfulResult(
          "mcp_discover_capabilities",
          output,
          `mcp_discover_capabilities: ${serverId} -> success`,
        );
      } catch (error) {
        return createToolErrorResult(
          randomUUID(),
          "mcp_discover_capabilities",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  },
  {
    spec: {
      name: "mcp_refresh_discovery_cache",
      description:
        "Connect to an enabled MCP server, discover its current capabilities, and write the workspace discovery cache used for direct MCP tool exposure.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["serverId"],
        properties: {
          serverId: {
            type: "string",
            description: "Configured MCP server id.",
          },
        },
      },
    },
    backingTool: "mcp",
    riskLevel: "medium",
    effect: "write",
    execute: async (args, context) => {
      const serverId = coerceString(args, "serverId");

      if (!serverId) {
        return createToolErrorResult(
          randomUUID(),
          "mcp_refresh_discovery_cache",
          "Expected a non-empty `serverId`.",
        );
      }

      try {
        const { discovery, cachePath, changes } = await mcpClientManager.discoverServerById(
          context.workspaceRoot,
          serverId,
          {
            persist: true,
            ...createMcpOperationOptions(context),
          },
        );
        const output = summarizeDiscovery(discovery, cachePath, changes);

        return createSuccessfulResult(
          "mcp_refresh_discovery_cache",
          output,
          `mcp_refresh_discovery_cache: ${serverId} -> ${cachePath ?? "not persisted"}`,
        );
      } catch (error) {
        return createToolErrorResult(
          randomUUID(),
          "mcp_refresh_discovery_cache",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  },
  {
    spec: {
      name: "mcp_call_tool",
      description:
        "Call a tool exposed by a configured MCP server. Use cached discovery or mcp_discover_capabilities first when tool names or arguments are unknown.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["serverId", "toolName"],
        properties: {
          serverId: {
            type: "string",
            description: "Configured MCP server id.",
          },
          toolName: {
            type: "string",
            description: "Remote MCP tool name.",
          },
          arguments: {
            type: "object",
            description: "Arguments to pass to the remote MCP tool.",
            additionalProperties: true,
          },
        },
      },
    },
    backingTool: "mcp",
    riskLevel: "high",
    effect: "external-side-effect",
    execute: (args, context) => executeMcpCall("mcp_call_tool", args, context),
  },
  {
    spec: {
      name: "mcp_read_resource",
      description:
        "Read a resource URI from an enabled MCP server.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["serverId", "uri"],
        properties: {
          serverId: {
            type: "string",
            description: "Configured MCP server id.",
          },
          uri: {
            type: "string",
            description: "Resource URI to read.",
          },
        },
      },
    },
    backingTool: "mcp",
    riskLevel: "low",
    effect: "external-read",
    execute: async (args, context) => {
      const serverId = coerceString(args, "serverId");
      const uri = coerceString(args, "uri");

      if (!serverId || !uri) {
        return createToolErrorResult(
          randomUUID(),
          "mcp_read_resource",
          "Expected non-empty `serverId` and `uri`.",
        );
      }

      try {
        const result = await mcpClientManager.readResource(
          context.workspaceRoot,
          serverId,
          uri,
          createMcpOperationOptions(context, "resource"),
        );
        const output = formatResourceOutput(result);

        return createSuccessfulResult(
          "mcp_read_resource",
          output,
          `mcp_read_resource: ${serverId}.${uri} -> ${compactTraceText(output)}`,
        );
      } catch (error) {
        return createToolErrorResult(
          randomUUID(),
          "mcp_read_resource",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  },
  {
    spec: {
      name: "mcp_get_prompt",
      description:
        "Fetch and render a prompt from an enabled MCP server.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["serverId", "promptName"],
        properties: {
          serverId: {
            type: "string",
            description: "Configured MCP server id.",
          },
          promptName: {
            type: "string",
            description: "Remote MCP prompt name.",
          },
          arguments: {
            type: "object",
            description: "String arguments for the prompt.",
            additionalProperties: {
              type: "string",
            },
          },
        },
      },
    },
    backingTool: "mcp",
    riskLevel: "low",
    effect: "external-read",
    execute: async (args, context) => {
      const serverId = coerceString(args, "serverId");
      const promptName = coerceString(args, "promptName");

      if (!serverId || !promptName) {
        return createToolErrorResult(
          randomUUID(),
          "mcp_get_prompt",
          "Expected non-empty `serverId` and `promptName`.",
        );
      }

      try {
        const result = await mcpClientManager.getPrompt(
          context.workspaceRoot,
          serverId,
          promptName,
          coerceStringRecord(args, "arguments"),
          createMcpOperationOptions(context, "prompt"),
        );
        const output = formatPromptOutput(result);

        return createSuccessfulResult(
          "mcp_get_prompt",
          output,
          `mcp_get_prompt: ${serverId}.${promptName} -> ${compactTraceText(output)}`,
        );
      } catch (error) {
        return createToolErrorResult(
          randomUUID(),
          "mcp_get_prompt",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  },
];

const createDirectToolDefinition = (
  mapping: McpDirectToolMapping,
): AgentToolDefinition => {
  return {
    spec: {
      name: mapping.exposedName,
      description: [
        mapping.description ?? mapping.title ?? mapping.remoteName,
        "",
        `Calls MCP tool \`${mapping.remoteName}\` on server \`${mapping.serverId}\`.`,
      ].join("\n"),
      inputSchema: mapping.inputSchema,
    },
    backingTool: "mcp",
    riskLevel: mapping.riskLevel,
    effect: mapping.effect,
    isReadOnlyInPlanMode: () => mapping.readOnlyInAskMode,
    execute: async (args, context) => {
      try {
        const result = await mcpClientManager.callTool(
          context.workspaceRoot,
          mapping.serverId,
          mapping.remoteName,
          args,
          createMcpOperationOptions(
            context,
            "tool",
            mapping.effect === "external-read",
          ),
        );
        const formatted = formatCallToolOutput(result);

        return {
          ...createSuccessfulResult(
            mapping.exposedName,
            formatted.output,
            `${mapping.exposedName}: ${mapping.serverId}.${mapping.remoteName} -> ${compactTraceText(
              formatted.output,
            )}`,
            formatted.content,
          ),
          toolResult: {
            callId: randomUUID(),
            name: mapping.exposedName,
            output: limitText(formatted.output, MCP_OUTPUT_MAX_CHARS),
            ...(formatted.content.length > 0 ? { content: formatted.content } : {}),
            ...(formatted.isError ? { isError: true } : {}),
          },
        };
      } catch (error) {
        return createToolErrorResult(
          randomUUID(),
          mapping.exposedName,
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
};

export const createMcpToolDefinitions = (
  workspaceRoot: string,
): AgentToolDefinition[] => {
  const config = loadMcpConfigSync(workspaceRoot);

  if (!config.defaults.enabled) {
    return [];
  }

  const cache = loadMcpDiscoveryCacheSync(workspaceRoot);
  const directToolDefinitions = createMcpDirectToolMappings(
    config,
    cache.servers,
  ).map(createDirectToolDefinition);

  return [...createMetaToolDefinitions(), ...directToolDefinitions];
};

export const assertMcpServerEnabled = async (
  workspaceRoot: string,
  serverId: string,
): Promise<McpEffectiveServerConfig> => {
  const config = await loadMcpConfig(workspaceRoot);
  const server = getEnabledMcpServer(config, serverId);

  if (!server) {
    throw new Error(`MCP server \`${serverId}\` is not configured or not enabled.`);
  }

  return server;
};

export const summarizeMcpDiscoveryForPrompt = (
  discovery: McpServerDiscovery,
): string => {
  const toolLines = discovery.tools.map(formatDiscoveredToolLine);
  const resourceLines = discovery.resources.map(formatDiscoveredResourceLine);
  const templateLines = discovery.resourceTemplates.map(
    formatDiscoveredResourceTemplateLine,
  );
  const promptLines = discovery.prompts.map(formatDiscoveredPromptLine);

  return [
    `MCP server ${discovery.serverId}`,
    toolLines.length > 0 ? `Tools:\n${toolLines.join("\n")}` : "Tools: none",
    resourceLines.length > 0
      ? `Resources:\n${resourceLines.join("\n")}`
      : "Resources: none",
    templateLines.length > 0
      ? `Resource templates:\n${templateLines.join("\n")}`
      : "Resource templates: none",
    promptLines.length > 0
      ? `Prompts:\n${promptLines.join("\n")}`
      : "Prompts: none",
  ].join("\n\n");
};

const formatDiscoveredToolLine = (tool: McpDiscoveredTool): string => {
  return `- ${tool.name}${tool.description ? `: ${tool.description}` : ""}`;
};

const formatDiscoveredResourceLine = (
  resource: McpDiscoveredResource,
): string => {
  return `- ${resource.uri}${resource.description ? `: ${resource.description}` : ""}`;
};

const formatDiscoveredResourceTemplateLine = (
  template: McpDiscoveredResourceTemplate,
): string => {
  return `- ${template.uriTemplate}${template.description ? `: ${template.description}` : ""}`;
};

const formatDiscoveredPromptLine = (prompt: McpDiscoveredPrompt): string => {
  return `- ${prompt.name}${prompt.description ? `: ${prompt.description}` : ""}`;
};

export const debugFormatMcpArgs = (args: Record<string, unknown>): string => {
  return compactTraceText(stringifyUnknown(args));
};
