import type { Edge, Node } from "@xyflow/react";
import { normalizeRalphFlowLayout } from "../../../../core/ralph-layout.js";
import type {
  RalphExecutionOutput,
  RalphFlow,
  RalphFlowBlock,
  RalphPosition,
  RalphSize,
} from "../../../../core/ralph.js";
import type { LocalIssue } from "./validate-flow-locally.helper";
import {
  getBlockOutputs,
  isVisualRalphCanvasBlock,
} from "./get-block-outputs.helper";
import { getRalphOutputTone } from "./get-ralph-block-visual.helper";
import { createFlowCanvasEdge } from "@machdoch/media-studio/tauri/ui/flow/flow-theme.js";

export type RalphNodeResizeEndHandler = (
  blockId: string,
  size: RalphSize,
  position: RalphPosition,
) => void;

export type RalphNodeData = Record<string, unknown> & {
  block: RalphFlowBlock;
  outputs: RalphExecutionOutput[];
  issueCount: number;
  active: boolean;
  selected: boolean;
  derivedChildIds: string[];
  hiddenByCollapsedGroup: boolean;
  collapsedGroupInput?: boolean;
  lockedByGroupId: string | null;
  onResizeEnd?: RalphNodeResizeEndHandler;
};

export type RalphCanvasNode = Node<RalphNodeData, "ralphBlock">;

export type RalphEdgeData = Record<string, unknown> & {
  output: RalphExecutionOutput;
};

export type RalphCanvasEdge = Edge<RalphEdgeData, "flow">;

export interface RalphCanvasBlockBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
}

export const RALPH_NOTE_DEFAULT_SIZE = { width: 280, height: 180 };
export const RALPH_GROUP_DEFAULT_SIZE = { width: 720, height: 420 };
export const RALPH_GROUP_COLLAPSED_HEIGHT = 72;
export const RALPH_GROUP_COLLAPSED_WIDTH = 320;
export const RALPH_CANVAS_X_GAP = 420;
export const RALPH_CANVAS_Y_GAP = 400;
export const RALPH_BLOCK_FALLBACK_HEIGHT = 150;
export const RALPH_CANVAS_STACK_OFFSET = 28;

const RALPH_CANVAS_COLUMNS = 2;
const RALPH_CANVAS_X_START = 80;
const RALPH_CANVAS_Y_START = 120;
const RALPH_STANDARD_BLOCK_WIDTH = 256;
const RALPH_UTILITY_BLOCK_WIDTH = 288;
const RALPH_CLEAN_LAYOUT_RESERVED_GAP = 96;
const RALPH_CANVAS_MAX_STACK_ATTEMPTS = 1000;

export const getDefaultCanvasPosition = (
  index: number,
): { x: number; y: number } => ({
  x: RALPH_CANVAS_X_START + (index % RALPH_CANVAS_COLUMNS) * RALPH_CANVAS_X_GAP,
  y:
    RALPH_CANVAS_Y_START +
    Math.floor(index / RALPH_CANVAS_COLUMNS) * RALPH_CANVAS_Y_GAP,
});

export const getBlockFallbackWidth = (block: RalphFlowBlock): number => {
  return block.type === "UTILITY"
    ? RALPH_UTILITY_BLOCK_WIDTH
    : RALPH_STANDARD_BLOCK_WIDTH;
};

export const getCanvasBlockSize = (
  block: RalphFlowBlock,
): { width: number; height: number } => {
  if (block.size) {
    return block.size;
  }

  if (block.type === "NOTE") {
    return RALPH_NOTE_DEFAULT_SIZE;
  }

  if (block.type === "GROUP") {
    return RALPH_GROUP_DEFAULT_SIZE;
  }

  return {
    width: getBlockFallbackWidth(block),
    height: Math.max(
      RALPH_BLOCK_FALLBACK_HEIGHT,
      220 + getBlockOutputs(block).length * 26,
    ),
  };
};

