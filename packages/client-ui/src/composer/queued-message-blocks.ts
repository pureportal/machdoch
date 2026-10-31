interface QueuedMessageBlockMember {
  id: string;
  iteration?: { groupId: string };
}

export const getQueuedMessageBlocks = <Message extends QueuedMessageBlockMember>(
  messages: readonly Message[],
): Message[][] => {
  const blocks = new Map<string, Message[]>();

  for (const message of messages) {
    const blockKey = message.iteration?.groupId ?? message.id;
    blocks.set(blockKey, [...(blocks.get(blockKey) ?? []), message]);
  }

  return [...blocks.values()];
};

export const findQueuedMessageBlockIndex = <
  Message extends QueuedMessageBlockMember,
>(
  blocks: readonly Message[][],
  messageId: string | null,
): number =>
  blocks.findIndex((block) => block.some((entry) => entry.id === messageId));

export const moveQueuedMessageBlock = <
  Message extends QueuedMessageBlockMember,
>(
  messages: readonly Message[],
  messageId: string,
  targetIndex: number,
): readonly Message[] => {
  const blocks = getQueuedMessageBlocks(messages);
  const sourceBlockIndex = findQueuedMessageBlockIndex(blocks, messageId);
  const targetBlockIndex = findQueuedMessageBlockIndex(
    blocks,
    messages[Math.max(0, Math.min(targetIndex, messages.length - 1))]?.id ??
      null,
  );
  const sourceBlock = blocks[sourceBlockIndex];

  if (!sourceBlock || sourceBlockIndex === targetBlockIndex) {
    return messages;
  }

  const remainingBlocks = blocks.filter(
    (_, blockIndex) => blockIndex !== sourceBlockIndex,
  );

  return [
    ...remainingBlocks.slice(0, targetBlockIndex),
    sourceBlock,
    ...remainingBlocks.slice(targetBlockIndex),
  ].flat();
};

export const getQueuedMessageStepTargetIndex = <
  Message extends QueuedMessageBlockMember,
>(
  messages: readonly Message[],
  messageId: string,
  direction: -1 | 1,
): number => {
  const blocks = getQueuedMessageBlocks(messages);
  const adjacentBlock =
    blocks[findQueuedMessageBlockIndex(blocks, messageId) + direction];
  const targetMessageId = adjacentBlock?.[0]?.id ?? messageId;

  return messages.findIndex((message) => message.id === targetMessageId);
};
