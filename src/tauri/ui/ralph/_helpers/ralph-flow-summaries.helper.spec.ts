import type {
  RalphFlow,
  RalphFlowSummary,
} from "../../../../core/ralph.js";
import { createBlankFlow, getFlowAlias } from "./create-blank-ralph-flow.helper";
import {
  DEFAULT_RALPH_FLOW_SCOPE,
  RALPH_FLOW_LIBRARY_LABELS,
  RALPH_FLOW_LIBRARY_MODES,
  RALPH_FLOW_SCOPE_LABELS,
  RALPH_FLOW_SCOPES,
  getDefaultCreationScope,
  isFlowScopeVisibleInLibraryMode,
  normalizeRalphFlowScope,
} from "./normalize-ralph-flow-scope.helper";
import {
  compareFlowSummaries,
  createUniqueFlowAlias,
  flowToSummary,
  getFlowSelectionKey,
  getFlowSummaryScope,
  getFlowSummarySelectionKey,
  hasFlowSelection,
  isFlowAliasUsed,
  upsertFlowSummary,
  withFlowSummaryScope,
} from "./upsert-flow-summary.helper";

const createSummary = (
  overrides: Partial<RalphFlowSummary> = {},
): RalphFlowSummary => ({
  id: "daily-review",
  name: "Daily Review",
  path: "daily-review.json",
  blockCount: 2,
  edgeCount: 1,
  variableCount: 0,
  ...overrides,
});

const createFlow = (overrides: Partial<RalphFlow> = {}): RalphFlow => ({
  schemaVersion: 1,
  id: "flow-one",
  alias: "flow-one",
  name: "Flow One",
  description: "Creates a summary",
  source: {
    kind: "starter",
    id: "autonomous-refactoring-flow",
    version: 2,
    importedAt: "2026-06-29T00:00:00.000Z",
  },
  variables: [{ name: "topic", type: "string", required: false }],
  blocks: [
    {
      id: "start",
      type: "START",
      title: "Start",
    },
    {
      id: "end",
      type: "END",
      title: "End",
      status: "success",
    },
  ],
  edges: [
    {
      id: "start-success-end",
      from: "start",
      fromOutput: "SUCCESS",
      to: "end",
    },
  ],
  ...overrides,
});

describe("Ralph flow scope helpers", () => {
  it("exposes the expected scopes, modes, labels, and default scope", () => {
    expect(RALPH_FLOW_SCOPES).toEqual(["workspace", "user"]);
    expect(RALPH_FLOW_LIBRARY_MODES).toEqual(["workspace", "user", "all"]);
    expect(RALPH_FLOW_SCOPE_LABELS).toEqual({
      workspace: "Workspace",
      user: "Global",
    });
    expect(RALPH_FLOW_LIBRARY_LABELS).toEqual({
      workspace: "Workspace",
      user: "Global",
      all: "All",
    });
    expect(DEFAULT_RALPH_FLOW_SCOPE).toBe("workspace");
  });

  it.each([
    ["user", "user"],
    ["workspace", "workspace"],
    ["all", "workspace"],
    ["", "workspace"],
    [null, "workspace"],
    [undefined, "workspace"],
  ] as const)("normalizes scope value %s to %s", (value, expected) => {
    expect(normalizeRalphFlowScope(value)).toBe(expected);
  });

  it("derives creation scope and library visibility", () => {
    expect(getDefaultCreationScope("user")).toBe("user");
    expect(getDefaultCreationScope("workspace")).toBe("workspace");
    expect(getDefaultCreationScope("all")).toBe("workspace");

    expect(isFlowScopeVisibleInLibraryMode("workspace", "workspace")).toBe(true);
    expect(isFlowScopeVisibleInLibraryMode("user", "workspace")).toBe(false);
    expect(isFlowScopeVisibleInLibraryMode("workspace", "all")).toBe(true);
    expect(isFlowScopeVisibleInLibraryMode("user", "all")).toBe(true);
  });
});