export const getCanvasBlockPosition = (
  block: RalphFlowBlock,
  index: number,
): RalphPosition => block.position ?? getDefaultCanvasPosition(index);

const getRoundedCanvasPosition = (position: RalphPosition): RalphPosition => ({
  x: Math.round(position.x),
  y: Math.round(position.y),
});

const getCanvasPositionKey = (position: RalphPosition): string => {
  const rounded = getRoundedCanvasPosition(position);

  return `${rounded.x}:${rounded.y}`;
};

export const getDisplacedCanvasPosition = (
  flow: RalphFlow,
  position: RalphPosition,
  options: {
    ignoredBlockIds?: ReadonlySet<string>;
    reservedPositions?: Iterable<RalphPosition>;
    offset?: number;
  } = {},
): RalphPosition => {
  const occupiedPositions = new Set<string>();
  const ignoredBlockIds = options.ignoredBlockIds ?? new Set<string>();
  const displacement =
    typeof options.offset === "number" &&
    Number.isFinite(options.offset) &&
    options.offset > 0
      ? options.offset
      : RALPH_CANVAS_STACK_OFFSET;

  for (const [index, block] of flow.blocks.entries()) {
    if (ignoredBlockIds.has(block.id)) {
      continue;
    }

    occupiedPositions.add(
      getCanvasPositionKey(getCanvasBlockPosition(block, index)),
    );
  }

  for (const reservedPosition of options.reservedPositions ?? []) {
    occupiedPositions.add(getCanvasPositionKey(reservedPosition));
  }

  let candidate = getRoundedCanvasPosition(position);

  for (
    let attempt = 0;
    attempt < RALPH_CANVAS_MAX_STACK_ATTEMPTS;
    attempt += 1
  ) {
    if (!occupiedPositions.has(getCanvasPositionKey(candidate))) {
      return candidate;
    }

    candidate = {
      x: candidate.x + displacement,
      y: candidate.y + displacement,
    };
  }

  return candidate;
};

export const getCanvasBlockBounds = (
  block: RalphFlowBlock,
  index: number,
): RalphCanvasBlockBounds => {
  const position = getCanvasBlockPosition(block, index);
  const size = getCanvasBlockSize(block);
  const right = position.x + size.width;
  const bottom = position.y + size.height;

  return {
    left: position.x,
    top: position.y,
    right,
    bottom,
    centerX: position.x + size.width / 2,
    centerY: position.y + size.height / 2,
  };
};

export const isPointInsideBounds = (
  x: number,
  y: number,
  bounds: RalphCanvasBlockBounds,
): boolean =>
  x >= bounds.left &&
  x <= bounds.right &&
  y >= bounds.top &&
  y <= bounds.bottom;

export const doCanvasBoundsOverlap = (
  left: RalphCanvasBlockBounds,
  right: RalphCanvasBlockBounds,
): boolean => {
  return !(
    left.right <= right.left ||
    right.right <= left.left ||
    left.bottom <= right.top ||
    right.bottom <= left.top
  );
};

export const getCanvasBlockBoundsAtPosition = (
  block: RalphFlowBlock,
  position: RalphPosition,
): RalphCanvasBlockBounds => {
  const size = getCanvasBlockSize(block);
  const right = position.x + size.width;
  const bottom = position.y + size.height;

  return {
    left: position.x,
    top: position.y,
    right,
    bottom,
    centerX: position.x + size.width / 2,
    centerY: position.y + size.height / 2,
  };
};

export const translateCanvasBounds = (
  bounds: RalphCanvasBlockBounds,
  deltaX: number,
  deltaY: number,
): RalphCanvasBlockBounds => ({
  left: bounds.left + deltaX,
  top: bounds.top + deltaY,
  right: bounds.right + deltaX,
  bottom: bounds.bottom + deltaY,
  centerX: bounds.centerX + deltaX,
  centerY: bounds.centerY + deltaY,
});

