import { describe, expect, it } from "vitest";
import { blameLabelsByLine } from "./workspace-file-blame";

const NOW = Date.parse("2026-11-24T12:00:00Z");

describe("blame labels", () => {
  it("labels the first line of every blame range", () => {
    const labels = blameLabelsByLine(
      [
        {
          startLine: 1,
          lineCount: 3,
          commit: "a".repeat(40),
          shortHash: "aaaaaaa",
          author: "Ada",
          authoredAt: "2026-11-21T12:00:00Z",
          summary: "Add parser",
          uncommitted: false,
        },
        {
          startLine: 4,
          lineCount: 1,
          commit: "0".repeat(40),
          shortHash: "0000000",
          author: "Not Committed Yet",
          authoredAt: "2026-11-24T12:00:00Z",
          summary: "",
          uncommitted: true,
        },
      ],
      NOW,
    );
    expect([...labels.keys()]).toEqual([1, 4]);
    expect(labels.get(1)).toEqual({
      text: "aaaaaaa · Ada · 3d",
      title: "aaaaaaa Add parser\nAda, 2026-11-21T12:00:00Z",
      uncommitted: false,
    });
    expect(labels.get(4)).toEqual({
      text: "Not committed",
      title: "Not committed",
      uncommitted: true,
    });
  });
});
