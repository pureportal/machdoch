import { createHash } from "node:crypto";
import type {
  McpDiscoveryChange,
  McpDiscoveryChangeCategory,
  McpDiscoveryChangeSet,
  McpDiscoveredPrompt,
  McpDiscoveredResource,
  McpDiscoveredResourceTemplate,
  McpDiscoveredTool,
  McpServerDiscovery,
} from "./types.js";

const HASH_PREFIX = "sha256:";

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const canonicalizeJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }

  if (!isRecord(value)) {
    return value === undefined ? null : value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeJsonValue(value[key])] as const),
  );
};

const canonicalJsonString = (value: unknown): string => {
  return JSON.stringify(canonicalizeJsonValue(value));
};

export const createMcpMetadataHash = (value: unknown): string => {
  return `${HASH_PREFIX}${createHash("sha256")
    .update(canonicalJsonString(value))
    .digest("hex")}`;
};

const createTextHash = (value: string | undefined): string | undefined => {
  return value ? createMcpMetadataHash(value) : undefined;
};

const cleanToolForDefinitionHash = (
  tool: McpDiscoveredTool,
): Record<string, unknown> => {
  return {
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? null,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema ?? null,
    annotations: tool.annotations ?? null,
    taskSupport: tool.taskSupport ?? null,
  };
};

const compareCatalogItems = <T>(
  category: McpDiscoveryChangeCategory,
  previousItems: T[],
  nextItems: T[],
  getName: (item: T) => string,
  getHash: (item: T) => string | undefined,
): McpDiscoveryChange[] => {
  const changes: McpDiscoveryChange[] = [];
  const previousByName = new Map(
    previousItems.map((item) => [getName(item), item] as const),
  );
  const nextByName = new Map(nextItems.map((item) => [getName(item), item] as const));

  for (const [name, nextItem] of nextByName) {
    const previousItem = previousByName.get(name);
    const nextHash = getHash(nextItem);

    if (!previousItem) {
      changes.push({
        category,
        type: "added",
        name,
        ...(nextHash ? { nextHash } : {}),
      });
      continue;
    }

    const previousHash = getHash(previousItem);

    if (previousHash !== nextHash) {
      changes.push({
        category,
        type: "changed",
        name,
        ...(previousHash ? { previousHash } : {}),
        ...(nextHash ? { nextHash } : {}),
      });
    }
  }

  for (const [name, previousItem] of previousByName) {
    if (nextByName.has(name)) {
      continue;
    }

    const previousHash = getHash(previousItem);

    changes.push({
      category,
      type: "removed",
      name,
      ...(previousHash ? { previousHash } : {}),
    });
  }

  return changes.sort((left, right) => {
    const categoryOrder = left.category.localeCompare(right.category);

    return categoryOrder === 0 ? left.name.localeCompare(right.name) : categoryOrder;
  });
};

export const compareMcpDiscoveries = (
  previousDiscovery: McpServerDiscovery | undefined,
  nextDiscovery: McpServerDiscovery,
): McpDiscoveryChangeSet => {
  const next = enrichMcpDiscoveryMetadata(nextDiscovery);

  if (!previousDiscovery) {
    const changes = [
      ...(next.capabilitiesHash
        ? [
            {
              category: "capabilities" as const,
              type: "added" as const,
              name: "server",
              nextHash: next.capabilitiesHash,
            },
          ]
        : []),
      ...compareCatalogItems(
        "tool",
        [],
        next.tools,
        (tool) => tool.name,
        (tool) => tool.definitionHash,
      ),
      ...compareCatalogItems(
        "resource",
        [],
        next.resources,
        (resource) => resource.uri,
        (resource) => resource.definitionHash,
      ),
      ...compareCatalogItems(
        "resource_template",
        [],
        next.resourceTemplates,
        (template) => template.uriTemplate,
        (template) => template.definitionHash,
      ),
      ...compareCatalogItems(
        "prompt",
        [],
        next.prompts,
        (prompt) => prompt.name,
        (prompt) => prompt.definitionHash,
      ),
    ];

    return {
      changed: changes.length > 0,
      nextCatalogHash: next.catalogHash ?? createMcpMetadataHash(next),
      changes,
    };
  }

  const previous = enrichMcpDiscoveryMetadata(previousDiscovery);
  const changes: McpDiscoveryChange[] = [
    ...(previous.capabilitiesHash !== next.capabilitiesHash
      ? [
          {
            category: "capabilities" as const,
            type: previous.capabilitiesHash ? "changed" as const : "added" as const,
            name: "server",
            ...(previous.capabilitiesHash
              ? { previousHash: previous.capabilitiesHash }
              : {}),
            ...(next.capabilitiesHash ? { nextHash: next.capabilitiesHash } : {}),
          },
        ]
      : []),
    ...compareCatalogItems(
      "tool",
      previous.tools,
      next.tools,
      (tool) => tool.name,
      (tool) => tool.definitionHash,
    ),
    ...compareCatalogItems(
      "resource",
      previous.resources,
      next.resources,
      (resource) => resource.uri,
      (resource) => resource.definitionHash,
    ),
    ...compareCatalogItems(
      "resource_template",
      previous.resourceTemplates,
      next.resourceTemplates,
      (template) => template.uriTemplate,
      (template) => template.definitionHash,
    ),
    ...compareCatalogItems(
      "prompt",
      previous.prompts,
      next.prompts,
      (prompt) => prompt.name,
      (prompt) => prompt.definitionHash,
    ),
  ];

  return {
    changed: previous.catalogHash !== next.catalogHash,
    ...(previous.catalogHash ? { previousCatalogHash: previous.catalogHash } : {}),
    nextCatalogHash: next.catalogHash ?? createMcpMetadataHash(next),
    changes,
  };
};

