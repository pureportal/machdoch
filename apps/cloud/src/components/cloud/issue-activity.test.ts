import { describe, expect, it } from "vitest";
import {
  collapseActivity,
  relationChangeEntries,
  type ActivityEntry,
} from "./issue-activity";

const change = (index: number): ActivityEntry<string> => ({
  kind: "change",
  at: `2026-11-0${index}T00:00:00.000Z`,
  change: {
    id: `change-${index}`,
    actor: "Dana",
    createdAt: `2026-11-0${index}T00:00:00.000Z`,
    description: `change ${index}`,
  },
});
const comment = (body: string): ActivityEntry<string> => ({
  kind: "comment",
  at: "2026-11-09T00:00:00.000Z",
  comment: body,
});
const shape = (rows: ReturnType<typeof collapseActivity<string>>) =>
  rows.map((row) =>
    row.kind === "collapsed"
      ? `collapsed:${row.changes.length}`
      : row.kind === "change"
        ? row.change.id
        : `comment:${row.comment}`,
  );

describe("collapseActivity", () => {
  it("keeps short runs and comments in order", () => {
    expect(
      shape(
        collapseActivity(
          [change(1), comment("a"), change(2), change(3)],
          new Set(),
        ),
      ),
    ).toEqual(["change-1", "comment:a", "change-2", "change-3"]);
  });

  it("collapses the middle of long runs of changes", () => {
    const entries = [1, 2, 3, 4, 5, 6].map(change);
    expect(
      shape(collapseActivity([...entries, comment("a")], new Set())),
    ).toEqual(["change-1", "collapsed:4", "change-6", "comment:a"]);
    expect(shape(collapseActivity(entries, new Set(["change-2"])))).toEqual([
      "change-1",
      "change-2",
      "change-3",
      "change-4",
      "change-5",
      "change-6",
    ]);
  });
});

describe("relationChangeEntries", () => {
  it("describes links from the issue's perspective", () => {
    const issue = {
      id: "other",
      identifier: "TM-2",
      title: "Remove MariaDB",
      state: "backlog" as const,
      statusName: "Backlog",
      archived: false,
      revision: 1,
    };
    expect(
      relationChangeEntries([
        {
          id: "a",
          kind: "blocks",
          actor: "Dana",
          createdAt: "2026-11-01T00:00:00.000Z",
          issue,
        },
        {
          id: "b",
          kind: "child",
          actor: "Malte",
          createdAt: "2026-11-02T00:00:00.000Z",
          issue,
        },
      ]),
    ).toEqual([
      {
        id: "relation-a",
        actor: "Dana",
        createdAt: "2026-11-01T00:00:00.000Z",
        description: "marked this as blocking TM-2 Remove MariaDB",
      },
      {
        id: "relation-b",
        actor: "Malte",
        createdAt: "2026-11-02T00:00:00.000Z",
        description: "added the sub-issue TM-2 Remove MariaDB",
      },
    ]);
  });
});