describe("Ralph flow summary helpers", () => {
  it("defaults missing summary scopes and derives stable selection keys", () => {
    const workspaceSummary = createSummary();
    const userSummary = createSummary({ id: "global-flow", scope: "user" });

    expect(getFlowSummaryScope(workspaceSummary)).toBe("workspace");
    expect(getFlowSummaryScope(userSummary)).toBe("user");
    expect(getFlowSelectionKey("daily-review", "workspace")).toBe(
      "workspace:daily-review",
    );
    expect(getFlowSummarySelectionKey(userSummary)).toBe("user:global-flow");
    expect(hasFlowSelection(userSummary, "global-flow", "user")).toBe(true);
    expect(hasFlowSelection(userSummary, "global-flow", "workspace")).toBe(
      false,
    );
  });

  it("adds fallback scopes without overwriting existing summary scope", () => {
    expect(withFlowSummaryScope(createSummary(), "user")).toMatchObject({
      scope: "user",
    });
    expect(withFlowSummaryScope(createSummary({ scope: "workspace" }), "user")).toMatchObject({
      scope: "workspace",
    });
  });

  it("sorts summaries by scope first and then alias, name, or id", () => {
    const summaries = [
      createSummary({ id: "z-user", alias: "z-user", scope: "user" }),
      createSummary({ id: "b-workspace", name: "Bravo" }),
      createSummary({ id: "a-workspace", alias: "alpha" }),
    ];

    expect([...summaries].sort(compareFlowSummaries).map((flow) => flow.id)).toEqual([
      "a-workspace",
      "b-workspace",
      "z-user",
    ]);
  });

  it("converts flows to summaries with counts, path, and explicit scope", () => {
    expect(flowToSummary(createFlow(), "flows/flow-one.json", "user")).toEqual({
      id: "flow-one",
      alias: "flow-one",
      name: "Flow One",
      scope: "user",
      path: "flows/flow-one.json",
      description: "Creates a summary",
      source: {
        kind: "starter",
        id: "autonomous-refactoring-flow",
        version: 2,
        importedAt: "2026-06-29T00:00:00.000Z",
      },
      blockCount: 2,
      edgeCount: 1,
      variableCount: 1,
    });

    const flowWithoutOptionalFields: RalphFlow = {
      schemaVersion: 1,
      id: "minimal-flow",
      name: "Minimal Flow",
      blocks: [],
      edges: [],
    };

    expect(flowToSummary(flowWithoutOptionalFields)).toMatchObject({
      id: "minimal-flow",
      scope: "workspace",
      blockCount: 0,
      edgeCount: 0,
      variableCount: 0,
    });
  });

  it("upserts matching id and scope while preserving same-id flows in other scopes", () => {
    const existingWorkspace = createSummary({
      id: "shared",
      alias: "old-workspace",
      scope: "workspace",
    });
    const existingUser = createSummary({
      id: "shared",
      alias: "old-user",
      scope: "user",
    });
    const nextWorkspace = createSummary({
      id: "shared",
      alias: "new-workspace",
      scope: "workspace",
    });

    expect(
      upsertFlowSummary([existingUser, existingWorkspace], nextWorkspace),
    ).toEqual([nextWorkspace, existingUser]);
  });

  it("checks alias use within scope, normalized aliases, ids, and current-flow exclusions", () => {
    const flows = [
      createSummary({ id: "daily-review", alias: "Daily Review", scope: "workspace" }),
      createSummary({ id: "global-review", alias: "Daily Review", scope: "user" }),
      createSummary({ id: "id-only-flow", scope: "workspace" }),
    ];

    expect(isFlowAliasUsed(flows, "daily review", "workspace")).toBe(true);
    expect(isFlowAliasUsed(flows, "global-review", "workspace")).toBe(false);
    expect(isFlowAliasUsed(flows, "id only flow", "workspace")).toBe(true);
    expect(isFlowAliasUsed(flows, "daily review", "workspace", "daily-review")).toBe(
      false,
    );
    expect(isFlowAliasUsed(flows, "", "workspace")).toBe(false);
  });

  it("creates unique normalized aliases by scope and increments collisions", () => {
    const flows = [
      createSummary({ id: "daily-review", alias: "daily-review", scope: "workspace" }),
      createSummary({ id: "daily-review-2", alias: "daily-review-2", scope: "workspace" }),
      createSummary({ id: "daily-review", alias: "daily-review", scope: "user" }),
    ];

    expect(createUniqueFlowAlias(" Daily Review ", flows, "workspace")).toBe(
      "daily-review-3",
    );
    expect(createUniqueFlowAlias(" Daily Review ", flows, "user")).toBe(
      "daily-review-2",
    );
    expect(createUniqueFlowAlias("", flows, "workspace")).toBe("ralph-flow");
  });
});

describe("blank Ralph flow helper", () => {
  it("creates a normalized start-to-end flow with timestamps and empty variables", () => {
    const flow = createBlankFlow(" Daily Review! ");

    expect(flow).toMatchObject({
      schemaVersion: 1,
      alias: "daily-review",
      name: "Daily Review",
      description: "",
      variables: [],
      blocks: [
        { id: "start", type: "START", title: "Start" },
        { id: "end", type: "END", title: "End", status: "success" },
      ],
      edges: [
        {
          id: "start-success-end",
          from: "start",
          fromOutput: "SUCCESS",
          to: "end",
        },
      ],
    });
    expect(flow.id).toBeTruthy();
    expect(Date.parse(flow.createdAt ?? "")).not.toBeNaN();
    expect(flow.updatedAt).toBe(flow.createdAt);
    expect(flow.blocks[0]?.position).toEqual({ x: 80, y: 120 });
    expect(flow.blocks[1]?.position).toEqual({ x: 500, y: 120 });
  });

  it("falls back to a Ralph Flow title when alias input is empty", () => {
    const flow = createBlankFlow("   ");

    expect(flow.alias).toBeUndefined();
    expect(flow.name).toBe("Ralph Flow");
  });

  it("prefers a trimmed alias and falls back to id for flow labels", () => {
    expect(getFlowAlias({ id: "flow-id", alias: "  friendly-alias  " })).toBe(
      "friendly-alias",
    );
    expect(getFlowAlias({ id: "flow-id", alias: "   " })).toBe("flow-id");
    expect(getFlowAlias({ id: "flow-id" })).toBe("flow-id");
  });
});
