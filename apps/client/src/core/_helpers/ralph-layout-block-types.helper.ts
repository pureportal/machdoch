import type { RalphFlowBlock } from "../ralph.js";

export type RalphLayoutGroupBlock = Extract<RalphFlowBlock, { type: "GROUP" }>;
export type RalphLayoutNoteBlock = Extract<RalphFlowBlock, { type: "NOTE" }>;

export const isRalphLayoutGroupBlock = (
  block: RalphFlowBlock,
): block is RalphLayoutGroupBlock => block.type === "GROUP";

export const isRalphLayoutNoteBlock = (
  block: RalphFlowBlock,
): block is RalphLayoutNoteBlock => block.type === "NOTE";

export const isRalphLayoutVisualBlock = (block: RalphFlowBlock): boolean =>
  block.type === "NOTE" || block.type === "GROUP";
