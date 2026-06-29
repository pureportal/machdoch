import { hasRalphPlaceholders } from "./ralph-placeholders.helper.js";
import type {
  RalphUtilityBlock,
  RalphValidationIssue,
} from "../ralph.js";

const MIN_RALPH_UI_VIEWPORT_SIZE = 320;
const MAX_RALPH_UI_VIEWPORT_SIZE = 3840;

const addUtilityIssue = (
  issues: RalphValidationIssue[],
  code: string,
  message: string,
  context: Pick<RalphValidationIssue, "blockId"> = {},
): void => {
  issues.push({ code, message, ...context });
};

const validateUtilityCondition = (
  blockLabel: string,
  block: RalphUtilityBlock,
  errors: RalphValidationIssue[],
): void => {
  const condition = block.utility.condition;

  if (!condition) {
    return;
  }

  if (condition.style === "javascript" || condition.style === "simple") {
    if (!condition.expression?.trim()) {
      addUtilityIssue(
        errors,
        "utility-condition-expression-required",
        `${blockLabel} ${condition.style} condition requires expression.`,
        { blockId: block.id },
      );
    }
    return;
  }

  if (!condition.path?.trim()) {
    addUtilityIssue(
      errors,
      "utility-condition-path-required",
      `${blockLabel} json-path condition requires path.`,
      { blockId: block.id },
    );
  }
};

