import {
  FLOW_FILE_EXTENSION,
  normalizeFlowAlias as normalizePublicFlowAlias,
  normalizeRunId as normalizePublicRunId,
} from "../ralph.ts";
import {
  normalizeFlowAlias,
  normalizeFlowFileName,
  normalizeFlowId,
  normalizeRevisionId,
  normalizeRunId,
} from "./ralph-flow-ids.helper.ts";

describe("normalizeFlowId", () => {
  it.each([
    ["  Daily Build Check  ", "daily-build-check"],
    ["Ralph_flow:Review", "ralph-flow-review"],
    ["---Already---Clean---", "already-clean"],
    ["ümlaut and symbols!!!", "mlaut-and-symbols"],
  ] as const)("normalizes %j to %j", (input, expected) => {
    expect(normalizeFlowId(input)).toBe(expected);
  });

  it("returns an empty id when input has no supported characters", () => {
    expect(normalizeFlowId("   !!!   ")).toBe("");
  });

  it("limits normalized flow ids to the validation boundary", () => {
    expect(normalizeFlowId("a".repeat(81))).toHaveLength(80);
  });
});

describe("normalizeFlowAlias", () => {
  it("uses the same normalization rules as flow ids", () => {
    expect(normalizeFlowAlias("Release Candidate #1")).toBe(
      normalizeFlowId("Release Candidate #1"),
    );
  });

  it("preserves the existing public export from ralph.ts", () => {
    expect(normalizePublicFlowAlias("Release Candidate #1")).toBe(
      normalizeFlowAlias("Release Candidate #1"),
    );
  });
});

describe("normalizeFlowFileName", () => {
  it("returns a normalized json file name", () => {
    expect(normalizeFlowFileName(" Daily Build Check ")).toBe(
      `daily-build-check${FLOW_FILE_EXTENSION}`,
    );
  });

  it("accepts the maximum valid normalized flow id length", () => {
    expect(normalizeFlowFileName("a".repeat(80))).toBe(
      `${"a".repeat(80)}${FLOW_FILE_EXTENSION}`,
    );
  });

  it.each(["", "   ", "!!!"] as const)(
    "rejects an empty normalized flow id from %j",
    (input) => {
      expect(() => normalizeFlowFileName(input)).toThrow(
        "Expected Ralph flow id to contain lowercase letters, numbers, and dashes.",
      );
    },
  );
});

describe("normalizeRevisionId", () => {
  it.each([
    [" revision-1.json ", "revision-1"],
    ["2026-06-18T19:14:00.000Z", "2026-06-18T19:14:00.000Z"],
    ["branch_name:checkpoint.v2", "branch_name:checkpoint.v2"],
  ] as const)("normalizes %j to %j", (input, expected) => {
    expect(normalizeRevisionId(input)).toBe(expected);
  });

  it("accepts the maximum valid revision id length", () => {
    expect(normalizeRevisionId("a".repeat(160))).toHaveLength(160);
  });

  it.each(["", "   ", "../escape", "a".repeat(161)] as const)(
    "rejects invalid revision id %j",
    (input) => {
      expect(() => normalizeRevisionId(input)).toThrow(
        "Expected Ralph revision id to contain letters, numbers, dashes, underscores, colons, or periods.",
      );
    },
  );
});

describe("normalizeRunId", () => {
  it.each([
    [" run.json ", "run"],
    ["nested/path\\run", "nested-path-run"],
    ["Run #1: Attempt?", "Run-1:-Attempt"],
    ["...run...", "...run..."],
  ] as const)("normalizes %j to %j", (input, expected) => {
    expect(normalizeRunId(input)).toBe(expected);
  });

  it("limits normalized run ids to the storage boundary", () => {
    expect(normalizeRunId("a".repeat(181))).toHaveLength(180);
  });

  it.each(["", "   ", "///", "***"] as const)(
    "rejects an empty normalized run id from %j",
    (input) => {
      expect(() => normalizeRunId(input)).toThrow("Expected a Ralph run id.");
    },
  );

  it("preserves the existing public export from ralph.ts", () => {
    expect(normalizePublicRunId("nested/path/run.json")).toBe(
      normalizeRunId("nested/path/run.json"),
    );
  });
});
