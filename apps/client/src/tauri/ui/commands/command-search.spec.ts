import { describe, expect, it } from "vitest";
import { rankCommandItems } from "./command-search";

const items = [
  { id: "media.add", title: "Add node", keywords: ["semantic"] },
  { id: "chat.new", title: "New session", keywords: ["conversation"] },
  { id: "settings.open", title: "Préférences", keywords: ["configuration"] },
  { id: "workspace.open", title: "Открыть проект" },
];

describe("command search", () => {
  it("normalizes diacritics and searches titles, keywords, and IDs", () => {
    expect(rankCommandItems(items, "preferences").map(({ id }) => id)).toEqual([
      "settings.open",
    ]);
    expect(rankCommandItems(items, "semantic").map(({ id }) => id)).toEqual([
      "media.add",
    ]);
    expect(rankCommandItems(items, "chat new").map(({ id }) => id)).toEqual([
      "chat.new",
    ]);
    expect(rankCommandItems(items, "проект").map(({ id }) => id)).toEqual([
      "workspace.open",
    ]);
  });

  it("ranks exact and prefix matches deterministically", () => {
    const ranked = rankCommandItems(
      [
        { id: "b", title: "Node add", order: 2 },
        { id: "a", title: "Add node", order: 1 },
        { id: "c", title: "Add", order: 3 },
      ],
      "add",
    );
    expect(ranked.map(({ id }) => id)).toEqual(["c", "a", "b"]);
  });
});
