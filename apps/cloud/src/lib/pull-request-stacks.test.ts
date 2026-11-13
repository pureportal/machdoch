import { expect, it } from "vitest";
import { pullRequestStacks, type StackCandidate } from "./pull-request-stacks";

function candidate(
  id: string,
  headRef: string,
  baseRef: string,
  fields: Partial<StackCandidate> = {},
): StackCandidate {
  return {
    id,
    repositoryId: "repo",
    number: Number(id.slice(1)),
    title: `Change ${id}`,
    headRef,
    baseRef,
    state: "open",
    updatedAt: "2026-11-01T10:00:00.000Z",
    ...fields,
  };
}

it("links each pull request to the one it is stacked on", () => {
  const stacks = pullRequestStacks([
    candidate("p1", "feature/a", "main"),
    candidate("p2", "feature/b", "feature/a"),
    candidate("p3", "feature/c", "feature/b"),
    candidate("p4", "fix", "main"),
  ]);
  expect(stacks.get("p4")).toBeUndefined();
  expect(stacks.get("p1")).toMatchObject({
    parent: null,
    depth: 0,
    retargetTo: null,
  });
  expect(stacks.get("p1")!.children.map((child) => child.id)).toEqual(["p2"]);
  expect(stacks.get("p2")).toMatchObject({ parent: { id: "p1" }, depth: 1 });
  expect(stacks.get("p3")).toMatchObject({ parent: { id: "p2" }, depth: 2 });
  expect(stacks.get("p3")!.children).toEqual([]);
});

it("asks to retarget onto the merged parent's base", () => {
  const stacks = pullRequestStacks([
    candidate("p1", "feature/a", "main", { state: "merged" }),
    candidate("p2", "feature/b", "feature/a"),
  ]);
  expect(stacks.get("p2")).toMatchObject({
    parent: { id: "p1", state: "merged" },
    depth: 0,
    retargetTo: "main",
  });
  expect(stacks.get("p1")!.children.map((child) => child.id)).toEqual(["p2"]);
});

it("prefers the open parent, ignores other repositories and closed parents", () => {
  const stacks = pullRequestStacks([
    candidate("p1", "feature/a", "main", {
      state: "merged",
      updatedAt: "2026-11-02T10:00:00.000Z",
    }),
    candidate("p2", "feature/a", "main"),
    candidate("p3", "feature/b", "feature/a"),
    candidate("p4", "feature/x", "main", { state: "closed" }),
    candidate("p5", "feature/y", "feature/x"),
    candidate("p6", "feature/b", "feature/a", { repositoryId: "other" }),
  ]);
  expect(stacks.get("p3")!.parent!.id).toBe("p2");
  expect(stacks.get("p5")).toBeUndefined();
  expect(stacks.get("p6")).toBeUndefined();
});

it("survives cycles", () => {
  const stacks = pullRequestStacks([
    candidate("p1", "a", "b"),
    candidate("p2", "b", "a"),
  ]);
  expect(stacks.get("p1")!.depth).toBe(1);
  expect(stacks.get("p2")!.depth).toBe(1);
});
