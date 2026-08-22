import type { RalphFlow } from "../../../../core/ralph.js";

export const hasLocalFlowCycle = (flow: RalphFlow): boolean => {
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
