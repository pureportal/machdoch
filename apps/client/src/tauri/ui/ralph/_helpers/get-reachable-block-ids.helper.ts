import type { RalphFlow } from "../../../../core/ralph.js";

export const getReachableBlockIds = (flow: RalphFlow): Set<string> => {
  const reachable = new Set<string>();
  const starts = flow.blocks.filter((block) => block.type === "START");
  const pending = starts.map((block) => block.id);
  const outgoingEdgesByBlock = new Map<string, string[]>();

  for (const edge of flow.edges) {
    const targets = outgoingEdgesByBlock.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoingEdgesByBlock.set(edge.from, targets);
  }

  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const current = pending[cursor];

    if (!current || reachable.has(current)) {
      continue;
    }

    reachable.add(current);
    for (const target of outgoingEdgesByBlock.get(current) ?? []) {
      pending.push(target);
    }
  }

  return reachable;
};