export const avoidReservedCleanLayoutBounds = (
  flow: RalphFlow,
  layoutBlockIds: ReadonlySet<string>,
  positionsByBlockId: ReadonlyMap<string, RalphPosition>,
): Map<string, RalphPosition> => {
  const blockIndex = new Map(
    flow.blocks.map((block, index) => [block.id, index] as const),
  );
  const reservedBounds = flow.blocks
    .filter((block) => !layoutBlockIds.has(block.id))
    .map((block) => {
      const index = blockIndex.get(block.id) ?? 0;

      return getCanvasBlockBounds(block, index);
    });
  const layoutBounds = flow.blocks.flatMap((block) => {
    if (!layoutBlockIds.has(block.id)) {
      return [];
    }

    const position = positionsByBlockId.get(block.id);

    return position
      ? [{ bounds: getCanvasBlockBoundsAtPosition(block, position) }]
      : [];
  });

  if (reservedBounds.length === 0 || layoutBounds.length === 0) {
    return new Map(positionsByBlockId);
  }

  let deltaX = 0;

  for (let attempt = 0; attempt < reservedBounds.length; attempt += 1) {
    let nextDeltaX = deltaX;

    for (const layoutBound of layoutBounds) {
      const shiftedBounds = translateCanvasBounds(
        layoutBound.bounds,
        deltaX,
        0,
      );

      for (const reservedBound of reservedBounds) {
        if (!doCanvasBoundsOverlap(shiftedBounds, reservedBound)) {
          continue;
        }

        nextDeltaX = Math.max(
          nextDeltaX,
          reservedBound.right +
            RALPH_CLEAN_LAYOUT_RESERVED_GAP -
            layoutBound.bounds.left,
        );
      }
    }

    if (nextDeltaX === deltaX) {
      break;
    }

    deltaX = nextDeltaX;
  }

  if (deltaX === 0) {
    return new Map(positionsByBlockId);
  }

  return new Map(
    Array.from(positionsByBlockId, ([blockId, position]) => [
      blockId,
      {
        x: Math.round(position.x + deltaX),
        y: position.y,
      },
    ]),
  );
};

export const createDerivedGroupChildrenById = (
  flow: RalphFlow,
): Map<string, string[]> => {
  const blockIndex = new Map(
    flow.blocks.map((block, index) => [block.id, index] as const),
  );
  const childrenByGroupId = new Map<string, string[]>();

  for (const group of flow.blocks) {
    if (group.type !== "GROUP") {
      continue;
    }

    const explicitlyListedChildIds = new Set(group.childBlockIds);
    const groupIndex = blockIndex.get(group.id) ?? 0;
    const groupBounds = getCanvasBlockBounds(group, groupIndex);
    const childIds = new Set<string>();

    for (const block of flow.blocks) {
      if (block.id === group.id) {
        continue;
      }

      if (block.parentGroupId === group.id) {
        childIds.add(block.id);
        continue;
      }

      const candidateIndex = blockIndex.get(block.id) ?? 0;
      const candidateBounds = getCanvasBlockBounds(block, candidateIndex);
      const hasPlacedGeometry = Boolean(group.position && block.position);
      const isInsideGroup = isPointInsideBounds(
        candidateBounds.centerX,
        candidateBounds.centerY,
        groupBounds,
      );

      if (
        isInsideGroup ||
        (!hasPlacedGeometry && explicitlyListedChildIds.has(block.id))
      ) {
        childIds.add(block.id);
      }
    }

    childrenByGroupId.set(group.id, [...childIds]);
  }

  return childrenByGroupId;
};

export const collectCollapsedGroupHiddenBlockIds = (
  flow: RalphFlow,
  childrenByGroupId: Map<string, string[]>,
): Set<string> => {
  const hiddenBlockIds = new Set<string>();
  const blocksById = new Map(flow.blocks.map((block) => [block.id, block]));

  const visitChild = (blockId: string): void => {
    if (hiddenBlockIds.has(blockId)) {
      return;
    }

    hiddenBlockIds.add(blockId);
    const block = blocksById.get(blockId);

    if (block?.type !== "GROUP") {
      return;
    }

    for (const childId of childrenByGroupId.get(block.id) ?? []) {
      visitChild(childId);
    }
  };

  for (const block of flow.blocks) {
    if (block.type !== "GROUP" || !block.collapsed) {
      continue;
    }

    for (const childId of childrenByGroupId.get(block.id) ?? []) {
      visitChild(childId);
    }
  }

  return hiddenBlockIds;
};

