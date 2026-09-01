import type { RalphFlow, RalphFlowSummary } from "../../../../core/ralph.js";
import { createBlankFlow } from "./create-blank-ralph-flow.helper";
import {
  DEFAULT_RALPH_FLOW_SCOPE,
  RALPH_FLOW_SCOPES,
  normalizeRalphFlowScope,
} from "./normalize-ralph-flow-scope.helper";
import {
  createUniqueFlowAlias,
  flowToSummary,
  getFlowSummaryScope,
  isFlowAliasUsed,
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
  variables: [],
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
  it("exposes the supported scopes and default scope", () => {
    expect(RALPH_FLOW_SCOPES).toEqual(["workspace", "user"]);
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
});

describe("Ralph flow summary helpers", () => {
  it("defaults missing summary scopes", () => {
    const workspaceSummary = createSummary();
    const userSummary = createSummary({ id: "global-flow", scope: "user" });

    expect(getFlowSummaryScope(workspaceSummary)).toBe("workspace");
    expect(getFlowSummaryScope(userSummary)).toBe("user");
  });

  it("adds fallback scopes without overwriting existing summary scope", () => {
    expect(withFlowSummaryScope(createSummary(), "user")).toMatchObject({
      scope: "user",
    });
    expect(
      withFlowSummaryScope(createSummary({ scope: "workspace" }), "user"),
    ).toMatchObject({
      scope: "workspace",
    });
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
      variables: [{ name: "topic", type: "string", required: false }],
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
      variables: [],
    });
  });

  it("checks alias use within scope, normalized aliases, ids, and current-flow exclusions", () => {
    const flows = [
      createSummary({
        id: "daily-review",
        alias: "Daily Review",
        scope: "workspace",
      }),
      createSummary({
        id: "global-review",
        alias: "Daily Review",
        scope: "user",
      }),
      createSummary({ id: "id-only-flow", scope: "workspace" }),
    ];

    expect(isFlowAliasUsed(flows, "daily review", "workspace")).toBe(true);
    expect(isFlowAliasUsed(flows, "global-review", "workspace")).toBe(false);
    expect(isFlowAliasUsed(flows, "id only flow", "workspace")).toBe(true);
    expect(
      isFlowAliasUsed(flows, "daily review", "workspace", "daily-review"),
    ).toBe(false);
    expect(isFlowAliasUsed(flows, "", "workspace")).toBe(false);
  });

  it("creates unique normalized aliases by scope and increments collisions", () => {
    const flows = [
      createSummary({
        id: "daily-review",
        alias: "daily-review",
        scope: "workspace",
      }),
      createSummary({
        id: "daily-review-2",
        alias: "daily-review-2",
        scope: "workspace",
      }),
      createSummary({
        id: "daily-review",
        alias: "daily-review",
        scope: "user",
      }),
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
  });

  it("falls back to a Ralph Flow title when alias input is empty", () => {
    const flow = createBlankFlow("   ");

    expect(flow.alias).toBeUndefined();
    expect(flow.name).toBe("Ralph Flow");
  });
});