const cleanResourceForDefinitionHash = (
  resource: McpDiscoveredResource,
): Record<string, unknown> => {
  return {
    uri: resource.uri,
    name: resource.name,
    title: resource.title ?? null,
    description: resource.description ?? null,
    mimeType: resource.mimeType ?? null,
    size: resource.size ?? null,
  };
};

const cleanResourceTemplateForDefinitionHash = (
  template: McpDiscoveredResourceTemplate,
): Record<string, unknown> => {
  return {
    uriTemplate: template.uriTemplate,
    name: template.name,
    title: template.title ?? null,
    description: template.description ?? null,
    mimeType: template.mimeType ?? null,
  };
};

const cleanPromptForDefinitionHash = (
  prompt: McpDiscoveredPrompt,
): Record<string, unknown> => {
  return {
    name: prompt.name,
    title: prompt.title ?? null,
    description: prompt.description ?? null,
    arguments: prompt.arguments ?? [],
  };
};

const enrichToolMetadata = (tool: McpDiscoveredTool): McpDiscoveredTool => {
  const descriptionHash = createTextHash(tool.description);

  return {
    ...tool,
    ...(descriptionHash ? { descriptionHash } : {}),
    inputSchemaHash: createMcpMetadataHash(tool.inputSchema),
    ...(tool.outputSchema
      ? {
          outputSchemaHash: createMcpMetadataHash(tool.outputSchema),
        }
      : {}),
    definitionHash: createMcpMetadataHash(cleanToolForDefinitionHash(tool)),
  };
};

const enrichResourceMetadata = (
  resource: McpDiscoveredResource,
): McpDiscoveredResource => {
  return {
    ...resource,
    definitionHash: createMcpMetadataHash(cleanResourceForDefinitionHash(resource)),
  };
};

const enrichResourceTemplateMetadata = (
  template: McpDiscoveredResourceTemplate,
): McpDiscoveredResourceTemplate => {
  return {
    ...template,
    definitionHash:
      createMcpMetadataHash(cleanResourceTemplateForDefinitionHash(template)),
  };
};

const enrichPromptMetadata = (
  prompt: McpDiscoveredPrompt,
): McpDiscoveredPrompt => {
  const descriptionHash = createTextHash(prompt.description);

  return {
    ...prompt,
    ...(descriptionHash ? { descriptionHash } : {}),
    definitionHash: createMcpMetadataHash(cleanPromptForDefinitionHash(prompt)),
  };
};

const createToolCatalogHash = (tools: McpDiscoveredTool[]): string => {
  return createMcpMetadataHash(
    tools
      .map((tool) => ({
        name: tool.name,
        inputSchemaHash: tool.inputSchemaHash,
        outputSchemaHash: tool.outputSchemaHash ?? null,
        descriptionHash: tool.descriptionHash ?? null,
        definitionHash: tool.definitionHash,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );
};

const createResourceCatalogHash = (
  resources: McpDiscoveredResource[],
  resourceTemplates: McpDiscoveredResourceTemplate[],
): string => {
  return createMcpMetadataHash({
    resources: resources
      .map((resource) => ({
        uri: resource.uri,
        definitionHash: resource.definitionHash,
      }))
      .sort((left, right) => left.uri.localeCompare(right.uri)),
    resourceTemplates: resourceTemplates
      .map((template) => ({
        uriTemplate: template.uriTemplate,
        definitionHash: template.definitionHash,
      }))
      .sort((left, right) =>
        left.uriTemplate.localeCompare(right.uriTemplate),
      ),
  });
};

const createPromptCatalogHash = (prompts: McpDiscoveredPrompt[]): string => {
  return createMcpMetadataHash(
    prompts
      .map((prompt) => ({
        name: prompt.name,
        descriptionHash: prompt.descriptionHash ?? null,
        definitionHash: prompt.definitionHash,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );
};

export const enrichMcpDiscoveryMetadata = (
  discovery: McpServerDiscovery,
): McpServerDiscovery => {
  const tools = discovery.tools.map(enrichToolMetadata);
  const resources = discovery.resources.map(enrichResourceMetadata);
  const resourceTemplates = discovery.resourceTemplates.map(
    enrichResourceTemplateMetadata,
  );
  const prompts = discovery.prompts.map(enrichPromptMetadata);
  const capabilitiesHash = discovery.capabilities
    ? createMcpMetadataHash(discovery.capabilities)
    : undefined;
  const toolCatalogHash = createToolCatalogHash(tools);
  const resourceCatalogHash = createResourceCatalogHash(
    resources,
    resourceTemplates,
  );
  const promptCatalogHash = createPromptCatalogHash(prompts);
  const catalogHash = createMcpMetadataHash({
    capabilitiesHash: capabilitiesHash ?? null,
    toolCatalogHash,
    resourceCatalogHash,
    promptCatalogHash,
  });

  return {
    ...discovery,
    ...(capabilitiesHash ? { capabilitiesHash } : {}),
    catalogHash,
    toolCatalogHash,
    resourceCatalogHash,
    promptCatalogHash,
    tools,
    resources,
    resourceTemplates,
    prompts,
  };
};
