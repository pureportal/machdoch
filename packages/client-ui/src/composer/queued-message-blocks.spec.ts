import { describe, expect, it } from "vitest";
import {
  getQueuedMessageBlocks,
  getQueuedMessageDropTargetIndex,
  getQueuedMessageStepTargetIndex,
  moveQueuedMessageBlock,
} from "./queued-message-blocks";

const single = (id: string) => ({ id });
const iteration = (id: string) => ({ id, iteration: { groupId: "group" } });
const queue = [
  single("a"),
  iteration("first"),
  iteration("second"),
  single("b"),
];
const ids = (messages: readonly { id: string }[]): string[] =>
  messages.map((message) => message.id);

describe("queued message blocks", () => {
  it("groups iterations into one block", () => {
    expect(getQueuedMessageBlocks(queue).map(ids)).toEqual([
      ["a"],
      ["first", "second"],
      ["b"],
    ]);
  });

  it.each([
    ["first", 0, ["first", "second", "a", "b"]],
    ["second", 0, ["first", "second", "a", "b"]],
    ["first", 3, ["a", "b", "first", "second"]],
    ["second", 3, ["a", "b", "first", "second"]],
  ])("moves %s with its group to row %i", (messageId, targetIndex, expected) => {
    expect(ids(moveQueuedMessageBlock(queue, messageId, targetIndex))).toEqual(
      expected,
    );
  });

  it.each([
    ["a", 1, ["first", "second", "a", "b"]],
    ["a", 2, ["first", "second", "a", "b"]],
    ["b", 2, ["a", "b", "first", "second"]],
    ["b", 1, ["a", "b", "first", "second"]],
  ])(
    "keeps the group together when %s lands on row %i",
    (messageId, targetIndex, expected) => {
      expect(
        ids(moveQueuedMessageBlock(queue, messageId, targetIndex)),
      ).toEqual(expected);
    },
  );

  it("leaves the queue unchanged when a message lands on its own group", () => {
    expect(moveQueuedMessageBlock(queue, "first", 2)).toBe(queue);
    expect(moveQueuedMessageBlock(queue, "unknown", 0)).toBe(queue);
  });

  it("steps past a whole neighboring block", () => {
    const moveBy = (messageId: string, direction: -1 | 1): string[] =>
      ids(
        moveQueuedMessageBlock(
          queue,
          messageId,
          getQueuedMessageStepTargetIndex(queue, messageId, direction),
        ),
      );

    expect(moveBy("a", 1)).toEqual(["first", "second", "a", "b"]);
    expect(moveBy("second", -1)).toEqual(["first", "second", "a", "b"]);
    expect(moveBy("first", 1)).toEqual(["a", "b", "first", "second"]);
    expect(moveBy("b", -1)).toEqual(["a", "b", "first", "second"]);
  });

  it("does not step past the queue edges", () => {
    expect(getQueuedMessageStepTargetIndex(queue, "a", -1)).toBe(0);
    expect(getQueuedMessageStepTargetIndex(queue, "b", 1)).toBe(3);
  });

  it.each([
    ["a", 2, ["first", "second", "a", "b"]],
    ["a", 3, ["first", "second", "b", "a"]],
    ["b", 0, ["b", "a", "first", "second"]],
    ["b", 1, ["a", "b", "first", "second"]],
    ["second", 0, ["first", "second", "a", "b"]],
    ["first", 3, ["a", "b", "first", "second"]],
  ])("drops %s into slot %i", (messageId, dropSlot, expected) => {
    const targetIndex = getQueuedMessageDropTargetIndex(
      queue,
      messageId,
      dropSlot,
    );

    expect(targetIndex).not.toBeNull();
    expect(
      ids(moveQueuedMessageBlock(queue, messageId, targetIndex ?? -1)),
    ).toEqual(expected);
  });

  it("ignores drops beside the dragged block or outside the queue", () => {
    expect(getQueuedMessageDropTargetIndex(queue, "first", 1)).toBeNull();
    expect(getQueuedMessageDropTargetIndex(queue, "first", 2)).toBeNull();
    expect(getQueuedMessageDropTargetIndex(queue, "b", 3)).toBeNull();
    expect(getQueuedMessageDropTargetIndex(queue, "a", 4)).toBeNull();
    expect(getQueuedMessageDropTargetIndex(queue, "unknown", 0)).toBeNull();
  });

  it("moves a whole block to either edge", () => {
    expect(ids(moveQueuedMessageBlock(queue, "b", 0))).toEqual([
      "b",
      "a",
      "first",
      "second",
    ]);
    expect(
      ids(moveQueuedMessageBlock(queue, "first", queue.length - 1)),
    ).toEqual(["a", "b", "first", "second"]);
  });
});
