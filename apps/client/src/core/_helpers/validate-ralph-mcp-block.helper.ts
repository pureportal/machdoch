import { hasRalphPlaceholders } from "./ralph-placeholders.helper.js";
import { addRalphValidationIssue } from "./create-ralph-validation-result.helper.js";
import {
  getEnabledMcpServer,
  loadMcpConfigSync,
  loadMcpDiscoveryCacheSync,
} from "../mcp/config.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import type {
  RalphMcpPromptBlock,
  RalphMcpResourceBlock,
  RalphMcpToolBlock,
  RalphValidationIssue,
} from "../ralph.js";

type RalphMcpBlock =
  | RalphMcpToolBlock
  | RalphMcpResourceBlock
  | RalphMcpPromptBlock;

interface ValidateRalphMcpBlockOptions {
  blockLabel: string;
  block: RalphMcpBlock;
  config: RuntimeConfig | undefined;
  errors: RalphValidationIssue[];
  warnings: RalphValidationIssue[];
}

const validateRequiredMcpBlockFields = (
  blockLabel: string,
  block: RalphMcpBlock,
  errors: RalphValidationIssue[],
): void => {
  if (!block.serverId.trim()) {
    addRalphValidationIssue(errors, "mcp-server-required", `${blockLabel} requires serverId.`, {
      blockId: block.id,
    });
  }

  if (block.type === "MCP_TOOL" && !block.toolName.trim()) {
    addRalphValidationIssue(errors, "mcp-tool-required", `${blockLabel} requires toolName.`, {
      blockId: block.id,
    });
  }

  if (block.type === "MCP_RESOURCE" && !block.uri.trim()) {
    addRalphValidationIssue(errors, "mcp-resource-uri-required", `${blockLabel} requires uri.`, {
      blockId: block.id,
    });
  }

  if (block.type === "MCP_PROMPT" && !block.promptName.trim()) {
    addRalphValidationIssue(errors, "mcp-prompt-required", `${blockLabel} requires promptName.`, {
      blockId: block.id,
    });
  }
};

const validateMcpBlockDiscovery = (
  blockLabel: string,
  block: RalphMcpBlock,
  config: RuntimeConfig,
  errors: RalphValidationIssue[],
  warnings: RalphValidationIssue[],
): void => {
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
      return;
    }

    const discovery = loadMcpDiscoveryCacheSync(config.workspaceRoot)
      .servers[server.id];

    if (!discovery) {
      addRalphValidationIssue(
        warnings,
        "mcp-discovery-missing",
        `${blockLabel} references MCP server \`${block.serverId}\`, but no cached discovery is available to verify its capabilities.`,
        { blockId: block.id },
      );
      return;
    }

    if (
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
      return;
    }

    if (
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
      return;
    }

    if (
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
};

export const validateRalphMcpBlock = ({
  blockLabel,
  block,
  config,
  errors,
  warnings,
}: ValidateRalphMcpBlockOptions): void => {
  validateRequiredMcpBlockFields(blockLabel, block, errors);

  if (!config || !block.serverId.trim() || hasRalphPlaceholders(block.serverId)) {
    return;
  }

  validateMcpBlockDiscovery(blockLabel, block, config, errors, warnings);
};
