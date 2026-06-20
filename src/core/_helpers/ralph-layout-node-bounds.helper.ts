import type { RalphFlowBlock, RalphPosition } from "../ralph.js";

export const RALPH_LAYOUT_COLUMN_GAP = 340;
export const RALPH_LAYOUT_ROW_GAP = 190;
export const RALPH_LAYOUT_NODE_MARGIN = 36;
export const RALPH_LAYOUT_DEFAULT_NODE_WIDTH = 270;
export const RALPH_LAYOUT_UTILITY_NODE_WIDTH = 300;
export const RALPH_LAYOUT_NOTE_NODE_WIDTH = 280;
export const RALPH_LAYOUT_GROUP_NODE_WIDTH = 720;
export const RALPH_LAYOUT_NODE_HEIGHT = 140;
export const RALPH_LAYOUT_NOTE_NODE_HEIGHT = 180;
export const RALPH_LAYOUT_GROUP_NODE_HEIGHT = 420;
export const RALPH_LAYOUT_GROUP_PADDING_X = 70;
export const RALPH_LAYOUT_GROUP_PADDING_TOP = 88;
export const RALPH_LAYOUT_GROUP_PADDING_BOTTOM = 56;
export const RALPH_LAYOUT_VISUAL_COLUMN_GAP = 80;
export const RALPH_LAYOUT_VISUAL_ROW_GAP = 36;

export interface RalphLayoutNodeBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const getRalphLayoutNodeWidth = (block: RalphFlowBlock): number => {
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

export const getRalphLayoutNodeHeight = (block: RalphFlowBlock): number => {
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

export const getRalphLayoutNodeBoundsAtPosition = (
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

export const getRalphLayoutNodeBounds = (
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

export const doRalphLayoutBoundsOverlap = (
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

export const doRalphLayoutBoundsContain = (
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

export const mergeRalphLayoutBounds = (
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
