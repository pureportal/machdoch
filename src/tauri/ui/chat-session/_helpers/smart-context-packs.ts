import type {
  ReasoningMode,
  RunMode,
} from "../../../../core/runtime-contract.generated.js";
import type {
  ChatSessionContextAttachment,
  ShellPersistedState,
  SmartContextPack,
  SmartContextPackVariable,
} from "../../chat-session.model";
import { createSession, normalizeShellState } from "../../chat-session.model";
import { getProviderLabel, type RuntimeProvider } from "../../model-catalog";
import { mergeContextAttachments } from "./session-context-attachments";

export interface SaveSmartContextPackInput {
  id?: string;
  name: string;
  scope: SmartContextPackScope;
  instructions: string;
  prompt: string;
  contextAttachments: ChatSessionContextAttachment[];
  variables: Array<string | SmartContextPackVariable>;
  triggerPhrases: string[];
  triggerPathPatterns: string[];
  autoApply: boolean;
  provider?: RuntimeProvider;
  model?: string;
  mode?: RunMode;
  reasoning?: ReasoningMode;
}

export interface SmartContextPackComposerApplication {
  draft: string;
  contextAttachments: ChatSessionContextAttachment[];
}

export interface SmartContextPackMatchInput {
  draft: string;
  contextAttachments: ChatSessionContextAttachment[];
}

export interface SmartContextPackPreview {
  attachmentCount: number;
  promptFileCount: number;
  skillFileCount: number;
  estimatedTokens: number;
  warnings: string[];
}

export type SmartContextPackScope = "workspace" | "global";

export type SmartContextPackScopeFilter = SmartContextPackScope | "all";

export interface SmartContextPackExportPayload {
  kind: "machdoch.context-packs";
  version: 1;
  exportedAt: number;
  contextPacks: SmartContextPack[];
}

const PATH_PATTERN_CACHE_LIMIT = 256;
const pathPatternRegExpCache = new Map<string, RegExp>();

export const getSmartContextPackSortTimestamp = (
  pack: Pick<SmartContextPack, "createdAt" | "lastUsedAt" | "updatedAt">,
): number => {
  return Math.max(pack.lastUsedAt ?? 0, pack.updatedAt, pack.createdAt);
};

const getWorkspaceComparisonKey = (workspace: string | null): string => {
  const normalized = workspace?.replace(/\\/gu, "/").replace(/\/+$/u, "").trim();

  if (!normalized) {
    return "";
  }

  return /^[A-Za-z]:\//u.test(normalized) ? normalized.toLowerCase() : normalized;
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

const cloneJson = <T>(value: T): T => {
  return JSON.parse(JSON.stringify(value)) as T;
};

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

const replaceSmartContextPackVariables = (
  value: string,
  variables: SmartContextPackVariable[],
  variableValues: Record<string, string>,
): string => {
  const replacementByName = new Map<string, string>();

  for (const variable of variables) {
    const valueForVariable =
      variableValues[variable.name]?.trim() ?? variable.defaultValue ?? "";

    if (valueForVariable) {
      replacementByName.set(variable.name, valueForVariable);
    }
  }

  return value.replace(
    /\{([A-Za-z][A-Za-z0-9_-]{0,39})\}/gu,
    (raw, name: string, offset: number, fullValue: string) => {
      const endIndex = offset + raw.length;

      if (fullValue[offset - 1] === "{" || fullValue[endIndex] === "}") {
        return raw;
      }

      return replacementByName.get(name) ?? raw;
    },
  );
};

export const getSmartContextPackMissingVariableNames = (
  pack: SmartContextPack,
  variableValues: Record<string, string>,
): string[] => {
  const missingVariableNames: string[] = [];

  for (const variable of pack.variables) {
    if (variableValues[variable.name]?.trim() || variable.defaultValue?.trim()) {
      continue;
    }

    missingVariableNames.push(variable.name);
  }

  return missingVariableNames;
};

export const createSmartContextPackDraftBlock = (
  pack: SmartContextPack,
  variableValues: Record<string, string> = {},
): string => {
  const sections = [`## Context Pack: ${pack.name}`];
  const instructions = replaceSmartContextPackVariables(
    pack.instructions,
    pack.variables,
    variableValues,
  ).trim();
  const prompt = replaceSmartContextPackVariables(
    pack.prompt,
    pack.variables,
    variableValues,
  ).trim();

  if (instructions) {
    sections.push(`### Instructions\n${instructions}`);
  }

  if (prompt) {
    sections.push(`### Prompt\n${prompt}`);
  }

  const promptFiles = pack.contextAttachments.filter(isPromptFileAttachment);
  const skillFiles = pack.contextAttachments.filter(isSkillFileAttachment);

  if (promptFiles.length > 0) {
    sections.push(
      [
        "### Prompt files",
        ...promptFiles.map(
          (attachment) =>
            `- ${getPromptFileInvocationLabel(attachment)} (${attachment.path})`,
        ),
      ].join("\n"),
    );
  }

  if (skillFiles.length > 0) {
    sections.push(
      [
        "### Skill files",
        ...skillFiles.map(
          (attachment) =>
            `- ${getSkillFileDisplayName(attachment)} (${attachment.path})`,
        ),
      ].join("\n"),
    );
  }

  return sections.length > 1 ? sections.join("\n\n") : "";
};

const applySmartContextPackToDraft = (
  draft: string,
  packDraftBlock: string,
): string => {
  if (!packDraftBlock) {
    return draft;
  }

  const normalizedDraft = draft.trim();

  if (!normalizedDraft) {
    return packDraftBlock;
  }

  return `${packDraftBlock}\n\n## Current Task\n${normalizedDraft}`;
};

export const applySmartContextPackToComposer = (
  draft: string,
  contextAttachments: ChatSessionContextAttachment[],
  pack: SmartContextPack,
  variableValues: Record<string, string> = {},
): SmartContextPackComposerApplication => {
  const packDraftBlock = createSmartContextPackDraftBlock(pack, variableValues);
  const clonedAttachments = cloneContextAttachmentsForPack(
    pack.contextAttachments,
  );

  return {
    draft: applySmartContextPackToDraft(draft, packDraftBlock),
    contextAttachments: mergeContextAttachments(
      contextAttachments,
      clonedAttachments,
    ),
  };
};

export const isSmartContextPackAppliedToDraft = (
  draft: string,
  pack: SmartContextPack,
): boolean => draft.includes(`## Context Pack: ${pack.name}`);

const normalizeTriggerSearchText = (value: string): string => {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
};

const normalizeTriggerPath = (value: string): string => {
  return value.replace(/\\/gu, "/").trim().toLowerCase();
};

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
};

