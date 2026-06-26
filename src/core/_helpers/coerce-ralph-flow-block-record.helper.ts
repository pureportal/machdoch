import { coerceRalphAttachmentReferences } from "./coerce-ralph-attachment-references.helper.js";
import { coerceRalphUtilityConfig } from "./coerce-ralph-utility-config.helper.js";
import { coerceMcpConfigOverride } from "../mcp/config.js";
import { isReasoningMode } from "../runtime-contract.generated.js";
import type {
  RalphAnnotationTone,
  RalphAskUserMode,
  RalphBaseBlock,
  RalphBlockSettings,
  RalphBlockType,
  RalphFlowBlock,
  RalphGroupExecutionBoundary,
  RalphInputField,
  RalphInputFieldType,
  RalphInputOption,
  RalphInputValue,
  RalphPosition,
  RalphRetryPolicy,
  RalphSize,
  RalphValidationScope,
  RalphWorkspaceSetting,
} from "../ralph.js";
import type { ModelProvider } from "../runtime-contract.generated.js";

const RALPH_FLOW_BLOCK_TYPES = [
  "START", "PROMPT", "VALIDATOR", "DECISION", "PACK", "ASK_USER", "INTERVIEW", "UTILITY",
  "MCP_TOOL", "MCP_RESOURCE", "MCP_PROMPT", "NOTE", "GROUP", "END",
] as const satisfies readonly RalphBlockType[];

const RALPH_INPUT_FIELD_TYPES = [
  "text", "textarea", "number", "boolean", "select", "multiselect", "url",
  "path", "file", "files", "image", "images",
] as const satisfies readonly RalphInputFieldType[];

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isRalphFlowBlockType = (value: unknown): value is RalphBlockType => {
  return (
    typeof value === "string" &&
    RALPH_FLOW_BLOCK_TYPES.includes(value as RalphBlockType)
  );
};

const isRalphInputFieldType = (value: unknown): value is RalphInputFieldType => {
  return (
    typeof value === "string" &&
    RALPH_INPUT_FIELD_TYPES.includes(value as RalphInputFieldType)
  );
};

const coerceStringArray = (value: unknown): string[] => {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
};

const coerceInputValue = (value: unknown): RalphInputValue | undefined => {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  return undefined;
};

const coerceInputOptions = (value: unknown): RalphInputOption[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry): RalphInputOption[] => {
    if (typeof entry === "string") {
      return [{ value: entry, label: entry }];
    }

    if (!isRecord(entry)) {
      return [];
    }

    const optionValue = typeof entry.value === "string" ? entry.value : "";
    const optionLabel = typeof entry.label === "string" ? entry.label : optionValue;

    return optionValue ? [{ value: optionValue, label: optionLabel }] : [];
  });
};

const coerceInputFieldValidation = (
  value: unknown,
): RalphInputField["validation"] | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const validation: NonNullable<RalphInputField["validation"]> = {};
  for (const key of ["min", "max", "step", "minLength", "maxLength"] as const) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) {
      validation[key] = value[key];
    }
  }

  if (typeof value.pattern === "string") {
    validation.pattern = value.pattern;
  }

  return Object.keys(validation).length > 0 ? validation : undefined;
};

const coerceInputFields = (value: unknown): RalphInputField[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry): RalphInputField[] => {
    if (!isRecord(entry)) {
      return [];
    }

    const defaultValue = coerceInputValue(entry.defaultValue ?? entry.default);
    const validation = coerceInputFieldValidation(entry.validation);

    return [
      {
        id: typeof entry.id === "string" ? entry.id : "",
        label: typeof entry.label === "string" ? entry.label : "",
        type: isRalphInputFieldType(entry.type) ? entry.type : "text",
        ...(typeof entry.required === "boolean" ? { required: entry.required } : {}),
        ...(typeof entry.skippable === "boolean" ? { skippable: entry.skippable } : {}),
        ...(typeof entry.placeholder === "string" ? { placeholder: entry.placeholder } : {}),
        ...(typeof entry.help === "string" ? { help: entry.help } : {}),
        ...(defaultValue !== undefined ? { defaultValue } : {}),
        options: coerceInputOptions(entry.options),
        ...(validation ? { validation } : {}),
        ...(typeof entry.variableName === "string"
          ? { variableName: entry.variableName }
          : {}),
      },
    ];
  });
};

const coerceAskUserMode = (value: unknown): RalphAskUserMode | undefined => {
  return value === "alwaysAsk" || value === "confirmOnly" || value === "missingOnly"
    ? value
    : undefined;
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

export const coerceRalphFlowBlockRecord = (
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

  if (typeof record.locked === "boolean") {
    base.locked = record.locked;
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
    case "ASK_USER": {
      const mode = coerceAskUserMode(record.mode);

      return {
        ...base,
        type,
        ...(mode ? { mode } : {}),
        ...(typeof record.prompt === "string" ? { prompt: record.prompt } : {}),
        fields: coerceInputFields(record.fields),
        ...(typeof record.submitLabel === "string"
          ? { submitLabel: record.submitLabel }
          : {}),
        ...(typeof record.cancelLabel === "string"
          ? { cancelLabel: record.cancelLabel }
          : {}),
        ...(typeof record.timeoutSeconds === "number" || record.timeoutSeconds === null
          ? { timeoutSeconds: record.timeoutSeconds }
          : {}),
      };
    }
    case "INTERVIEW":
      return {
        ...base,
        type,
        prompt: typeof record.prompt === "string" ? record.prompt : "",
        ...(typeof record.completionCriteria === "string"
          ? { completionCriteria: record.completionCriteria }
          : {}),
        ...(typeof record.maxTurns === "number"
          ? { maxTurns: Math.trunc(record.maxTurns) }
          : {}),
        ...(typeof record.questionsPerTurn === "number"
          ? { questionsPerTurn: Math.trunc(record.questionsPerTurn) }
          : {}),
        ...(typeof record.outputVariableName === "string"
          ? { outputVariableName: record.outputVariableName }
          : {}),
        ...(typeof record.submitLabel === "string"
          ? { submitLabel: record.submitLabel }
          : {}),
        ...(typeof record.cancelLabel === "string"
          ? { cancelLabel: record.cancelLabel }
          : {}),
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
