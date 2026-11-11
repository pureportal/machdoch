import { describe, expect, it } from "vitest";
import type { WorkspaceGitGraphCommit } from "../runtime";
import { layoutWorkspaceGitGraph } from "./workspace-git-graph-layout";

const commit = (
  hash: string,
  parents: string[] = [],
): WorkspaceGitGraphCommit => ({
  hash,
  shortHash: hash,
  parents,
  subject: hash,
  author: "Test",
  authoredAt: "2026-11-11T10:00:00Z",
  refs: [],
});

const lanesOf = (
  lanes: readonly ({ hash: string } | null)[],
): (string | null)[] => lanes.map((lane) => lane?.hash ?? null);

describe("workspace Git graph layout", () => {
  it("keeps a linear history in one lane", () => {
    const layout = layoutWorkspaceGitGraph(
      [commit("c", ["b"]), commit("b", ["a"]), commit("a")],
      6,
    );
    expect(layout.width).toBe(1);
    expect(layout.rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(layout.rows.map((row) => row.outgoing)).toEqual([[0], [0], []]);
    expect(layout.rows[1]!.incoming).toEqual([0]);
  });

  it("shows a branch forking from the base and joining its lanes", () => {
    const layout = layoutWorkspaceGitGraph(
      [
        commit("feature-2", ["feature-1"]),
        commit("main-2", ["fork"]),
        commit("feature-1", ["fork"]),
        commit("fork", ["root"]),
        commit("root"),
      ],
      6,
    );
    expect(layout.width).toBe(2);
    expect(layout.rows.map((row) => row.lane)).toEqual([0, 1, 0, 0, 0]);
    const fork = layout.rows[3]!;
    expect(fork.incoming).toEqual([0, 1]);
    expect(lanesOf(fork.top)).toEqual(["fork", "fork"]);
    expect(lanesOf(fork.bottom)).toEqual(["root"]);
    expect(layout.rows[1]!.color).not.toBe(layout.rows[0]!.color);
    expect(lanesOf(layout.rows[1]!.top)).toEqual(["feature-1"]);
    expect(lanesOf(layout.rows[1]!.bottom)).toEqual(["feature-1", "fork"]);
  });

  it("opens a lane for the second parent of a merge", () => {
    const layout = layoutWorkspaceGitGraph(
      [
        commit("merge", ["main-1", "topic-1"]),
        commit("topic-1", ["base"]),
        commit("main-1", ["base"]),
        commit("base"),
      ],
      6,
    );
    const merge = layout.rows[0]!;
    expect(merge.outgoing).toEqual([0, 1]);
    expect(lanesOf(merge.bottom)).toEqual(["main-1", "topic-1"]);
    expect(layout.rows[1]!.lane).toBe(1);
    expect(layout.rows[2]!.lane).toBe(0);
    expect(layout.rows[3]!.incoming).toEqual([0, 1]);
  });

  it("reuses free lanes and ignores parents outside the loaded history", () => {
    const layout = layoutWorkspaceGitGraph(
      [
        commit("a2", ["a1"]),
        commit("b1", ["outside"]),
        commit("a1", ["root"]),
        commit("c1", ["root"]),
        commit("root"),
      ],
      2,
    );
    expect(layout.rows[1]!.outgoing).toEqual([]);
    expect(lanesOf(layout.rows[1]!.bottom)).toEqual(["a1"]);
    expect(layout.rows[3]!.lane).toBe(1);
    expect(layout.rows[3]!.color).toBe(0);
    expect(layout.width).toBe(2);
  });
});
