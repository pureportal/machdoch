import type { RalphFlow } from "../../../../core/ralph.js";

export const getReachableBlockIds = (flow: RalphFlow): Set<string> => {
  const reachable = new Set<string>();
  const starts = flow.blocks.filter((block) => block.type === "START");
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
