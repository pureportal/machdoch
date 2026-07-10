import { FLOW_ID_PATTERN } from "./ralph-flow-ids.helper.js";
import { discoverRalphFlowVariables } from "./ralph-placeholders.helper.js";
import {
  addRalphValidationIssue,
  createValidationResult,
  RALPH_FLOW_SCHEMA_VERSION,
} from "./create-ralph-validation-result.helper.js";
import {
  getRalphBlockOutputs,
  isExecutableRalphBlock,
  isVisualRalphBlock,
} from "./get-ralph-block-outputs.helper.js";
import { validateRalphFlowBlocks } from "./validate-ralph-flow-blocks.helper.js";
import {
  createRalphFlowGraphIndex,
  DEFAULT_RALPH_GROUP_MAX_DEPTH,
  getRalphBlockIdsWithPathToEnd,
  getReachableRalphBlockIds,
  getRalphGroupDepthIssue,
  hasGraphCycle,
  hasOutgoingRalphEdge,
} from "./validate-ralph-flow-graph.helper.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import type {
  RalphFlow,
  RalphValidationIssue,
  RalphValidationResult,
} from "../ralph.js";

export {
  createValidationResult,
  RALPH_FLOW_SCHEMA_VERSION,
} from "./create-ralph-validation-result.helper.js";
export {
  getRalphUtilityOutputs,
  isExecutableRalphBlock,
  isVisualRalphBlock,
} from "./get-ralph-block-outputs.helper.js";
export { hasGraphCycle } from "./validate-ralph-flow-graph.helper.js";

const EDGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/u;
const MAX_FLOW_BLOCKS = 250;
const MAX_FLOW_EDGES = 500;

