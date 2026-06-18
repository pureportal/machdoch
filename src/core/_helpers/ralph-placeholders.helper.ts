import type {
  RalphFlow,
  RalphFlowBlock,
  RalphFlowVariable,
  RalphVariableType,
} from "../ralph.js";

export const RALPH_PLACEHOLDER_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/gu;
const RALPH_PLACEHOLDER_VARIABLE_TYPES = [
  "string",
  "text",
  "path",
  "file",
  "files",
  "url",
  "number",
  "boolean",
  "image",
  "images",
  "model",
  "provider",
  "pack",
] as const satisfies readonly RalphVariableType[];

export interface RalphPlaceholderBlockReference {
  kind: "result" | "summary" | "error" | "data";
  blockId: string;
  path?: string;
}

export interface ParsedRalphPlaceholder {
  raw: string;
  content: string;
  variable?: RalphFlowVariable;
  builtin?: string;
  blockReference?: RalphPlaceholderBlockReference;
  invalid?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isRalphPlaceholderVariableType = (
  value: string,
): value is (typeof RALPH_PLACEHOLDER_VARIABLE_TYPES)[number] => {
  return RALPH_PLACEHOLDER_VARIABLE_TYPES.includes(
    value as (typeof RALPH_PLACEHOLDER_VARIABLE_TYPES)[number],
  );
};

export const parseRalphPlaceholderContent = (
  raw: string,
  content: string,
): ParsedRalphPlaceholder => {
  const builtinNames = new Set([
    "lastResult",
    "lastResultSummary",
    "lastError",
    "lastData",
    "runLog",
  ]);

  if (builtinNames.has(content)) {
    return { raw, content, builtin: content };
  }

  const blockReference = content.match(
    /^(result|summary|error|data):([a-z0-9][a-z0-9-]{0,79})(?::([\s\S]+))?$/u,
  );
  if (blockReference) {
    return {
      raw,
      content,
      blockReference: {
        kind: blockReference[1] as RalphPlaceholderBlockReference["kind"],
        blockId: blockReference[2] ?? "",
        ...(blockReference[3] ? { path: blockReference[3] } : {}),
      },
    };
  }

  const variableMatch = content.match(
    /^([A-Za-z_][A-Za-z0-9_]*)(?::([a-z][a-z0-9-]*))?(?:=([\s\S]*))?$/u,
  );
  if (!variableMatch) {
    return {
      raw,
      content,
      invalid: `placeholder \`${raw}\` has invalid Ralph variable syntax.`,
    };
  }

  const type = variableMatch[2] ?? "string";
  if (!isRalphPlaceholderVariableType(type)) {
    return {
      raw,
      content,
      invalid: `placeholder \`${raw}\` uses unsupported variable type \`${type}\`.`,
    };
  }

  const defaultValue = variableMatch[3];

  return {
    raw,
    content,
    variable: {
      name: variableMatch[1] ?? "",
      type,
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      required: defaultValue === undefined,
    },
  };
};

export const extractRalphPlaceholders = (
  text: string,
): ParsedRalphPlaceholder[] => {
  return [...text.matchAll(RALPH_PLACEHOLDER_PATTERN)].map((match) =>
    parseRalphPlaceholderContent(match[0] ?? "", (match[1] ?? "").trim()),
  );
};

export const hasRalphPlaceholders = (text: string): boolean => {
  return /\{\{\s*([^}]+?)\s*\}\}/u.test(text);
};

export const collectRalphTemplateTexts = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectRalphTemplateTexts);
  }

  if (isRecord(value)) {
    return Object.values(value).flatMap(collectRalphTemplateTexts);
  }

  return [];
};

export const getRalphPromptLikeTexts = (block: RalphFlowBlock): string[] => {
  switch (block.type) {
    case "PROMPT":
    case "VALIDATOR":
    case "DECISION":
      return [block.prompt];
    case "MCP_TOOL":
      return [
        block.serverId,
        block.toolName,
        ...collectRalphTemplateTexts(block.arguments),
      ];
    case "MCP_RESOURCE":
      return [block.serverId, block.uri];
    case "MCP_PROMPT":
      return [
        block.serverId,
        block.promptName,
        ...collectRalphTemplateTexts(block.arguments),
      ];
    case "UTILITY":
      return collectRalphTemplateTexts(block.utility);
    case "START":
    case "PACK":
    case "NOTE":
    case "GROUP":
    case "END":
      return [];
  }
};

export const isPlainRalphVariableReference = (value: string): boolean => {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(value.trim());
};

export const getRalphAttachmentTemplateTexts = (
  block: RalphFlowBlock,
): string[] => {
  return (
    block.settings?.attachments?.map((attachment) => {
      if (
        attachment.source === "variable" &&
        isPlainRalphVariableReference(attachment.value)
      ) {
        return `{{${attachment.value.trim()}:file}}`;
      }

      return attachment.value;
    }) ?? []
  );
};

export const discoverRalphFlowVariables = (
  flow: RalphFlow,
): RalphFlowVariable[] => {
  const variables = new Map<string, RalphFlowVariable>();

  for (const declared of flow.variables ?? []) {
    if (!declared.name.trim()) {
      continue;
    }

    variables.set(declared.name, declared);
  }

  for (const block of flow.blocks) {
    for (const text of [
      ...getRalphPromptLikeTexts(block),
      ...getRalphAttachmentTemplateTexts(block),
    ]) {
      for (const placeholder of extractRalphPlaceholders(text)) {
        if (!placeholder.variable) {
          continue;
        }

        const current = variables.get(placeholder.variable.name);
        variables.set(placeholder.variable.name, {
          ...placeholder.variable,
          ...(current?.default !== undefined
            ? { default: current.default, required: current.required }
            : {}),
          type: current?.type ?? placeholder.variable.type,
        });
      }
    }
  }

  for (const block of flow.blocks) {
    if (
      block.type === "UTILITY" &&
      block.utility.type === "SET_VARIABLE" &&
      block.utility.variableName?.trim()
    ) {
      const name = block.utility.variableName.trim();
      const current = variables.get(name);

      variables.set(name, {
        name,
        type: current?.type ?? "string",
        ...(current?.default !== undefined ? { default: current.default } : {}),
        required: false,
      });
    }
  }

  return [...variables.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
};