const createPathPatternRegExp = (normalizedPattern: string): RegExp => {
  const regexSource = escapeRegExp(normalizedPattern)
    .replace(/\\\*\\\*/gu, ".*")
    .replace(/\\\*/gu, "[^/]*")
    .replace(/\\\?/gu, "[^/]");

  return new RegExp(`(^|/)${regexSource}$`, "u");
};

const getPathPatternRegExp = (normalizedPattern: string): RegExp => {
  const cachedRegExp = pathPatternRegExpCache.get(normalizedPattern);

  if (cachedRegExp) {
    return cachedRegExp;
  }

  const regExp = createPathPatternRegExp(normalizedPattern);

  if (pathPatternRegExpCache.size >= PATH_PATTERN_CACHE_LIMIT) {
    const oldestKey = pathPatternRegExpCache.keys().next().value;

    if (oldestKey) {
      pathPatternRegExpCache.delete(oldestKey);
    }
  }

  pathPatternRegExpCache.set(normalizedPattern, regExp);

  return regExp;
};

const pathMatchesPattern = (path: string, pattern: string): boolean => {
  const normalizedPath = normalizeTriggerPath(path);
  const normalizedPattern = normalizeTriggerPath(pattern);

  if (!normalizedPath || !normalizedPattern) {
    return false;
  }

  return getPathPatternRegExp(normalizedPattern).test(normalizedPath);
};

export const doesSmartContextPackMatchComposer = (
  pack: SmartContextPack,
  input: SmartContextPackMatchInput,
): boolean => {
  if (
    pack.trigger.phrases.length === 0 &&
    pack.trigger.pathPatterns.length === 0
  ) {
    return false;
  }

  const searchText = normalizeTriggerSearchText(input.draft);

  if (
    pack.trigger.phrases.some((phrase) =>
      searchText.includes(normalizeTriggerSearchText(phrase)),
    )
  ) {
    return true;
  }

  if (
    input.contextAttachments.length === 0 ||
    pack.trigger.pathPatterns.length === 0
  ) {
    return false;
  }

  return input.contextAttachments.some((attachment) =>
    pack.trigger.pathPatterns.some((pattern) =>
      pathMatchesPattern(attachment.path, pattern) ||
      pathMatchesPattern(attachment.name, pattern),
    ),
  );
};