export const validateRalphFlow = (
  flow: RalphFlow,
  options: {
    config?: RuntimeConfig;
    variableValues?: Record<string, string>;
  } = {},
): RalphValidationResult => {
  const errors: RalphValidationIssue[] = [];
  const warnings: RalphValidationIssue[] = [];
  const variables = discoverRalphFlowVariables(flow);
  const graphIndex = createRalphFlowGraphIndex(flow);

  if (flow.schemaVersion !== RALPH_FLOW_SCHEMA_VERSION) {
    addRalphValidationIssue(
      errors,
      "schema-version",
      `schemaVersion must be ${RALPH_FLOW_SCHEMA_VERSION}.`,
    );
  }

  if (!flow.id.trim()) {
    addRalphValidationIssue(errors, "flow-id-required", "flow id is required.");
  } else if (!FLOW_ID_PATTERN.test(flow.id)) {
    addRalphValidationIssue(errors, "flow-id-invalid", `flow id \`${flow.id}\` must match ${FLOW_ID_PATTERN.source}.`);
  }

  if (flow.alias !== undefined) {
    const alias = flow.alias.trim();

    if (!alias) {
      addRalphValidationIssue(errors, "flow-alias-empty", "flow alias cannot be empty.");
    } else if (!FLOW_ID_PATTERN.test(alias)) {
      addRalphValidationIssue(
        errors,
        "flow-alias-invalid",
        `flow alias \`${flow.alias}\` must match ${FLOW_ID_PATTERN.source}.`,
      );
    }
  }

  if (!flow.name.trim()) {
    addRalphValidationIssue(errors, "flow-name-required", "flow name is required.");
  }

  if (
    flow.settings?.maxTransitions !== undefined &&
    (!Number.isInteger(flow.settings.maxTransitions) ||
      flow.settings.maxTransitions < 1)
  ) {
    addRalphValidationIssue(
      errors,
      "flow-max-transitions-invalid",
      "flow settings.maxTransitions must be an integer >= 1.",
    );
  }

  const autonomy = flow.settings?.autonomy;
  if (typeof autonomy === "object" && autonomy !== null) {
    if (
      autonomy.maxRecoveryAttempts !== undefined &&
      (!Number.isInteger(autonomy.maxRecoveryAttempts) ||
        autonomy.maxRecoveryAttempts < 0)
    ) {
      addRalphValidationIssue(
        errors,
        "flow-autonomy-max-recovery-attempts-invalid",
        "flow settings.autonomy.maxRecoveryAttempts must be an integer >= 0.",
      );
    }

    const initialDelaySeconds = autonomy.backoff?.initialDelaySeconds;
    const multiplier = autonomy.backoff?.multiplier;
    const maxDelaySeconds = autonomy.backoff?.maxDelaySeconds;

    if (
      initialDelaySeconds !== undefined &&
      (!Number.isFinite(initialDelaySeconds) || initialDelaySeconds < 0)
    ) {
      addRalphValidationIssue(
        errors,
        "flow-autonomy-initial-delay-invalid",
        "flow settings.autonomy.backoff.initialDelaySeconds must be a finite number >= 0.",
      );
    }
    if (
      multiplier !== undefined &&
      (!Number.isFinite(multiplier) || multiplier < 1)
    ) {
      addRalphValidationIssue(
        errors,
        "flow-autonomy-backoff-multiplier-invalid",
        "flow settings.autonomy.backoff.multiplier must be a finite number >= 1.",
      );
    }
    if (
      maxDelaySeconds !== undefined &&
      (!Number.isFinite(maxDelaySeconds) || maxDelaySeconds < 0)
    ) {
      addRalphValidationIssue(
        errors,
        "flow-autonomy-max-delay-invalid",
        "flow settings.autonomy.backoff.maxDelaySeconds must be a finite number >= 0.",
      );
    }
    if (
      initialDelaySeconds !== undefined &&
      maxDelaySeconds !== undefined &&
      maxDelaySeconds < initialDelaySeconds
    ) {
      addRalphValidationIssue(
        errors,
        "flow-autonomy-delay-range-invalid",
        "flow settings.autonomy.backoff.maxDelaySeconds must be >= initialDelaySeconds.",
      );
    }
    if (
      autonomy.enabled !== false &&
      autonomy.recoveryExhaustion !== "block" &&
      !autonomy.deferToBlockId?.trim()
    ) {
      addRalphValidationIssue(
        warnings,
        "flow-autonomy-defer-target-unset",
        "flow settings.autonomy resolves recovery exhaustion to defer but has no executable deferToBlockId.",
      );
    }
  }

  if (
    flow.settings?.maxTransitions === undefined &&
    hasGraphCycle(flow, graphIndex)
  ) {
    addRalphValidationIssue(
      warnings,
      "flow-cycle-without-cap",
      "Flow contains a cycle but does not define settings.maxTransitions; runs can continue until manually stopped.",
    );
  }

  if (flow.blocks.length > MAX_FLOW_BLOCKS) {
    addRalphValidationIssue(
      errors,
      "too-many-blocks",
      `blocks cannot contain more than ${MAX_FLOW_BLOCKS} entries.`,
    );
  }

  if (flow.edges.length > MAX_FLOW_EDGES) {
    addRalphValidationIssue(
      errors,
      "too-many-edges",
      `edges cannot contain more than ${MAX_FLOW_EDGES} entries.`,
    );
  }

  const blockValidationOptions = {
    flow,
    errors,
    warnings,
    ...(options.config ? { config: options.config } : {}),
  };
  const { blockIds, startBlocks } = validateRalphFlowBlocks(blockValidationOptions);

  const blocksById = graphIndex.blocksById;

  const deferToBlockId =
    typeof autonomy === "object" && autonomy !== null
      ? autonomy.deferToBlockId?.trim()
      : undefined;
  if (deferToBlockId) {
    const deferTarget = blocksById.get(deferToBlockId);

    if (!deferTarget) {
      addRalphValidationIssue(
        errors,
        "flow-autonomy-defer-target-missing",
        `flow settings.autonomy.deferToBlockId references missing block \`${deferToBlockId}\`.`,
      );
    } else if (!isExecutableRalphBlock(deferTarget)) {
      addRalphValidationIssue(
        errors,
        "flow-autonomy-defer-target-not-executable",
        `flow settings.autonomy.deferToBlockId must reference an executable block; \`${deferToBlockId}\` is ${deferTarget.type}.`,
      );
    }
  }

  for (const block of flow.blocks) {
    if (block.parentGroupId) {
      const parent = blocksById.get(block.parentGroupId);

      if (!parent) {
        addRalphValidationIssue(
          errors,
          "parent-group-missing",
          `${block.id} references missing parent group \`${block.parentGroupId}\`.`,
          { blockId: block.id },
        );
      } else if (parent.type !== "GROUP") {
        addRalphValidationIssue(
          errors,
          "parent-group-invalid",
          `${block.id} parentGroupId must reference a GROUP block.`,
          { blockId: block.id },
        );
      }
    }

    const groupDepthIssue = getRalphGroupDepthIssue(block, blocksById);
    if (groupDepthIssue === "cycle") {
      addRalphValidationIssue(errors, "group-parent-cycle", `${block.id} has a cyclic group parent chain.`, {
        blockId: block.id,
      });
    } else if (groupDepthIssue === "too-deep") {
      addRalphValidationIssue(
        errors,
        "group-parent-depth",
        `${block.id} group nesting exceeds ${DEFAULT_RALPH_GROUP_MAX_DEPTH} levels.`,
        { blockId: block.id },
      );
    }

    if (block.type !== "GROUP") {
      continue;
    }

    for (const childBlockId of block.childBlockIds) {
      const child = blocksById.get(childBlockId);

      if (!child) {
        addRalphValidationIssue(
          warnings,
          "group-child-missing",
          `${block.id} references missing child block \`${childBlockId}\`.`,
          { blockId: block.id },
        );
      } else if (child.parentGroupId && child.parentGroupId !== block.id) {
        addRalphValidationIssue(
          warnings,
          "group-child-parent-mismatch",
          `${block.id} lists \`${childBlockId}\`, but that block belongs to \`${child.parentGroupId}\`.`,
          { blockId: block.id },
        );
      }
    }

    if (
      block.executionBoundary?.mode === "selectedChild" &&
      (!block.executionBoundary.blockId ||
        !block.childBlockIds.includes(block.executionBoundary.blockId))
    ) {
      addRalphValidationIssue(
        errors,
        "group-execution-boundary-missing",
        `${block.id} selected execution boundary must reference a child block.`,
        { blockId: block.id },
      );
    } else if (
      block.executionBoundary?.mode === "selectedChild" &&
      block.executionBoundary.blockId
    ) {
      const boundaryBlock = blocksById.get(block.executionBoundary.blockId);

      if (!boundaryBlock || !isExecutableRalphBlock(boundaryBlock)) {
        addRalphValidationIssue(
          errors,
          "group-execution-boundary-invalid",
          `${block.id} selected execution boundary must reference an executable child block.`,
          { blockId: block.id },
        );
      }
    }
  }

  const annotationLinkIds = new Set<string>();
  for (const annotationLink of flow.annotationLinks ?? []) {
    if (!annotationLink.id.trim()) {
      addRalphValidationIssue(errors, "annotation-link-id-required", "annotation link id is required.");
    } else if (annotationLinkIds.has(annotationLink.id)) {
      addRalphValidationIssue(
        errors,
        "annotation-link-id-duplicate",
        `annotation link id \`${annotationLink.id}\` is duplicated.`,
      );
    }

    annotationLinkIds.add(annotationLink.id);

    if (!blocksById.has(annotationLink.from)) {
      addRalphValidationIssue(
        warnings,
        "annotation-link-from-missing",
        `annotation link \`${annotationLink.id}\` references missing source \`${annotationLink.from}\`.`,
      );
    }

    if (!blocksById.has(annotationLink.to)) {
      addRalphValidationIssue(
        warnings,
        "annotation-link-to-missing",
        `annotation link \`${annotationLink.id}\` references missing target \`${annotationLink.to}\`.`,
      );
    }
  }

  const edgeIds = new Set<string>();
  for (const edge of flow.edges) {
    if (!edge.id.trim()) {
      addRalphValidationIssue(errors, "edge-id-required", "edge id is required.", {
        edgeId: edge.id,
      });
    } else if (!EDGE_ID_PATTERN.test(edge.id)) {
      addRalphValidationIssue(errors, "edge-id-invalid", `edge id \`${edge.id}\` must match ${EDGE_ID_PATTERN.source}.`, {
        edgeId: edge.id,
      });
    } else if (edgeIds.has(edge.id)) {
      addRalphValidationIssue(errors, "edge-id-duplicate", `edge id \`${edge.id}\` is duplicated.`, {
        edgeId: edge.id,
      });
    }

    edgeIds.add(edge.id);

    if (!blockIds.has(edge.from)) {
      addRalphValidationIssue(
        errors,
        "edge-from-missing",
        `edge \`${edge.id}\` references missing source block \`${edge.from}\`.`,
        { edgeId: edge.id },
      );
    }

    if (!blockIds.has(edge.to)) {
      addRalphValidationIssue(
        errors,
        "edge-to-missing",
        `edge \`${edge.id}\` references missing target block \`${edge.to}\`.`,
        { edgeId: edge.id },
      );
    }

    const sourceBlock = blocksById.get(edge.from);
    const targetBlock = blocksById.get(edge.to);

    if (sourceBlock && isVisualRalphBlock(sourceBlock)) {
      addRalphValidationIssue(
        errors,
        "edge-from-visual-block",
        `edge \`${edge.id}\` cannot use visual block \`${edge.from}\` as a source.`,
        { edgeId: edge.id, blockId: edge.from },
      );
    }

    if (targetBlock && isVisualRalphBlock(targetBlock)) {
      addRalphValidationIssue(
        errors,
        "edge-to-visual-block",
        `edge \`${edge.id}\` cannot use visual block \`${edge.to}\` as a target.`,
        { edgeId: edge.id, blockId: edge.to },
      );
    }
  }

  for (const block of flow.blocks) {
    for (const output of getRalphBlockOutputs(block)) {
      if (block.type === "VALIDATOR" && output === "RETRY") {
        continue;
      }

      if (!hasOutgoingRalphEdge(flow, block.id, output, graphIndex)) {
        const code =
          block.type === "VALIDATOR" && output === "CONTINUE"
            ? "validator-continue-missing"
            : "output-edge-missing";
        addRalphValidationIssue(
          warnings,
          code,
          `${block.id} has no edge for output ${output}.`,
          { blockId: block.id },
        );
      }
    }
  }

  const reachable = getReachableRalphBlockIds(flow, graphIndex);
  const blockIdsWithPathToEnd = getRalphBlockIdsWithPathToEnd(flow, graphIndex);
  for (const block of flow.blocks) {
    if (isVisualRalphBlock(block)) {
      continue;
    }

    if (startBlocks.length === 1 && !reachable.has(block.id)) {
      addRalphValidationIssue(warnings, "unreachable-block", `${block.id} is unreachable from START.`, {
        blockId: block.id,
      });
    }

    if (
      isExecutableRalphBlock(block) &&
      !blockIdsWithPathToEnd.has(block.id)
    ) {
      addRalphValidationIssue(
        warnings,
        "no-terminal-path",
        `${block.id} has no routed path to an END block.`,
        { blockId: block.id },
      );
    }
  }

  for (const variable of variables) {
    if (!variable.name.trim()) {
      addRalphValidationIssue(errors, "variable-name-required", "variable name is required.");
    }

    if (
      variable.required &&
      variable.default === undefined &&
      options.variableValues &&
      !Object.hasOwn(options.variableValues, variable.name)
    ) {
      addRalphValidationIssue(
        errors,
        "variable-missing",
        `missing required Ralph variable \`${variable.name}\`.`,
      );
    }
  }

  return createValidationResult(errors, warnings, variables);
};