export const createLockedParentGroupIdByBlockId = (
  flow: RalphFlow,
): Map<string, string> => {
  const childrenByGroupId = createDerivedGroupChildrenById(flow);
  const blocksById = new Map(flow.blocks.map((block) => [block.id, block]));
  const lockedParentGroupIdByBlockId = new Map<string, string>();

  const visitGroup = (
    groupId: string,
    inheritedLockedGroupId: string | null,
    visitingGroupIds: ReadonlySet<string>,
  ): void => {
    if (visitingGroupIds.has(groupId)) {
      return;
    }

    const group = blocksById.get(groupId);

    if (group?.type !== "GROUP") {
      return;
    }

    const nextVisitingGroupIds = new Set(visitingGroupIds);
    nextVisitingGroupIds.add(groupId);
    const lockedGroupId = group.locked ? group.id : inheritedLockedGroupId;

    for (const childId of childrenByGroupId.get(group.id) ?? []) {
      if (lockedGroupId && !lockedParentGroupIdByBlockId.has(childId)) {
        lockedParentGroupIdByBlockId.set(childId, lockedGroupId);
      }

      const child = blocksById.get(childId);

      if (child?.type === "GROUP") {
        visitGroup(child.id, lockedGroupId, nextVisitingGroupIds);
      }
    }
  };

  for (const block of flow.blocks) {
    if (block.type === "GROUP") {
      visitGroup(block.id, null, new Set<string>());
    }
  }

  return lockedParentGroupIdByBlockId;
};

export const createLockedCanvasBlockIdSet = (flow: RalphFlow): Set<string> => {
  const lockedParentGroupIdByBlockId = createLockedParentGroupIdByBlockId(flow);
  const lockedBlockIds = new Set(lockedParentGroupIdByBlockId.keys());

  for (const block of flow.blocks) {
    if (block.locked) {
      lockedBlockIds.add(block.id);
    }
  }

  return lockedBlockIds;
};

export const normalizeDerivedGroupMembership = (flow: RalphFlow): RalphFlow => {
  const childrenByGroupId = createDerivedGroupChildrenById(flow);
  let changed = false;
  const blocks = flow.blocks.map((block) => {
    if (block.type !== "GROUP") {
      return block;
    }

    const childBlockIds = childrenByGroupId.get(block.id) ?? [];

    if (childBlockIds.join("\n") === block.childBlockIds.join("\n")) {
      return block;
    }

    changed = true;
    return { ...block, childBlockIds };
  });

  return changed ? { ...flow, blocks } : flow;
};

