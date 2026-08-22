import type { RalphFlowBlock, RalphPosition } from "../ralph.js";
import {
  getRalphLayoutNodeBoundsAtPosition,
  mergeRalphLayoutBounds,
  type RalphLayoutNodeBounds,
} from "./ralph-layout-node-bounds.helper.js";

export const getRalphLayoutBoundsForBlockIds = (
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
