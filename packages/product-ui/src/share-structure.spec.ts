import { expect, it } from "vitest";
import { shareStructure } from "./share-structure";

it("keeps unchanged branches and replaces only what changed", () => {
  const previous = {
    messages: [{ id: "a", text: "one" }, { id: "b", text: "two" }],
    composer: { model: "gpt", draft: "" },
  };
  const next = {
    messages: [{ id: "a", text: "one" }, { id: "b", text: "two" }],
    composer: { model: "gpt", draft: "typed" },
  };
  const shared = shareStructure(previous, next);
  expect(shared).toEqual(next);
  expect(shared.messages).toBe(previous.messages);
  expect(shared.composer).not.toBe(previous.composer);
  expect(shareStructure(previous, structuredClone(previous))).toBe(previous);
});

it("treats added, removed and reordered entries as changes", () => {
  const previous = { list: [1, 2], flag: true } as Record<string, unknown>;
  expect(shareStructure(previous, { list: [2, 1], flag: true })).not.toBe(
    previous,
  );
  expect(shareStructure(previous, { list: [1, 2] })).not.toBe(previous);
  expect(
    shareStructure(previous, { list: [1, 2], flag: true, extra: 1 }),
  ).not.toBe(previous);
});
