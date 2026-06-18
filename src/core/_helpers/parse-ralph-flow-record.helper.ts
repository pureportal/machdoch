import { coerceRalphAttachmentReferences } from "./coerce-ralph-attachment-references.helper.js";
import { coerceRalphUtilityConfig } from "./coerce-ralph-utility-config.helper.js";
import { RALPH_FLOW_SCHEMA_VERSION } from "./create-ralph-validation-result.helper.js";
import { coerceMcpConfigOverride } from "../mcp/config.js";
import { isReasoningMode } from "../runtime-contract.generated.js";
import type {
  RalphAnnotationLink, RalphAnnotationLinkKind, RalphAnnotationTone, RalphBaseBlock,
  RalphBlockSettings, RalphBlockType, RalphFlow, RalphFlowBlock, RalphFlowEdge,
  RalphFlowSettings, RalphFlowVariable, RalphGroupExecutionBoundary, RalphPosition,
  RalphRetryPolicy, RalphSize, RalphValidationScope, RalphVariableType,
  RalphWorkspaceSetting,
} from "../ralph.js";
import type { ModelProvider } from "../runtime-contract.generated.js";

const RALPH_FLOW_BLOCK_TYPES = [
  "START", "PROMPT", "VALIDATOR", "DECISION", "PACK", "UTILITY",
  "MCP_TOOL", "MCP_RESOURCE", "MCP_PROMPT", "NOTE", "GROUP", "END",
] as const satisfies readonly RalphBlockType[];

const RALPH_FLOW_VARIABLE_TYPES = [
  "string", "text", "path", "file", "files", "url", "number", "boolean",
  "image", "images", "model", "provider", "pack",
] as const satisfies readonly RalphVariableType[];

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isRalphFlowBlockType = (value: unknown): value is RalphBlockType => {
  return (
    typeof value === "string" &&
    RALPH_FLOW_BLOCK_TYPES.includes(value as RalphBlockType)
  );
};

const isRalphFlowVariableType = (
  value: string,
): value is RalphVariableType => {
  return RALPH_FLOW_VARIABLE_TYPES.includes(value as RalphVariableType);
};

const coerceStringArray = (value: unknown): string[] => {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
};

const coerceStringAlias = (
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  for (const key of keys) {
    const value = record[key];

    if (typeof value === "string") {
      return value;
    }
  }

  return undefined;
};

const coercePosition = (value: unknown): RalphPosition | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const x = typeof value.x === "number" ? value.x : undefined;
  const y = typeof value.y === "number" ? value.y : undefined;

  return x !== undefined && y !== undefined ? { x, y } : undefined;
};

const coerceSize = (value: unknown): RalphSize | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const width = typeof value.width === "number" ? value.width : undefined;
  const height = typeof value.height === "number" ? value.height : undefined;

  return width !== undefined && height !== undefined ? { width, height } : undefined;
};

const coerceAnnotationTone = (
  value: unknown,
): RalphAnnotationTone | undefined => {
  return value === "slate" ||
    value === "amber" ||
    value === "sky" ||
    value === "lime" ||
    value === "rose" ||
    value === "violet"
    ? value
    : undefined;
};

const coerceGroupExecutionBoundary = (
  value: unknown,
): RalphGroupExecutionBoundary | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const mode =
    value.mode === "firstExecutableChild" || value.mode === "selectedChild"
      ? value.mode
      : "none";

  return {
    mode,
    ...(typeof value.blockId === "string" ? { blockId: value.blockId } : {}),
  };
};

const coerceAnnotationLinkKind = (
  value: unknown,
): RalphAnnotationLinkKind => {
  return value === "evidence" ||
    value === "todo" ||
    value === "related" ||
    value === "risk"
    ? value
    : "explains";
};

const coerceAnnotationLinks = (value: unknown): RalphAnnotationLink[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry): RalphAnnotationLink[] => {
    if (!isRecord(entry)) {
      return [];
    }

    return [
      {
        id: typeof entry.id === "string" ? entry.id : "",
        from: typeof entry.from === "string" ? entry.from : "",
        to: typeof entry.to === "string" ? entry.to : "",
        kind: coerceAnnotationLinkKind(entry.kind),
      },
    ];
  });
};

const coerceRetryPolicy = (value: unknown): RalphRetryPolicy | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const mode = value.mode === "finite" ? "finite" : "infinite";
  const maxRetries =
    typeof value.maxRetries === "number" ? value.maxRetries : null;
  const delaySeconds =
    typeof value.delaySeconds === "number" ? value.delaySeconds : undefined;

  return {
    mode,
    maxRetries,
    ...(delaySeconds !== undefined ? { delaySeconds } : {}),
  };
};

const coerceWorkspaceSetting = (
  value: unknown,
): RalphWorkspaceSetting | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.mode === "custom") {
    return {
      mode: "custom",
      ...(typeof value.path === "string" ? { path: value.path } : {}),
    };
  }

  return value.mode === "default" ? { mode: "default" } : undefined;
};

