import type {
  RalphExecutionOutput,
  RalphFlow,
  RalphFlowBlock,
  RalphFlowEdge,
  RalphPosition,
  RalphSize,
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
const RALPH_LAYOUT_GROUP_PADDING_X = 70;
const RALPH_LAYOUT_GROUP_PADDING_TOP = 88;
const RALPH_LAYOUT_GROUP_PADDING_BOTTOM = 56;
const RALPH_LAYOUT_VISUAL_COLUMN_GAP = 80;
const RALPH_LAYOUT_VISUAL_ROW_GAP = 36;

interface RalphLayoutNodeBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

type RalphLayoutGroupBlock = Extract<RalphFlowBlock, { type: "GROUP" }>;
type RalphLayoutNoteBlock = Extract<RalphFlowBlock, { type: "NOTE" }>;

const isRalphLayoutGroupBlock = (
  block: RalphFlowBlock,
): block is RalphLayoutGroupBlock => block.type === "GROUP";

const isRalphLayoutNoteBlock = (
  block: RalphFlowBlock,
): block is RalphLayoutNoteBlock => block.type === "NOTE";

const isRalphLayoutVisualBlock = (block: RalphFlowBlock): boolean =>
  block.type === "NOTE" || block.type === "GROUP";

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
    case "INPUT":
    case "INTERVIEW":
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
    case "INPUT":
    case "INTERVIEW":
    case "UTILITY":
    case "MCP_TOOL":
    case "MCP_RESOURCE":
    case "MCP_PROMPT":
    case "END":
      return RALPH_LAYOUT_NODE_HEIGHT;
  }
};

const getRalphLayoutNodeBoundsAtPosition = (
  block: RalphFlowBlock,
  position: RalphPosition,
  margin = 0,
): RalphLayoutNodeBounds => {
  const width = getRalphLayoutNodeWidth(block);
  const height = getRalphLayoutNodeHeight(block);

  return {
    left: position.x - margin,
    right: position.x + width + margin,
    top: position.y - margin,
    bottom: position.y + height + margin,
  };
};

