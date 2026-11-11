import { describe, expect, it } from "vitest";
import { rankWorkspaceOptions } from "./workspace-option-search";

const options = [
  {
    id: "alpha-tools",
    label: "alpha-tools",
    path: "C:\\Development\\alpha-tools",
  },
  { id: "beta", label: "beta", path: "C:\\Development\\alpha\\beta" },
  { id: "alpha", label: "alpha", path: "C:\\Development\\alpha" },
  { id: "not-set", label: "No workspace", path: null },
];

describe("workspace option search", () => {
  it("keeps the original order without a query", () => {
    expect(rankWorkspaceOptions(options, "  ").map(({ id }) => id)).toEqual([
      "alpha-tools",
      "beta",
      "alpha",
      "not-set",
    ]);
  });

  it("ranks exact label matches first and matches paths with any separator", () => {
    expect(rankWorkspaceOptions(options, "alpha").map(({ id }) => id)).toEqual([
      "alpha",
      "alpha-tools",
      "beta",
    ]);
    expect(
      rankWorkspaceOptions(options, "development/alpha/beta").map(
        ({ id }) => id,
      ),
    ).toEqual(["beta"]);
  });

  it("requires every query token to match", () => {
    expect(rankWorkspaceOptions(options, "alpha missing")).toEqual([]);
  });
});
