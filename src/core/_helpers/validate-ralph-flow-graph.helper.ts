import type {
  RalphExecutionOutput,
  RalphFlow,
  RalphFlowBlock,
  RalphFlowEdge,
} from "../ralph.js";

export const DEFAULT_RALPH_GROUP_MAX_DEPTH = 3;

export const getRalphBlockById = (flow: RalphFlow): Map<string, RalphFlowBlock> => {
  return new Map(flow.blocks.map((block) => [block.id, block]));
};

export const hasOutgoingRalphEdge = (
  flow: RalphFlow,
  blockId: string,
  output: RalphExecutionOutput,
): boolean => {
  return flow.edges.some(
    (edge) => edge.from === blockId && edge.fromOutput === output,
  );
};

export const findOutgoingRalphEdge = (
  flow: RalphFlow,
  blockId: string,
  output: RalphExecutionOutput,
): RalphFlowEdge | undefined => {
  return flow.edges.find(
    (edge) => edge.from === blockId && edge.fromOutput === output,
  );
};

export const getReachableRalphBlockIds = (flow: RalphFlow): Set<string> => {
  const starts = flow.blocks.filter((block) => block.type === "START");
  const reachable = new Set<string>();
  const pending = starts.map((block) => block.id);

  while (pending.length > 0) {
    const current = pending.shift();

    if (!current || reachable.has(current)) {
      continue;
    }

    reachable.add(current);
    for (const edge of flow.edges.filter((candidate) => candidate.from === current)) {
      pending.push(edge.to);
    }
  }

  return reachable;
};

export const hasRalphPathToEnd = (flow: RalphFlow, startBlockId: string): boolean => {
  const blockMap = getRalphBlockById(flow);
  const visited = new Set<string>();
  const pending = [startBlockId];

  while (pending.length > 0) {
    const current = pending.shift();

    if (!current || visited.has(current)) {
      continue;
    }

    visited.add(current);
    const block = blockMap.get(current);
    if (block?.type === "END") {
      return true;
    }

    for (const edge of flow.edges.filter((candidate) => candidate.from === current)) {
      pending.push(edge.to);
    }
  }

  return false;
};

export const getRalphGroupDepthIssue = (
  block: RalphFlowBlock,
  blocksById: Map<string, RalphFlowBlock>,
): "cycle" | "too-deep" | undefined => {
  const seen = new Set<string>([block.id]);
  let depth = 0;
  let parentGroupId = block.parentGroupId;

  while (parentGroupId) {
    if (seen.has(parentGroupId)) {
      return "cycle";
    }

    seen.add(parentGroupId);
    depth += 1;

    if (depth > DEFAULT_RALPH_GROUP_MAX_DEPTH) {
      return "too-deep";
    }

    const parent = blocksById.get(parentGroupId);
    parentGroupId = parent?.parentGroupId;
  }

  return undefined;
};

export const hasGraphCycle = (flow: RalphFlow): boolean => {
  const edgesBySource = new Map<string, string[]>();

  for (const edge of flow.edges) {
    const targets = edgesBySource.get(edge.from) ?? [];
    targets.push(edge.to);
    edgesBySource.set(edge.from, targets);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (blockId: string): boolean => {
    if (visiting.has(blockId)) {
      return true;
    }

    if (visited.has(blockId)) {
      return false;
    }

    visiting.add(blockId);

    for (const target of edgesBySource.get(blockId) ?? []) {
      if (visit(target)) {
        return true;
      }
    }

    visiting.delete(blockId);
    visited.add(blockId);

    return false;
  };

  return flow.blocks.some((block) => visit(block.id));
};
