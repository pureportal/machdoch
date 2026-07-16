import type {
  RalphExecutionOutput,
  RalphFlow,
  RalphFlowScope,
  RalphFlowSummary,
} from "../../../../core/ralph.js";
import type { ProviderModelCatalogSnapshot } from "../../model-catalog";
import { createFlowAlias } from "./create-flow-alias.helper";
import {
  getBlockOutputs,
  isVisualRalphCanvasBlock,
} from "./get-block-outputs.helper";
import { getReachableBlockIds } from "./get-reachable-block-ids.helper";
import { hasLocalFlowCycle } from "./has-local-flow-cycle.helper";

const DEFAULT_RALPH_FLOW_SCOPE: RalphFlowScope = "workspace";
const MEDIA_FLOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const MEDIA_BINDING_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const RALPH_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/u;

export const RALPH_NOTE_MIN_SIZE = { width: 180, height: 120 };
export const RALPH_GROUP_MIN_SIZE = { width: 280, height: 180 };

export interface LocalIssue {
  level: "error" | "warning";
  message: string;
  blockId?: string;
  output?: RalphExecutionOutput;
}

const getFlowSummaryScope = (flow: RalphFlowSummary): RalphFlowScope => {
  return flow.scope ?? DEFAULT_RALPH_FLOW_SCOPE;
};

const isFlowAliasUsed = (
  flows: RalphFlowSummary[],
  alias: string,
  scope: RalphFlowScope,
  currentFlowId?: string,
): boolean => {
  const normalizedAlias = createFlowAlias(alias);

  if (!normalizedAlias) {
    return false;
  }

  return flows.some((flow) => {
    if (getFlowSummaryScope(flow) !== scope || flow.id === currentFlowId) {
      return false;
    }

    return (
      createFlowAlias(flow.alias ?? "") === normalizedAlias ||
      createFlowAlias(flow.id) === normalizedAlias
    );
  });
};