const coerceMcpArguments = (
  value: unknown,
): Record<string, unknown> | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  return { ...value };
};

const coerceSettings = (value: unknown): RalphBlockSettings | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const workspace = coerceWorkspaceSetting(value.workspace);
  const retry = coerceRetryPolicy(value.retry);
  const mcp = coerceMcpConfigOverride(value.mcp);
  const provider =
    typeof value.provider === "string"
      ? (value.provider as ModelProvider | "default")
      : undefined;
  const model = typeof value.model === "string" ? value.model : undefined;
  const reasoning =
    typeof value.reasoning === "string" && isReasoningMode(value.reasoning)
      ? value.reasoning
      : undefined;
  const timeoutSeconds =
    typeof value.timeoutSeconds === "number" ? value.timeoutSeconds : undefined;
  const temperature =
    typeof value.temperature === "number" ? value.temperature : undefined;
  const maxIterations =
    typeof value.maxIterations === "number" ? value.maxIterations : undefined;

  return {
    ...(workspace ? { workspace } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(typeof value.webAccess === "boolean"
      ? { webAccess: value.webAccess }
      : {}),
    ...(typeof value.fileAccess === "boolean"
      ? { fileAccess: value.fileAccess }
      : {}),
    attachments: coerceRalphAttachmentReferences(value.attachments),
    packs: coerceStringArray(value.packs),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(typeof value.internalValidatorEnabled === "boolean"
      ? { internalValidatorEnabled: value.internalValidatorEnabled }
      : {}),
    ...(retry ? { retry } : {}),
    ...(mcp ? { mcp } : {}),
  };
};

const coerceValidationScope = (
  value: unknown,
): RalphValidationScope | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const allowedModes: RalphValidationScope["mode"][] = [
    "sinceLastValidator",
    "previousBlock",
    "selectedBlocks",
    "wholeFlow",
  ];
  const mode = allowedModes.includes(value.mode as RalphValidationScope["mode"])
    ? (value.mode as RalphValidationScope["mode"])
    : "sinceLastValidator";

  return {
    mode,
    blockIds: coerceStringArray(value.blockIds),
  };
};

const coerceFlowSettings = (value: unknown): RalphFlowSettings | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const settings: RalphFlowSettings = {};

  if (
    typeof value.maxTransitions === "number" &&
    Number.isFinite(value.maxTransitions)
  ) {
    settings.maxTransitions = Math.trunc(value.maxTransitions);
  }

  return Object.keys(settings).length > 0 ? settings : undefined;
};

const coerceFlowBlockRecord = (
  record: Record<string, unknown>,
): RalphFlowBlock => {
  const type = isRalphFlowBlockType(record.type) ? record.type : "PROMPT";
  const base: Omit<RalphBaseBlock, "type"> = {
    id: typeof record.id === "string" ? record.id : "",
    title: typeof record.title === "string" ? record.title : "",
  };
  const position = coercePosition(record.position);
  const size = coerceSize(record.size);
  const settings = coerceSettings(record.settings);
  const parentGroupId =
    typeof record.parentGroupId === "string" ? record.parentGroupId : undefined;

  if (position) {
    base.position = position;
  }

  if (size) {
    base.size = size;
  }

  if (parentGroupId) {
    base.parentGroupId = parentGroupId;
  }

  if (settings) {
    base.settings = settings;
  }

  if (typeof record.groupBoundary === "boolean") {
    base.groupBoundary = record.groupBoundary;
  }

  switch (type) {
    case "START":
      return { ...base, type };
    case "PROMPT":
      return {
        ...base,
        type,
        prompt: typeof record.prompt === "string" ? record.prompt : "",
      };
    case "VALIDATOR": {
      const validationScope = coerceValidationScope(record.validationScope);
      return {
        ...base,
        type,
        prompt: typeof record.prompt === "string" ? record.prompt : "",
        ...(validationScope ? { validationScope } : {}),
      };
    }
    case "DECISION":
      return {
        ...base,
        type,
        prompt: typeof record.prompt === "string" ? record.prompt : "",
        labels: coerceStringArray(record.labels),
      };
    case "PACK":
      return {
        ...base,
        type,
        packIds: coerceStringArray(record.packIds),
        propagationMode:
          record.propagationMode === "untilOverridden"
            ? "untilOverridden"
            : "nextBlockOnly",
      };
    case "UTILITY":
      return {
        ...base,
        type,
        utility: coerceRalphUtilityConfig(record.utility),
      };
    case "MCP_TOOL": {
      const mcpArguments = coerceMcpArguments(record.arguments);
      return {
        ...base,
        type,
        serverId: typeof record.serverId === "string" ? record.serverId : "",
        toolName: typeof record.toolName === "string" ? record.toolName : "",
        ...(mcpArguments ? { arguments: mcpArguments } : {}),
      };
    }
    case "MCP_RESOURCE":
      return {
        ...base,
        type,
        serverId: typeof record.serverId === "string" ? record.serverId : "",
        uri: typeof record.uri === "string" ? record.uri : "",
      };
    case "MCP_PROMPT": {
      const mcpArguments = coerceMcpArguments(record.arguments);
      return {
        ...base,
        type,
        serverId: typeof record.serverId === "string" ? record.serverId : "",
        promptName:
          typeof record.promptName === "string" ? record.promptName : "",
        ...(mcpArguments ? { arguments: mcpArguments } : {}),
      };
    }
    case "NOTE": {
      const tone = coerceAnnotationTone(record.tone);
      return {
        ...base,
        type,
        text:
          coerceStringAlias(record, ["text", "note", "content", "body"]) ?? "",
        ...(tone ? { tone } : {}),
        tags: coerceStringArray(record.tags),
        ...(typeof record.collapsed === "boolean"
          ? { collapsed: record.collapsed }
          : {}),
        pinnedBlockIds: coerceStringArray(record.pinnedBlockIds),
      };
    }
    case "GROUP": {
      const tone = coerceAnnotationTone(record.tone);
      const executionBoundary = coerceGroupExecutionBoundary(
        record.executionBoundary,
      );
      const layoutMode =
        record.layoutMode === "stack" || record.layoutMode === "swimlane"
          ? record.layoutMode
          : "freeform";

      return {
        ...base,
        type,
        ...(tone ? { tone } : {}),
        ...(typeof record.description === "string"
          ? { description: record.description }
          : {}),
        childBlockIds: coerceStringArray(record.childBlockIds),
        ...(typeof record.collapsed === "boolean"
          ? { collapsed: record.collapsed }
          : {}),
        ...(typeof record.locked === "boolean" ? { locked: record.locked } : {}),
        ...(typeof record.moveChildren === "boolean"
          ? { moveChildren: record.moveChildren }
          : {}),
        ...(typeof record.maxDepth === "number"
          ? { maxDepth: Math.trunc(record.maxDepth) }
          : {}),
        layoutMode,
        ...(executionBoundary ? { executionBoundary } : {}),
      };
    }
    case "END":
      return {
        ...base,
        type,
        status:
          record.status === "failed" ||
          record.status === "cancelled" ||
          record.status === "review"
            ? record.status
            : "success",
      };
  }
};

