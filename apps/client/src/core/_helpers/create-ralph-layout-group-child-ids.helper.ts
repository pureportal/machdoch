import type { RalphFlow } from "../ralph.js";
import {
  isRalphLayoutGroupBlock,
  type RalphLayoutGroupBlock,
} from "./ralph-layout-block-types.helper.js";

export const createRalphLayoutGroupChildIds = (
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

export const createRalphNormalizedGroupChildIds = (
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

export const createRalphLayoutChildGroupIds = (
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