export const forceRalphFlowLayout = (flow: RalphFlow): RalphFlow => {
  const flowWithDerivedGroups = normalizeDerivedGroupMembership(flow);
  const lockedBlockIds = createLockedCanvasBlockIdSet(flowWithDerivedGroups);
  const childIdsByGroupId = new Map<string, string[]>();

  for (const block of flowWithDerivedGroups.blocks) {
    if (block.type === "GROUP") {
      childIdsByGroupId.set(block.id, block.childBlockIds);
    }
  }

  const groupedBlockIds = new Set<string>();
  const collectGroupedBlockIds = (blockId: string): void => {
    if (groupedBlockIds.has(blockId)) {
      return;
    }

    groupedBlockIds.add(blockId);

    for (const childBlockId of childIdsByGroupId.get(blockId) ?? []) {
      collectGroupedBlockIds(childBlockId);
    }
  };

  for (const childBlockIds of childIdsByGroupId.values()) {
    for (const childBlockId of childBlockIds) {
      collectGroupedBlockIds(childBlockId);
    }
  }

  const layoutBlockIds = new Set(
    flowWithDerivedGroups.blocks
      .filter(
        (block) =>
          block.type !== "NOTE" &&
          block.type !== "GROUP" &&
          !lockedBlockIds.has(block.id) &&
          !groupedBlockIds.has(block.id),
      )
      .map((block) => block.id),
  );

  if (layoutBlockIds.size === 0) {
    return flowWithDerivedGroups;
  }

  const withoutPositions: RalphFlow = {
    ...flowWithDerivedGroups,
    blocks: flowWithDerivedGroups.blocks
      .filter((block) => layoutBlockIds.has(block.id))
      .map((block) => {
        const copy = { ...block } as RalphFlowBlock;
        delete copy.position;
        return copy;
      }),
    edges: flowWithDerivedGroups.edges.filter(
      (edge) => layoutBlockIds.has(edge.from) && layoutBlockIds.has(edge.to),
    ),
  };
  const arrangedFlow = normalizeRalphFlowLayout(withoutPositions);
  const arrangedPositionsByBlockId = new Map(
    arrangedFlow.blocks.flatMap((block) =>
      block.position ? [[block.id, block.position] as const] : [],
    ),
  );
  const positionsByBlockId = avoidReservedCleanLayoutBounds(
    flowWithDerivedGroups,
    layoutBlockIds,
    arrangedPositionsByBlockId,
  );

  return {
    ...flowWithDerivedGroups,
    blocks: flowWithDerivedGroups.blocks.map((block) => {
      const position = positionsByBlockId.get(block.id);

      return position ? { ...block, position } : block;
    }),
  };
};

const createCollapsedGroupRepresentatives = (
  flow: RalphFlow,
  childrenByGroupId: Map<string, string[]>,
  hiddenBlockIds: Set<string>,
): Map<string, string> => {
  const representatives = new Map(
    flow.blocks.map((block) => [block.id, block.id]),
  );
  for (const group of flow.blocks) {
    if (
      group.type !== "GROUP" ||
      !group.collapsed ||
      hiddenBlockIds.has(group.id)
    )
      continue;
    const pending = [...(childrenByGroupId.get(group.id) ?? [])];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      representatives.set(id, group.id);
      pending.push(...(childrenByGroupId.get(id) ?? []));
    }
  }
  return representatives;
};

