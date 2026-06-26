import type {
  RalphExecutionOutput,
  RalphFlowBlock,
  RalphFlowSummary,
  RalphUtilityCondition,
  RalphUtilityType,
  RalphValidationScope,
} from "../../../../core/ralph.js";
import {
  getProviderLabel,
  type CatalogModel,
  type RuntimeProvider,
} from "../../model-catalog";

export type RalphProviderOption = RuntimeProvider | "default";

export const UTILITY_TYPE_LABELS: Record<RalphUtilityType, string> = {
  WAIT: "Wait",
  HTTP_FETCH: "HTTP Fetch",
  POLL: "Poll",
  CONDITION: "Condition",
  RUN_COMMAND: "Run Command",
  READ_FILE: "Read File",
  WRITE_FILE: "Write File",
  READ_JSON: "Read JSON",
  WRITE_JSON: "Write JSON",
  PATCH_JSON: "Patch JSON",
  APPEND_JSONL: "Append JSONL",
  READ_JSONL: "Read JSONL",
  QUERY_JSONL: "Query JSONL",
  FILE_EXISTS: "File Exists",
  DELETE_FILE: "Delete File",
  MOVE_FILE: "Move File",
  ARCHIVE_FILE: "Archive File",
  LOOP_COUNTER: "Loop Counter",
  PROMPT_JSON: "Prompt JSON",
  VALIDATOR_JSON: "Validator JSON",
  SELECT_JSON_TASK: "Select JSON Task",
  MARK_JSON_TASK: "Mark JSON Task",
  CHANGE_SCOPE_GUARD: "Change Scope Guard",
  SCAN_SCOPE_EVIDENCE: "Scan Scope Evidence",
  UPDATE_SCOPE_REGISTRY: "Update Scope Registry",
  SELECT_SCOPE: "Select Scope",
  MARK_SCOPE_RESULT: "Mark Scope Result",
  SEARCH_FILES: "Search Files",
  RUN_CHECK: "Run Check",
  UI_ANALYZE: "UI Analyze",
  GIT_STATUS: "Git Status",
  GIT_SNAPSHOT: "Git Snapshot",
  GIT_DIFF_SUMMARY: "Git Diff Summary",
  DETECT_PROJECT_COMMANDS: "Detect Project Commands",
  SET_VARIABLE: "Set Variable",
  TRANSFORM_JSON: "Transform JSON",
  VALIDATE_JSON: "Validate JSON",
  FINAL_REPORT: "Final Report",
  NOTIFY: "Notify",
};

export const formatFlowSubtitle = (flow: RalphFlowSummary): string => {
  return flow.alias ?? flow.id;
};

export const formatRouteTargetLabel = (block: RalphFlowBlock): string => {
  return `${block.title} [${block.type}]`;
};

export const formatRouteOptionTargetLabel = (
  sourceBlock: RalphFlowBlock,
  targetBlock: RalphFlowBlock,
): string => {
  const targetLabel = formatRouteTargetLabel(targetBlock);

  return sourceBlock.id === targetBlock.id ? `Self (${targetLabel})` : targetLabel;
};

export const formatProviderOptionLabel = (
  provider: RalphProviderOption,
): string => {
  return provider === "default" ? "Default" : getProviderLabel(provider);
};

export const formatUtilityTypeLabel = (type: RalphUtilityType): string => {
  return UTILITY_TYPE_LABELS[type];
};

export const formatValidationScopeLabel = (
  mode: RalphValidationScope["mode"],
): string => {
  switch (mode) {
    case "sinceLastValidator":
      return "Since last validator";
    case "previousBlock":
      return "Previous block";
    case "selectedBlocks":
      return "Selected blocks";
    case "wholeFlow":
      return "Whole flow";
  }
};

export const formatCatalogModelLabel = (
  models: CatalogModel[],
  modelId: string,
): string => {
  return models.find((model) => model.id === modelId)?.label ?? modelId;
};

export const formatUnconnectedRouteLabel = (
  block: RalphFlowBlock,
  output: RalphExecutionOutput,
): string => {
  return block.type === "VALIDATOR" && output === "RETRY"
    ? "Auto retry group"
    : "Unconnected";
};

export const titleFromId = (id: string): string => {
  const words = id
    .replace(/-/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);

  return words.length > 0
    ? words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(" ")
    : "Ralph Flow";
};

export const compactPreviewText = (
  value: string | undefined | null,
  fallback: string,
): string => {
  const normalized = value?.replace(/\s+/gu, " ").trim();

  return normalized ? normalized : fallback;
};

export const formatSeconds = (value: number | null | undefined): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "not set";
  }

  if (value >= 60 && value % 60 === 0) {
    return `${value / 60}m`;
  }

  return `${value}s`;
};

export const formatMaxBytes = (value: number | null | undefined): string => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "unlimited output";
  }

  if (value >= 1_000_000) {
    return `${Math.round(value / 100_000) / 10} MB output`;
  }

  if (value >= 1_000) {
    return `${Math.round(value / 100) / 10} KB output`;
  }

  return `${value} B output`;
};

export const formatUtilityConditionSummary = (
  condition: RalphUtilityCondition | undefined,
): string => {
  if (!condition) {
    return "No condition configured";
  }

  if (condition.style === "json-path") {
    const path = compactPreviewText(condition.path, "$");
    const operator = condition.operator
      ? titleFromId(condition.operator)
      : "Matches";
    const value = compactPreviewText(condition.value, "");

    return value ? `JSON ${path} ${operator} ${value}` : `JSON ${path} ${operator}`;
  }

  const expression = compactPreviewText(condition.expression, "No expression");

  return condition.style === "javascript"
    ? `JS ${expression}`
    : `When ${expression}`;
};