const hasSensitivePathSegment = (
  attachment: ChatSessionContextAttachment,
): boolean => {
  const normalizedPath = attachment.path.replace(/\\/gu, "/").toLowerCase();

  return /(^|\/)(\.env|id_rsa|id_dsa|\.ssh|secrets?)(\/|$)/u.test(
    normalizedPath,
  ) || /\.(pem|key|p12|pfx)$/u.test(normalizedPath);
};

const getNormalizedAttachmentPath = (
  attachment: ChatSessionContextAttachment,
): string => attachment.path.replace(/\\/gu, "/");

export const isPromptFileAttachment = (
  attachment: ChatSessionContextAttachment,
): boolean => getNormalizedAttachmentPath(attachment).endsWith(".prompt.md");

export const isSkillFileAttachment = (
  attachment: ChatSessionContextAttachment,
): boolean => /(^|\/)SKILL\.md$/u.test(getNormalizedAttachmentPath(attachment));

const getFileNameWithoutSuffix = (name: string, suffix: string): string => {
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
};

export const getPromptFileInvocationLabel = (
  attachment: ChatSessionContextAttachment,
): string => {
  const fallbackName =
    getNormalizedAttachmentPath(attachment).split("/").at(-1) ?? "";
  const normalizedName = getFileNameWithoutSuffix(
    attachment.name || fallbackName,
    ".prompt.md",
  ).trim();

  return normalizedName ? `/${normalizedName}` : attachment.path;
};

export const getSkillFileDisplayName = (
  attachment: ChatSessionContextAttachment,
): string => {
  const pathParts = getNormalizedAttachmentPath(attachment)
    .split("/")
    .filter(Boolean);
  const parentName = pathParts.at(-2);

  return parentName?.trim() || attachment.name || attachment.path;
};

export const createSmartContextPackPreview = (
  pack: SmartContextPack,
  options: { imageInputSupported: boolean },
): SmartContextPackPreview => {
  let attachmentPathChars = 0;
  let imageCount = 0;
  let hasDirectory = false;
  let hasSensitivePaths = false;
  let promptFileCount = 0;
  let skillFileCount = 0;

  for (const attachment of pack.contextAttachments) {
    attachmentPathChars += attachment.path.length + attachment.name.length;

    if (attachment.kind === "image") {
      imageCount += 1;
    }

    if (attachment.kind === "directory") {
      hasDirectory = true;
    }

    if (hasSensitivePathSegment(attachment)) {
      hasSensitivePaths = true;
    }

    if (isPromptFileAttachment(attachment)) {
      promptFileCount += 1;
    }

    if (isSkillFileAttachment(attachment)) {
      skillFileCount += 1;
    }
  }

  const textChars =
    pack.name.length +
    pack.instructions.length +
    pack.prompt.length +
    attachmentPathChars;
  const warnings: string[] = [];

  if (pack.variables.length > 0) {
    warnings.push(
      `${pack.variables.length} variable${pack.variables.length === 1 ? "" : "s"}`,
    );
  }

  if (imageCount > 0 && !options.imageInputSupported) {
    warnings.push("image model required");
  }

  if (hasSensitivePaths) {
    warnings.push("sensitive paths");
  }

  if (hasDirectory) {
    warnings.push("folder size unknown");
  }

  if (pack.trigger.autoApply) {
    warnings.push("auto-apply");
  }

  return {
    attachmentCount: pack.contextAttachments.length,
    promptFileCount,
    skillFileCount,
    estimatedTokens: Math.max(1, Math.ceil(textChars / 4)),
    warnings,
  };
};

