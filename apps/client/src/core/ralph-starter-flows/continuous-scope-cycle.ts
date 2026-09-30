import type { RalphFlow } from "../ralph.js";

export const enableContinuousRalphScopeCycles = (flow: RalphFlow): void => {
  const completion = flow.edges.find(
    (edge) =>
      edge.from === "completion-report" && edge.fromOutput === "SUCCESS",
  );
  if (!completion) {
    throw new Error(`Flow ${flow.id} has no completed scope cycle route.`);
  }
  const completedTarget = completion.to;
  if (flow.settings) {
    delete flow.settings.maxTransitions;
  }
  completion.to = "continue-scope-cycles";
  flow.variables = [
    ...(flow.variables ?? []),
    { name: "continuous", type: "boolean", default: "true", required: false },
  ];
  flow.blocks.push(
    {
      id: "continue-scope-cycles",
      type: "UTILITY",
      title: "Continue Scope Cycles",
      utility: {
        type: "CONDITION",
        condition: {
          style: "json-path",
          path: "variables.continuous",
          operator: "is-one-of",
          matchValues: ["true"],
          allowedValues: ["true", "false"],
        },
      },
    },
    {
      id: "wait-for-scope-cycle",
      type: "UTILITY",
      title: "Wait for Scope Cycle",
      utility: { type: "WAIT", delaySeconds: 60 },
    },
  );
  flow.edges.push(
    {
      id: "continue-cycle",
      from: "continue-scope-cycles",
      fromOutput: "MATCH",
      to: "wait-for-scope-cycle",
    },
    {
      id: "complete-cycle",
      from: "continue-scope-cycles",
      fromOutput: "NO_MATCH",
      to: completedTarget,
    },
    {
      id: "cycle-setting-invalid",
      from: "continue-scope-cycles",
      fromOutput: "ERROR",
      to: "deferred",
    },
    {
      id: "next-cycle",
      from: "wait-for-scope-cycle",
      fromOutput: "SUCCESS",
      to: "begin-scope-cycle",
    },
  );
  const selection = flow.blocks.find(
    (block) =>
      block.type === "UTILITY" && block.utility.type === "SELECT_SCOPE",
  );
  const deferred = flow.edges.find(
    (edge) => edge.from === selection?.id && edge.fromOutput === "DEFERRED",
  );
  if (selection && deferred) {
    const deferredTarget = deferred.to;
    deferred.to = "continue-deferred-scope-cycles";
    const eligibilityPath = `resultsByBlock.${selection.id}.data.availability.nextEligibleAt`;
    flow.blocks.push(
      {
        id: "continue-deferred-scope-cycles",
        type: "UTILITY",
        title: "Wait for Eligible Scope",
        utility: {
          type: "CONDITION",
          condition: {
            style: "json-path",
            path: "variables.continuous",
            operator: "is-one-of",
            matchValues: ["true"],
            allowedValues: ["true", "false"],
            combinator: "all",
            conditions: [
              {
                style: "json-path",
                path: eligibilityPath,
                operator: "non-empty-string",
              },
            ],
          },
        },
      },
      {
        id: "wait-for-eligible-scope",
        type: "UTILITY",
        title: "Wait for Eligible Scope",
        utility: {
          type: "WAIT",
          mode: "condition",
          intervalSeconds: 30,
          condition: {
            style: "javascript",
            expression: `Date.now() >= Date.parse(context.resultsByBlock[${JSON.stringify(selection.id)}].data.availability.nextEligibleAt)`,
          },
        },
      },
    );
    flow.edges.push(
      {
        id: "wait-eligible-scope",
        from: "continue-deferred-scope-cycles",
        fromOutput: "MATCH",
        to: "wait-for-eligible-scope",
      },
      {
        id: "defer-ineligible-scope",
        from: "continue-deferred-scope-cycles",
        fromOutput: "NO_MATCH",
        to: deferredTarget,
      },
      {
        id: "invalid-deferred-cycle-setting",
        from: "continue-deferred-scope-cycles",
        fromOutput: "ERROR",
        to: deferredTarget,
      },
      {
        id: "eligible-scope-cycle",
        from: "wait-for-eligible-scope",
        fromOutput: "SUCCESS",
        to: "begin-scope-cycle",
      },
      {
        id: "invalid-scope-eligibility",
        from: "wait-for-eligible-scope",
        fromOutput: "ERROR",
        to: deferredTarget,
      },
    );
  }
};
