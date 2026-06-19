import {
  extractRalphPlaceholders,
  getRalphAttachmentTemplateTexts,
  getRalphPromptLikeTexts,
  hasRalphPlaceholders,
} from "./ralph-placeholders.helper.js";
import { addRalphValidationIssue } from "./create-ralph-validation-result.helper.js";
import { validateRalphUtilityBlock } from "./validate-ralph-utility-block.helper.js";
import {
  getEnabledMcpServer,
  loadMcpConfigSync,
  loadMcpDiscoveryCacheSync,
} from "../mcp/config.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import type {
  RalphFlow,
  RalphFlowBlock,
  RalphInputField,
  RalphValidationIssue,
} from "../ralph.js";

const BLOCK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/u;
const INPUT_FIELD_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/u;
const INPUT_FIELD_TYPES_REQUIRING_OPTIONS = new Set(["select", "multiselect"]);

interface ValidateRalphFlowBlocksOptions {
  flow: RalphFlow;
  config?: RuntimeConfig;
  errors: RalphValidationIssue[];
  warnings: RalphValidationIssue[];
}

interface ValidateRalphFlowBlocksResult {
  blockIds: Set<string>;
  startBlocks: RalphFlowBlock[];
}

const validateBlockReferencePlaceholders = (
  flow: RalphFlow,
  block: RalphFlowBlock,
  errors: RalphValidationIssue[],
  warnings: RalphValidationIssue[],
): void => {
  const blockIds = new Set(flow.blocks.map((candidate) => candidate.id));

  for (const text of [
    ...getRalphPromptLikeTexts(block),
    ...getRalphAttachmentTemplateTexts(block),
  ]) {
    for (const placeholder of extractRalphPlaceholders(text)) {
      if (placeholder.invalid) {
        addRalphValidationIssue(errors, "invalid-placeholder", placeholder.invalid, {
          blockId: block.id,
        });
        continue;
      }

      const reference = placeholder.blockReference;
      if (reference && !blockIds.has(reference.blockId)) {
        addRalphValidationIssue(
          warnings,
          "missing-result-reference",
          `${block.id} references result placeholder for unknown block \`${reference.blockId}\`.`,
          { blockId: block.id },
        );
      }
    }
  }
};

const validateInputField = (
  block: RalphFlowBlock,
  field: RalphInputField,
  fieldIds: Set<string>,
  errors: RalphValidationIssue[],
): void => {
  const fieldLabel = `${block.id}.${field.id || field.label || "field"}`;

  if (!field.id.trim()) {
    addRalphValidationIssue(
      errors,
      "input-field-id-required",
      `${block.id} input field id is required.`,
      { blockId: block.id },
    );
  } else if (!INPUT_FIELD_ID_PATTERN.test(field.id)) {
    addRalphValidationIssue(
      errors,
      "input-field-id-invalid",
      `${fieldLabel} id must match ${INPUT_FIELD_ID_PATTERN.source}.`,
      { blockId: block.id },
    );
  } else if (fieldIds.has(field.id)) {
    addRalphValidationIssue(
      errors,
      "input-field-id-duplicate",
      `${block.id} input field id \`${field.id}\` is duplicated.`,
      { blockId: block.id },
    );
  }

  fieldIds.add(field.id);

  if (!field.label.trim()) {
    addRalphValidationIssue(
      errors,
      "input-field-label-required",
      `${fieldLabel} label is required.`,
      { blockId: block.id },
    );
  }

  if (
    INPUT_FIELD_TYPES_REQUIRING_OPTIONS.has(field.type) &&
    (!field.options || field.options.length === 0)
  ) {
    addRalphValidationIssue(
      errors,
      "input-field-options-required",
      `${fieldLabel} requires at least one option.`,
      { blockId: block.id },
    );
  }

  if (field.options) {
    const optionValues = new Set<string>();
    for (const option of field.options) {
      if (!option.value.trim()) {
        addRalphValidationIssue(
          errors,
          "input-option-value-required",
          `${fieldLabel} has an option with an empty value.`,
          { blockId: block.id },
        );
      } else if (optionValues.has(option.value)) {
        addRalphValidationIssue(
          errors,
          "input-option-value-duplicate",
          `${fieldLabel} option value \`${option.value}\` is duplicated.`,
          { blockId: block.id },
        );
      }

      optionValues.add(option.value);
    }
  }

  const validation = field.validation;
  if (validation?.min !== undefined && validation?.max !== undefined && validation.min > validation.max) {
    addRalphValidationIssue(
      errors,
      "input-field-range-invalid",
      `${fieldLabel} min cannot be greater than max.`,
      { blockId: block.id },
    );
  }

  if (
    validation?.minLength !== undefined &&
    validation?.maxLength !== undefined &&
    validation.minLength > validation.maxLength
  ) {
    addRalphValidationIssue(
      errors,
      "input-field-length-range-invalid",
      `${fieldLabel} minLength cannot be greater than maxLength.`,
      { blockId: block.id },
    );
  }

  if (validation?.pattern) {
    try {
      new RegExp(validation.pattern, "u");
    } catch {
      addRalphValidationIssue(
        errors,
        "input-field-pattern-invalid",
        `${fieldLabel} pattern must be a valid regular expression.`,
        { blockId: block.id },
      );
    }
  }
};