const coerceFlowEdges = (value: unknown): RalphFlowEdge[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((edge): RalphFlowEdge[] => {
    if (!isRecord(edge)) {
      return [];
    }

    return [
      {
        id: typeof edge.id === "string" ? edge.id : "",
        from: typeof edge.from === "string" ? edge.from : "",
        fromOutput: typeof edge.fromOutput === "string" ? edge.fromOutput : "",
        to: typeof edge.to === "string" ? edge.to : "",
      },
    ];
  });
};

const coerceFlowVariables = (value: unknown): RalphFlowVariable[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((variable): RalphFlowVariable[] => {
    if (!isRecord(variable)) {
      return [];
    }

    const type =
      typeof variable.type === "string" && isRalphFlowVariableType(variable.type)
        ? variable.type
        : "string";
    const name = typeof variable.name === "string" ? variable.name : "";
    const defaultValue =
      typeof variable.default === "string" ? variable.default : undefined;

    return [
      {
        name,
        type,
        ...(defaultValue !== undefined ? { default: defaultValue } : {}),
        required:
          typeof variable.required === "boolean"
            ? variable.required
            : defaultValue === undefined,
      },
    ];
  });
};

export const parseRalphFlowRecord = (value: unknown): RalphFlow => {
  if (!isRecord(value)) {
    throw new Error("Expected Ralph flow JSON to be an object.");
  }

  const schemaVersion =
    typeof value.schemaVersion === "number"
      ? value.schemaVersion
      : value.schemaVersion === undefined || value.schemaVersion === null
        ? RALPH_FLOW_SCHEMA_VERSION
        : Number.NaN;
  const blocks = Array.isArray(value.blocks)
    ? value.blocks.flatMap((block): RalphFlowBlock[] =>
        isRecord(block) ? [coerceFlowBlockRecord(block)] : [],
      )
    : [];
  const settings = coerceFlowSettings(value.settings);
  const annotationLinks = coerceAnnotationLinks(value.annotationLinks);

  return {
    schemaVersion: schemaVersion as typeof RALPH_FLOW_SCHEMA_VERSION,
    id: typeof value.id === "string" ? value.id : "",
    ...(typeof value.alias === "string" ? { alias: value.alias } : {}),
    name: typeof value.name === "string" ? value.name : "",
    ...(typeof value.description === "string"
      ? { description: value.description }
      : {}),
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
    ...(settings ? { settings } : {}),
    variables: coerceFlowVariables(value.variables),
    blocks,
    edges: coerceFlowEdges(value.edges),
    ...(annotationLinks.length > 0 ? { annotationLinks } : {}),
  };
};