const isHttpLikeUrl = (value: string | undefined): boolean => {
  if (!value?.trim() || hasRalphPlaceholders(value)) {
    return true;
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const validateUiAnalyzeUtilityBlock = (
  blockLabel: string,
  block: RalphUtilityBlock,
  errors: RalphValidationIssue[],
): void => {
  const utility = block.utility;
  const adapter = utility.adapter ?? "auto";
  const hasTargetUrl = Boolean(utility.targetUrl?.trim() || utility.url?.trim());
  const hasScreenshotPath = Boolean(utility.screenshotPath?.trim());
  const isMcpAdapter = adapter === "playwright-mcp" || adapter === "tauri-mcp";

  if (!hasTargetUrl && !hasScreenshotPath && !isMcpAdapter) {
    addUtilityIssue(
      errors,
      "utility-ui-target-required",
      `${blockLabel} requires targetUrl or screenshotPath.`,
      { blockId: block.id },
    );
  }

  if (adapter === "browser" && !hasTargetUrl) {
    addUtilityIssue(
      errors,
      "utility-ui-target-url-required",
      `${blockLabel} browser analysis requires targetUrl.`,
      { blockId: block.id },
    );
  }

  if (adapter === "image" && !hasScreenshotPath) {
    addUtilityIssue(
      errors,
      "utility-ui-screenshot-required",
      `${blockLabel} image analysis requires screenshotPath.`,
      { blockId: block.id },
    );
  }

  if (
    isMcpAdapter &&
    (!utility.mcpServerId?.trim() || !utility.mcpToolName?.trim())
  ) {
    addUtilityIssue(
      errors,
      "utility-ui-mcp-required",
      `${blockLabel} ${adapter} analysis requires mcpServerId and mcpToolName.`,
      { blockId: block.id },
    );
  }

  if (!isHttpLikeUrl(utility.targetUrl ?? utility.url)) {
    addUtilityIssue(
      errors,
      "utility-ui-target-url-invalid",
      `${blockLabel} targetUrl must be an HTTP or HTTPS URL.`,
      { blockId: block.id },
    );
  }

  if (!isHttpLikeUrl(utility.server?.healthUrl)) {
    addUtilityIssue(
      errors,
      "utility-ui-health-url-invalid",
      `${blockLabel} server.healthUrl must be an HTTP or HTTPS URL.`,
      { blockId: block.id },
    );
  }

  for (const viewport of utility.viewports ?? []) {
    if (
      !Number.isInteger(viewport.width) ||
      !Number.isInteger(viewport.height) ||
      viewport.width < MIN_RALPH_UI_VIEWPORT_SIZE ||
      viewport.height < MIN_RALPH_UI_VIEWPORT_SIZE ||
      viewport.width > MAX_RALPH_UI_VIEWPORT_SIZE ||
      viewport.height > MAX_RALPH_UI_VIEWPORT_SIZE
    ) {
      addUtilityIssue(
        errors,
        "utility-ui-viewport-invalid",
        `${blockLabel} viewport dimensions must be integers from ${MIN_RALPH_UI_VIEWPORT_SIZE} to ${MAX_RALPH_UI_VIEWPORT_SIZE}.`,
        { blockId: block.id },
      );
      break;
    }
  }
};

export const validateRalphUtilityBlock = (
  block: RalphUtilityBlock,
  errors: RalphValidationIssue[],
): void => {
  const blockLabel = block.id || block.title || "utility block";
  const utility = block.utility;

  if (utility.delaySeconds !== undefined && utility.delaySeconds < 0) {
    addUtilityIssue(
      errors,
      "utility-delay-invalid",
      `${blockLabel} delaySeconds must be >= 0.`,
      { blockId: block.id },
    );
  }

  if (utility.intervalSeconds !== undefined && utility.intervalSeconds < 0) {
    addUtilityIssue(
      errors,
      "utility-interval-invalid",
      `${blockLabel} intervalSeconds must be >= 0.`,
      { blockId: block.id },
    );
  }

  const maxAttempts =
    typeof utility.maxAttempts === "string"
      ? utility.maxAttempts.trim()
        ? Number(utility.maxAttempts)
        : undefined
      : utility.maxAttempts;
  const maxAttemptsIsPlaceholder =
    typeof utility.maxAttempts === "string" &&
    hasRalphPlaceholders(utility.maxAttempts);

  if (
    !maxAttemptsIsPlaceholder &&
    maxAttempts !== undefined &&
    maxAttempts !== null &&
    (!Number.isInteger(maxAttempts) || maxAttempts < 1)
  ) {
    addUtilityIssue(
      errors,
      "utility-max-attempts-invalid",
      `${blockLabel} maxAttempts must be null or an integer >= 1.`,
      { blockId: block.id },
    );
  }

  if (
    utility.timeoutSeconds !== undefined &&
    (!Number.isFinite(utility.timeoutSeconds) || utility.timeoutSeconds < 0)
  ) {
    addUtilityIssue(
      errors,
      "utility-timeout-invalid",
      `${blockLabel} timeoutSeconds must be >= 0.`,
      { blockId: block.id },
    );
  }

  if (
    utility.maxOutputBytes !== undefined &&
    (!Number.isInteger(utility.maxOutputBytes) || utility.maxOutputBytes < 1)
  ) {
    addUtilityIssue(
      errors,
      "utility-output-limit-invalid",
      `${blockLabel} maxOutputBytes must be an integer >= 1.`,
      { blockId: block.id },
    );
  }

  validateUtilityCondition(blockLabel, block, errors);

  switch (utility.type) {
    case "WAIT":
      if (utility.mode === "until-time" && !utility.runAt?.trim()) {
        addUtilityIssue(
          errors,
          "utility-run-at-required",
          `${blockLabel} requires runAt.`,
          { blockId: block.id },
        );
      }

      if (
        (utility.mode === "condition" || utility.mode === "poll") &&
        !utility.condition
      ) {
        addUtilityIssue(
          errors,
          "utility-condition-required",
          `${blockLabel} requires a condition.`,
          { blockId: block.id },
        );
      }
      break;
    case "HTTP_FETCH":
    case "POLL":
      if (!utility.url?.trim()) {
        addUtilityIssue(
          errors,
          "utility-url-required",
          `${blockLabel} requires url.`,
          { blockId: block.id },
        );
      }

      if (utility.type === "POLL" && !utility.condition) {
        addUtilityIssue(
          errors,
          "utility-condition-required",
          `${blockLabel} requires a poll condition.`,
          { blockId: block.id },
        );
      }
      break;
    case "CONDITION":
      if (!utility.condition) {
        addUtilityIssue(
          errors,
          "utility-condition-required",
          `${blockLabel} requires a condition.`,
          { blockId: block.id },
        );
      }
      break;
    case "RUN_COMMAND":
    case "RUN_CHECK":
      if (!utility.command?.trim() && !utility.fallbackCommand?.trim()) {
        addUtilityIssue(
          errors,
          "utility-command-required",
          `${blockLabel} requires command.`,
          { blockId: block.id },
        );
      }
      break;
    case "READ_FILE":
    case "WRITE_FILE":
    case "READ_JSON":
    case "WRITE_JSON":
    case "PATCH_JSON":
    case "APPEND_JSONL":
    case "READ_JSONL":
    case "QUERY_JSONL":
    case "SELECT_JSON_TASK":
    case "MARK_JSON_TASK":
    case "FILE_EXISTS":
    case "DELETE_FILE":
    case "MOVE_FILE":
    case "ARCHIVE_FILE":
      if (!utility.path?.trim()) {
        addUtilityIssue(
          errors,
          "utility-path-required",
          `${blockLabel} requires path.`,
          { blockId: block.id },
        );
      }

      if (utility.type === "WRITE_FILE" && utility.content === undefined) {
        addUtilityIssue(
          errors,
          "utility-content-required",
          `${blockLabel} requires content.`,
          { blockId: block.id },
        );
      }

      if (utility.type === "MOVE_FILE" && !utility.outputPath?.trim()) {
        addUtilityIssue(
          errors,
          "utility-output-path-required",
          `${blockLabel} requires outputPath.`,
          { blockId: block.id },
        );
      }
      break;
    case "LOOP_COUNTER":
      break;
    case "PROMPT_JSON":
    case "VALIDATOR_JSON":
      if (
        !utility.prompt?.trim() &&
        !utility.message?.trim() &&
        !utility.input?.trim()
      ) {
        addUtilityIssue(
          errors,
          "utility-prompt-required",
          `${blockLabel} requires prompt.`,
          { blockId: block.id },
        );
      }
      break;
    case "CHANGE_SCOPE_GUARD":
      break;
    case "SCAN_SCOPE_EVIDENCE":
    case "UPDATE_SCOPE_REGISTRY":
    case "SELECT_SCOPE":
    case "MARK_SCOPE_RESULT":
      break;
    case "SEARCH_FILES":
      if (!utility.pattern?.trim() && !utility.glob?.trim()) {
        addUtilityIssue(
          errors,
          "utility-search-pattern-required",
          `${blockLabel} requires pattern or glob.`,
          { blockId: block.id },
        );
      }
      break;
    case "UI_ANALYZE":
      validateUiAnalyzeUtilityBlock(blockLabel, block, errors);
      break;
    case "SET_VARIABLE":
      if (!utility.variableName?.trim()) {
        addUtilityIssue(
          errors,
          "utility-variable-name-required",
          `${blockLabel} requires variableName.`,
          { blockId: block.id },
        );
      }
      break;
    case "TRANSFORM_JSON":
      if (!utility.expression?.trim()) {
        addUtilityIssue(
          errors,
          "utility-expression-required",
          `${blockLabel} requires expression.`,
          { blockId: block.id },
        );
      }
      break;
    case "VALIDATE_JSON":
      if (utility.schema === undefined) {
        addUtilityIssue(
          errors,
          "utility-schema-required",
          `${blockLabel} requires schema.`,
          { blockId: block.id },
        );
      }
      break;
    case "GIT_STATUS":
    case "GIT_SNAPSHOT":
    case "GIT_DIFF_SUMMARY":
    case "DETECT_PROJECT_COMMANDS":
    case "FINAL_REPORT":
    case "NOTIFY":
      break;
  }
};