export const validateFlowLocally = (
  flow: RalphFlow,
  modelCatalog: ProviderModelCatalogSnapshot | null,
  flowSummaries: RalphFlowSummary[],
  scope: RalphFlowScope,
): LocalIssue[] => {
  const issues: LocalIssue[] = [];
  const blockIds = new Set<string>();
  const startBlocks = flow.blocks.filter((block) => block.type === "START");
  const endBlocks = flow.blocks.filter((block) => block.type === "END");
  const alias = createFlowAlias(flow.alias ?? "");

  if (flow.alias && !alias) {
    issues.push({
      level: "error",
      message: "Flow alias cannot be empty.",
    });
  } else if (alias && isFlowAliasUsed(flowSummaries, alias, scope, flow.id)) {
    issues.push({
      level: "error",
      message: `Flow alias ${alias} is already used by another flow.`,
    });
  }

  if (startBlocks.length !== 1) {
    issues.push({
      level: "error",
      message: "Flow must contain exactly one START block.",
    });
  }

  if (endBlocks.length === 0) {
    issues.push({
      level: "warning",
      message: "Flow has no END block.",
    });
  }

  if (
    flow.settings?.maxTransitions !== undefined &&
    (!Number.isInteger(flow.settings.maxTransitions) ||
      flow.settings.maxTransitions < 1)
  ) {
    issues.push({
      level: "error",
      message: "Flow settings.maxTransitions must be an integer >= 1.",
    });
  }

  if (flow.settings?.maxTransitions === undefined && hasLocalFlowCycle(flow)) {
    issues.push({
      level: "warning",
      message:
        "Flow contains a cycle but does not define settings.maxTransitions; runs can continue until manually stopped.",
    });
  }

  for (const block of flow.blocks) {
    if (blockIds.has(block.id)) {
      issues.push({
        level: "error",
        message: `Block id ${block.id} is duplicated.`,
        blockId: block.id,
      });
    }

    blockIds.add(block.id);

    if (block.type === "NOTE") {
      if (!block.text.trim()) {
        issues.push({
          level: "warning",
          message: `${block.title} is empty.`,
          blockId: block.id,
        });
      }

      if (
        block.size &&
        (block.size.width < RALPH_NOTE_MIN_SIZE.width ||
          block.size.height < RALPH_NOTE_MIN_SIZE.height)
      ) {
        issues.push({
          level: "error",
          message: `${block.title} is smaller than the note minimum size.`,
          blockId: block.id,
        });
      }
    }

    if (
      block.type === "GROUP" &&
      block.size &&
      !block.collapsed &&
      (block.size.width < RALPH_GROUP_MIN_SIZE.width ||
        block.size.height < RALPH_GROUP_MIN_SIZE.height)
    ) {
      issues.push({
        level: "error",
        message: `${block.title} is smaller than the group minimum size.`,
        blockId: block.id,
      });
    }

    if (
      (block.type === "PROMPT" ||
        block.type === "VALIDATOR" ||
        block.type === "DECISION" ||
        block.type === "INTERVIEW") &&
      !block.prompt.trim()
    ) {
      issues.push({
        level: "error",
        message: `${block.title} has an empty prompt.`,
        blockId: block.id,
      });
    }

    if (block.type === "ASK_USER") {
      if (block.fields.length === 0 && block.mode !== "confirmOnly") {
        issues.push({
          level: "error",
          message: `${block.title} needs at least one field unless mode is Confirm Only.`,
          blockId: block.id,
        });
      }

      const fieldIds = new Set<string>();
      for (const field of block.fields) {
        if (!field.id.trim()) {
          issues.push({
            level: "error",
            message: `${block.title} has an input field without an id.`,
            blockId: block.id,
          });
        } else if (fieldIds.has(field.id)) {
          issues.push({
            level: "error",
            message: `${block.title} duplicates input field ${field.id}.`,
            blockId: block.id,
          });
        }

        fieldIds.add(field.id);

        if (!field.label.trim()) {
          issues.push({
            level: "error",
            message: `${block.title} has an input field without a label.`,
            blockId: block.id,
          });
        }

        if (
          (field.type === "select" || field.type === "multiselect") &&
          (!field.options || field.options.length === 0)
        ) {
          issues.push({
            level: "error",
            message: `${block.title} field ${field.id || field.label} needs options.`,
            blockId: block.id,
          });
        }
      }
    }

    if (block.type === "INTERVIEW") {
      const maxTurns = block.maxTurns ?? 8;
      const questionsPerTurn = block.questionsPerTurn ?? 3;

      if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 50) {
        issues.push({
          level: "error",
          message: `${block.title} max turns must be between 1 and 50.`,
          blockId: block.id,
        });
      }

      if (!Number.isInteger(questionsPerTurn) || questionsPerTurn < 1 || questionsPerTurn > 10) {
        issues.push({
          level: "error",
          message: `${block.title} questions per turn must be between 1 and 10.`,
          blockId: block.id,
        });
      }
    }

    if (block.type === "DECISION" && block.labels.length === 0) {
      issues.push({
        level: "error",
        message: `${block.title} needs at least one decision label.`,
        blockId: block.id,
      });
    }

    if (block.type === "PACK" && block.packIds.length === 0) {
      issues.push({
        level: "warning",
        message: `${block.title} has no packs selected.`,
        blockId: block.id,
      });
    }

    if (block.type === "PACK" && block.packIds.length > 0) {
      issues.push({
        level: "warning",
        message: `${block.title} references packs, but Ralph currently stores pack ids as metadata and does not inject pack contents at runtime.`,
        blockId: block.id,
      });
    }

    if (block.type === "MEDIA_FLOW") {
      if (!MEDIA_FLOW_ID_PATTERN.test(block.flowId)) {
        issues.push({
          level: "error",
          message: `${block.title} requires a pinned Media Studio flow id.`,
          blockId: block.id,
        });
      }
      if (!MEDIA_FLOW_ID_PATTERN.test(block.revisionId)) {
        issues.push({
          level: "error",
          message: `${block.title} requires a pinned Media Studio revision id.`,
          blockId: block.id,
        });
      }
      const variableNames = new Set(
        (flow.variables ?? []).map((variable) => variable.name),
      );
      const inputEntries = Object.entries(block.inputBindings);
      const outputEntries = Object.entries(block.outputBindings);
      if (inputEntries.length > 32) {
        issues.push({
          level: "error",
          message: `${block.title} may bind at most 32 Media Studio inputs.`,
          blockId: block.id,
        });
      }
      if (outputEntries.length > 32) {
        issues.push({
          level: "error",
          message: `${block.title} may bind at most 32 Media Studio outputs.`,
          blockId: block.id,
        });
      }
      for (const [inputId, binding] of inputEntries) {
        if (!MEDIA_BINDING_ID_PATTERN.test(inputId)) {
          issues.push({
            level: "error",
            message: `${block.title} input binding ${inputId} is not a valid Media Studio variable id.`,
            blockId: block.id,
          });
        }
        if (
          (binding.source === "variable" &&
            (!RALPH_VARIABLE_NAME_PATTERN.test(binding.variableName) ||
              !variableNames.has(binding.variableName))) ||
          (binding.source === "path" && !binding.path.trim()) ||
          (binding.source === "media-asset" && !binding.assetId.trim())
        ) {
          issues.push({
            level: "error",
            message: `${block.title} input binding ${inputId} is incomplete or references an undeclared Ralph variable.`,
            blockId: block.id,
          });
        }
      }
      for (const [outputId, binding] of outputEntries) {
        if (!MEDIA_BINDING_ID_PATTERN.test(outputId)) {
          issues.push({
            level: "error",
            message: `${block.title} output binding ${outputId} is invalid.`,
            blockId: block.id,
          });
        }
        if (
          !RALPH_VARIABLE_NAME_PATTERN.test(binding.variableName) ||
          !variableNames.has(binding.variableName)
        ) {
          issues.push({
            level: "error",
            message: `${block.title} output ${outputId} requires a declared Ralph variable.`,
            blockId: block.id,
          });
        }
      }
      if (block.runPolicy === "submit-and-continue" && outputEntries.length > 0) {
        issues.push({
          level: "error",
          message: `${block.title} cannot bind outputs while using submit-and-continue.`,
          blockId: block.id,
        });
      }
    }

    if (block.settings?.packs && block.settings.packs.length > 0) {
      issues.push({
        level: "warning",
        message: `${block.title} references settings.packs, but Ralph currently stores pack ids as metadata and does not inject pack contents at runtime.`,
        blockId: block.id,
      });
    }

    if (
      block.type === "VALIDATOR" &&
      block.validationScope?.mode === "selectedBlocks" &&
      (block.validationScope.blockIds ?? []).length === 0
    ) {
      issues.push({
        level: "warning",
        message: `${block.title} validates selected blocks but none are selected.`,
        blockId: block.id,
      });
    }

    if (block.type === "MCP_TOOL") {
      if (!block.serverId.trim()) {
        issues.push({
          level: "error",
          message: `${block.title} requires an MCP server.`,
          blockId: block.id,
        });
      }

      if (!block.toolName.trim()) {
        issues.push({
          level: "error",
          message: `${block.title} requires an MCP tool name.`,
          blockId: block.id,
        });
      }
    }

    if (block.type === "MCP_RESOURCE") {
      if (!block.serverId.trim()) {
        issues.push({
          level: "error",
          message: `${block.title} requires an MCP server.`,
          blockId: block.id,
        });
      }

      if (!block.uri.trim()) {
        issues.push({
          level: "error",
          message: `${block.title} requires a resource URI.`,
          blockId: block.id,
        });
      }
    }

    if (block.type === "MCP_PROMPT") {
      if (!block.serverId.trim()) {
        issues.push({
          level: "error",
          message: `${block.title} requires an MCP server.`,
          blockId: block.id,
        });
      }

      if (!block.promptName.trim()) {
        issues.push({
          level: "error",
          message: `${block.title} requires an MCP prompt name.`,
          blockId: block.id,
        });
      }
    }

    if (block.settings?.model) {
      const provider =
        block.settings.provider && block.settings.provider !== "default"
          ? block.settings.provider
          : null;
      const providerCatalog = provider
        ? modelCatalog?.providers.find((entry) => entry.provider === provider)
        : null;

      if (provider && providerCatalog && !providerCatalog.available) {
        issues.push({
          level: "warning",
          message: `${block.title} uses unavailable provider ${provider}.`,
          blockId: block.id,
        });
      } else if (
        providerCatalog &&
        providerCatalog.models.length > 0 &&
        !providerCatalog.models.some((model) => model.id === block.settings?.model)
      ) {
        issues.push({
          level: "warning",
          message: `${block.title} uses unavailable model ${block.settings.model}.`,
          blockId: block.id,
        });
      }
    }

    for (const output of getBlockOutputs(block)) {
      if (block.type === "VALIDATOR" && output === "RETRY") {
        continue;
      }

      if (
        !flow.edges.some(
          (edge) => edge.from === block.id && edge.fromOutput === output,
        )
      ) {
        issues.push({
          level: "warning",
          message: `${block.title} does not route ${output}.`,
          blockId: block.id,
          output,
        });
      }
    }
  }

  const blocksById = new Map(flow.blocks.map((block) => [block.id, block]));

  for (const edge of flow.edges) {
    if (!blockIds.has(edge.from)) {
      issues.push({
        level: "error",
        message: `Edge ${edge.id} references missing source ${edge.from}.`,
        blockId: edge.from,
      });
    }

    if (!blockIds.has(edge.to)) {
      issues.push({
        level: "error",
        message: `Edge ${edge.id} references missing target ${edge.to}.`,
        blockId: edge.to,
      });
    }

    const sourceBlock = blocksById.get(edge.from);
    const targetBlock = blocksById.get(edge.to);

    if (sourceBlock && isVisualRalphCanvasBlock(sourceBlock)) {
      issues.push({
        level: "error",
        message: `Route ${edge.id} cannot start from visual block ${sourceBlock.title}.`,
        blockId: sourceBlock.id,
      });
    }

    if (targetBlock && isVisualRalphCanvasBlock(targetBlock)) {
      issues.push({
        level: "error",
        message: `Route ${edge.id} cannot target visual block ${targetBlock.title}.`,
        blockId: targetBlock.id,
      });
    }
  }

  const reachable = getReachableBlockIds(flow);

  for (const block of flow.blocks) {
    if (isVisualRalphCanvasBlock(block)) {
      continue;
    }

    if (startBlocks.length === 1 && !reachable.has(block.id)) {
      issues.push({
        level: "warning",
        message: `${block.title} is unreachable from START.`,
        blockId: block.id,
      });
    }
  }

  return issues;
};