export const validateRalphFlowBlocks = ({
  flow,
  config,
  errors,
  warnings,
}: ValidateRalphFlowBlocksOptions): ValidateRalphFlowBlocksResult => {
  const blockIds = new Set<string>();
  const startBlocks = flow.blocks.filter((block) => block.type === "START");

  if (startBlocks.length === 0) {
    addRalphValidationIssue(errors, "missing-start", "Ralph flow must contain exactly one START block.");
  } else if (startBlocks.length > 1) {
    addRalphValidationIssue(errors, "multiple-start", "Ralph flow cannot contain more than one START block.");
  }

  for (const block of flow.blocks) {
    const blockLabel = block.id || block.title || "block";

    if (!block.id.trim()) {
      addRalphValidationIssue(errors, "block-id-required", "block id is required.", {
        blockId: block.id,
      });
    } else if (!BLOCK_ID_PATTERN.test(block.id)) {
      addRalphValidationIssue(
        errors,
        "block-id-invalid",
        `block id \`${block.id}\` must match ${BLOCK_ID_PATTERN.source}.`,
        { blockId: block.id },
      );
    } else if (blockIds.has(block.id)) {
      addRalphValidationIssue(errors, "block-id-duplicate", `block id \`${block.id}\` is duplicated.`, {
        blockId: block.id,
      });
    }

    blockIds.add(block.id);

    if (!block.title.trim()) {
      addRalphValidationIssue(errors, "block-title-required", `${blockLabel} title is required.`, {
        blockId: block.id,
      });
    }

    if (block.size) {
      if (
        !Number.isFinite(block.size.width) ||
        !Number.isFinite(block.size.height) ||
        block.size.width <= 0 ||
        block.size.height <= 0
      ) {
        addRalphValidationIssue(errors, "block-size-invalid", `${blockLabel} size must be positive.`, {
          blockId: block.id,
        });
      }
    }

    if (block.type === "NOTE") {
      if (!block.text.trim()) {
        addRalphValidationIssue(warnings, "note-empty", `${blockLabel} note is empty.`, {
          blockId: block.id,
        });
      }

      if (
        block.size &&
        (block.size.width < 180 || block.size.height < 120)
      ) {
        addRalphValidationIssue(errors, "note-size-invalid", `${blockLabel} note size is too small.`, {
          blockId: block.id,
        });
      }
    }

    if (block.type === "GROUP") {
      if (
        block.size &&
        !block.collapsed &&
        (block.size.width < 280 || block.size.height < 180)
      ) {
        addRalphValidationIssue(errors, "group-size-invalid", `${blockLabel} group size is too small.`, {
          blockId: block.id,
        });
      }
    }

    if (
      (block.type === "PROMPT" ||
        block.type === "VALIDATOR" ||
        block.type === "DECISION" ||
        block.type === "INTERVIEW") &&
      !block.prompt.trim()
    ) {
      addRalphValidationIssue(errors, "block-prompt-required", `${blockLabel} prompt is required.`, {
        blockId: block.id,
      });
    }

    if (block.type === "INPUT") {
      if (block.fields.length === 0) {
        addRalphValidationIssue(
          errors,
          "input-fields-required",
          `${blockLabel} input block requires at least one field.`,
          { blockId: block.id },
        );
      }

      const fieldIds = new Set<string>();
      for (const field of block.fields) {
        validateInputField(block, field, fieldIds, errors);
      }

      if (
        block.timeoutSeconds !== undefined &&
        block.timeoutSeconds !== null &&
        (!Number.isFinite(block.timeoutSeconds) || block.timeoutSeconds < 0)
      ) {
        addRalphValidationIssue(
          errors,
          "input-timeout-invalid",
          `${blockLabel} timeoutSeconds must be null or >= 0.`,
          { blockId: block.id },
        );
      }
    }

    if (block.type === "INTERVIEW") {
      const maxTurns = block.maxTurns ?? 8;
      const questionsPerTurn = block.questionsPerTurn ?? 3;

      if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 50) {
        addRalphValidationIssue(
          errors,
          "interview-max-turns-invalid",
          `${blockLabel} maxTurns must be an integer from 1 to 50.`,
          { blockId: block.id },
        );
      }

      if (!Number.isInteger(questionsPerTurn) || questionsPerTurn < 1 || questionsPerTurn > 10) {
        addRalphValidationIssue(
          errors,
          "interview-questions-per-turn-invalid",
          `${blockLabel} questionsPerTurn must be an integer from 1 to 10.`,
          { blockId: block.id },
        );
      }
    }

    if (block.type === "DECISION" && block.labels.length === 0) {
      addRalphValidationIssue(
        errors,
        "decision-labels-required",
        `${blockLabel} decision block requires at least one label.`,
        { blockId: block.id },
      );
    }

    if (block.type === "PACK" && block.packIds.length === 0) {
      addRalphValidationIssue(warnings, "pack-empty", `${blockLabel} pack block does not reference any packs.`, {
        blockId: block.id,
      });
    }

    if (block.type === "PACK" && block.packIds.length > 0) {
      addRalphValidationIssue(
        warnings,
        "pack-runtime-not-implemented",
        `${blockLabel} references context packs, but Ralph currently stores pack ids as metadata and does not inject pack contents at runtime.`,
        { blockId: block.id },
      );
    }

    if (block.settings?.packs && block.settings.packs.length > 0) {
      addRalphValidationIssue(
        warnings,
        "settings-packs-runtime-not-implemented",
        `${blockLabel} references settings.packs, but Ralph currently stores pack ids as metadata and does not inject pack contents at runtime.`,
        { blockId: block.id },
      );
    }

    if (block.type === "UTILITY") {
      validateRalphUtilityBlock(block, errors);
    }

    if (block.type === "MCP_TOOL") {
      if (!block.serverId.trim()) {
        addRalphValidationIssue(errors, "mcp-server-required", `${blockLabel} requires serverId.`, {
          blockId: block.id,
        });
      }

      if (!block.toolName.trim()) {
        addRalphValidationIssue(errors, "mcp-tool-required", `${blockLabel} requires toolName.`, {
          blockId: block.id,
        });
      }
    }

    if (block.type === "MCP_RESOURCE") {
      if (!block.serverId.trim()) {
        addRalphValidationIssue(errors, "mcp-server-required", `${blockLabel} requires serverId.`, {
          blockId: block.id,
        });
      }

      if (!block.uri.trim()) {
        addRalphValidationIssue(errors, "mcp-resource-uri-required", `${blockLabel} requires uri.`, {
          blockId: block.id,
        });
      }
    }

    if (block.type === "MCP_PROMPT") {
      if (!block.serverId.trim()) {
        addRalphValidationIssue(errors, "mcp-server-required", `${blockLabel} requires serverId.`, {
          blockId: block.id,
        });
      }

      if (!block.promptName.trim()) {
        addRalphValidationIssue(errors, "mcp-prompt-required", `${blockLabel} requires promptName.`, {
          blockId: block.id,
        });
      }
    }

    if (
      config &&
      (block.type === "MCP_TOOL" ||
        block.type === "MCP_RESOURCE" ||
        block.type === "MCP_PROMPT") &&
      block.serverId.trim() &&
      !hasRalphPlaceholders(block.serverId)
    ) {
      try {
        const mcpConfig = loadMcpConfigSync(
          config.workspaceRoot,
          block.settings?.mcp,
        );

        const server = getEnabledMcpServer(mcpConfig, block.serverId);

        if (!server) {
          addRalphValidationIssue(
            errors,
            "mcp-server-unavailable",
            `${blockLabel} references MCP server \`${block.serverId}\`, but it is not configured or not enabled.`,
            { blockId: block.id },
          );
        } else {
          const discovery = loadMcpDiscoveryCacheSync(config.workspaceRoot)
            .servers[server.id];

          if (!discovery) {
            addRalphValidationIssue(
              warnings,
              "mcp-discovery-missing",
              `${blockLabel} references MCP server \`${block.serverId}\`, but no cached discovery is available to verify its capabilities.`,
              { blockId: block.id },
            );
          } else if (
            block.type === "MCP_TOOL" &&
            !hasRalphPlaceholders(block.toolName) &&
            !discovery.tools.some((tool) => tool.name === block.toolName)
          ) {
            addRalphValidationIssue(
              warnings,
              "mcp-tool-undiscovered",
              `${blockLabel} references MCP tool \`${block.toolName}\`, but cached discovery for \`${block.serverId}\` does not include that tool.`,
              { blockId: block.id },
            );
          } else if (
            block.type === "MCP_RESOURCE" &&
            !hasRalphPlaceholders(block.uri) &&
            !discovery.resources.some((resource) => resource.uri === block.uri) &&
            !discovery.resourceTemplates.some((template) =>
              template.uriTemplate.includes(block.uri),
            )
          ) {
            addRalphValidationIssue(
              warnings,
              "mcp-resource-undiscovered",
              `${blockLabel} references MCP resource \`${block.uri}\`, but cached discovery for \`${block.serverId}\` does not include it.`,
              { blockId: block.id },
            );
          } else if (
            block.type === "MCP_PROMPT" &&
            !hasRalphPlaceholders(block.promptName) &&
            !discovery.prompts.some((prompt) => prompt.name === block.promptName)
          ) {
            addRalphValidationIssue(
              warnings,
              "mcp-prompt-undiscovered",
              `${blockLabel} references MCP prompt \`${block.promptName}\`, but cached discovery for \`${block.serverId}\` does not include it.`,
              { blockId: block.id },
            );
          }
        }
      } catch (error) {
        addRalphValidationIssue(
          errors,
          "mcp-config-invalid",
          `${blockLabel} could not load MCP config: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { blockId: block.id },
        );
      }
    }

    const maxIterations = block.settings?.maxIterations;
    if (
      maxIterations !== undefined &&
      (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 100)
    ) {
      addRalphValidationIssue(
        errors,
        "max-iterations-invalid",
        `${blockLabel} maxIterations must be an integer from 1 to 100.`,
        { blockId: block.id },
      );
    }

    const retry = block.settings?.retry;
    if (
      retry?.mode === "finite" &&
      (retry.maxRetries === null ||
        retry.maxRetries === undefined ||
        !Number.isInteger(retry.maxRetries) ||
        retry.maxRetries < 0)
    ) {
      addRalphValidationIssue(
        errors,
        "retry-invalid",
        `${blockLabel} finite retry policy requires maxRetries >= 0.`,
        { blockId: block.id },
      );
    }

    if (
      block.settings?.provider &&
      block.settings.provider !== "default" &&
      config &&
      !config.providerAvailability.some(
        (entry) => entry.provider === block.settings?.provider && entry.configured,
      )
    ) {
      addRalphValidationIssue(
        errors,
        "provider-unavailable",
        `${blockLabel} uses unavailable provider \`${block.settings.provider}\`.`,
        { blockId: block.id },
      );
    }

    validateBlockReferencePlaceholders(flow, block, errors, warnings);
  }

  return { blockIds, startBlocks };
};
