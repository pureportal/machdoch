import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import type { RalphUtilityBlock } from "../ralph.js";
import { evaluateRalphUtilityCondition } from "../_helpers/evaluate-ralph-utility-condition.helper.js";
import { featureImplementationChecklistLoopStarterFlow } from "./feature-implementation-checklist-loop.js";

const flow = featureImplementationChecklistLoopStarterFlow.flow;
const utilityBlock = (id: string): RalphUtilityBlock => {
  const block = flow.blocks.find((candidate) => candidate.id === id);
  if (block?.type !== "UTILITY") throw new Error(`Missing utility ${id}.`);
  return block;
};

const resolveRequest = (variables: Record<string, string>) => {
  const expression = utilityBlock("resolve-checklist-path").utility.expression!;
  return new Function("variables", `return (${expression});`)(variables) as {
    featureId: string;
    requestKey: string;
    path: string;
  };
};

describe("feature checklist goal context", () => {
  it("enforces scope against the original repository baseline before recording DONE", () => {
    expect(utilityBlock("scope-change-guard").utility).toMatchObject({
      type: "CHANGE_SCOPE_GUARD",
      enforce: true,
      baseline: "{{data:detect-project-commands:repositoryBaseline}}",
    });
    expect(
      flow.edges.find(
        (edge) =>
          edge.from === "validate-feature" && edge.fromOutput === "DONE",
      )?.to,
    ).toBe("resolve-feature-scope");
    expect(
      flow.edges.filter((edge) => edge.to === "record-done-outcome"),
    ).toEqual([
      expect.objectContaining({
        from: "scope-change-guard",
        fromOutput: "IN_SCOPE",
      }),
    ]);
    const resolve = new Function(
      "variables",
      "input",
      `return (${utilityBlock("resolve-feature-scope").utility.expression});`,
    );
    const tasks = [
      { likelyFiles: ["app.js", "index.html"] },
      { likelyFiles: ["app.js", "tests/"] },
    ];
    expect(
      resolve({ implementationScope: "app.js, index.html" }, { tasks }),
    ).toEqual({ allowedPaths: ["app.js", "index.html"] });
    expect(resolve({ implementationScope: "auto-detect" }, { tasks })).toEqual({
      allowedPaths: ["app.js", "index.html", "tests/"],
    });
  });
  it("requires fresh verification even when a selected task changes no files", () => {
    for (const output of ["SUCCESS", "ERROR"]) {
      expect(
        flow.edges.find(
          (edge) =>
            edge.from === "work-yield-analysis" && edge.fromOutput === output,
        )?.to,
      ).toBe("verification-decision");
    }
    expect(
      flow.blocks.some((block) => block.id === "work-yield-decision"),
    ).toBe(false);
  });
  it("reviews the task state produced by the runtime transition to verifying", () => {
    const validator = flow.blocks.find(
      (block) => block.id === "validate-progress",
    );
    if (
      validator?.type !== "UTILITY" ||
      validator.utility.type !== "VALIDATOR_JSON"
    )
      throw new Error("Missing task review");
    expect(validator.utility.prompt).toContain(
      "{{data:mark-tasks-verifying:tasks}}",
    );
    expect(validator.utility.prompt).toContain(
      "{{data:mark-tasks-verifying:json.research}}",
    );
    expect(validator.utility.prompt).not.toContain(
      "{{data:select-next-task:tasks}}",
    );
  });
  const variables = {
    featureId: "account-search",
    featureRequest: "Add account search",
    acceptanceCriteria: "Keyboard navigation and persisted filters",
    previousGoal: "Keep existing account management behavior",
  };

  it("resumes only the same goal and acceptance criteria under the same feature id", () => {
    const original = resolveRequest(variables);
    const matches = (current: ReturnType<typeof resolveRequest>) =>
      evaluateRalphUtilityCondition(
        utilityBlock("checklist-matches-feature").utility.condition!,
        {
          variables: {},
          runLog: [],
          lastResult: {
            blockId: "read-checklist",
            status: "completed",
            output: "SUCCESS",
            attempt: 1,
            summary: "Checklist read",
            data: { json: original },
          },
          resultsByBlock: new Map([
            [
              "resolve-checklist-path",
              {
                blockId: "resolve-checklist-path",
                status: "completed",
                output: "SUCCESS",
                attempt: 1,
                summary: "Request resolved",
                data: { output: current },
              },
            ],
          ]),
        },
      );

    expect(matches(resolveRequest({ ...variables }))).toBe(true);
    for (const key of [
      "featureRequest",
      "acceptanceCriteria",
      "previousGoal",
    ]) {
      expect(matches(resolveRequest({ ...variables, [key]: "Changed" }))).toBe(
        false,
      );
    }
    expect(
      matches(resolveRequest({ ...variables, featureId: "other-feature" })),
    ).toBe(false);
  });

  it("preserves multiline goal context without delimiter collisions", () => {
    const resolved = resolveRequest({
      ...variables,
      previousGoal: 'First line\n"Second line"',
    });
    expect(JSON.parse(resolved.requestKey)).toEqual([
      variables.featureRequest,
      variables.acceptanceCriteria,
      'First line\n"Second line"',
    ]);
    expect(
      resolveRequest({
        ...variables,
        featureRequest: "a",
        acceptanceCriteria: "bc",
      }).requestKey,
    ).not.toBe(
      resolveRequest({
        ...variables,
        featureRequest: "ab",
        acceptanceCriteria: "c",
      }).requestKey,
    );
  });

  it("accepts research links and previous goals in the persisted checklist schema", () => {
    const validate = new Ajv2020({ strict: true }).compile(
      utilityBlock("specification-checklist").utility.schema!,
    );
    const request = resolveRequest(variables);
    const checklist = {
      featureId: request.featureId,
      requestKey: request.requestKey,
      request: variables.featureRequest,
      previousGoal: variables.previousGoal,
      research:
        "Primary source: https://example.com/docs/search\nPreserve keyboard support.",
      acceptanceCriteria: [variables.acceptanceCriteria],
      status: "planned",
      tasks: [
        {
          id: "search",
          title: "Add account search",
          status: "planned",
          batchKey: "search",
          dependencies: [],
          likelyFiles: ["src/search.ts"],
          size: "medium",
          acceptanceCriteria: ["Keyboard navigation works"],
          priority: 80,
        },
      ],
    };
    const persisted = JSON.parse(JSON.stringify(checklist)) as typeof checklist;
    expect(validate(persisted), JSON.stringify(validate.errors)).toBe(true);
    expect(persisted.research).toBe(checklist.research);
    expect(persisted.previousGoal).toBe(variables.previousGoal);
    const { requestKey: _requestKey, ...withoutIdentity } = checklist;
    expect(validate(withoutIdentity)).toBe(false);
    for (const acceptanceCriteria of [undefined, [], [""]]) {
      expect(
        validate({
          ...checklist,
          tasks: [{ ...checklist.tasks[0], acceptanceCriteria }],
        }),
      ).toBe(false);
    }
  });
});
