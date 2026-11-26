import { describe, expect, it } from "vitest";
import {
  collectContextPackFlowPlaceholders,
  getContextPackFlowIssue,
  getContextPackFlowPackOptions,
  getContextPackFlowStepDropIndex,
  getContextPackFlowsForWorkspace,
  matchesContextPackFlowSearch,
  moveContextPackFlowStep,
  resolveContextPackFlowSteps,
} from "./flows";
import type { ContextPackFlow, SmartContextPack } from "./model";

const createPack = (
  id: string,
  overrides: Partial<SmartContextPack> = {},
): SmartContextPack => ({
  id,
  workspace: null,
  name: id,
  instructions: "",
  prompt: `Run ${id}`,
  contextAttachments: [],
  variables: [],
  trigger: { phrases: [], pathPatterns: [] },
  createdAt: 1,
  updatedAt: 1,
  useCount: 0,
  ...overrides,
});

const createFlow = (
  id: string,
  overrides: Partial<ContextPackFlow> = {},
): ContextPackFlow => ({
  id,
  workspace: null,
  name: id,
  steps: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe("context pack flows", () => {
  it("lists global flows and flows of the current workspace by recency", () => {
    const flows = [
      createFlow("global", { updatedAt: 5 }),
      createFlow("current", { workspace: "C:\\Repo\\", updatedAt: 10 }),
      createFlow("other", { workspace: "C:/Other", updatedAt: 20 }),
      createFlow("used", { lastUsedAt: 30 }),
    ];

    expect(
      getContextPackFlowsForWorkspace(flows, "c:/repo").map((flow) => flow.id),
    ).toEqual(["used", "current", "global"]);
  });

  it("limits global flows to global packs", () => {
    const packs = [
      createPack("global"),
      createPack("workspace", { workspace: "C:/Repo" }),
      createPack("other", { workspace: "C:/Other" }),
    ];

    expect(
      getContextPackFlowPackOptions(packs, "global", "C:/Repo").map(
        (pack) => pack.id,
      ),
    ).toEqual(["global"]);
    expect(
      getContextPackFlowPackOptions(packs, "workspace", "C:/Repo").map(
        (pack) => pack.id,
      ),
    ).toEqual(["global", "workspace"]);
  });

  it("flags missing, out-of-scope and empty packs", () => {
    const packs = [
      createPack("ok"),
      createPack("empty", { prompt: "" }),
      createPack("workspace", { workspace: "C:/Repo" }),
    ];
    const resolved = resolveContextPackFlowSteps(
      {
        workspace: null,
        steps: [
          { id: "1", packId: "ok" },
          { id: "2", packId: "empty" },
          { id: "3", packId: "workspace" },
          { id: "4", packId: "deleted" },
        ],
      },
      packs,
    );

    expect(resolved.map((entry) => entry.issue)).toEqual([
      null,
      "empty-pack",
      "missing-pack",
      "missing-pack",
    ]);
    expect(getContextPackFlowIssue(resolved)).toBe(
      "Step 2: Pack has no prompt",
    );
    expect(getContextPackFlowIssue([])).toBe("Add at least one step");
    expect(getContextPackFlowIssue(resolved.slice(0, 1))).toBeNull();
  });

  it("accepts repeated packs and attachment-only packs", () => {
    const pack = createPack("files", {
      prompt: "",
      contextAttachments: [
        {
          id: "a",
          source: "path",
          path: "C:/Repo/README.md",
          name: "README.md",
          kind: "file",
        },
      ],
    });
    const resolved = resolveContextPackFlowSteps(
      {
        workspace: null,
        steps: [
          { id: "1", packId: "files" },
          { id: "2", packId: "files" },
        ],
      },
      [pack],
    );

    expect(getContextPackFlowIssue(resolved)).toBeNull();
  });

  it("rejects flows above the step limit", () => {
    const pack = createPack("ok");
    const resolved = resolveContextPackFlowSteps(
      {
        workspace: null,
        steps: Array.from({ length: 21 }, (_, index) => ({
          id: String(index),
          packId: "ok",
        })),
      },
      [pack],
    );

    expect(getContextPackFlowIssue(resolved)).toBe("Use at most 20 steps");
  });

  it("groups variables across steps and skips remembered ones", () => {
    const packs = [
      createPack("implement", {
        prompt: "Implement [[task]] on {branch} with [[notes?]]",
        variables: [{ name: "branch" }],
      }),
      createPack("commit", {
        instructions: "Commit to [[Branch=main]]",
        prompt: "Mention [[TASK]] and [[notes?]]",
      }),
      createPack("pr", {
        prompt: "Target [[base|main,develop]] for {ticket}",
        variables: [{ name: "ticket", defaultValue: "ABC-1" }],
      }),
      createPack("review", { prompt: "Review [[base=develop]]" }),
    ];

    expect(collectContextPackFlowPlaceholders(packs, {})).toEqual([
      { key: "task", lookupKey: "task", occurrenceCount: 2 },
      { key: "notes", lookupKey: "notes", occurrenceCount: 2, optional: true },
      {
        key: "branch",
        lookupKey: "branch",
        occurrenceCount: 2,
        defaultValue: "main",
      },
      {
        key: "base",
        lookupKey: "base",
        occurrenceCount: 2,
        options: ["main", "develop"],
        defaultValue: "develop",
      },
      {
        key: "ticket",
        lookupKey: "ticket",
        occurrenceCount: 1,
        defaultValue: "ABC-1",
      },
    ]);
    expect(
      collectContextPackFlowPlaceholders(packs, {
        branch: "feature",
        task: "",
      }).map((placeholder) => placeholder.lookupKey),
    ).toEqual(["notes", "base", "ticket"]);
  });

  it("resolves drop slots and moves steps", () => {
    expect(getContextPackFlowStepDropIndex(0, 3, 3)).toBe(2);
    expect(getContextPackFlowStepDropIndex(2, 0, 3)).toBe(0);
    expect(getContextPackFlowStepDropIndex(1, 1, 3)).toBeNull();
    expect(getContextPackFlowStepDropIndex(1, 2, 3)).toBeNull();
    expect(getContextPackFlowStepDropIndex(0, 4, 3)).toBeNull();
    expect(moveContextPackFlowStep(["a", "b", "c"], 0, 2)).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(moveContextPackFlowStep(["a", "b", "c"], 2, 0)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(moveContextPackFlowStep(["a"], 0, 3)).toEqual(["a"]);
  });

  it("searches flows by name and step pack names", () => {
    const packs = [createPack("p1", { name: "Commit & Push" })];
    const flow = createFlow("f", {
      name: "Ship it",
      steps: [{ id: "1", packId: "p1" }],
    });

    expect(matchesContextPackFlowSearch(flow, packs, "")).toBe(true);
    expect(matchesContextPackFlowSearch(flow, packs, "ship push")).toBe(true);
    expect(matchesContextPackFlowSearch(flow, packs, "review")).toBe(false);
  });

  it("makes a variable required when any step requires it", () => {
    const packs = [
      createPack("first", { prompt: "[[scope?]]" }),
      createPack("second", { prompt: "[[scope]]" }),
    ];

    expect(collectContextPackFlowPlaceholders(packs, {})).toEqual([
      { key: "scope", lookupKey: "scope", occurrenceCount: 2 },
    ]);
  });
});
