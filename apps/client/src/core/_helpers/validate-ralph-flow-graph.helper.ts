import type {
  RalphExecutionOutput,
  RalphFlow,
  RalphFlowBlock,
  RalphFlowEdge,
} from "../ralph.js";

export const DEFAULT_RALPH_GROUP_MAX_DEPTH = 3;

export interface RalphFlowGraphIndex {
  blocksById: Map<string, RalphFlowBlock>;
  incomingBlockIdsByBlock: Map<string, string[]>;
  outgoingEdgeByBlockAndOutput: Map<
    string,
    Map<RalphExecutionOutput, RalphFlowEdge>
  >;
  outgoingEdgesByBlock: Map<string, RalphFlowEdge[]>;
}

export const getRalphBlockById = (
  flow: RalphFlow,
): Map<string, RalphFlowBlock> => {
  return new Map(flow.blocks.map((block) => [block.id, block]));
};

export const createRalphFlowGraphIndex = (
  flow: RalphFlow,
): RalphFlowGraphIndex => {
  const incomingBlockIdsByBlock = new Map<string, string[]>();
  const outgoingEdgeByBlockAndOutput = new Map<
    string,
    Map<RalphExecutionOutput, RalphFlowEdge>
  >();
  const outgoingEdgesByBlock = new Map<string, RalphFlowEdge[]>();

  for (const edge of flow.edges) {
    const outgoingEdges = outgoingEdgesByBlock.get(edge.from) ?? [];
    outgoingEdges.push(edge);
    outgoingEdgesByBlock.set(edge.from, outgoingEdges);

    const outgoingByOutput =
      outgoingEdgeByBlockAndOutput.get(edge.from) ?? new Map();
    if (!outgoingByOutput.has(edge.fromOutput)) {
      outgoingByOutput.set(edge.fromOutput, edge);
      outgoingEdgeByBlockAndOutput.set(edge.from, outgoingByOutput);
    }

    const incomingBlockIds = incomingBlockIdsByBlock.get(edge.to) ?? [];
    incomingBlockIds.push(edge.from);
    incomingBlockIdsByBlock.set(edge.to, incomingBlockIds);
  }

  return {
    blocksById: getRalphBlockById(flow),
    incomingBlockIdsByBlock,
    outgoingEdgeByBlockAndOutput,
    outgoingEdgesByBlock,
  };
};

export const hasOutgoingRalphEdge = (
  flow: RalphFlow,
  blockId: string,
  output: RalphExecutionOutput,
  index?: RalphFlowGraphIndex,
): boolean => {
  return index
    ? index.outgoingEdgeByBlockAndOutput.get(blockId)?.has(output) === true
    : flow.edges.some(
        (edge) => edge.from === blockId && edge.fromOutput === output,
      );
};

export const findOutgoingRalphEdge = (
  flow: RalphFlow,
  blockId: string,
  output: RalphExecutionOutput,
  index?: RalphFlowGraphIndex,
): RalphFlowEdge | undefined => {
  return index
    ? index.outgoingEdgeByBlockAndOutput.get(blockId)?.get(output)
    : flow.edges.find(
        (edge) => edge.from === blockId && edge.fromOutput === output,
      );
};

export const getReachableRalphBlockIds = (
  flow: RalphFlow,
  index = createRalphFlowGraphIndex(flow),
): Set<string> => {
  const starts = flow.blocks.filter((block) => block.type === "START");
  const reachable = new Set<string>();
  const pending = starts.map((block) => block.id);

  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const current = pending[cursor];

    if (!current || reachable.has(current)) {
      continue;
    }

    reachable.add(current);
    for (const edge of index.outgoingEdgesByBlock.get(current) ?? []) {
      pending.push(edge.to);
    }
  }

  return reachable;
};

export const getRalphBlockIdsWithPathToEnd = (
  flow: RalphFlow,
  index = createRalphFlowGraphIndex(flow),
): Set<string> => {
  const blockIdsWithPathToEnd = new Set(
    flow.blocks
      .filter((block) => block.type === "END")
      .map((block) => block.id),
  );
  const pending = [...blockIdsWithPathToEnd];

  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const current = pending[cursor];

    if (!current) {
      continue;
    }

    for (const sourceBlockId of index.incomingBlockIdsByBlock.get(current) ??
      []) {
      if (!blockIdsWithPathToEnd.has(sourceBlockId)) {
        blockIdsWithPathToEnd.add(sourceBlockId);
        pending.push(sourceBlockId);
      }
    }
  }

  return blockIdsWithPathToEnd;
};

export const hasRalphPathToEnd = (
  flow: RalphFlow,
  startBlockId: string,
  index = createRalphFlowGraphIndex(flow),
): boolean => {
  return getRalphBlockIdsWithPathToEnd(flow, index).has(startBlockId);
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

export const hasGraphCycle = (
  flow: RalphFlow,
  index = createRalphFlowGraphIndex(flow),
): boolean => {
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

    for (const edge of index.outgoingEdgesByBlock.get(blockId) ?? []) {
      if (visit(edge.to)) {
        return true;
      }
    }

    visiting.delete(blockId);
    visited.add(blockId);

    return false;
  };

  return flow.blocks.some((block) => visit(block.id));
};
