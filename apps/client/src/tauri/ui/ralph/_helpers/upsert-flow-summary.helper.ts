import { discoverRalphFlowVariables } from "../../../../core/_helpers/ralph-placeholders.helper.js";
import type {
  RalphFlow,
  RalphFlowScope,
  RalphFlowSummary,
} from "../../../../core/ralph.js";
import { createFlowAlias } from "./create-flow-alias.helper";
import {
  DEFAULT_RALPH_FLOW_SCOPE,
  RALPH_FLOW_SCOPES,
} from "./normalize-ralph-flow-scope.helper";

export const getFlowSummaryScope = (
  flow: RalphFlowSummary,
): RalphFlowScope => {
  return flow.scope ?? DEFAULT_RALPH_FLOW_SCOPE;
};

export const getFlowSelectionKey = (
  flowId: string,
  scope: RalphFlowScope,
): string => `${scope}:${flowId}`;

export const getFlowSummarySelectionKey = (
  flow: RalphFlowSummary,
): string => {
  return getFlowSelectionKey(flow.id, getFlowSummaryScope(flow));
};

export const hasFlowSelection = (
  flow: RalphFlowSummary,
  flowId: string,
  scope: RalphFlowScope,
): boolean => flow.id === flowId && getFlowSummaryScope(flow) === scope;

export const withFlowSummaryScope = (
  flow: RalphFlowSummary,
  scope: RalphFlowScope,
): RalphFlowSummary => ({
  ...flow,
  scope: flow.scope ?? scope,
});

export const compareFlowSummaries = (
  left: RalphFlowSummary,
  right: RalphFlowSummary,
): number => {
  const leftScope = getFlowSummaryScope(left);
  const rightScope = getFlowSummaryScope(right);

  if (leftScope !== rightScope) {
    return (
      RALPH_FLOW_SCOPES.indexOf(leftScope) -
      RALPH_FLOW_SCOPES.indexOf(rightScope)
    );
  }

  return (left.alias ?? left.name ?? left.id).localeCompare(
    right.alias ?? right.name ?? right.id,
  );
};

export const flowToSummary = (
  flow: RalphFlow,
  path = "",
  scope: RalphFlowScope = DEFAULT_RALPH_FLOW_SCOPE,
): RalphFlowSummary => {
  return {
    id: flow.id,
    name: flow.name,
    scope,
    path,
    ...(flow.alias !== undefined ? { alias: flow.alias } : {}),
    ...(flow.description !== undefined
      ? { description: flow.description }
      : {}),
    ...(flow.source !== undefined ? { source: flow.source } : {}),
    blockCount: flow.blocks.length,
    edgeCount: flow.edges.length,
    variableCount: discoverRalphFlowVariables(flow).length,
  };
};

export const upsertFlowSummary = (
  flows: RalphFlowSummary[],
  summary: RalphFlowSummary,
): RalphFlowSummary[] => {
  const summaryScope = getFlowSummaryScope(summary);
  const withoutExisting = flows.filter(
    (flow) =>
      !(flow.id === summary.id && getFlowSummaryScope(flow) === summaryScope),
  );

  return [summary, ...withoutExisting].sort(compareFlowSummaries);
};

export const isFlowAliasUsed = (
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

export const createUniqueFlowAlias = (
  baseAlias: string,
  flows: RalphFlowSummary[],
  scope: RalphFlowScope,
): string => {
  const base = createFlowAlias(baseAlias) || "ralph-flow";

  if (!isFlowAliasUsed(flows, base, scope)) {
    return base;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = createFlowAlias(`${base}-${index}`);

    if (!isFlowAliasUsed(flows, candidate, scope)) {
      return candidate;
    }
  }

  return createFlowAlias(`${base}-${Date.now()}`);
};
