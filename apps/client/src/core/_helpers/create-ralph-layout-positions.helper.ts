import type { RalphExecutionOutput, RalphFlowBlock, RalphFlowEdge, RalphPosition } from "../ralph.js";
import {
  RALPH_LAYOUT_COLUMN_GAP,
  RALPH_LAYOUT_ROW_GAP,
} from "./ralph-layout-node-bounds.helper.js";

const getRalphLayoutOutputOrder = (output: RalphExecutionOutput): number => {
  switch (output) {
    case "SUCCESS":
    case "DONE":
      return 0;
    case "CONTINUE":
      return 1;
    case "RETRY":
      return 2;
    case "ERROR":
    case "FAILED":
    case "INVALID":
    case "TIMEOUT":
    case "HTTP_ERROR":
      return 10;
    default:
      return 5;
  }
};

export const createRalphLayoutRanks = (
  blocksToLayout: readonly RalphFlowBlock[],
  edges: readonly RalphFlowEdge[],
): Map<string, number> => {
  const blockIds = new Set(blocksToLayout.map((block) => block.id));
  const outgoingEdgesByBlock = new Map<string, RalphFlowEdge[]>();
  const ranks = new Map<string, number>();
  const startBlocks = blocksToLayout.filter((block) => block.type === "START");
  const initialBlocks =
    startBlocks.length > 0 ? startBlocks : blocksToLayout.slice(0, 1);
  const pending: Array<{ blockId: string; rank: number }> = [];

  for (const edge of edges) {
    if (!blockIds.has(edge.from) || !blockIds.has(edge.to)) {
      continue;
    }

    const blockEdges = outgoingEdgesByBlock.get(edge.from) ?? [];
    blockEdges.push(edge);
    outgoingEdgesByBlock.set(edge.from, blockEdges);
  }

  for (const block of initialBlocks) {
    ranks.set(block.id, 0);
    pending.push({ blockId: block.id, rank: 0 });
  }

  while (pending.length > 0) {
    const current = pending.shift();

    if (!current) {
      continue;
    }

    for (const edge of outgoingEdgesByBlock.get(current.blockId) ?? []) {
      const nextRank = current.rank + 1;
      const existingRank = ranks.get(edge.to);

      if (existingRank !== undefined && existingRank <= nextRank) {
        continue;
      }

      ranks.set(edge.to, nextRank);
      pending.push({ blockId: edge.to, rank: nextRank });
    }
  }

  const fallbackRank = Math.max(0, ...Array.from(ranks.values())) + 1;

  for (const block of blocksToLayout) {
    if (!ranks.has(block.id)) {
      ranks.set(block.id, fallbackRank);
    }
  }

  return ranks;
};

export const createRalphLayoutIncomingOrder = (
  blocksToLayout: readonly RalphFlowBlock[],
  edges: readonly RalphFlowEdge[],
): Map<string, number> => {
  const blockIndex = new Map(
    blocksToLayout.map((block, index) => [block.id, index] as const),
  );
  const incomingOrder = new Map<string, number>();

  for (const edge of edges) {
    const sourceIndex = blockIndex.get(edge.from);

    if (sourceIndex === undefined) {
      continue;
    }

    const order = sourceIndex * 100 + getRalphLayoutOutputOrder(edge.fromOutput);
    const existingOrder = incomingOrder.get(edge.to);

    if (existingOrder === undefined || order < existingOrder) {
      incomingOrder.set(edge.to, order);
    }
  }

  return incomingOrder;
};

export const createRalphLayoutPositions = (
  blocksToLayout: readonly RalphFlowBlock[],
  edges: readonly RalphFlowEdge[],
): Map<string, RalphPosition> => {
  const ranks = createRalphLayoutRanks(blocksToLayout, edges);
  const incomingOrder = createRalphLayoutIncomingOrder(blocksToLayout, edges);
  const blockIndex = new Map(
    blocksToLayout.map((block, index) => [block.id, index] as const),
  );
  const blocksByRank = new Map<number, RalphFlowBlock[]>();

  for (const block of blocksToLayout) {
    const rank = ranks.get(block.id) ?? 0;
    const rankBlocks = blocksByRank.get(rank) ?? [];

    rankBlocks.push(block);
    blocksByRank.set(rank, rankBlocks);
  }

  const positionsByBlockId = new Map<string, RalphPosition>();

  for (const [rank, blocks] of blocksByRank) {
    const sortedBlocks = [...blocks].sort((left, right) => {
      const leftIncomingOrder = incomingOrder.get(left.id);
      const rightIncomingOrder = incomingOrder.get(right.id);

      if (
        leftIncomingOrder !== undefined &&
        rightIncomingOrder !== undefined &&
        leftIncomingOrder !== rightIncomingOrder
      ) {
        return leftIncomingOrder - rightIncomingOrder;
      }

      if (leftIncomingOrder !== undefined && rightIncomingOrder === undefined) {
        return -1;
      }

      if (leftIncomingOrder === undefined && rightIncomingOrder !== undefined) {
        return 1;
      }

      return (blockIndex.get(left.id) ?? 0) - (blockIndex.get(right.id) ?? 0);
    });
    const yOffset = ((sortedBlocks.length - 1) * RALPH_LAYOUT_ROW_GAP) / -2;

    sortedBlocks.forEach((block, index) => {
      positionsByBlockId.set(block.id, {
        x: rank * RALPH_LAYOUT_COLUMN_GAP,
        y: yOffset + index * RALPH_LAYOUT_ROW_GAP,
      });
    });
  }

  return positionsByBlockId;
};
