import type {
  RalphExecutionOutput,
  RalphFlow,
  RalphFlowBlock,
  RalphFlowEdge,
  RalphPosition,
} from "./ralph.js";

const RALPH_LAYOUT_COLUMN_GAP = 340;
const RALPH_LAYOUT_ROW_GAP = 190;
const RALPH_LAYOUT_NODE_MARGIN = 36;
const RALPH_LAYOUT_DEFAULT_NODE_WIDTH = 270;
const RALPH_LAYOUT_UTILITY_NODE_WIDTH = 300;
const RALPH_LAYOUT_NOTE_NODE_WIDTH = 280;
const RALPH_LAYOUT_GROUP_NODE_WIDTH = 720;
const RALPH_LAYOUT_NODE_HEIGHT = 140;
const RALPH_LAYOUT_NOTE_NODE_HEIGHT = 180;
const RALPH_LAYOUT_GROUP_NODE_HEIGHT = 420;

interface RalphLayoutNodeBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const getRalphLayoutNodeWidth = (block: RalphFlowBlock): number => {
  if (block.size) {
    return block.size.width;
  }

  switch (block.type) {
    case "UTILITY":
      return RALPH_LAYOUT_UTILITY_NODE_WIDTH;
    case "NOTE":
      return RALPH_LAYOUT_NOTE_NODE_WIDTH;
    case "GROUP":
      return RALPH_LAYOUT_GROUP_NODE_WIDTH;
    case "START":
    case "PROMPT":
    case "VALIDATOR":
    case "DECISION":
    case "PACK":
    case "MCP_TOOL":
    case "MCP_RESOURCE":
    case "MCP_PROMPT":
    case "END":
      return RALPH_LAYOUT_DEFAULT_NODE_WIDTH;
  }
};

const getRalphLayoutNodeHeight = (block: RalphFlowBlock): number => {
  if (block.size) {
    return block.size.height;
  }

  switch (block.type) {
    case "NOTE":
      return RALPH_LAYOUT_NOTE_NODE_HEIGHT;
    case "GROUP":
      return RALPH_LAYOUT_GROUP_NODE_HEIGHT;
    case "START":
    case "PROMPT":
    case "VALIDATOR":
    case "DECISION":
    case "PACK":
    case "UTILITY":
    case "MCP_TOOL":
    case "MCP_RESOURCE":
    case "MCP_PROMPT":
    case "END":
      return RALPH_LAYOUT_NODE_HEIGHT;
  }
};

const getRalphLayoutNodeBounds = (
  block: RalphFlowBlock,
): RalphLayoutNodeBounds | null => {
  if (!block.position) {
    return null;
  }

  const width = getRalphLayoutNodeWidth(block);
  const height = getRalphLayoutNodeHeight(block);

  return {
    left: block.position.x - RALPH_LAYOUT_NODE_MARGIN,
    right: block.position.x + width + RALPH_LAYOUT_NODE_MARGIN,
    top: block.position.y - RALPH_LAYOUT_NODE_MARGIN,
    bottom: block.position.y + height + RALPH_LAYOUT_NODE_MARGIN,
  };
};

const doRalphLayoutBoundsOverlap = (
  left: RalphLayoutNodeBounds,
  right: RalphLayoutNodeBounds,
): boolean => {
  return !(
    left.right <= right.left ||
    right.right <= left.left ||
    left.bottom <= right.top ||
    right.bottom <= left.top
  );
};

const shouldNormalizeRalphFlowLayout = (flow: RalphFlow): boolean => {
  const bounds: RalphLayoutNodeBounds[] = [];

  for (const block of flow.blocks) {
    const blockBounds = getRalphLayoutNodeBounds(block);

    if (!blockBounds) {
      return true;
    }

    if (bounds.some((existing) => doRalphLayoutBoundsOverlap(existing, blockBounds))) {
      return true;
    }

    bounds.push(blockBounds);
  }

  return false;
};

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

const createRalphLayoutRanks = (flow: RalphFlow): Map<string, number> => {
  const blockIds = new Set(flow.blocks.map((block) => block.id));
  const outgoingEdgesByBlock = new Map<string, RalphFlowEdge[]>();
  const ranks = new Map<string, number>();
  const startBlocks = flow.blocks.filter((block) => block.type === "START");
  const initialBlocks = startBlocks.length > 0 ? startBlocks : flow.blocks.slice(0, 1);
  const pending: Array<{ blockId: string; rank: number }> = [];

  for (const edge of flow.edges) {
    if (!blockIds.has(edge.from) || !blockIds.has(edge.to)) {
      continue;
    }

    const edges = outgoingEdgesByBlock.get(edge.from) ?? [];
    edges.push(edge);
    outgoingEdgesByBlock.set(edge.from, edges);
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

  for (const block of flow.blocks) {
    if (!ranks.has(block.id)) {
      ranks.set(block.id, fallbackRank);
    }
  }

  return ranks;
};

const createRalphLayoutIncomingOrder = (flow: RalphFlow): Map<string, number> => {
  const blockIndex = new Map(
    flow.blocks.map((block, index) => [block.id, index] as const),
  );
  const incomingOrder = new Map<string, number>();

  for (const edge of flow.edges) {
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

export const normalizeRalphFlowLayout = (flow: RalphFlow): RalphFlow => {
  if (!shouldNormalizeRalphFlowLayout(flow)) {
    return flow;
  }

  const ranks = createRalphLayoutRanks(flow);
  const incomingOrder = createRalphLayoutIncomingOrder(flow);
  const blockIndex = new Map(
    flow.blocks.map((block, index) => [block.id, index] as const),
  );
  const blocksByRank = new Map<number, RalphFlowBlock[]>();

  for (const block of flow.blocks) {
    const rank = ranks.get(block.id) ?? 0;
    const blocks = blocksByRank.get(rank) ?? [];

    blocks.push(block);
    blocksByRank.set(rank, blocks);
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

  return {
    ...flow,
    blocks: flow.blocks.map((block) => {
      const position = positionsByBlockId.get(block.id);

      return position ? { ...block, position } : block;
    }),
  };
};
