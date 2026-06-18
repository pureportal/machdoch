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
  RalphValidationIssue,
} from "../ralph.js";

const BLOCK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/u;

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
        block.type === "DECISION") &&
      !block.prompt.trim()
    ) {
      addRalphValidationIssue(errors, "block-prompt-required", `${blockLabel} prompt is required.`, {
        blockId: block.id,
      });
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
