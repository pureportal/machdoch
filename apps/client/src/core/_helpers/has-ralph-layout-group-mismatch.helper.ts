import type { RalphFlow } from "../ralph.js";
import {
  createRalphLayoutGroupChildIds,
  createRalphNormalizedGroupChildIds,
} from "./create-ralph-layout-group-child-ids.helper.js";
import { isRalphLayoutGroupBlock } from "./ralph-layout-block-types.helper.js";
import {
  doRalphLayoutBoundsContain,
  getRalphLayoutNodeBoundsAtPosition,
} from "./ralph-layout-node-bounds.helper.js";

export const hasRalphLayoutGroupMismatch = (flow: RalphFlow): boolean => {
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
