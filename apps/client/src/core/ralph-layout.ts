import type { RalphFlow, RalphFlowBlock } from "./ralph.js";
import {
  createRalphLayoutGroupChildIds,
  createRalphNormalizedGroupChildIds,
} from "./_helpers/create-ralph-layout-group-child-ids.helper.js";
import { createRalphLayoutPositions } from "./_helpers/create-ralph-layout-positions.helper.js";
import {
  createRalphLayoutGroupPositions,
  createRalphLayoutNotePositions,
} from "./_helpers/create-ralph-visual-layouts.helper.js";
import {
  isRalphLayoutGroupBlock,
  isRalphLayoutNoteBlock,
  isRalphLayoutVisualBlock,
} from "./_helpers/ralph-layout-block-types.helper.js";
import { shouldNormalizeRalphFlowLayout } from "./_helpers/should-normalize-ralph-flow-layout.helper.js";

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
  const blocksById = new Map<string, RalphFlowBlock>(
    flow.blocks.map((block) => [block.id, block]),
  );
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