const getRalphLayoutNodeBounds = (
  block: RalphFlowBlock,
): RalphLayoutNodeBounds | null => {
  return block.position
    ? getRalphLayoutNodeBoundsAtPosition(
        block,
        block.position,
        RALPH_LAYOUT_NODE_MARGIN,
      )
    : null;
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

const doRalphLayoutBoundsContain = (
  container: RalphLayoutNodeBounds,
  child: RalphLayoutNodeBounds,
): boolean => {
  return (
    container.left <= child.left &&
    container.right >= child.right &&
    container.top <= child.top &&
    container.bottom >= child.bottom
  );
};

const mergeRalphLayoutBounds = (
  bounds: readonly RalphLayoutNodeBounds[],
): RalphLayoutNodeBounds | null => {
  if (bounds.length === 0) {
    return null;
  }

  return {
    left: Math.min(...bounds.map((bound) => bound.left)),
    right: Math.max(...bounds.map((bound) => bound.right)),
    top: Math.min(...bounds.map((bound) => bound.top)),
    bottom: Math.max(...bounds.map((bound) => bound.bottom)),
  };
};

const createRalphLayoutGroupChildIds = (
  flow: RalphFlow,
): Map<string, string[]> => {
  const blockIds = new Set(flow.blocks.map((block) => block.id));
  const childIdSetByGroupId = new Map<string, Set<string>>();

  for (const block of flow.blocks) {
    if (!isRalphLayoutGroupBlock(block)) {
      continue;
    }

    const childIds = new Set<string>();

    for (const childBlockId of block.childBlockIds) {
      if (childBlockId !== block.id && blockIds.has(childBlockId)) {
        childIds.add(childBlockId);
      }
    }

    childIdSetByGroupId.set(block.id, childIds);
  }

  for (const block of flow.blocks) {
    if (!block.parentGroupId || !blockIds.has(block.parentGroupId)) {
      continue;
    }

    const childIds = childIdSetByGroupId.get(block.parentGroupId);

    if (childIds && block.id !== block.parentGroupId) {
      childIds.add(block.id);
    }
  }

  const childrenByGroupId = new Map<string, string[]>();

  for (const block of flow.blocks) {
    if (!isRalphLayoutGroupBlock(block)) {
      continue;
    }

    const childIdSet = childIdSetByGroupId.get(block.id) ?? new Set<string>();
    childrenByGroupId.set(
      block.id,
      flow.blocks
        .map((candidate) => candidate.id)
        .filter((blockId) => childIdSet.has(blockId)),
    );
  }

  return childrenByGroupId;
};

const createRalphNormalizedGroupChildIds = (
  group: RalphLayoutGroupBlock,
  derivedChildIds: readonly string[],
): string[] => {
  const childIds = new Set<string>();

  for (const childBlockId of group.childBlockIds) {
    if (childBlockId && childBlockId !== group.id) {
      childIds.add(childBlockId);
    }
  }

  for (const childBlockId of derivedChildIds) {
    if (childBlockId !== group.id) {
      childIds.add(childBlockId);
    }
  }

  return [...childIds];
};

const createRalphLayoutChildGroupIds = (
  childrenByGroupId: Map<string, string[]>,
): Map<string, string[]> => {
  const groupIdsByChildId = new Map<string, string[]>();

  for (const [groupId, childBlockIds] of childrenByGroupId) {
    for (const childBlockId of childBlockIds) {
      const groupIds = groupIdsByChildId.get(childBlockId) ?? [];
      groupIds.push(groupId);
      groupIdsByChildId.set(childBlockId, groupIds);
    }
  }

  return groupIdsByChildId;
};

const getRalphLayoutBoundsForBlockIds = (
  blocksById: Map<string, RalphFlowBlock>,
  positionsByBlockId: Map<string, RalphPosition>,
  blockIds: readonly string[],
): RalphLayoutNodeBounds | null => {
  const bounds: RalphLayoutNodeBounds[] = [];

  for (const blockId of blockIds) {
    const block = blocksById.get(blockId);
    const position = positionsByBlockId.get(blockId) ?? block?.position;

    if (!block || !position) {
      continue;
    }

    bounds.push(getRalphLayoutNodeBoundsAtPosition(block, position));
  }

  return mergeRalphLayoutBounds(bounds);
};

const hasRalphLayoutGroupMismatch = (flow: RalphFlow): boolean => {
  const blocksById = new Map(flow.blocks.map((block) => [block.id, block]));
  const childrenByGroupId = createRalphLayoutGroupChildIds(flow);

  for (const block of flow.blocks) {
    if (!isRalphLayoutGroupBlock(block)) {
      continue;
    }

    const childBlockIds = childrenByGroupId.get(block.id) ?? [];
    const normalizedChildBlockIds = createRalphNormalizedGroupChildIds(
      block,
      childBlockIds,
    );

    if (normalizedChildBlockIds.join("\n") !== block.childBlockIds.join("\n")) {
      return true;
    }

    if (childBlockIds.length === 0) {
      continue;
    }

    const groupBounds = block.position
      ? getRalphLayoutNodeBoundsAtPosition(block, block.position)
      : null;

    if (!groupBounds) {
      return true;
    }

    for (const childBlockId of childBlockIds) {
      const childBlock = blocksById.get(childBlockId);

      if (!childBlock) {
        continue;
      }

      if (!childBlock.position) {
        return true;
      }

      const childBounds = getRalphLayoutNodeBoundsAtPosition(
        childBlock,
        childBlock.position,
      );

      if (!doRalphLayoutBoundsContain(groupBounds, childBounds)) {
        return true;
      }
    }
  }

  return false;
};

const shouldNormalizeRalphFlowLayout = (flow: RalphFlow): boolean => {
  const bounds: RalphLayoutNodeBounds[] = [];

  for (const block of flow.blocks) {
    if (isRalphLayoutGroupBlock(block)) {
      if (!block.position) {
        return true;
      }

      continue;
    }

    const blockBounds = getRalphLayoutNodeBounds(block);

    if (!blockBounds) {
      return true;
    }

    if (bounds.some((existing) => doRalphLayoutBoundsOverlap(existing, blockBounds))) {
      return true;
    }

    bounds.push(blockBounds);
  }

  return hasRalphLayoutGroupMismatch(flow);
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

const createRalphLayoutRanks = (
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

  for (const block of blocksToLayout) {
    if (!ranks.has(block.id)) {
      ranks.set(block.id, fallbackRank);
    }
  }

  return ranks;
};

const createRalphLayoutIncomingOrder = (
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

const createRalphLayoutPositions = (
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

  return positionsByBlockId;
};

const createRalphLayoutNotePositions = (
  notes: readonly RalphLayoutNoteBlock[],
  blocksById: Map<string, RalphFlowBlock>,
  positionsByBlockId: Map<string, RalphPosition>,
  childrenByGroupId: Map<string, string[]>,
): void => {
  const graphBounds = mergeRalphLayoutBounds(
    Array.from(positionsByBlockId, ([blockId, position]) => {
      const block = blocksById.get(blockId);
      return block ? getRalphLayoutNodeBoundsAtPosition(block, position) : null;
    }).filter((bounds): bounds is RalphLayoutNodeBounds => bounds !== null),
  );
  const groupIdsByChildId = createRalphLayoutChildGroupIds(childrenByGroupId);
  const fallbackX =
    (graphBounds?.right ?? 0) + RALPH_LAYOUT_VISUAL_COLUMN_GAP;
  let fallbackY = graphBounds?.top ?? 0;
  const groupNoteYByGroupId = new Map<string, number>();

  for (const note of notes) {
    const noteHeight = getRalphLayoutNodeHeight(note);
    const containingGroupId =
      note.parentGroupId ?? groupIdsByChildId.get(note.id)?.[0];
    const containingGroupChildIds =
      containingGroupId !== undefined
        ? (childrenByGroupId.get(containingGroupId) ?? []).filter(
            (childBlockId) => childBlockId !== note.id,
          )
        : [];
    const groupPeerBounds = getRalphLayoutBoundsForBlockIds(
      blocksById,
      positionsByBlockId,
      containingGroupChildIds,
    );
    const pinnedBounds = getRalphLayoutBoundsForBlockIds(
      blocksById,
      positionsByBlockId,
      note.pinnedBlockIds ?? [],
    );

    if (groupPeerBounds) {
      const y =
        groupNoteYByGroupId.get(containingGroupId ?? "") ??
        groupPeerBounds.bottom + RALPH_LAYOUT_VISUAL_ROW_GAP;

      positionsByBlockId.set(note.id, {
        x: groupPeerBounds.left,
        y,
      });
      if (containingGroupId) {
        groupNoteYByGroupId.set(
          containingGroupId,
          y + noteHeight + RALPH_LAYOUT_VISUAL_ROW_GAP,
        );
      }
      continue;
    }

    const anchorBounds = pinnedBounds;
    if (anchorBounds) {
      const y = Math.max(anchorBounds.top, fallbackY);
      positionsByBlockId.set(note.id, {
        x: anchorBounds.right + RALPH_LAYOUT_VISUAL_COLUMN_GAP,
        y,
      });
      fallbackY = y + noteHeight + RALPH_LAYOUT_VISUAL_ROW_GAP;
      continue;
    }

    positionsByBlockId.set(note.id, {
      x: fallbackX,
      y: fallbackY,
    });
    fallbackY += noteHeight + RALPH_LAYOUT_VISUAL_ROW_GAP;
  }
};

const createRalphGroupLayout = (
  group: RalphLayoutGroupBlock,
  childBounds: RalphLayoutNodeBounds,
): { position: RalphPosition; size: RalphSize } => {
  const width = Math.max(
    RALPH_LAYOUT_GROUP_NODE_WIDTH,
    childBounds.right - childBounds.left + RALPH_LAYOUT_GROUP_PADDING_X * 2,
  );
  const height = Math.max(
    RALPH_LAYOUT_GROUP_NODE_HEIGHT,
    childBounds.bottom -
      childBounds.top +
      RALPH_LAYOUT_GROUP_PADDING_TOP +
      RALPH_LAYOUT_GROUP_PADDING_BOTTOM,
  );

  return {
    position: {
      x: childBounds.left - RALPH_LAYOUT_GROUP_PADDING_X,
      y: childBounds.top - RALPH_LAYOUT_GROUP_PADDING_TOP,
    },
    size: {
      width,
      height: group.collapsed ? RALPH_LAYOUT_GROUP_NODE_HEIGHT : height,
    },
  };
};

const createRalphLayoutGroupPositions = (
  groups: readonly RalphLayoutGroupBlock[],
  blocksById: Map<string, RalphFlowBlock>,
  positionsByBlockId: Map<string, RalphPosition>,
  childrenByGroupId: Map<string, string[]>,
): Map<string, { position: RalphPosition; size: RalphSize }> => {
  const groupLayoutsById = new Map<
    string,
    { position: RalphPosition; size: RalphSize }
  >();
  const remainingGroupIds = new Set(groups.map((group) => group.id));
  let progressed = true;

  while (remainingGroupIds.size > 0 && progressed) {
    progressed = false;

    for (const group of groups) {
      if (!remainingGroupIds.has(group.id)) {
        continue;
      }

      const childBlockIds = childrenByGroupId.get(group.id) ?? [];
      const hasUnresolvedChildGroup = childBlockIds.some((childBlockId) =>
        remainingGroupIds.has(childBlockId),
      );

      if (hasUnresolvedChildGroup) {
        continue;
      }

      let layout: { position: RalphPosition; size: RalphSize } | undefined;
      const childBounds = getRalphLayoutBoundsForBlockIds(
        blocksById,
        positionsByBlockId,
        childBlockIds,
      );

      if (childBounds) {
        layout = createRalphGroupLayout(group, childBounds);
      } else if (group.position) {
        layout = {
          position: group.position,
          size: group.size ?? {
            width: RALPH_LAYOUT_GROUP_NODE_WIDTH,
            height: RALPH_LAYOUT_GROUP_NODE_HEIGHT,
          },
        };
      }

      if (!layout) {
        continue;
      }

      groupLayoutsById.set(group.id, layout);
      positionsByBlockId.set(group.id, layout.position);
      remainingGroupIds.delete(group.id);
      progressed = true;
    }
  }

  const existingBounds = mergeRalphLayoutBounds(
    Array.from(positionsByBlockId, ([blockId, position]) => {
      const block = blocksById.get(blockId);
      return block ? getRalphLayoutNodeBoundsAtPosition(block, position) : null;
    }).filter((bounds): bounds is RalphLayoutNodeBounds => bounds !== null),
  );
  const fallbackX =
    (existingBounds?.right ?? 0) + RALPH_LAYOUT_VISUAL_COLUMN_GAP;
  let fallbackY = existingBounds?.top ?? 0;

  for (const group of groups) {
    if (!remainingGroupIds.has(group.id)) {
      continue;
    }

    const childBounds = getRalphLayoutBoundsForBlockIds(
      blocksById,
      positionsByBlockId,
      childrenByGroupId.get(group.id) ?? [],
    );
    const layout = childBounds
      ? createRalphGroupLayout(group, childBounds)
      : {
          position: {
            x: fallbackX,
            y: fallbackY,
          },
          size: group.size ?? {
            width: RALPH_LAYOUT_GROUP_NODE_WIDTH,
            height: RALPH_LAYOUT_GROUP_NODE_HEIGHT,
          },
        };

    groupLayoutsById.set(group.id, layout);
    positionsByBlockId.set(group.id, layout.position);
    remainingGroupIds.delete(group.id);
    fallbackY += layout.size.height + RALPH_LAYOUT_VISUAL_ROW_GAP;
  }

  return groupLayoutsById;
};

export const normalizeRalphFlowLayout = (flow: RalphFlow): RalphFlow => {
  if (!shouldNormalizeRalphFlowLayout(flow)) {
    return flow;
  }

  const blocksToLayout = flow.blocks.filter(
    (block) => !isRalphLayoutVisualBlock(block),
  );
  const blockIdsToLayout = new Set(blocksToLayout.map((block) => block.id));
  const layoutEdges = flow.edges.filter(
    (edge) => blockIdsToLayout.has(edge.from) && blockIdsToLayout.has(edge.to),
  );
  const positionsByBlockId = createRalphLayoutPositions(
    blocksToLayout,
    layoutEdges,
  );
  const blocksById = new Map(flow.blocks.map((block) => [block.id, block]));
  const childrenByGroupId = createRalphLayoutGroupChildIds(flow);
  const notes = flow.blocks.filter(isRalphLayoutNoteBlock);

  createRalphLayoutNotePositions(
    notes,
    blocksById,
    positionsByBlockId,
    childrenByGroupId,
  );

  const groupLayoutsById = createRalphLayoutGroupPositions(
    flow.blocks.filter(isRalphLayoutGroupBlock),
    blocksById,
    positionsByBlockId,
    childrenByGroupId,
  );

  return {
    ...flow,
    blocks: flow.blocks.map((block) => {
      const position = positionsByBlockId.get(block.id);

      if (isRalphLayoutGroupBlock(block)) {
        const groupLayout = groupLayoutsById.get(block.id);

        return {
          ...block,
          childBlockIds: createRalphNormalizedGroupChildIds(
            block,
            childrenByGroupId.get(block.id) ?? [],
          ),
          ...(groupLayout
            ? { position: groupLayout.position, size: groupLayout.size }
            : {}),
        };
      }

      return position ? { ...block, position } : block;
    }),
  };
};