export const createContextPackSummary = (
  pack: Pick<
    SmartContextPack,
    | "contextAttachments"
    | "instructions"
    | "mode"
    | "reasoning"
    | "prompt"
    | "provider"
    | "model"
    | "trigger"
    | "variables"
  >,
): string[] => {
  const summary: string[] = [];
  const attachmentCounts = {
    files: 0,
    folders: 0,
    images: 0,
    other: 0,
    promptFiles: 0,
    skillFiles: 0,
  };

  if (pack.prompt.trim()) {
    summary.push("prompt");
  }

  if (pack.instructions.trim()) {
    summary.push("instructions");
  }

  if (pack.variables.length > 0) {
    summary.push(
      `${pack.variables.length} variable${pack.variables.length === 1 ? "" : "s"}`,
    );
  }

  for (const attachment of pack.contextAttachments) {
    if (isPromptFileAttachment(attachment)) {
      attachmentCounts.promptFiles += 1;
    }

    if (isSkillFileAttachment(attachment)) {
      attachmentCounts.skillFiles += 1;
    }

    switch (attachment.kind) {
      case "file":
        attachmentCounts.files += 1;
        break;
      case "directory":
        attachmentCounts.folders += 1;
        break;
      case "image":
        attachmentCounts.images += 1;
        break;
      case "other":
      default:
        attachmentCounts.other += 1;
        break;
    }
  }

  if (attachmentCounts.files > 0) {
    summary.push(
      `${attachmentCounts.files} file${attachmentCounts.files === 1 ? "" : "s"}`,
    );
  }

  if (attachmentCounts.promptFiles > 0) {
    summary.push(
      `${attachmentCounts.promptFiles} prompt file${
        attachmentCounts.promptFiles === 1 ? "" : "s"
      }`,
    );
  }

  if (attachmentCounts.skillFiles > 0) {
    summary.push(
      `${attachmentCounts.skillFiles} skill file${
        attachmentCounts.skillFiles === 1 ? "" : "s"
      }`,
    );
  }

  if (attachmentCounts.folders > 0) {
    summary.push(
      `${attachmentCounts.folders} folder${attachmentCounts.folders === 1 ? "" : "s"}`,
    );
  }

  if (attachmentCounts.images > 0) {
    summary.push(
      `${attachmentCounts.images} image${attachmentCounts.images === 1 ? "" : "s"}`,
    );
  }

  if (attachmentCounts.other > 0) {
    summary.push(
      `${attachmentCounts.other} path${attachmentCounts.other === 1 ? "" : "s"}`,
    );
  }

  if (pack.mode) {
    summary.push(getContextPackModeLabel(pack.mode));
  }

  if (pack.reasoning) {
    summary.push(getContextPackReasoningLabel(pack.reasoning));
  }

  if (pack.provider && pack.model) {
    summary.push(`${getProviderLabel(pack.provider)} / ${pack.model}`);
  }

  if (pack.trigger.phrases.length > 0 || pack.trigger.pathPatterns.length > 0) {
    summary.push(pack.trigger.autoApply ? "auto trigger" : "trigger");
  }

  return summary;
};

export const createSmartContextPackExportPayload = (
  packs: SmartContextPack[],
  timestamp = Date.now(),
): SmartContextPackExportPayload => {
  return {
    kind: "machdoch.context-packs",
    version: 1,
    exportedAt: timestamp,
    contextPacks: cloneJson(packs),
  };
};

const parseSmartContextPackExportPayload = (
  value: unknown,
): SmartContextPackExportPayload => {
  if (!value || typeof value !== "object") {
    throw new Error("Context pack import file is not valid JSON.");
  }

  const candidate = value as Partial<SmartContextPackExportPayload>;

  if (
    candidate.kind !== "machdoch.context-packs" ||
    candidate.version !== 1 ||
    !Array.isArray(candidate.contextPacks)
  ) {
    throw new Error("Context pack import file is not a supported machdoch export.");
  }

  return {
    kind: "machdoch.context-packs",
    version: 1,
    exportedAt:
      typeof candidate.exportedAt === "number" ? candidate.exportedAt : Date.now(),
    contextPacks: candidate.contextPacks,
  };
};

export const importSmartContextPacksIntoShellState = (
  state: ShellPersistedState,
  rawPayload: unknown,
  targetWorkspace: string | null,
  targetScope: SmartContextPackScope = "workspace",
  timestamp = Date.now(),
): ShellPersistedState => {
  const payload = parseSmartContextPackExportPayload(rawPayload);
  const fallbackSession = createSession();
  const normalizedImportState = normalizeShellState({
    ...state,
    activeSessionId: state.activeSessionId || fallbackSession.id,
    sessions: state.sessions.length > 0 ? state.sessions : [fallbackSession],
    contextPacks: payload.contextPacks,
  });
  const existingIds = new Set(state.contextPacks.map((pack) => pack.id));
  const importedPacks = normalizedImportState.contextPacks.map((pack, index) => {
    const id = existingIds.has(pack.id) ? crypto.randomUUID() : pack.id;

    existingIds.add(id);

    return {
      ...pack,
      id,
      workspace: targetScope === "global" ? null : targetWorkspace,
      createdAt: timestamp + index,
      updatedAt: timestamp + index,
      useCount: 0,
    };
  });

  if (importedPacks.length === 0) {
    throw new Error("Context pack import file does not contain importable packs.");
  }

  return {
    ...state,
    contextPacks: [...importedPacks, ...state.contextPacks],
  };
};