export const flowToNodes = (
  flow: RalphFlow,
  issues: LocalIssue[],
  selectedBlockId: string | null,
  activeBlockId: string | null,
  onNodeResizeEnd?: RalphNodeResizeEndHandler,
): RalphCanvasNode[] => {
  const childrenByGroupId = createDerivedGroupChildrenById(flow);
  const hiddenBlockIds = collectCollapsedGroupHiddenBlockIds(
    flow,
    childrenByGroupId,
  );
  const lockedParentGroupIdByBlockId = createLockedParentGroupIdByBlockId(flow);
  const representatives = createCollapsedGroupRepresentatives(
    flow,
    childrenByGroupId,
    hiddenBlockIds,
  );
  const visibleBlocks = flow.blocks.filter(
    (block) => !hiddenBlockIds.has(block.id),
  );
  const compactOverview =
    visibleBlocks.length > 0 &&
    visibleBlocks.every((block) => block.type === "GROUP" && block.collapsed);
  const overviewPositions = new Map(
    compactOverview
      ? visibleBlocks.map(
          (block, index) =>
            [
              block.id,
              {
                x: RALPH_CANVAS_X_START + (index % 2) * RALPH_CANVAS_X_GAP,
                y: RALPH_CANVAS_Y_START + Math.floor(index / 2) * 200,
              },
            ] as const,
        )
      : [],
  );

  return flow.blocks.map((block, index) => {
    const size = block.size;
    const isCollapsedGroup = block.type === "GROUP" && block.collapsed;
    const renderSize = isCollapsedGroup
      ? {
          width: RALPH_GROUP_COLLAPSED_WIDTH,
          height: RALPH_GROUP_COLLAPSED_HEIGHT,
        }
      : size;
    const lockedByGroupId = lockedParentGroupIdByBlockId.get(block.id) ?? null;
    const isLocked = Boolean(block.locked || lockedByGroupId);

    return {
      id: block.id,
      type: "ralphBlock",
      position:
        overviewPositions.get(block.id) ?? getCanvasBlockPosition(block, index),
      ...(renderSize
        ? { style: { width: renderSize.width, height: renderSize.height } }
        : {}),
      ...(block.type === "GROUP" ? { zIndex: -1 } : {}),
      ...(isLocked || compactOverview ? { draggable: false } : {}),
      ...(hiddenBlockIds.has(block.id) ? { hidden: true } : {}),
      data: {
        block,
        outputs: isCollapsedGroup
          ? flow.edges.some(
              (edge) =>
                representatives.get(edge.from) === block.id &&
                representatives.get(edge.to) !== block.id,
            )
            ? ["group-output"]
            : []
          : getBlockOutputs(block),
        ...(isCollapsedGroup
          ? {
              collapsedGroupInput: flow.edges.some(
                (edge) =>
                  representatives.get(edge.to) === block.id &&
                  representatives.get(edge.from) !== block.id,
              ),
            }
          : {}),
        issueCount: issues.filter((issue) => issue.blockId === block.id).length,
        active:
          activeBlockId !== null &&
          block.id === representatives.get(activeBlockId),
        selected: block.id === selectedBlockId,
        derivedChildIds: childrenByGroupId.get(block.id) ?? [],
        hiddenByCollapsedGroup: hiddenBlockIds.has(block.id),
        lockedByGroupId,
        ...(onNodeResizeEnd ? { onResizeEnd: onNodeResizeEnd } : {}),
      },
    };
  });
};

export const flowToEdges = (
  flow: RalphFlow,
  selectedEdgeId: string | null,
  selectedBlockId: string | null,
): RalphCanvasEdge[] => {
  const childrenByGroupId = createDerivedGroupChildrenById(flow);
  const hiddenBlockIds = collectCollapsedGroupHiddenBlockIds(
    flow,
    childrenByGroupId,
  );
  const representatives = createCollapsedGroupRepresentatives(
    flow,
    childrenByGroupId,
    hiddenBlockIds,
  );
  const visibleGroupConnections = new Set<string>();

  return flow.edges.map((edge) => {
    const source = representatives.get(edge.from) ?? edge.from;
    const target = representatives.get(edge.to) ?? edge.to;
    const collapsedConnection = source !== edge.from || target !== edge.to;
    const connection = JSON.stringify([
      source,
      source !== edge.from ? "group-output" : edge.fromOutput,
      target,
    ]);
    const hidden =
      collapsedConnection &&
      (source === target || visibleGroupConnections.has(connection));
    if (collapsedConnection && !hidden) visibleGroupConnections.add(connection);
    const selected = edge.id === selectedEdgeId;
    const connectedToSelectedBlock =
      selectedBlockId !== null &&
      (source === selectedBlockId || target === selectedBlockId);
    const output = source !== edge.from ? "" : edge.fromOutput;
    const tone = getRalphOutputTone(output);

    const canvasEdge = createFlowCanvasEdge<RalphEdgeData>({
      id: edge.id,
      source,
      sourceHandle: source !== edge.from ? "group-output" : edge.fromOutput,
      target,
      data: {
        output,
      },
      tone,
      emphasis: selected
        ? "strong"
        : connectedToSelectedBlock
          ? "medium"
          : "default",
      selected,
      hidden,
    });
    return collapsedConnection ? { ...canvasEdge, zIndex: -2 } : canvasEdge;
  });
};

export const getSelectableRouteTargets = (
  flow: RalphFlow,
): RalphFlowBlock[] => {
  return flow.blocks.filter((block) => !isVisualRalphCanvasBlock(block));
};
