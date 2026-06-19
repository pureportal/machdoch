import { coerceRalphFlowBlockRecord } from "./coerce-ralph-flow-block-record.helper.js";
import { RALPH_FLOW_SCHEMA_VERSION } from "./create-ralph-validation-result.helper.js";
import type {
  RalphAnnotationLink, RalphAnnotationLinkKind, RalphFlow, RalphFlowBlock,
  RalphFlowEdge, RalphFlowSettings, RalphFlowVariable, RalphVariableType,
} from "../ralph.js";

const RALPH_FLOW_VARIABLE_TYPES = [
  "string", "text", "path", "file", "files", "url", "number", "boolean",
  "image", "images", "model", "provider", "pack",
] as const satisfies readonly RalphVariableType[];

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isRalphFlowVariableType = (
  value: string,
): value is RalphVariableType => {
  return RALPH_FLOW_VARIABLE_TYPES.includes(value as RalphVariableType);
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
        isRecord(block) ? [coerceRalphFlowBlockRecord(block)] : [],
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
