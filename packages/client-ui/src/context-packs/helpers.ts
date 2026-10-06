import type {
  RunMode,
  ReasoningMode,
} from "@machdoch/fleet-protocol/runtime-options";
import type { ChatSessionContextAttachment } from "../composer/model";
import type {
  SmartContextPack,
  SmartContextPackVariable,
  SmartContextPackScope,
  SmartContextPackScopeFilter,
  SmartContextPackExportPayload,
} from "./model";

export const getSmartContextPackSortTimestamp = (
  pack: Pick<SmartContextPack, "createdAt" | "lastUsedAt" | "updatedAt">,
): number => {
  return Math.max(pack.lastUsedAt ?? 0, pack.updatedAt, pack.createdAt);
};

const getWorkspaceComparisonKey = (workspace: string | null): string => {
  const normalized = workspace
    ?.replace(/\\/gu, "/")
    .replace(/\/+$/u, "")
    .trim();

  if (!normalized) {
    return "";
  }

  return /^[A-Za-z]:\//u.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
};

export const areSmartContextPackWorkspacesEqual = (
  left: string | null,
  right: string | null,
): boolean => {
  return getWorkspaceComparisonKey(left) === getWorkspaceComparisonKey(right);
};

const cloneContextAttachment = (
  attachment: ChatSessionContextAttachment,
): ChatSessionContextAttachment => {
  return {
    ...attachment,
    id: crypto.randomUUID(),
  };
};

export const cloneContextAttachmentsForPack = (
  attachments: ChatSessionContextAttachment[],
): ChatSessionContextAttachment[] => attachments.map(cloneContextAttachment);

export const getSmartContextPacksForWorkspace = (
  packs: SmartContextPack[],
  workspace: string | null,
): SmartContextPack[] => {
  return packs.filter(
    (pack) =>
      getSmartContextPackScope(pack) === "global" ||
      areSmartContextPackWorkspacesEqual(pack.workspace, workspace),
  );
};

export const getSmartContextPackScope = (
  pack: Pick<SmartContextPack, "workspace">,
): SmartContextPackScope => (pack.workspace ? "workspace" : "global");

export const getSmartContextPackScopeLabel = (
  scope: SmartContextPackScope,
): string => (scope === "global" ? "Global" : "Workspace");

export const filterSmartContextPacksByScope = (
  packs: SmartContextPack[],
  scopeFilter: SmartContextPackScopeFilter,
): SmartContextPack[] => {
  if (scopeFilter === "all") {
    return packs;
  }

  return packs.filter((pack) => getSmartContextPackScope(pack) === scopeFilter);
};

export const getContextPackModeLabel = (mode: RunMode): string => {
  return mode === "ask" ? "Ask mode" : "Machdoch";
};

export const getContextPackReasoningLabel = (
  reasoning: ReasoningMode,
): string => {
  if (reasoning === "default") {
    return "Provider default reasoning";
  }

  return `${reasoning} reasoning`;
};

const normalizeVariableName = (value: string): string => {
  const name = value
    .replace(/^\{|\}$/gu, "")
    .trim()
    .replace(/[^A-Za-z0-9_-]/gu, "_");

  return /^[A-Za-z]/u.test(name) ? name : "";
};

export const parseSmartContextPackListInput = (value: string): string[] => {
  const seenEntries = new Set<string>();
  const entries: string[] = [];

  for (const entry of value.split(/[\n,]/u)) {
    const normalized = entry.replace(/\s+/gu, " ").trim();
    const key = normalized.toLowerCase();

    if (!normalized || seenEntries.has(key)) {
      continue;
    }

    seenEntries.add(key);
    entries.push(normalized);
  }

  return entries;
};

export const parseSmartContextPackVariableInput = (
  value: string,
): SmartContextPackVariable[] => {
  const variables: SmartContextPackVariable[] = [];
  const seenVariables = new Set<string>();

  for (const entry of value.split(/[\n,]/u)) {
    const normalized = entry.replace(/\s+/gu, " ").trim();

    if (!normalized) {
      continue;
    }

    const [rawName = "", ...defaultParts] = normalized.split("=");
    const name = normalizeVariableName(rawName);
    const key = name.toLowerCase();

    if (!name || seenVariables.has(key)) {
      continue;
    }

    seenVariables.add(key);

    const defaultValue = defaultParts.join("=").trim();

    variables.push({
      name,
      ...(defaultValue ? { defaultValue } : {}),
    });
  }

  return variables;
};

export const extractSmartContextPackVariables = (
  ...values: string[]
): string[] => {
  const variables: string[] = [];
  const seenVariables = new Set<string>();
  const variablePattern = /\{([A-Za-z][A-Za-z0-9_-]{0,39})\}/gu;

  for (const value of values) {
    for (const match of value.matchAll(variablePattern)) {
      const startIndex = match.index ?? 0;
      const endIndex = startIndex + (match[0]?.length ?? 0);

      if (value[startIndex - 1] === "{" || value[endIndex] === "}") {
        continue;
      }

      const name = normalizeVariableName(match[1] ?? "");
      const key = name.toLowerCase();

      if (!name || seenVariables.has(key)) {
        continue;
      }

      seenVariables.add(key);
      variables.push(name);
    }
  }

  return variables;
};

export const createSmartContextPackVariables = (
  variableEntries: Array<string | SmartContextPackVariable>,
): SmartContextPackVariable[] => {
  const variables: SmartContextPackVariable[] = [];
  const seenVariables = new Set<string>();

  for (const variableEntry of variableEntries) {
    const name = normalizeVariableName(
      typeof variableEntry === "string" ? variableEntry : variableEntry.name,
    );
    const key = name.toLowerCase();

    if (!name || seenVariables.has(key)) {
      continue;
    }

    seenVariables.add(key);

    const defaultValue =
      typeof variableEntry === "string"
        ? ""
        : variableEntry.defaultValue?.replace(/\s+/gu, " ").trim();

    variables.push({
      name,
      ...(defaultValue ? { defaultValue } : {}),
    });
  }

  return variables;
};

export const getSmartContextPackMissingVariableNames = (
  pack: SmartContextPack,
  variableValues: Record<string, string>,
): string[] => {
  const missingVariableNames: string[] = [];

  for (const variable of pack.variables) {
    if (
      variableValues[variable.name]?.trim() ||
      variable.defaultValue?.trim()
    ) {
      continue;
    }

    missingVariableNames.push(variable.name);
  }

  return missingVariableNames;
};

export const createSmartContextPackExportPayload = (
  packs: SmartContextPack[],
  timestamp = Date.now(),
): SmartContextPackExportPayload => {
  return {
    kind: "machdoch.context-packs",
    version: 1,
    exportedAt: timestamp,
    contextPacks: JSON.parse(JSON.stringify(packs)) as SmartContextPack[],
  };
};
