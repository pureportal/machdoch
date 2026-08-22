import type { RalphFlow } from "../ralph.js";
import { hasRalphLayoutGroupMismatch } from "./has-ralph-layout-group-mismatch.helper.js";
import { isRalphLayoutGroupBlock } from "./ralph-layout-block-types.helper.js";
import {
  doRalphLayoutBoundsOverlap,
  getRalphLayoutNodeBounds,
  type RalphLayoutNodeBounds,
} from "./ralph-layout-node-bounds.helper.js";

export const shouldNormalizeRalphFlowLayout = (flow: RalphFlow): boolean => {
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
