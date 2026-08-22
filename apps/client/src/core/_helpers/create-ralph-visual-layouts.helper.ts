import type { RalphFlowBlock, RalphPosition, RalphSize } from "../ralph.js";
import {
  createRalphLayoutChildGroupIds,
} from "./create-ralph-layout-group-child-ids.helper.js";
import { getRalphLayoutBoundsForBlockIds } from "./get-ralph-layout-bounds-for-block-ids.helper.js";
import {
  RALPH_LAYOUT_GROUP_NODE_HEIGHT,
  RALPH_LAYOUT_GROUP_NODE_WIDTH,
  RALPH_LAYOUT_GROUP_PADDING_BOTTOM,
  RALPH_LAYOUT_GROUP_PADDING_TOP,
  RALPH_LAYOUT_GROUP_PADDING_X,
  RALPH_LAYOUT_VISUAL_COLUMN_GAP,
  RALPH_LAYOUT_VISUAL_ROW_GAP,
  getRalphLayoutNodeBoundsAtPosition,
  getRalphLayoutNodeHeight,
  mergeRalphLayoutBounds,
  type RalphLayoutNodeBounds,
} from "./ralph-layout-node-bounds.helper.js";
import type {
  RalphLayoutGroupBlock,
  RalphLayoutNoteBlock,
} from "./ralph-layout-block-types.helper.js";

export const createRalphLayoutNotePositions = (
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

export const createRalphGroupLayout = (
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

export const createRalphLayoutGroupPositions = (
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
