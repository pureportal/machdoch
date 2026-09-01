import { describe, expect, it } from "vitest";
import {
  STARTER_RALPH_FLOWS,
  applyRalphStarterFlowProtocol,
  createImportedRalphStarterFlow,
  createRalphStarterFlowSummary,
  createUpgradedRalphStarterFlowWithReport,
  getRalphStarterFlow,
  type RalphStarterFlow,
} from "./ralph-starter-flows.js";
import {
  discoverRalphFlowVariables,
  hasGraphCycle,
  validateRalphFlow,
  type RalphFlowBlock,
  type RalphFlow,
  type RalphBlockExecutionResult,
  type RalphUtilityBlock,
} from "./ralph.js";
import {
  evaluateRalphUtilityCondition,
  readRalphUtilityValuePath,
} from "./_helpers/evaluate-ralph-utility-condition.helper.js";
import {
  parseRalphValidatorJsonResult,
  RALPH_VALIDATOR_JSON_SCHEMA,
} from "./_helpers/parse-ralph-validator-json-result.helper.js";
import { canonicalDigest } from "./instruction-system/index.js";
import {
  assessRalphRepositoryWorkYield,
  isRalphRepositoryWorkYield,
  parseRalphRepositoryObservation,
  parseRalphWorkSelectionIdentity,
  resolveRalphCodeImprovementPlan,
  resolveRalphVerificationCommand,
  resolveRalphVisualRuntime,
} from "./_helpers/ralph-repository-work-yield.helper.js";

const asStarterResult = (value: unknown): RalphBlockExecutionResult =>
  value as RalphBlockExecutionResult;

const evaluateStarterTransformWithContext = (
  block: RalphUtilityBlock,
  resultsByBlock: Map<string, unknown>,
  variables: Record<string, string> = {},
): Record<string, unknown> => {
  if (block.utility.type !== "TRANSFORM_JSON") {
    throw new Error(`Expected ${block.id} to contain a JSON transform.`);
  }

  const transform = block.utility.deterministicTransform;
  if (transform?.type === "verification-command") {
    const selectionResult = asStarterResult(
      resultsByBlock.get(transform.selectionBlockId),
    );
    const commandsResult = asStarterResult(
      resultsByBlock.get(transform.commandsBlockId),
    );
    return {
      ...resolveRalphVerificationCommand({
        selection: readRalphUtilityValuePath(
          selectionResult?.data,
          transform.selectionPath,
        ),
        commands: commandsResult?.data,
        ...(variables[transform.configuredCommandVariable] === undefined
          ? {}
          : {
              configuredCommand: variables[transform.configuredCommandVariable],
            }),
      }),
    };
  }
  if (transform?.type === "code-improvement-plan") {
    return {
      ...resolveRalphCodeImprovementPlan({
        draft: readRalphUtilityValuePath(
          asStarterResult(resultsByBlock.get(transform.draftBlockId))?.data,
          "output",
        ),
        selection: asStarterResult(
          resultsByBlock.get(transform.selectionBlockId),
        )?.data,
        constitution: readRalphUtilityValuePath(
          asStarterResult(resultsByBlock.get(transform.constitutionBlockId))
            ?.data,
          "output.constitution",
        ),
        research: asStarterResult(resultsByBlock.get(transform.researchBlockId))
          ?.summary,
        stableDigest: canonicalDigest,
      }),
    };
  }
  if (transform?.type === "visual-runtime") {
    return {
      ...resolveRalphVisualRuntime({
        commands: asStarterResult(resultsByBlock.get(transform.commandsBlockId))
          ?.data,
        variables,
        transform,
      }),
    };
  }
  if (transform?.type === "repository-work-yield") {
    const baseline = parseRalphRepositoryObservation(
      asStarterResult(resultsByBlock.get(transform.baselineBlockId))?.data,
    );
    const currentResult = asStarterResult(
      resultsByBlock.get(transform.currentBlockId),
    );
    const current = parseRalphRepositoryObservation(currentResult?.data);
    if (!baseline || !current) {
      throw new Error(`Expected ${block.id} repository observations.`);
    }
    const previous = readRalphUtilityValuePath(
      asStarterResult(resultsByBlock.get(block.id))?.data,
      "output",
    );
    const workSelection = transform.workItemBlockId
      ? parseRalphWorkSelectionIdentity(
          asStarterResult(resultsByBlock.get(transform.workItemBlockId))?.data,
        )
      : undefined;

    return {
      ...assessRalphRepositoryWorkYield({
        baseline,
        current,
        ...(workSelection ? { workSelection } : {}),
        ...(isRalphRepositoryWorkYield(previous) ? { previous } : {}),
        ...(transform.excludedPaths
          ? { excludedPaths: transform.excludedPaths }
          : {}),
        ...(transform.trackPrevious !== undefined
          ? { trackPrevious: transform.trackPrevious }
          : {}),
        scopeAccepted: transform.scopeGuardBlockId
          ? asStarterResult(resultsByBlock.get(transform.scopeGuardBlockId))
              ?.output === "IN_SCOPE"
          : true,
      }),
    };
  }

  if (!block.utility.expression) {
    throw new Error(`Expected ${block.id} to contain a transform expression.`);
  }

  const evaluator = new Function(
    "input",
    "variables",
    "lastResult",
    "context",
    `"use strict"; return (${block.utility.expression});`,
  ) as (
    input: unknown,
    variables: Record<string, string>,
    lastResult: unknown,
    context: unknown,
  ) => unknown;
  const output = evaluator({}, variables, undefined, { resultsByBlock });

  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    throw new Error(`Expected ${block.id} to return an object.`);
  }

  return output as Record<string, unknown>;
};

const evaluateStarterTransform = (
  block: RalphUtilityBlock,
  sourceBlockId: string,
  sourceOutput: Record<string, unknown>,
  sourceData?: Record<string, unknown>,
): Record<string, unknown> => {
  return evaluateStarterTransformWithContext(
    block,
    new Map<string, unknown>([
      [sourceBlockId, { data: sourceData ?? { output: sourceOutput } }],
      [
        "detect-project-commands",
        {
          data: {
            focusedVerificationCommand: "focused-check",
            standardVerificationCommand: "standard-check",
            broadVerificationCommand: "broad-check",
            verificationCommand: "fallback-check",
          },
        },
      ],
    ]),
  );
};

const evaluateStarterCondition = (
  block: RalphUtilityBlock,
  lastOutput: Record<string, unknown>,
  resultsByBlock: Record<string, unknown> = {},
  lastDataOverride?: Record<string, unknown>,
): boolean => {
  if (block.utility.type !== "CONDITION" || !block.utility.condition) {
    throw new Error(`Expected ${block.id} to contain a condition.`);
  }

  const lastResult: RalphBlockExecutionResult = {
    blockId: "starter-test-result",
    output: "SUCCESS",
    status: "completed",
    attempt: 1,
    summary: "Starter test result",
    data: lastDataOverride ?? { output: lastOutput },
  };

  return evaluateRalphUtilityCondition(block.utility.condition, {
    lastResult,
    runLog: [],
    variables: {},
    resultsByBlock: new Map(
      Object.entries(resultsByBlock).map(([id, result]) => [
        id,
        asStarterResult(result),
      ]),
    ),
  });
};

function calculateReachableDominators(flow: RalphFlow): {
  dominators: Map<string, Set<string>>;
  reachable: Set<string>;
} {
  const start = flow.blocks.find((block) => block.type === "START");
  if (!start) {
    return { dominators: new Map(), reachable: new Set() };
  }

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of flow.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  }

  const reachable = new Set<string>();
  const pending = [start.id];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || reachable.has(current)) {
      continue;
    }
    reachable.add(current);
    pending.push(...(outgoing.get(current) ?? []));
  }

  const allReachable = [...reachable];
  const dominators = new Map<string, Set<string>>(
    allReachable.map((id) => [
      id,
      id === start.id ? new Set([start.id]) : new Set(allReachable),
    ]),
  );

  let changed = true;
  while (changed) {
    changed = false;
    for (const id of allReachable) {
      if (id === start.id) {
        continue;
      }
      const predecessors = (incoming.get(id) ?? []).filter((candidate) =>
        reachable.has(candidate),
      );
      if (predecessors.length === 0) {
        continue;
      }
      const next = new Set(dominators.get(predecessors[0]!) ?? []);
      for (const predecessor of predecessors.slice(1)) {
        const predecessorDominators = dominators.get(predecessor) ?? new Set();
        for (const candidate of [...next]) {
          if (!predecessorDominators.has(candidate)) {
            next.delete(candidate);
          }
        }
      }
      next.add(id);

      const previous = dominators.get(id) ?? new Set();
      if (
        previous.size !== next.size ||
        [...previous].some((candidate) => !next.has(candidate))
      ) {
        dominators.set(id, next);
        changed = true;
      }
    }
  }

  return { dominators, reachable };
}

function omitPermissiveModelText(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(omitPermissiveModelText);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "prompt" && key !== "message")
      .map(([key, nested]) => [key, omitPermissiveModelText(nested)]),
  );
}

const createStarterProtocolFixture = (): RalphStarterFlow => ({
  id: "autonomous-code-improvement-loop",
  version: 1,
  defaultAlias: "protocol-fixture",
  category: "Test",
  tags: [],
  protocol: {
    schemaVersion: 1,
    verification: {
      planId: "fixture:frozen-verification",
      baselineBlockId: "ordinary-check",
      candidateBlockId: "candidate-check",
      baselineInconclusiveTargetId: "done",
      candidateInconclusiveTargetId: "done",
      routeOverrides: [{ edgeId: "start-route", toBlockId: "ordinary-check" }],
    },
    terminalOutcomes: [{ blockId: "done", outcome: "succeeded" }],
  },
  flow: {
    schemaVersion: 1,
    id: "starter-protocol-fixture",
    name: "Starter protocol fixture",
    blocks: [
      { id: "start", type: "START", title: "Start" },
      {
        id: "ordinary-check",
        type: "UTILITY",
        title: "Quoted candidate and baseline words are inert",
        utility: { type: "RUN_CHECK", command: "old command" },
      },
      {
        id: "candidate-check",
        type: "UTILITY",
        title: "Candidate",
        utility: { type: "RUN_CHECK", command: "pnpm test" },
      },
      {
        id: "baseline-review-defer-incidental",
        type: "UTILITY",
        title: "Not authoritative",
        utility: { type: "RUN_CHECK", command: "pnpm lint" },
      },
      {
        id: "review-choose-incidental",
        type: "UTILITY",
        title: "Schema prose does not define a verdict",
        utility: {
          type: "PROMPT_JSON",
          schema: {
            type: "object",
            properties: { decision: { type: "string" } },
          },
        },
      },
      {
        id: "done",
        type: "END",
        title: 'Quoted "deferred" and negated not deferred text',
        status: "success",
      },
    ],
    edges: [
      {
        id: "start-route",
        from: "start",
        fromOutput: "SUCCESS",
        to: "baseline-review-defer-incidental",
      },
    ],
  },
});

describe("Ralph starter flows", () => {
  it("bundles valid starter flows with useful summaries", () => {
    expect(STARTER_RALPH_FLOWS).toHaveLength(6);

    for (const starterFlow of STARTER_RALPH_FLOWS) {
      const validation = validateRalphFlow(starterFlow.flow);
      const summary = createRalphStarterFlowSummary(starterFlow);

      expect(validation.valid).toBe(true);
      expect(validation.warnings).toEqual([]);
      expect(starterFlow.version).toBeGreaterThan(0);
      expect(summary.version).toBe(starterFlow.version);
      expect(summary.name).toBe(starterFlow.flow.name);
      expect(summary.defaultAlias).toBe(starterFlow.defaultAlias);
      expect(summary.blockCount).toBeGreaterThan(0);
      expect(summary.edgeCount).toBeGreaterThan(0);
      expect(summary.variableCount).toBe(
        discoverRalphFlowVariables(starterFlow.flow).length,
      );

      for (const block of starterFlow.flow.blocks) {
        if (block.type === "UTILITY" && block.utility.type === "CONDITION") {
          const condition = block.utility.condition;
          if (!condition) {
            throw new Error(`${starterFlow.id}:${block.id} lacks a condition.`);
          }
          expect(condition.style, `${starterFlow.id}:${block.id}`).not.toBe(
            "javascript",
          );
        }
      }
    }
  });

  it("applies one evidence and autonomy contract consistently to every starter", () => {
    for (const starter of STARTER_RALPH_FLOWS) {
      const flow = starter.flow;
      const runChecks = flow.blocks.filter(
        (block): block is RalphUtilityBlock =>
          block.type === "UTILITY" && block.utility.type === "RUN_CHECK",
      );
      const baseline = runChecks.find(
        (block) => block.utility.verificationRole === "baseline",
      );
      const candidate = runChecks.find(
        (block) => block.utility.verificationRole === "candidate",
      );
      const { dominators, reachable } = calculateReachableDominators(flow);

      expect(baseline, `${starter.id} baseline`).toBeTruthy();
      expect(candidate, `${starter.id} candidate`).toBeTruthy();
      expect(reachable.has(baseline!.id), starter.id).toBe(true);
      expect(reachable.has(candidate!.id), starter.id).toBe(true);
      expect(dominators.get(candidate!.id)?.has(baseline!.id), starter.id).toBe(
        true,
      );
      expect(candidate!.utility.baselineBlockId, starter.id).toBe(baseline!.id);
      expect(candidate!.utility.verificationPlanId, starter.id).toBe(
        baseline!.utility.verificationPlanId,
      );
      expect(candidate!.utility.command, starter.id).toBe(
        baseline!.utility.command,
      );
      expect(candidate!.utility.fallbackCommand, starter.id).toBe(
        baseline!.utility.fallbackCommand,
      );
      expect(candidate!.utility.cwd, starter.id).toBe(baseline!.utility.cwd);
      expect(
        flow.edges.some(
          (edge) =>
            edge.from === candidate!.id && edge.fromOutput === "INCONCLUSIVE",
        ),
        starter.id,
      ).toBe(true);

      for (const block of flow.blocks) {
        if (block.type === "END") {
          expect(block.outcome, `${starter.id}:${block.id}`).toBeTruthy();
        }
        if (
          block.type === "UTILITY" &&
          (block.utility.type === "GIT_SNAPSHOT" ||
            block.utility.type === "GIT_DIFF_SUMMARY" ||
            block.utility.type === "CHANGE_SCOPE_GUARD")
        ) {
          expect(block.utility.cwd, `${starter.id}:${block.id}`).toBe(
            "{{data:detect-project-commands:repositoryContext.worktreeRoot}}",
          );
        }
      }

      expect(flow.settings?.autonomy).toMatchObject({
        maxStagnantTransitions: 48,
        maxRepeatedCycle: 3,
      });
      expect(flow.guidance).toContain(
        "Reaching an END block alone never proves completion",
      );
    }
  });

  it("routes starter execution only from the explicit protocol", () => {
    const applied = applyRalphStarterFlowProtocol(
      createStarterProtocolFixture(),
    );
    const ordinaryCheck = applied.flow.blocks.find(
      (block) => block.id === "ordinary-check",
    );
    const incidentalCheck = applied.flow.blocks.find(
      (block) => block.id === "baseline-review-defer-incidental",
    );
    const schemaBlock = applied.flow.blocks.find(
      (block) => block.id === "review-choose-incidental",
    );
    const terminal = applied.flow.blocks.find((block) => block.id === "done");

    expect(ordinaryCheck).toMatchObject({
      type: "UTILITY",
      utility: {
        command: "pnpm test",
        verificationRole: "baseline",
        verificationPlanId: "fixture:frozen-verification",
      },
    });
    expect(incidentalCheck).toMatchObject({
      type: "UTILITY",
      utility: { verificationRole: "supplemental" },
    });
    expect(
      applied.flow.edges.find((edge) => edge.id === "start-route"),
    ).toMatchObject({ to: "ordinary-check" });
    expect(terminal).toMatchObject({ type: "END", outcome: "succeeded" });
    expect(
      schemaBlock?.type === "UTILITY"
        ? (
            schemaBlock.utility.schema as {
              properties?: { decision?: { enum?: string[] } };
            }
          ).properties?.decision?.enum
        : undefined,
    ).toBeUndefined();
  });

  it("rejects missing, unknown, and inconsistent starter protocols", () => {
    const missing = createStarterProtocolFixture() as unknown as {
      protocol?: unknown;
    };
    delete missing.protocol;
    expect(() =>
      applyRalphStarterFlowProtocol(missing as RalphStarterFlow),
    ).toThrow("invalid execution protocol");

    const unknownVersion = createStarterProtocolFixture();
    unknownVersion.protocol.schemaVersion = 2 as 1;
    expect(() => applyRalphStarterFlowProtocol(unknownVersion)).toThrow(
      "invalid execution protocol",
    );

    const unknownBlock = createStarterProtocolFixture();
    unknownBlock.protocol.verification.baselineBlockId = "missing-check";
    expect(() => applyRalphStarterFlowProtocol(unknownBlock)).toThrow(
      "unknown or duplicate block",
    );

    const incompleteOutcomes = createStarterProtocolFixture();
    incompleteOutcomes.protocol.terminalOutcomes = [];
    expect(() => applyRalphStarterFlowProtocol(incompleteOutcomes)).toThrow(
      "must assign every terminal outcome exactly once",
    );

    const unsafeLoopLimit = createStarterProtocolFixture();
    unsafeLoopLimit.flow.blocks.push({
      id: "loop-limit",
      type: "UTILITY",
      title: "Loop limit",
      utility: { type: "LOOP_COUNTER", maxAttempts: 1 },
    });
    unsafeLoopLimit.flow.edges.push({
      id: "loop-limit-to-done",
      from: "loop-limit",
      fromOutput: "LIMIT_REACHED",
      to: "done",
    });
    expect(() => applyRalphStarterFlowProtocol(unsafeLoopLimit)).toThrow(
      "routes LOOP_COUNTER LIMIT_REACHED",
    );

    const unsafeLoopCondition = createStarterProtocolFixture();
    unsafeLoopCondition.flow.blocks.push(
      {
        id: "loop-limit",
        type: "UTILITY",
        title: "Loop limit",
        utility: { type: "LOOP_COUNTER", maxAttempts: 1 },
      },
      {
        id: "completion-condition",
        type: "UTILITY",
        title: "Completion",
        utility: {
          type: "CONDITION",
          condition: { style: "javascript", expression: "true" },
        },
      },
    );
    unsafeLoopCondition.flow.edges.push({
      id: "loop-limit-to-condition",
      from: "loop-limit",
      fromOutput: "LIMIT_REACHED",
      to: "completion-condition",
    });
    expect(() => applyRalphStarterFlowProtocol(unsafeLoopCondition)).toThrow(
      "routes LOOP_COUNTER LIMIT_REACHED",
    );

    const unsafeReportFailure = createStarterProtocolFixture();
    unsafeReportFailure.flow.blocks.push({
      id: "report",
      type: "UTILITY",
      title: "Report",
      utility: { type: "FINAL_REPORT" },
    });
    unsafeReportFailure.flow.edges.push({
      id: "report-error-to-done",
      from: "report",
      fromOutput: "ERROR",
      to: "done",
    });
    expect(() => applyRalphStarterFlowProtocol(unsafeReportFailure)).toThrow(
      "routes FINAL_REPORT ERROR",
    );
  });

  it("persists every autonomous outcome before retiring active state", () => {
    const archivePolicies = [
      {
        flowId: "autonomous-feature-generation-loop",
        archiveId: "archive-goal",
        sources: [
          "record-blocked-goal-outcome",
          "record-deferred-goal-outcome",
          "record-done-goal-outcome",
          "record-resumed-goal-deferred-outcome",
        ],
        output: "SUCCESS",
      },
      {
        flowId: "full-feature-implementation",
        archiveId: "archive-feature-checklist",
        sources: ["outcome-ledger-persisted"],
        output: "MATCH",
      },
      {
        flowId: "autonomous-code-improvement-loop",
        archiveId: "archive-active-improvement",
        sources: [
          "record-done-outcome",
          "record-scope-deferred-outcome",
          "record-scope-invalid-outcome",
        ],
        output: "SUCCESS",
      },
      {
        flowId: "autonomous-ui-improvement-loop",
        archiveId: "archive-active-ui-improvement",
        sources: [
          "record-deferred-outcome",
          "record-done-outcome",
          "record-invalid-outcome",
          "record-stop-outcome",
        ],
        output: "SUCCESS",
      },
    ] as const;

    for (const starterFlow of STARTER_RALPH_FLOWS) {
      const outcomeLedgers = starterFlow.flow.blocks.filter(
        (block) =>
          block.type === "UTILITY" &&
          block.utility.type === "APPEND_JSONL" &&
          block.id.includes("outcome"),
      );
      expect(outcomeLedgers.length).toBeGreaterThan(0);

      for (const ledger of outcomeLedgers) {
        expect(ledger.settings?.retry).toMatchObject({
          mode: "finite",
          maxRetries: expect.any(Number),
        });
        if (ledger.settings?.retry?.mode === "finite") {
          expect(ledger.settings.retry.maxRetries).toBeGreaterThanOrEqual(3);
        }

        for (const edge of starterFlow.flow.edges.filter(
          (candidate) =>
            candidate.from === ledger.id &&
            ["ERROR", "INVALID"].includes(candidate.fromOutput),
        )) {
          const target = starterFlow.flow.blocks.find(
            (candidate) => candidate.id === edge.to,
          );
          expect(target?.type).not.toBe("END");
          expect(
            target?.type === "UTILITY" &&
              target.utility.type === "ARCHIVE_FILE",
          ).toBe(false);
        }
      }

      for (const archive of starterFlow.flow.blocks.filter(
        (block) =>
          block.type === "UTILITY" && block.utility.type === "ARCHIVE_FILE",
      )) {
        expect(archive.settings?.retry).toMatchObject({
          mode: "finite",
          maxRetries: expect.any(Number),
        });
        if (archive.settings?.retry?.mode === "finite") {
          expect(archive.settings.retry.maxRetries).toBeGreaterThanOrEqual(3);
        }
        const archiveError = starterFlow.flow.edges.find(
          (edge) => edge.from === archive.id && edge.fromOutput === "ERROR",
        );
        expect(archiveError).toBeTruthy();
        const errorTarget = starterFlow.flow.blocks.find(
          (block) => block.id === archiveError?.to,
        );
        expect(errorTarget?.type).not.toBe("END");
        expect(errorTarget?.id).not.toBe("final-report");
        expect(errorTarget?.id).not.toBe("scope-cycle-complete");
        expect(errorTarget?.id).not.toBe("feature-outcome-is-done");
      }
    }

    for (const policy of archivePolicies) {
      const flow = getRalphStarterFlow(policy.flowId)!.flow;
      const incoming = flow.edges.filter(
        (edge) => edge.to === policy.archiveId,
      );
      expect(incoming).toHaveLength(policy.sources.length);
      expect(incoming.map((edge) => edge.from).sort()).toEqual(
        [...policy.sources].sort(),
      );
      expect(incoming.every((edge) => edge.fromOutput === policy.output)).toBe(
        true,
      );
    }

    const codeFlow = getRalphStarterFlow(
      "autonomous-code-improvement-loop",
    )!.flow;
    expect(codeFlow.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "record-invalid-outcome",
          fromOutput: "SUCCESS",
          to: "retained-active-report",
        }),
        expect.objectContaining({
          from: "record-deferred-outcome",
          fromOutput: "SUCCESS",
          to: "retained-active-report",
        }),
      ]),
    );

    for (const testCase of [
      {
        flowId: "autonomous-feature-generation-loop",
        localLedger: "record-deferred-goal-outcome",
        localTarget: "archive-goal",
        globalLedger: "record-goal-portfolio-deferred-outcome",
        retainedReport: "retained-goal-report",
      },
      {
        flowId: "autonomous-code-improvement-loop",
        localLedger: "record-scope-deferred-outcome",
        localTarget: "archive-active-improvement",
        globalLedger: "record-deferred-outcome",
        retainedReport: "retained-active-report",
      },
      {
        flowId: "autonomous-ui-improvement-loop",
        localLedger: "record-deferred-outcome",
        localTarget: "archive-active-ui-improvement",
        globalLedger: "record-coverage-deferred-outcome",
        retainedReport: "retained-active-report",
      },
      {
        flowId: "autonomous-refactoring-flow",
        localLedger: "record-deferred-outcome",
        localTarget: "final-report",
        globalLedger: "record-coverage-deferred-outcome",
        retainedReport: "retained-outcome-report",
      },
      {
        flowId: "security-fix-loop",
        localLedger: "record-deferred-outcome",
        localTarget: "final-report",
        globalLedger: "record-coverage-deferred-outcome",
        retainedReport: "retained-outcome-report",
      },
    ] as const) {
      const flow = getRalphStarterFlow(testCase.flowId)!.flow;
      expect(flow.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: testCase.localLedger,
            fromOutput: "SUCCESS",
            to: testCase.localTarget,
          }),
          expect.objectContaining({
            from: testCase.globalLedger,
            fromOutput: "SUCCESS",
            to: testCase.retainedReport,
          }),
        ]),
      );
    }

    const oneShotFlow = getRalphStarterFlow(
      "full-feature-implementation",
    )!.flow;
    expect(oneShotFlow.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "record-deferred-outcome",
          fromOutput: "SUCCESS",
          to: "retained-checklist-report",
        }),
      ]),
    );

    const featureFlow = getRalphStarterFlow(
      "full-feature-implementation",
    )!.flow;
    const archiveGate = featureFlow.blocks.find(
      (block) => block.id === "outcome-ledger-persisted",
    );
    expect(JSON.stringify(archiveGate)).not.toContain(
      "record-deferred-outcome",
    );

    const generationFlow = getRalphStarterFlow(
      "autonomous-feature-generation-loop",
    )!.flow;
    expect(generationFlow.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "record-no-action-goal-outcome",
          fromOutput: "SUCCESS",
          to: "stop-goal-report",
        }),
        expect.objectContaining({
          from: "stop-goal-report",
          fromOutput: "SUCCESS",
          to: "success",
        }),
        expect.objectContaining({
          from: "record-invalid-goal-outcome",
          fromOutput: "SUCCESS",
          to: "retained-goal-report",
        }),
      ]),
    );
    expect(generationFlow.edges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "stop-goal-report",
          to: "goals-per-run-counter",
        }),
      ]),
    );
  });

  it("routes every reachable terminal through a final report", () => {
    for (const starterFlow of STARTER_RALPH_FLOWS) {
      const { reachable } = calculateReachableDominators(starterFlow.flow);
      const finalReports = starterFlow.flow.blocks.filter(
        (block) =>
          block.type === "UTILITY" && block.utility.type === "FINAL_REPORT",
      );
      expect(finalReports.length).toBeGreaterThan(0);
      const reportIds = new Set(finalReports.map((report) => report.id));
      const start = starterFlow.flow.blocks.find(
        (block) => block.type === "START",
      )!;
      const reachableWithoutReports = new Set<string>();
      const pending = [start.id];
      while (pending.length > 0) {
        const current = pending.pop();
        if (!current || reachableWithoutReports.has(current)) {
          continue;
        }
        reachableWithoutReports.add(current);
        for (const edge of starterFlow.flow.edges.filter(
          (candidate) => candidate.from === current,
        )) {
          if (!reportIds.has(edge.to)) {
            pending.push(edge.to);
          }
        }
      }

      for (const terminal of starterFlow.flow.blocks) {
        if (terminal.type !== "END" || !reachable.has(terminal.id)) {
          continue;
        }
        expect(reachableWithoutReports.has(terminal.id)).toBe(false);
        if (terminal.outcome === "deferred") {
          expect(terminal.status).toBeUndefined();
        } else {
          expect(terminal.status).toBe("success");
        }
      }
    }
  });

  it("only uses strict utility result references after their producers dominate", () => {
    for (const starterFlow of STARTER_RALPH_FLOWS) {
      const { dominators, reachable } = calculateReachableDominators(
        starterFlow.flow,
      );
      const blockIds = new Set(
        starterFlow.flow.blocks.map((block) => block.id),
      );

      for (const block of starterFlow.flow.blocks) {
        if (block.type !== "UTILITY" || !reachable.has(block.id)) {
          continue;
        }
        const strictConfig = JSON.stringify(
          omitPermissiveModelText(block.utility),
        );
        const references = [
          ...strictConfig.matchAll(
            /\{\{(?:data|result):([^}:]+)(?::[^}]*)?\}\}/gu,
          ),
        ]
          .map((match) => match[1])
          .filter((reference): reference is string => Boolean(reference));

        for (const reference of references) {
          expect(
            blockIds.has(reference),
            `${starterFlow.id}/${block.id} references unknown ${reference}`,
          ).toBe(true);
          expect(
            dominators.get(block.id)?.has(reference),
            `${starterFlow.id}/${block.id} uses ${reference} before it is guaranteed`,
          ).toBe(true);
        }
      }
    }
  });

  it("assesses multi-task feature state before deterministic selection", () => {
    const taskFlows = [
      {
        flowId: "autonomous-feature-generation-loop",
        validatorId: "validate-goal",
        assessmentId: "assess-goal-tasks",
        completedOutcomeId: "read-completed-goal",
        blockedOutcomeId: "record-blocked-goal-outcome",
        deferredOutcomeId: "record-deferred-goal-outcome",
        invalidOutcomeId: "record-invalid-goal-outcome",
        blockedSuccessTarget: "archive-goal",
      },
      {
        flowId: "full-feature-implementation",
        validatorId: "validate-progress",
        assessmentId: "assess-checklist-tasks",
        completedOutcomeId: "record-done-outcome",
        blockedOutcomeId: "record-blocked-outcome",
        deferredOutcomeId: "record-deferred-outcome",
        invalidOutcomeId: "record-invalid-outcome",
        blockedSuccessTarget: "retained-checklist-report",
      },
    ] as const;

    for (const taskFlow of taskFlows) {
      const flow = getRalphStarterFlow(taskFlow.flowId)!.flow;
      const assessment = flow.blocks.find(
        (block) => block.id === taskFlow.assessmentId,
      );
      expect(assessment).toMatchObject({
        type: "UTILITY",
        utility: {
          type: "ASSESS_JSON_TASKS",
          strategy: "start-to-end",
          maxTasks: "{{maxTasksPerImplementationPass:number=3}}",
        },
      });
      const blockedOutcome = flow.blocks.find(
        (block) => block.id === taskFlow.blockedOutcomeId,
      );
      expect(blockedOutcome).toMatchObject({
        type: "UTILITY",
        utility: {
          type: "APPEND_JSONL",
          input: expect.stringContaining('"outcome":"BLOCKED"'),
        },
      });
      expect(JSON.stringify(blockedOutcome)).toContain(
        `{{data:${taskFlow.assessmentId}}}`,
      );
      expect(flow.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: taskFlow.validatorId,
            fromOutput: "DONE",
            to: "mark-tasks-completed",
          }),
          expect.objectContaining({
            from: taskFlow.validatorId,
            fromOutput: "RETRY",
            to: "mark-tasks-repairing",
          }),
          expect.objectContaining({
            from: "mark-tasks-completed",
            fromOutput: "SUCCESS",
            to: taskFlow.assessmentId,
          }),
          expect.objectContaining({
            from: "select-next-task",
            fromOutput: "EMPTY",
            to: taskFlow.assessmentId,
          }),
          expect.objectContaining({
            from: taskFlow.assessmentId,
            fromOutput: "READY",
            to: "select-next-task",
          }),
          expect.objectContaining({
            from: taskFlow.assessmentId,
            fromOutput: "COMPLETE",
            to: taskFlow.completedOutcomeId,
          }),
          expect.objectContaining({
            from: taskFlow.assessmentId,
            fromOutput: "BLOCKED",
            to: taskFlow.blockedOutcomeId,
          }),
          expect.objectContaining({
            from: taskFlow.assessmentId,
            fromOutput: "DEFERRED",
            to: taskFlow.deferredOutcomeId,
          }),
          expect.objectContaining({
            from: taskFlow.assessmentId,
            fromOutput: "EMPTY",
            to: taskFlow.invalidOutcomeId,
          }),
          expect.objectContaining({
            from: taskFlow.blockedOutcomeId,
            fromOutput: "SUCCESS",
            to: taskFlow.blockedSuccessTarget,
          }),
          expect.objectContaining({
            from: "select-next-task",
            fromOutput: "DEFERRED",
            to: taskFlow.deferredOutcomeId,
          }),
          expect.objectContaining({
            from: "select-next-task",
            fromOutput: "BLOCKED",
            to: taskFlow.blockedOutcomeId,
          }),
          expect.objectContaining({
            from: "mark-tasks-deferred",
            fromOutput: "SUCCESS",
            to: taskFlow.assessmentId,
          }),
        ]),
      );

      if (taskFlow.flowId === "autonomous-feature-generation-loop") {
        expect(flow.edges).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              from: "assess-goal-tasks",
              fromOutput: "BLOCKED",
              to: "record-blocked-goal-outcome",
            }),
            expect.objectContaining({
              from: "select-next-task",
              fromOutput: "ERROR",
              to: "record-deferred-goal-outcome",
            }),
          ]),
        );
        expect(flow.edges).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              from: "assess-goal-tasks",
              to: "mark-tasks-deferred",
            }),
            expect.objectContaining({
              from: "select-next-task",
              to: "mark-tasks-deferred",
            }),
          ]),
        );
      }
    }
  });

  it("uses one bounded validator contract and newest-first bounded discovery", () => {
    let validatorCount = 0;
    for (const starterFlow of STARTER_RALPH_FLOWS) {
      for (const block of starterFlow.flow.blocks) {
        if (block.type !== "UTILITY") {
          continue;
        }
        if (block.utility.type === "VALIDATOR_JSON") {
          validatorCount += 1;
          const schema = block.utility.schema as {
            additionalProperties?: boolean;
            required?: string[];
            properties?: {
              decision?: { enum?: string[] };
              confidence?: { minimum?: number; maximum?: number };
            };
          };
          expect(schema.additionalProperties).toBe(false);
          expect(schema.required).toEqual([
            "decision",
            "confidence",
            "summary",
            "evidence",
            "remainingWork",
          ]);
          expect(schema.properties?.decision?.enum).toEqual([
            "DONE",
            "CONTINUE",
            "RETRY",
            "ERROR",
          ]);
          expect(schema.properties?.confidence).toMatchObject({
            minimum: 0,
            maximum: 1,
          });
        }
        if (block.utility.type === "QUERY_JSONL") {
          expect(block.utility.order).toBe("newest");
          expect(block.utility.maxResults).toBeLessThanOrEqual(50);
        }
        if (block.utility.type === "SCAN_SCOPE_EVIDENCE") {
          expect(String(block.utility.maxDepth)).toContain(
            "{{scopeScanMaxDepth:number=",
          );
          expect(String(block.utility.maxResults)).toContain(
            "{{scopeScanMaxResults:number=",
          );
        }
      }
    }
    expect(validatorCount).toBe(STARTER_RALPH_FLOWS.length);
  });

  it("gives starter flow verification checks enough time for full workspace commands", () => {
    for (const starterFlow of STARTER_RALPH_FLOWS) {
      let runCheckCount = 0;

      for (const block of starterFlow.flow.blocks) {
        if (block.type !== "UTILITY" || block.utility.type !== "RUN_CHECK") {
          continue;
        }

        runCheckCount += 1;
        expect(block.utility.timeoutSeconds).toBeGreaterThanOrEqual(1_800);
      }

      expect(runCheckCount).toBeGreaterThan(0);
    }
  });

  it("runs scoped starter-flow verification from the selected project root", () => {
    const scopedFlows = [
      {
        starterFlowId: "autonomous-code-improvement-loop",
        runCheckBlockId: "run-verification",
        minimumVersion: 8,
      },
      {
        starterFlowId: "autonomous-ui-improvement-loop",
        runCheckBlockId: "run-verification",
        minimumVersion: 5,
      },
      {
        starterFlowId: "autonomous-refactoring-flow",
        runCheckBlockId: "run-validation-checks",
        minimumVersion: 8,
      },
      {
        starterFlowId: "security-fix-loop",
        runCheckBlockId: "run-verification",
        minimumVersion: 6,
      },
    ] as const;

    for (const {
      starterFlowId,
      runCheckBlockId,
      minimumVersion,
    } of scopedFlows) {
      const starterFlow = getRalphStarterFlow(starterFlowId);
      const flow = starterFlow?.flow;
      const detectCommands = flow?.blocks.find(
        (block) => block.id === "detect-project-commands",
      );
      const runCheck = flow?.blocks.find(
        (block) => block.id === runCheckBlockId,
      );

      expect(starterFlow?.version).toBeGreaterThanOrEqual(minimumVersion);
      expect(detectCommands).toMatchObject({
        type: "UTILITY",
        utility: {
          type: "DETECT_PROJECT_COMMANDS",
          rootPath:
            starterFlowId === "autonomous-code-improvement-loop"
              ? "{{data:read-active-improvement:json.scope.paths.0}}"
              : "{{data:select-scope:scope.paths.0}}",
        },
      });
      expect(runCheck).toMatchObject({
        type: "UTILITY",
        utility: {
          type: "RUN_CHECK",
          cwd: "{{data:detect-project-commands:rootPath}}",
        },
      });
    }
  });

  it("runs feature verification from the detected project root", () => {
    const featureFlows = [
      {
        starterFlowId: "autonomous-feature-generation-loop",
        runCheckBlockId: "run-verification",
        minimumVersion: 7,
      },
      {
        starterFlowId: "full-feature-implementation",
        runCheckBlockId: "run-configured-checks",
        minimumVersion: 7,
      },
    ] as const;

    for (const {
      starterFlowId,
      runCheckBlockId,
      minimumVersion,
    } of featureFlows) {
      const starterFlow = getRalphStarterFlow(starterFlowId);
      const flow = starterFlow?.flow;
      const detectCommands = flow?.blocks.find(
        (block) => block.id === "detect-project-commands",
      );
      const runCheck = flow?.blocks.find(
        (block) => block.id === runCheckBlockId,
      );

      expect(starterFlow?.version).toBeGreaterThanOrEqual(minimumVersion);
      expect(detectCommands).toMatchObject({
        type: "UTILITY",
        utility: {
          type: "DETECT_PROJECT_COMMANDS",
          rootPath: ".",
        },
      });
      expect(runCheck).toMatchObject({
        type: "UTILITY",
        utility: {
          type: "RUN_CHECK",
          cwd: "{{data:detect-project-commands:rootPath}}",
        },
      });
    }
  });

  it("keeps generated template note and history files under the machdoch workspace directory", () => {
    const expectedMachdochFiles = [
      {
        starterFlowId: "autonomous-ui-improvement-loop",
        variableName: "notesFile",
        expectedPath:
          ".machdoch/ralph/ui-improvements/RALPH_UI_IMPROVEMENT_NOTES.md",
        rootFallback: "path=RALPH_UI_IMPROVEMENT_NOTES.md",
      },
      {
        starterFlowId: "autonomous-refactoring-flow",
        variableName: "notesFile",
        expectedPath: ".machdoch/ralph/refactor/RALPH_REFACTOR_NOTES.md",
        rootFallback: "path=RALPH_REFACTOR_NOTES.md",
      },
      {
        starterFlowId: "security-fix-loop",
        variableName: "historyFile",
        expectedPath: ".machdoch/ralph/security/RALPH_SECURITY_HISTORY.md",
        rootFallback: "path=RALPH_SECURITY_HISTORY.md",
      },
    ] as const;

    for (const {
      starterFlowId,
      variableName,
      expectedPath,
      rootFallback,
    } of expectedMachdochFiles) {
      const flow = getRalphStarterFlow(starterFlowId)?.flow;
      const fileVariable = flow?.variables?.find(
        (variable) => variable.name === variableName,
      );
      const serializedFlow = JSON.stringify(flow);

      expect(fileVariable).toMatchObject({
        type: "path",
        default: expectedPath,
      });
      expect(serializedFlow).toContain(expectedPath);
      expect(serializedFlow).not.toContain(rootFallback);
    }
  });

  it("caps bundled starter flows that contain cycles", () => {
    for (const starterFlow of STARTER_RALPH_FLOWS) {
      if (!hasGraphCycle(starterFlow.flow)) {
        continue;
      }

      const validation = validateRalphFlow(starterFlow.flow);
      const maxTransitions = starterFlow.flow.settings?.maxTransitions;

      expect(maxTransitions).toEqual(expect.any(Number));
      expect(maxTransitions ?? 0).toBeGreaterThanOrEqual(1);
      expect(validation.warnings).not.toContain("flow-cycle-without-cap");
    }
  });

  it("allocates a sustained outer budget to multi-unit starters", () => {
    for (const starterFlowId of [
      "autonomous-feature-generation-loop",
      "autonomous-code-improvement-loop",
      "autonomous-ui-improvement-loop",
      "autonomous-refactoring-flow",
      "security-fix-loop",
    ]) {
      expect(
        getRalphStarterFlow(starterFlowId)?.flow.settings?.maxTransitions,
      ).toBe(5_000);
    }
  });

  it("routes scoped coverage from authoritative utility outcomes", () => {
    for (const testCase of [
      {
        flowId: "autonomous-code-improvement-loop",
        scanId: "scan-scopes",
        retainedReportId: "retained-active-report",
      },
      {
        flowId: "autonomous-ui-improvement-loop",
        scanId: "scan-ui-scopes",
        retainedReportId: "retained-active-report",
      },
      {
        flowId: "security-fix-loop",
        scanId: "scan-scopes",
        retainedReportId: "retained-outcome-report",
      },
      {
        flowId: "autonomous-refactoring-flow",
        scanId: "scan-scopes",
        retainedReportId: "retained-outcome-report",
      },
    ] as const) {
      const flow = getRalphStarterFlow(testCase.flowId)!.flow;

      expect(
        flow.blocks.some((block) =>
          ["scope-selection-exhausted", "scope-cycle-complete"].includes(
            block.id,
          ),
        ),
      ).toBe(false);
      expect(flow.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: "select-scope",
            fromOutput: "EXHAUSTED",
            to: "record-exhausted-outcome",
          }),
          expect.objectContaining({
            from: "select-scope",
            fromOutput: "DEFERRED",
            to: expect.stringContaining("deferred-outcome"),
          }),
          expect.objectContaining({
            from: "record-exhausted-outcome",
            fromOutput: "SUCCESS",
            to: "completion-report",
          }),
          expect.objectContaining({
            from: "completion-report",
            fromOutput: "SUCCESS",
            to: "success",
          }),
          expect.objectContaining({
            from: "final-report",
            fromOutput: "SUCCESS",
            to: testCase.scanId,
          }),
          expect.objectContaining({
            from: "final-report",
            fromOutput: "ERROR",
            to: testCase.retainedReportId,
          }),
        ]),
      );
      expect(
        flow.edges.some(
          (edge) => edge.from === "final-report" && edge.to === "success",
        ),
      ).toBe(false);
    }
  });

  it("routes autonomous improvement decisions only from exact schema enums", () => {
    for (const testCase of [
      {
        flowId: "autonomous-code-improvement-loop",
        actionableId: "has-actionable-improvement",
        choiceId: "choose-improvement",
        reviewId: "independent-review",
        errorPrefix: "Code improvement",
      },
      {
        flowId: "autonomous-ui-improvement-loop",
        actionableId: "has-actionable-ui-improvement",
        choiceId: "choose-ui-improvement",
        reviewId: "independent-ui-review",
        errorPrefix: "UI improvement",
      },
    ] as const) {
      const flow = getRalphStarterFlow(testCase.flowId)?.flow;
      const findCondition = (id: string): RalphUtilityBlock => {
        const block = flow?.blocks.find((candidate) => candidate.id === id);
        if (block?.type !== "UTILITY" || block.utility.type !== "CONDITION") {
          throw new Error(`Expected ${testCase.flowId} condition ${id}.`);
        }
        return block;
      };
      const actionable = findCondition(testCase.actionableId);
      const deferred = findCondition("selection-is-deferred");
      const reviewDeferred = findCondition("review-is-deferred");
      const reviewFix = findCondition("review-needs-fix");
      const usesPersistentPlan =
        testCase.flowId === "autonomous-code-improvement-loop";
      const decisionBlockId = usesPersistentPlan
        ? "build-improvement-plan"
        : testCase.choiceId;
      const implementResult = {
        [decisionBlockId]: {
          data: {
            output: usesPersistentPlan
              ? {
                  decision: "IMPLEMENT",
                  tasks: [{ id: "candidate", status: "planned" }],
                }
              : {
                  decision: "IMPLEMENT",
                  selectedCandidate: {
                    id: "candidate",
                    evidence: ['Quoted prose: "STOP DEFER".'],
                  },
                },
          },
        },
      };

      expect(evaluateStarterCondition(actionable, {}, implementResult)).toBe(
        true,
      );
      expect(
        evaluateStarterCondition(
          deferred,
          {},
          {
            [decisionBlockId]: { data: { output: { decision: "DEFER" } } },
          },
        ),
      ).toBe(true);
      expect(() =>
        evaluateStarterCondition(
          actionable,
          {},
          {
            [decisionBlockId]: {
              data: {
                output: usesPersistentPlan
                  ? { decision: "implement", tasks: [] }
                  : { decision: "implement", selectedCandidate: {} },
              },
            },
          },
        ),
      ).toThrow(
        `${testCase.errorPrefix} ${usesPersistentPlan ? "plan" : "selection"} decision is missing or invalid.`,
      );
      expect(() =>
        evaluateStarterCondition(
          actionable,
          {},
          {
            [decisionBlockId]: {
              data: {
                output: usesPersistentPlan
                  ? { decision: "IMPLEMENT", tasks: [] }
                  : { decision: "IMPLEMENT", selectedCandidate: {} },
              },
            },
          },
        ),
      ).toThrow(
        usesPersistentPlan
          ? "IMPLEMENT requires persisted tasks."
          : /IMPLEMENT requires a structured selected/u,
      );
      expect(
        evaluateStarterCondition(
          reviewDeferred,
          {},
          {
            [testCase.reviewId]: { data: { output: { decision: "DEFER" } } },
          },
        ),
      ).toBe(true);
      expect(
        evaluateStarterCondition(
          reviewFix,
          {},
          {
            [testCase.reviewId]: { data: { output: { decision: "FIX" } } },
          },
        ),
      ).toBe(true);
      expect(() =>
        evaluateStarterCondition(
          reviewFix,
          {},
          {
            [testCase.reviewId]: {
              data: { output: { decision: 'Quoted verdict: "FIX".' } },
            },
          },
        ),
      ).toThrow(
        `${testCase.errorPrefix} review decision is missing or invalid.`,
      );
    }
  });

  it("does not expose dynamically named environment variables to UI flows", () => {
    const serialized = JSON.stringify(
      getRalphStarterFlow("autonomous-ui-improvement-loop")?.flow,
    );

    expect(serialized).not.toContain("process.env");
    expect(serialized).not.toContain("targetUrlEnvKey");
    expect(serialized).not.toContain("healthUrlEnvKey");
  });

  it("resumes feature checklists only by exact structured identity", () => {
    const block = getRalphStarterFlow(
      "full-feature-implementation",
    )?.flow.blocks.find(
      (candidate) => candidate.id === "checklist-matches-feature",
    );
    if (block?.type !== "UTILITY" || block.utility.type !== "CONDITION") {
      throw new Error("Expected the checklist identity condition.");
    }
    const expected = {
      "resolve-checklist-path": {
        data: {
          output: {
            featureId: "billing-settings",
            note: 'Quoted prose: "BILLING-SETTINGS".',
          },
        },
      },
    };

    expect(
      evaluateStarterCondition(block, {}, expected, {
        json: { featureId: "billing-settings" },
      }),
    ).toBe(true);
    expect(
      evaluateStarterCondition(block, {}, expected, {
        json: { featureId: "BILLING-SETTINGS" },
      }),
    ).toBe(false);
    expect(
      evaluateStarterCondition(block, {}, expected, {
        json: { featureId: " billing-settings " },
      }),
    ).toBe(false);
    expect(() =>
      evaluateStarterCondition(block, {}, expected, { json: {} }),
    ).toThrow("Checklist feature identity is missing or invalid.");
  });

  it("includes an autonomous feature-generation loop with bounded goal selection", () => {
    const starterFlow = getRalphStarterFlow(
      "autonomous-feature-generation-loop",
    );
    const flow = starterFlow?.flow;
    const passCounter = flow?.blocks.find(
      (block) => block.id === "count-implementation-pass",
    );
    const implementFeature = flow?.blocks.find(
      (block) => block.id === "implement-feature",
    );
    const readCompletedGoals = flow?.blocks.find(
      (block) => block.id === "read-completed-goals",
    );
    const readGoalOutcomes = flow?.blocks.find(
      (block) => block.id === "read-goal-outcomes",
    );
    const hasActionableGoal = flow?.blocks.find(
      (block) => block.id === "has-actionable-goal",
    );
    const runVerification = flow?.blocks.find(
      (block) => block.id === "run-verification",
    );
    const workYieldAnalysis = flow?.blocks.find(
      (block) => block.id === "work-yield-analysis",
    );
    const workYieldDecision = flow?.blocks.find(
      (block) => block.id === "work-yield-decision",
    );
    const validateGoal = flow?.blocks.find(
      (block) => block.id === "validate-goal",
    );
    const selectNextTask = flow?.blocks.find(
      (block) => block.id === "select-next-task",
    );
    const assessGoalTasks = flow?.blocks.find(
      (block) => block.id === "assess-goal-tasks",
    );
    const maxTasksPerImplementationPass = flow?.variables?.find(
      (variable) => variable.name === "maxTasksPerImplementationPass",
    );

    expect(starterFlow?.defaultAlias).toBe(
      "autonomous-feature-generation-loop",
    );
    expect(starterFlow?.version).toBeGreaterThanOrEqual(8);
    expect(maxTasksPerImplementationPass).toMatchObject({
      type: "number",
      default: "3",
    });
    expect(flow).toMatchObject({
      name: "Autonomous Feature Generation Loop",
      settings: { maxTransitions: 5_000 },
    });
    expect(
      flow?.blocks.find((block) => block.id === "find-active-goal"),
    ).toMatchObject({
      type: "UTILITY",
      utility: { type: "FILE_EXISTS" },
    });
    expect(
      flow?.blocks.find((block) => block.id === "archive-goal"),
    ).toMatchObject({
      type: "UTILITY",
      utility: { type: "ARCHIVE_FILE" },
    });
    expect(readCompletedGoals).toMatchObject({
      type: "UTILITY",
      utility: { type: "QUERY_JSONL", maxResults: 50, order: "newest" },
    });
    expect(readGoalOutcomes).toMatchObject({
      type: "UTILITY",
      utility: { type: "QUERY_JSONL", maxResults: 50, order: "newest" },
    });
    expect(hasActionableGoal).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "CONDITION",
        condition: {
          style: "json-path",
          path: "lastData.output.status",
          operator: "is-one-of",
          matchValues: ["planned", "implementing"],
          allowedValues: expect.arrayContaining(["no_action"]),
        },
      },
    });

    if (
      hasActionableGoal?.type !== "UTILITY" ||
      hasActionableGoal.utility.type !== "CONDITION"
    ) {
      throw new Error("Expected the actionable-goal condition block.");
    }

    const selectionIsDeferred = flow?.blocks.find(
      (block) => block.id === "selection-is-deferred",
    );
    if (
      selectionIsDeferred?.type !== "UTILITY" ||
      selectionIsDeferred.utility.type !== "CONDITION"
    ) {
      throw new Error("Expected the deferred-selection condition block.");
    }

    expect(
      evaluateStarterCondition(hasActionableGoal, {
        status: "planned",
        tasks: [
          {
            id: "task-1",
            description:
              'Quoted incidental prose: "deferred, completed, no_action".',
          },
        ],
      }),
    ).toBe(true);
    expect(
      evaluateStarterCondition(hasActionableGoal, {
        status: "completed",
        tasks: [{ id: "task-1" }],
      }),
    ).toBe(false);
    expect(() =>
      evaluateStarterCondition(hasActionableGoal, {
        status: "PLANNED",
        tasks: [{ id: "task-1" }],
      }),
    ).toThrow("Feature goal status is missing or invalid.");
    expect(
      evaluateStarterCondition(
        selectionIsDeferred,
        {},
        {
          "improve-feature-goal": {
            data: { output: { status: "deferred" } },
          },
        },
      ),
    ).toBe(true);
    expect(() =>
      evaluateStarterCondition(
        selectionIsDeferred,
        {},
        {
          "improve-feature-goal": {
            data: { output: { status: "not deferred; continue" } },
          },
        },
      ),
    ).toThrow("Feature goal status is missing or invalid.");
    expect(passCounter).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "LOOP_COUNTER",
        counterName: expect.stringContaining(
          "{{data:select-next-task:tasks.0.id}}",
        ),
        maxAttempts: "{{maxImplementationPasses:number=10}}",
      },
    });
    expect(selectNextTask).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "SELECT_JSON_TASK",
        maxTasks: "{{maxTasksPerImplementationPass:number=3}}",
      },
    });
    expect(assessGoalTasks).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "ASSESS_JSON_TASKS",
        maxTasks: "{{maxTasksPerImplementationPass:number=3}}",
      },
    });
    expect(implementFeature).toMatchObject({
      type: "PROMPT",
      prompt: expect.stringContaining("selected active-goal task batch"),
    });
    expect(implementFeature).toMatchObject({
      type: "PROMPT",
      prompt: expect.stringContaining("work-yield analysis"),
    });
    expect(workYieldAnalysis).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "TRANSFORM_JSON",
        deterministicTransform: {
          type: "repository-work-yield",
          baselineBlockId: "git-snapshot-before",
          currentBlockId: "git-diff-summary",
          workItemBlockId: "select-next-task",
          verifyOnObservationError: true,
        },
      },
    });
    expect(workYieldDecision).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "CONDITION",
        condition: {
          style: "json-path",
          path: "lastData.output.shouldVerify",
          operator: "equals",
          value: "true",
        },
      },
    });
    expect(validateGoal).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "VALIDATOR_JSON",
        prompt: expect.stringContaining("work-yield analysis"),
      },
    });
    expect(runVerification).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "RUN_CHECK",
        cwd: "{{data:detect-project-commands:rootPath}}",
      },
    });
    expect(flow?.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "start",
          to: "detect-project-commands",
        }),
        expect.objectContaining({
          from: "detect-project-commands",
          to: "find-active-goal",
        }),
        expect.objectContaining({
          from: "find-active-goal",
          fromOutput: "MISSING",
          to: "read-completed-goals",
        }),
        expect.objectContaining({
          from: "read-completed-goals",
          to: "read-goal-outcomes",
        }),
        expect.objectContaining({
          from: "read-goal-outcomes",
          to: "understand-project",
        }),
        expect.objectContaining({
          from: "improve-feature-goal",
          to: "has-actionable-goal",
        }),
        expect.objectContaining({
          from: "has-actionable-goal",
          fromOutput: "NO_MATCH",
          to: "selection-is-deferred",
        }),
        expect.objectContaining({
          from: "git-snapshot-before",
          to: "baseline-verification",
        }),
        expect.objectContaining({
          from: "baseline-verification",
          fromOutput: "SUCCESS",
          to: "count-implementation-pass",
        }),
        expect.objectContaining({
          from: "count-implementation-pass",
          fromOutput: "CONTINUE",
          to: "implement-feature",
        }),
        expect.objectContaining({
          from: "count-implementation-pass",
          fromOutput: "LIMIT_REACHED",
          to: "mark-tasks-deferred",
        }),
        expect.objectContaining({
          from: "implement-feature",
          fromOutput: "SUCCESS",
          to: "mark-tasks-verifying",
        }),
        expect.objectContaining({
          from: "mark-tasks-verifying",
          fromOutput: "SUCCESS",
          to: "git-diff-summary",
        }),
        expect.objectContaining({
          from: "git-diff-summary",
          fromOutput: "SUCCESS",
          to: "work-yield-analysis",
        }),
        expect.objectContaining({
          from: "work-yield-analysis",
          fromOutput: "SUCCESS",
          to: "work-yield-decision",
        }),
        expect.objectContaining({
          from: "work-yield-decision",
          fromOutput: "MATCH",
          to: "verification-decision",
        }),
        expect.objectContaining({
          from: "work-yield-decision",
          fromOutput: "NO_MATCH",
          to: "validate-goal",
        }),
        expect.objectContaining({
          from: "goals-per-run-counter",
          to: "detect-project-commands",
        }),
        expect.objectContaining({
          from: "goals-per-run-counter",
          fromOutput: "LIMIT_REACHED",
          to: "retained-goal-report",
        }),
      ]),
    );
    expect(flow?.edges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "implement-feature",
          fromOutput: "SUCCESS",
          to: "verification-decision",
        }),
      ]),
    );

    const endBlocks = (flow?.blocks ?? []).filter(
      (block: RalphFlowBlock) => block.type === "END",
    );

    expect(endBlocks.map((block) => block.id).sort()).toEqual([
      "deferred",
      "success",
    ]);
  });

  it("enforces implementation pass limits in the feature checklist starter", () => {
    const starterFlow = getRalphStarterFlow("full-feature-implementation");
    const flow = starterFlow?.flow;
    const passCounter = flow?.blocks.find(
      (block) => block.id === "count-implementation-pass",
    );
    const implementFeature = flow?.blocks.find(
      (block) => block.id === "implement-feature",
    );
    const featureRequest = flow?.variables?.find(
      (variable) => variable.name === "featureRequest",
    );
    const runConfiguredChecks = flow?.blocks.find(
      (block) => block.id === "run-configured-checks",
    );
    const workYieldAnalysis = flow?.blocks.find(
      (block) => block.id === "work-yield-analysis",
    );
    const workYieldDecision = flow?.blocks.find(
      (block) => block.id === "work-yield-decision",
    );
    const validateProgress = flow?.blocks.find(
      (block) => block.id === "validate-progress",
    );
    const selectNextTask = flow?.blocks.find(
      (block) => block.id === "select-next-task",
    );
    const assessChecklistTasks = flow?.blocks.find(
      (block) => block.id === "assess-checklist-tasks",
    );
    const maxTasksPerImplementationPass = flow?.variables?.find(
      (variable) => variable.name === "maxTasksPerImplementationPass",
    );

    expect(starterFlow?.version).toBeGreaterThanOrEqual(8);
    expect(featureRequest).toMatchObject({
      type: "text",
      required: false,
      default: expect.stringContaining("Autonomously identify"),
    });
    expect(flow?.blocks.some((block) => block.type === "INTERVIEW")).toBe(
      false,
    );
    expect(maxTasksPerImplementationPass).toMatchObject({
      type: "number",
      default: "3",
    });
    expect(flow).toMatchObject({
      settings: { maxTransitions: 500 },
    });
    expect(passCounter).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "LOOP_COUNTER",
        counterName: expect.stringContaining(
          "{{data:select-next-task:tasks.0.id}}",
        ),
        maxAttempts: "{{maxImplementationPasses:number=8}}",
      },
    });
    expect(selectNextTask).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "SELECT_JSON_TASK",
        maxTasks: "{{maxTasksPerImplementationPass:number=3}}",
      },
    });
    expect(assessChecklistTasks).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "ASSESS_JSON_TASKS",
        maxTasks: "{{maxTasksPerImplementationPass:number=3}}",
      },
    });
    expect(implementFeature).toMatchObject({
      type: "PROMPT",
      prompt: expect.stringContaining("selected checklist task batch"),
    });
    expect(implementFeature).toMatchObject({
      type: "PROMPT",
      prompt: expect.stringContaining("work-yield analysis"),
    });
    expect(workYieldAnalysis).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "TRANSFORM_JSON",
        deterministicTransform: {
          type: "repository-work-yield",
          baselineBlockId: "git-snapshot-before",
          currentBlockId: "git-diff-summary",
          workItemBlockId: "select-next-task",
          verifyOnObservationError: true,
        },
      },
    });
    expect(workYieldDecision).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "CONDITION",
        condition: {
          style: "json-path",
          path: "lastData.output.shouldVerify",
          operator: "equals",
          value: "true",
        },
      },
    });
    expect(validateProgress).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "VALIDATOR_JSON",
        prompt: expect.stringContaining("work-yield analysis"),
      },
    });
    expect(runConfiguredChecks).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "RUN_CHECK",
        cwd: "{{data:detect-project-commands:rootPath}}",
      },
    });
    expect(flow?.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "git-snapshot-before",
          to: "baseline-verification",
        }),
        expect.objectContaining({
          from: "baseline-verification",
          fromOutput: "SUCCESS",
          to: "count-implementation-pass",
        }),
        expect.objectContaining({
          from: "count-implementation-pass",
          fromOutput: "CONTINUE",
          to: "implement-feature",
        }),
        expect.objectContaining({
          from: "count-implementation-pass",
          fromOutput: "LIMIT_REACHED",
          to: "mark-tasks-deferred",
        }),
        expect.objectContaining({
          from: "implement-feature",
          fromOutput: "SUCCESS",
          to: "mark-tasks-verifying",
        }),
        expect.objectContaining({
          from: "mark-tasks-verifying",
          fromOutput: "SUCCESS",
          to: "git-diff-summary",
        }),
        expect.objectContaining({
          from: "git-diff-summary",
          fromOutput: "SUCCESS",
          to: "work-yield-analysis",
        }),
        expect.objectContaining({
          from: "work-yield-analysis",
          fromOutput: "SUCCESS",
          to: "work-yield-decision",
        }),
        expect.objectContaining({
          from: "work-yield-decision",
          fromOutput: "MATCH",
          to: "verification-decision",
        }),
        expect.objectContaining({
          from: "work-yield-decision",
          fromOutput: "NO_MATCH",
          to: "validate-progress",
        }),
      ]),
    );
    expect(flow?.edges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "implement-feature",
          fromOutput: "SUCCESS",
          to: "verification-decision",
        }),
      ]),
    );
  });

  it("ships the refactor starter with validation fallback, workspace-tolerant final scan, and pass counter", () => {
    const starterFlow = getRalphStarterFlow("autonomous-refactoring-flow");
    const flow = starterFlow?.flow;
    const passCounter = flow?.blocks.find(
      (block) => block.id === "count-refactor-pass",
    );
    const scopeSelectionStrategy = flow?.variables?.find(
      (variable) => variable.name === "scopeSelectionStrategy",
    );
    const auditAgainstPolicy = flow?.blocks.find(
      (block) => block.id === "audit-against-policy",
    );
    const selectValidationCommand = flow?.blocks.find(
      (block) => block.id === "select-validation-command",
    );
    const hasActionableRefactor = flow?.blocks.find(
      (block) => block.id === "has-actionable-refactor",
    );
    const validationDecision = flow?.blocks.find(
      (block) => block.id === "validation-decision",
    );
    const runValidation = flow?.blocks.find(
      (block) => block.id === "run-validation-checks",
    );
    const refactorPass = flow?.blocks.find(
      (block) => block.id === "refactor-pass",
    );
    const fixValidationFailures = flow?.blocks.find(
      (block) => block.id === "fix-validation-failures",
    );
    const finalRefactorScan = flow?.blocks.find(
      (block) => block.id === "final-refactor-scan",
    );
    const finalScanCounter = flow?.blocks.find(
      (block) => block.id === "count-final-refactor-scan",
    );
    const progressAnalysis = flow?.blocks.find(
      (block) => block.id === "refactor-progress-analysis",
    );
    const readRefactorOutcomes = flow?.blocks.find(
      (block) => block.id === "read-refactor-outcomes",
    );
    expect(starterFlow?.version).toBeGreaterThanOrEqual(8);
    expect(scopeSelectionStrategy).toMatchObject({
      type: "text",
      default: "priority",
    });
    expect(auditAgainstPolicy).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "PROMPT_JSON",
        prompt: expect.stringContaining("STOP with passes []"),
      },
    });
    expect(auditAgainstPolicy).toMatchObject({
      type: "UTILITY",
      utility: {
        prompt: expect.stringContaining("provisional refactor portfolio"),
      },
    });
    expect(hasActionableRefactor).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "CONDITION",
        condition: {
          style: "json-path",
          path: "resultsByBlock.audit-against-policy.data.output.outcome",
          operator: "equals",
          value: "IMPLEMENT",
          conditions: expect.arrayContaining([
            expect.objectContaining({ operator: "non-empty-array" }),
          ]),
        },
      },
    });
    expect(passCounter).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "LOOP_COUNTER",
        counterName: expect.stringContaining("{{data:select-scope:scope.id}}"),
        maxAttempts: "{{maxRefactorPasses:number=3}}",
      },
    });
    expect(validationDecision).toMatchObject({
      type: "UTILITY",
      utility: {
        condition: {
          style: "json-path",
          path: "resultsByBlock.select-validation-command.data.output.command",
          operator: "truthy",
        },
      },
    });
    expect(selectValidationCommand).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "TRANSFORM_JSON",
        deterministicTransform: {
          type: "verification-command",
          selectionBlockId: "audit-against-policy",
          selectionPath: "output",
        },
      },
    });
    expect(runValidation).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "RUN_CHECK",
        command: "{{data:select-validation-command:output.command}}",
        fallbackCommand:
          "{{data:detect-project-commands:focusedVerificationCommand}}",
        cwd: "{{data:detect-project-commands:rootPath}}",
        timeoutSeconds: 1800,
      },
    });
    expect(refactorPass).toMatchObject({
      type: "PROMPT",
      settings: { maxIterations: 1 },
      prompt: expect.stringContaining("authoritative handoff"),
    });
    expect(refactorPass?.settings).not.toHaveProperty("timeoutSeconds");
    expect(refactorPass).toMatchObject({
      type: "PROMPT",
      prompt: expect.stringContaining("count-refactor-pass:count"),
    });
    expect(fixValidationFailures).toMatchObject({
      type: "PROMPT",
    });
    expect(fixValidationFailures?.settings).not.toHaveProperty(
      "timeoutSeconds",
    );
    expect(finalRefactorScan).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "VALIDATOR_JSON",
        prompt: expect.stringContaining("Ignore unrelated changes"),
      },
    });
    expect(finalRefactorScan?.settings).not.toHaveProperty("timeoutSeconds");
    expect(finalScanCounter).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "LOOP_COUNTER",
        maxAttempts: "{{maxFinalRefactorScans:number=3}}",
      },
    });
    expect(progressAnalysis).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "TRANSFORM_JSON",
        deterministicTransform: {
          type: "repository-work-yield",
          baselineBlockId: "git-snapshot-before",
          currentBlockId: "git-diff-summary",
          scopeGuardBlockId: "scope-change-guard",
          trackPrevious: true,
        },
      },
    });
    expect(readRefactorOutcomes).toMatchObject({
      type: "UTILITY",
      utility: { type: "QUERY_JSONL", maxResults: 50, order: "newest" },
    });
    expect(
      flow?.blocks.some((block) => block.id === "change-scope-guard"),
    ).toBe(false);
    expect(
      flow?.blocks.some((block) => block.id === "scope-change-guard"),
    ).toBe(true);
    expect(
      flow?.blocks.some(
        (block) => block.type === "END" && block.status === "failed",
      ),
    ).toBe(false);
    expect(flow?.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "propose-refactor-packages",
          fromOutput: "SUCCESS",
          to: "research-decision",
        }),
        expect.objectContaining({
          from: "research-decision",
          fromOutput: "NO_MATCH",
          to: "audit-against-policy",
        }),
        expect.objectContaining({
          from: "audit-against-policy",
          fromOutput: "SUCCESS",
          to: "has-actionable-refactor",
        }),
        expect.objectContaining({
          from: "has-actionable-refactor",
          fromOutput: "MATCH",
          to: "record-selected-refactor",
        }),
        expect.objectContaining({
          from: "record-selected-refactor",
          fromOutput: "SUCCESS",
          to: "git-snapshot-before",
        }),
        expect.objectContaining({
          from: "has-actionable-refactor",
          fromOutput: "NO_MATCH",
          to: "selection-is-deferred",
        }),
        expect.objectContaining({
          from: "git-snapshot-before",
          fromOutput: "SUCCESS",
          to: "select-validation-command",
        }),
        expect.objectContaining({
          from: "select-validation-command",
          fromOutput: "SUCCESS",
          to: "baseline-validation",
        }),
        expect.objectContaining({
          from: "baseline-validation",
          fromOutput: "SUCCESS",
          to: "count-refactor-pass",
        }),
        expect.objectContaining({
          from: "count-refactor-pass",
          fromOutput: "CONTINUE",
          to: "refactor-pass",
        }),
        expect.objectContaining({
          from: "count-refactor-pass",
          fromOutput: "LIMIT_REACHED",
          to: "defer-scope",
        }),
        expect.objectContaining({
          from: "refactor-pass",
          fromOutput: "SUCCESS",
          to: "validation-decision",
        }),
        expect.objectContaining({
          from: "final-refactor-scan",
          fromOutput: "CONTINUE",
          to: "count-refactor-pass",
        }),
        expect.objectContaining({
          from: "git-diff-summary",
          fromOutput: "SUCCESS",
          to: "scope-change-guard",
        }),
        expect.objectContaining({
          from: "scope-change-guard",
          fromOutput: "IN_SCOPE",
          to: "refactor-progress-analysis",
        }),
        expect.objectContaining({
          from: "refactor-progress-produced",
          fromOutput: "NO_MATCH",
          to: "defer-scope",
        }),
        expect.objectContaining({
          from: "count-final-refactor-scan",
          fromOutput: "CONTINUE",
          to: "final-refactor-scan",
        }),
      ]),
    );
    expect(flow?.edges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "final-refactor-scan",
          fromOutput: "CONTINUE",
          to: "refactor-pass",
        }),
      ]),
    );
  });

  it("runs security review after risk-first scope selection with bounded fix loops", () => {
    const starterFlow = getRalphStarterFlow("security-fix-loop");
    const flow = starterFlow?.flow;
    const scopeSelectionStrategy = flow?.variables?.find(
      (variable) => variable.name === "scopeSelectionStrategy",
    );
    const updateScopeRegistry = flow?.blocks.find(
      (block) => block.id === "update-scope-registry",
    );
    const selectScope = flow?.blocks.find(
      (block) => block.id === "select-scope",
    );
    const beginScopeCycle = flow?.blocks.find(
      (block) => block.id === "begin-scope-cycle",
    );
    const securityResearch = flow?.blocks.find(
      (block) => block.id === "security-research",
    );
    const countFixLoop = flow?.blocks.find(
      (block) => block.id === "count-fix-loop",
    );
    const verifyStopCondition = flow?.blocks.find(
      (block) => block.id === "verify-stop-condition",
    );

    expect(starterFlow?.version).toBeGreaterThanOrEqual(6);
    expect(scopeSelectionStrategy).toMatchObject({
      type: "text",
      default: "risk-first",
    });
    expect(updateScopeRegistry).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "UPDATE_SCOPE_REGISTRY",
        strategy: "{{scopeSelectionStrategy:text=risk-first}}",
      },
    });
    expect(selectScope).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "SELECT_SCOPE",
        strategy: "{{scopeSelectionStrategy:text=risk-first}}",
      },
    });
    expect(beginScopeCycle).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "BEGIN_SCOPE_CYCLE",
        strategy: "{{scopeSelectionStrategy:text=risk-first}}",
      },
    });
    expect(securityResearch).toMatchObject({
      type: "PROMPT",
      prompt: expect.stringContaining("selected JSON scope"),
    });
    expect(countFixLoop).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "LOOP_COUNTER",
        counterName: expect.stringContaining("{{data:select-scope:scope.id}}"),
        maxAttempts: "{{maxFixLoops:number=10}}",
      },
    });
    expect(verifyStopCondition).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "VALIDATOR_JSON",
        prompt: expect.stringContaining("bounded repairs"),
      },
    });
    expect(flow?.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "start",
          to: "begin-scope-cycle",
        }),
        expect.objectContaining({
          from: "begin-scope-cycle",
          to: "scan-scopes",
        }),
        expect.objectContaining({
          from: "detect-project-commands",
          to: "read-security-outcomes",
        }),
        expect.objectContaining({
          from: "read-security-outcomes",
          to: "research-decision",
        }),
        expect.objectContaining({
          from: "security-research",
          to: "git-snapshot-before",
        }),
        expect.objectContaining({
          from: "git-snapshot-before",
          to: "baseline-verification",
        }),
        expect.objectContaining({
          from: "findings-present",
          fromOutput: "MATCH",
          to: "record-security-findings",
        }),
        expect.objectContaining({
          from: "record-security-findings",
          fromOutput: "SUCCESS",
          to: "count-fix-loop",
        }),
        expect.objectContaining({
          from: "count-fix-loop",
          fromOutput: "CONTINUE",
          to: "fix-findings",
        }),
        expect.objectContaining({
          from: "count-fix-loop",
          fromOutput: "LIMIT_REACHED",
          to: "defer-scope",
        }),
        expect.objectContaining({
          from: "git-diff-summary",
          fromOutput: "SUCCESS",
          to: "scope-change-guard",
        }),
        expect.objectContaining({
          from: "verify-stop-condition",
          fromOutput: "CONTINUE",
          to: "count-fix-loop",
        }),
      ]),
    );
    expect(flow?.edges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "start",
          to: "research-decision",
        }),
        expect.objectContaining({
          from: "security-research",
          to: "scan-scopes",
        }),
      ]),
    );
  });

  it("includes an autonomous code improvement loop with evidence-backed stop behavior", () => {
    const starterFlow = getRalphStarterFlow("autonomous-code-improvement-loop");
    const flow = starterFlow?.flow;
    const chooseImprovement = flow?.blocks.find(
      (block) => block.id === "choose-improvement",
    );
    const buildImprovementPlan = flow?.blocks.find(
      (block) => block.id === "build-improvement-plan",
    );
    const actionableDecision = flow?.blocks.find(
      (block) => block.id === "has-actionable-improvement",
    );
    const scopeSelectionStrategy = flow?.variables?.find(
      (variable) => variable.name === "scopeSelectionStrategy",
    );
    const passCounter = flow?.blocks.find(
      (block) => block.id === "count-improvement-pass",
    );
    const implementImprovement = flow?.blocks.find(
      (block) => block.id === "implement-improvement",
    );
    const independentReview = flow?.blocks.find(
      (block) => block.id === "independent-review",
    );
    const validateImprovement = flow?.blocks.find(
      (block) => block.id === "validate-improvement",
    );
    const workYieldAnalysis = flow?.blocks.find(
      (block) => block.id === "work-yield-analysis",
    );
    const usefulWorkProduced = flow?.blocks.find(
      (block) => block.id === "useful-work-produced",
    );
    const finalScanCounter = flow?.blocks.find(
      (block) => block.id === "count-final-validation-scan",
    );
    const taskAssessment = flow?.blocks.find(
      (block) => block.id === "assess-improvement-tasks",
    );
    const activePlanFile = flow?.variables?.find(
      (variable) => variable.name === "activeImprovementPlanFile",
    );
    const scopeScanDepth = flow?.variables?.find(
      (variable) => variable.name === "scopeScanMaxDepth",
    );

    expect(starterFlow).toMatchObject({
      defaultAlias: "autonomous-code-improvement-loop",
      category: "Code Quality",
    });
    expect(starterFlow?.version).toBeGreaterThanOrEqual(20);
    expect(scopeSelectionStrategy).toMatchObject({
      type: "text",
      default: "priority",
    });
    expect(flow).toMatchObject({
      name: "Autonomous Code Improvement Loop",
      settings: { maxTransitions: 5_000 },
    });
    expect(activePlanFile).toMatchObject({
      type: "path",
      default: ".machdoch/ralph/code-improvements/active-improvement-plan.json",
    });
    expect(scopeScanDepth).toMatchObject({ type: "number", default: "6" });
    expect(taskAssessment).toMatchObject({
      type: "UTILITY",
      utility: { type: "ASSESS_JSON_TASKS", jsonPath: "tasks", maxTasks: 1 },
    });
    expect(chooseImprovement).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "PROMPT_JSON",
        prompt: expect.stringContaining("Return decision IMPLEMENT only"),
      },
    });
    if (
      buildImprovementPlan?.type !== "UTILITY" ||
      buildImprovementPlan.utility.type !== "TRANSFORM_JSON"
    ) {
      throw new Error("Expected code improvement plan transform.");
    }
    const createPlan = (taskIds: string[]): Record<string, unknown> =>
      evaluateStarterTransformWithContext(
        buildImprovementPlan,
        new Map<string, unknown>([
          [
            "choose-improvement",
            {
              data: {
                output: {
                  decision: "IMPLEMENT",
                  rationale: "Implement",
                  tasks: taskIds.map((id) => ({ id, status: "planned" })),
                },
              },
            },
          ],
          ["select-scope", { data: { scope: { id: "scope" } } }],
        ]),
      );
    expect(buildImprovementPlan.utility.deterministicTransform).toMatchObject({
      type: "code-improvement-plan",
      draftBlockId: "choose-improvement",
      selectionBlockId: "select-scope",
    });
    expect(createPlan(["a", "b"]).planId).not.toBe(createPlan(["a,b"]).planId);
    expect(chooseImprovement).toMatchObject({
      utility: {
        prompt: expect.stringContaining(
          "retain every currently eligible meaningful package",
        ),
      },
    });
    expect(chooseImprovement).toMatchObject({
      utility: {
        prompt: expect.stringContaining("DEFER only"),
      },
    });
    expect(actionableDecision).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "CONDITION",
        condition: {
          style: "json-path",
          path: "resultsByBlock.build-improvement-plan.data.output.decision",
          operator: "equals",
          value: "IMPLEMENT",
        },
      },
    });
    expect(passCounter).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "LOOP_COUNTER",
        counterName: expect.stringContaining(
          "{{data:select-improvement-task:tasks.0.id}}",
        ),
        maxAttempts: "{{maxImprovementPasses:number=3}}",
      },
    });
    expect(implementImprovement).toMatchObject({
      type: "PROMPT",
      settings: { maxIterations: 1 },
      prompt: expect.stringContaining("Implement only selected task"),
    });
    expect(implementImprovement).toMatchObject({
      type: "PROMPT",
      prompt: expect.stringContaining("Do not repeat discovery"),
    });
    expect(independentReview).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "PROMPT_JSON",
        prompt: expect.stringContaining("verification baseline"),
      },
    });
    expect(validateImprovement).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "VALIDATOR_JSON",
        prompt: expect.stringContaining("no new or worsened failure"),
      },
    });
    expect(workYieldAnalysis).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "TRANSFORM_JSON",
        deterministicTransform: {
          type: "repository-work-yield",
          baselineBlockId: "git-snapshot-before",
          currentBlockId: "git-diff-summary",
          scopeGuardBlockId: "scope-change-guard",
          workItemBlockId: "select-improvement-task",
          trackPrevious: true,
        },
      },
    });
    if (
      workYieldAnalysis?.type !== "UTILITY" ||
      workYieldAnalysis.utility.type !== "TRANSFORM_JSON"
    ) {
      throw new Error("Expected code work-yield analysis transform.");
    }
    const createYieldContext = (
      signature: string,
      prior?: Record<string, unknown>,
    ): Map<string, unknown> =>
      new Map<string, unknown>([
        [
          "git-snapshot-before",
          {
            data: {
              head: "head-one",
              files: [{ path: "src/a.ts", signature: "before" }],
            },
          },
        ],
        [
          "git-diff-summary",
          {
            data: {
              head: "head-one",
              files: [{ path: "src/a.ts", signature }],
            },
          },
        ],
        [
          "select-improvement-task",
          {
            data: {
              path: ".machdoch/tasks.json",
              jsonPath: "tasks",
              taskIds: ["task-1"],
            },
          },
        ],
        ["scope-change-guard", { output: "IN_SCOPE" }],
        ...(prior
          ? ([["work-yield-analysis", { data: { output: prior } }]] as Array<
              [string, unknown]
            >)
          : []),
      ]);
    const firstYield = evaluateStarterTransformWithContext(
      workYieldAnalysis,
      createYieldContext("after-one"),
    );
    const repairedYield = evaluateStarterTransformWithContext(
      workYieldAnalysis,
      createYieldContext("after-two", firstYield),
    );
    const unchangedYield = evaluateStarterTransformWithContext(
      workYieldAnalysis,
      createYieldContext("after-two", repairedYield),
    );

    expect(firstYield).toMatchObject({
      changedFiles: ["src/a.ts"],
      madeProgress: true,
    });
    expect(repairedYield).toMatchObject({
      changedFiles: ["src/a.ts"],
      madeProgress: true,
    });
    expect(repairedYield.repositoryFingerprint).not.toBe(
      firstYield.repositoryFingerprint,
    );
    expect(unchangedYield).toMatchObject({ madeProgress: false });
    expect(usefulWorkProduced).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "CONDITION",
        condition: {
          style: "json-path",
          path: "lastData.output.usefulWorkProduced",
          operator: "equals",
          value: "true",
        },
      },
    });
    expect(finalScanCounter).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "LOOP_COUNTER",
        maxAttempts: "{{maxFinalValidationScans:number=3}}",
      },
    });
    expect(flow?.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "has-actionable-improvement",
          fromOutput: "NO_MATCH",
          to: "selection-is-deferred",
        }),
        expect.objectContaining({
          from: "archive-active-improvement",
          fromOutput: "SUCCESS",
          to: "final-report",
        }),
        expect.objectContaining({
          from: "git-snapshot-before",
          to: "select-verification-command",
        }),
        expect.objectContaining({
          from: "select-verification-command",
          fromOutput: "SUCCESS",
          to: "baseline-verification",
        }),
        expect.objectContaining({
          from: "implement-improvement",
          fromOutput: "SUCCESS",
          to: "mark-improvement-task-verifying",
        }),
        expect.objectContaining({
          from: "baseline-verification",
          fromOutput: "SUCCESS",
          to: "count-improvement-pass",
        }),
        expect.objectContaining({
          from: "count-improvement-pass",
          fromOutput: "CONTINUE",
          to: "implement-improvement",
        }),
        expect.objectContaining({
          from: "count-improvement-pass",
          fromOutput: "LIMIT_REACHED",
          to: "mark-improvement-task-deferred",
        }),
        expect.objectContaining({
          from: "count-verification-repair",
          fromOutput: "LIMIT_REACHED",
          to: "mark-improvement-task-deferred",
        }),
        expect.objectContaining({
          from: "validate-improvement",
          fromOutput: "CONTINUE",
          to: "mark-improvement-task-repairing",
        }),
        expect.objectContaining({
          from: "validate-improvement",
          fromOutput: "RETRY",
          to: "mark-improvement-task-repairing",
        }),
        expect.objectContaining({
          from: "useful-work-produced",
          fromOutput: "NO_MATCH",
          to: "mark-improvement-task-deferred",
        }),
        expect.objectContaining({
          from: "review-needs-fix",
          fromOutput: "MATCH",
          to: "mark-improvement-task-repairing",
        }),
        expect.objectContaining({
          from: "count-final-validation-scan",
          fromOutput: "CONTINUE",
          to: "validate-improvement",
        }),
        expect.objectContaining({
          from: "mark-improvement-task-completed",
          fromOutput: "SUCCESS",
          to: "assess-improvement-tasks",
        }),
        expect.objectContaining({
          from: "mark-improvement-task-deferred",
          fromOutput: "SUCCESS",
          to: "assess-improvement-tasks",
        }),
        expect.objectContaining({
          from: "assess-improvement-tasks",
          fromOutput: "COMPLETE",
          to: "read-completed-improvement-plan",
        }),
        expect.objectContaining({
          from: "assess-improvement-tasks",
          fromOutput: "BLOCKED",
          to: "mark-invalid-active-scope",
        }),
        expect.objectContaining({
          from: "assess-improvement-tasks",
          fromOutput: "DEFERRED",
          to: "defer-active-plan-scope",
        }),
        expect.objectContaining({
          from: "final-report",
          fromOutput: "SUCCESS",
          to: "scan-scopes",
        }),
        expect.objectContaining({
          from: "final-report",
          fromOutput: "ERROR",
          to: "retained-active-report",
        }),
        expect.objectContaining({
          from: "select-scope",
          fromOutput: "EXHAUSTED",
          to: "record-exhausted-outcome",
        }),
        expect.objectContaining({
          from: "record-exhausted-outcome",
          fromOutput: "SUCCESS",
          to: "completion-report",
        }),
        expect.objectContaining({
          from: "select-scope",
          fromOutput: "DEFERRED",
          to: "record-deferred-outcome",
        }),
        expect.objectContaining({
          from: "append-deferred-improvement-plan",
          fromOutput: "SUCCESS",
          to: "record-scope-deferred-outcome",
        }),
      ]),
    );
    expect(flow?.edges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "archive-active-improvement",
          to: "read-completed-improvements",
        }),
      ]),
    );
    expect(JSON.stringify(flow)).toContain("CHANGE_SCOPE_GUARD");
    expect(JSON.stringify(flow)).not.toContain(
      "archive-superseded-improvement",
    );
    expect(JSON.stringify(flow)).not.toContain("selectedCandidate");
    expect(independentReview).toMatchObject({
      utility: {
        prompt: expect.stringContaining("Review selected task"),
      },
    });
    expect(validateImprovement).toMatchObject({
      utility: {
        prompt: expect.stringContaining("Ignore unrelated workspace changes"),
      },
    });
  });

  it("continues code improvements until scope selection is exhausted", () => {
    const flow = getRalphStarterFlow("autonomous-code-improvement-loop")!.flow;

    expect(flow.blocks.some((block) => block.id === "scope-exhausted")).toBe(
      false,
    );
    expect(flow.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "final-report",
          fromOutput: "SUCCESS",
          to: "scan-scopes",
        }),
        expect.objectContaining({
          from: "select-scope",
          fromOutput: "EXHAUSTED",
          to: "record-exhausted-outcome",
        }),
        expect.objectContaining({
          from: "select-scope",
          fromOutput: "DEFERRED",
          to: "record-deferred-outcome",
        }),
        expect.objectContaining({
          from: "completion-report",
          fromOutput: "SUCCESS",
          to: "success",
        }),
      ]),
    );
  });

  it("keeps bundled git-diff validators tolerant of shared workspace changes", () => {
    const scopeGuardedStarterIds = new Set([
      "autonomous-code-improvement-loop",
      "autonomous-ui-improvement-loop",
      "autonomous-refactoring-flow",
      "security-fix-loop",
    ]);

    for (const starterFlow of STARTER_RALPH_FLOWS) {
      const serializedFlow = JSON.stringify(starterFlow.flow);

      if (scopeGuardedStarterIds.has(starterFlow.id)) {
        expect(serializedFlow).toContain("CHANGE_SCOPE_GUARD");
        expect(serializedFlow).toContain("scope-change-guard");
      }
      for (const block of starterFlow.flow.blocks) {
        if (
          block.type === "UTILITY" &&
          block.utility.type === "GIT_DIFF_SUMMARY"
        ) {
          expect(block.utility.baseline).toBeUndefined();
        }
      }

      if (serializedFlow.includes("{{result:git-diff-summary}}")) {
        expect(serializedFlow.toLowerCase()).toContain(
          "ignore unrelated workspace changes",
        );
      }
    }
  });

  it("defaults starter flows to online content enrichment with explicit web-search guidance", () => {
    const researchBlocks = [
      {
        starterFlowId: "security-fix-loop",
        minimumVersion: 6,
        researchBlockId: "security-research",
      },
      {
        starterFlowId: "autonomous-refactoring-flow",
        minimumVersion: 8,
        researchBlockId: "refactor-research",
      },
      {
        starterFlowId: "full-feature-implementation",
        minimumVersion: 7,
        researchBlockId: "initial-research",
      },
      {
        starterFlowId: "autonomous-feature-generation-loop",
        minimumVersion: 7,
        researchBlockId: "research-inspiration",
      },
      {
        starterFlowId: "autonomous-code-improvement-loop",
        minimumVersion: 8,
        researchBlockId: "improvement-research",
      },
      {
        starterFlowId: "autonomous-ui-improvement-loop",
        minimumVersion: 2,
        researchBlockId: "ui-research",
      },
    ] as const;

    for (const {
      starterFlowId,
      minimumVersion,
      researchBlockId,
    } of researchBlocks) {
      const starterFlow = getRalphStarterFlow(starterFlowId);
      const flow = starterFlow?.flow;
      const enableOnlineResearch = flow?.variables?.find(
        (variable) => variable.name === "enableOnlineResearch",
      );
      const researchBlock = flow?.blocks.find(
        (block) => block.id === researchBlockId,
      );
      const serializedResearchBlock = JSON.stringify(researchBlock);

      expect(starterFlow?.version).toBeGreaterThanOrEqual(minimumVersion);
      expect(enableOnlineResearch).toMatchObject({
        type: "boolean",
        default: "true",
      });
      expect(researchBlock).toMatchObject({
        settings: {
          webAccess: true,
        },
      });
      expect(serializedResearchBlock).toContain("search_web");
      expect(serializedResearchBlock).toContain("fetch_url");
      expect(serializedResearchBlock).toContain("source links");
      expect(serializedResearchBlock.toLowerCase()).toContain("official");
      expect(serializedResearchBlock.toLowerCase()).toContain(
        "if web search is unavailable",
      );
    }
  });

  it("starts bundled templates autonomously without ask-user gates", () => {
    const expectedStartTargets: Record<string, string> = {
      "autonomous-feature-generation-loop": "detect-project-commands",
      "autonomous-code-improvement-loop": "find-active-improvement",
      "autonomous-ui-improvement-loop": "begin-scope-cycle",
      "full-feature-implementation": "detect-project-commands",
      "autonomous-refactoring-flow": "begin-scope-cycle",
      "security-fix-loop": "begin-scope-cycle",
    };

    for (const starterFlow of STARTER_RALPH_FLOWS) {
      expect(
        starterFlow.flow.blocks.some((block) => block.type === "ASK_USER"),
      ).toBe(false);
      expect(
        starterFlow.flow.blocks.some(
          (block) => block.id === "configure-template",
        ),
      ).toBe(false);
      expect(JSON.stringify(starterFlow.flow.edges)).not.toContain(
        "configure-template",
      );
      expect(starterFlow.flow.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: "start",
            to: expectedStartTargets[starterFlow.id],
          }),
        ]),
      );

      for (const variable of starterFlow.flow.variables ?? []) {
        expect(variable.name).toMatch(/^[a-z][A-Za-z0-9]*$/u);
      }

      const verificationVariable = starterFlow.flow.variables?.find(
        (variable) => variable.name === "verificationCommand",
      );

      if (verificationVariable) {
        expect(verificationVariable.default).toBe("");
      }

      expect(
        starterFlow.flow.blocks.some((block) => block.type === "DECISION"),
      ).toBe(false);
      expect(JSON.stringify(starterFlow.flow)).not.toContain("HUMAN_APPROVAL");
    }

    const featureFlow = getRalphStarterFlow(
      "full-feature-implementation",
    )?.flow;
    const featureRequest = featureFlow?.variables?.find(
      (variable) => variable.name === "featureRequest",
    );

    expect(featureRequest).toMatchObject({
      required: false,
      default: expect.stringContaining("Autonomously identify"),
    });
    expect(
      featureFlow?.blocks.some((block) => block.type === "INTERVIEW"),
    ).toBe(false);
  });

  it("creates import copies with caller-owned identity and timestamps", () => {
    const starterFlow = getRalphStarterFlow("full-feature-implementation");

    expect(starterFlow).toBeTruthy();

    const importedAt = "2026-06-24T12:00:00.000Z";
    const imported = createImportedRalphStarterFlow(starterFlow!, {
      id: "imported-flow-id",
      alias: "feature-workflow",
      importedAt,
    });

    expect(imported).toMatchObject({
      id: "imported-flow-id",
      alias: "feature-workflow",
      createdAt: importedAt,
      updatedAt: importedAt,
      source: {
        kind: "starter",
        id: "full-feature-implementation",
        version: starterFlow!.version,
        importedAt,
      },
      name: "Feature Implementation Checklist Loop",
    });
    expect(imported.id).not.toBe(starterFlow!.flow.id);
    expect(starterFlow!.flow.alias).toBe(
      "feature-implementation-checklist-loop",
    );
    expect(validateRalphFlow(imported).valid).toBe(true);
  });

  it("hardens every model-backed starter block with finite retry and strict schemas", () => {
    const assertStrictObjectSchemas = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(assertStrictObjectSchemas);
        return;
      }
      if (typeof value !== "object" || value === null) {
        return;
      }

      const record = value as Record<string, unknown>;
      const properties = record.properties;
      if (
        record.type === "object" &&
        typeof properties === "object" &&
        properties !== null &&
        Object.keys(properties).length > 0
      ) {
        expect(record.additionalProperties).toBe(false);
      }
      Object.values(record).forEach(assertStrictObjectSchemas);
    };

    for (const starterFlow of STARTER_RALPH_FLOWS) {
      for (const block of starterFlow.flow.blocks) {
        const isModelBacked =
          block.type === "PROMPT" ||
          block.type === "VALIDATOR" ||
          block.type === "DECISION" ||
          block.type === "INTERVIEW" ||
          (block.type === "UTILITY" &&
            (block.utility.type === "PROMPT_JSON" ||
              block.utility.type === "VALIDATOR_JSON"));

        if (isModelBacked) {
          expect(block.settings?.retry).toEqual({
            mode: "finite",
            maxRetries: 2,
            delaySeconds: 2,
          });
        }
        if (
          block.type === "UTILITY" &&
          (block.utility.type === "PROMPT_JSON" ||
            block.utility.type === "VALIDATOR_JSON") &&
          block.utility.schema
        ) {
          assertStrictObjectSchemas(block.utility.schema);
        }
      }
    }
  });

  it("uses one executor pass and one canonical validator contract in every starter", () => {
    const validDecision = {
      decision: "DONE",
      confidence: 0.95,
      summary: "Verified.",
      evidence: ["Checks passed."],
      remainingWork: [],
    } as const;
    expect(parseRalphValidatorJsonResult(validDecision)).toEqual(validDecision);

    for (const starterFlow of STARTER_RALPH_FLOWS) {
      const promptBlocks = starterFlow.flow.blocks.filter(
        (block) => block.type === "PROMPT",
      );
      expect(promptBlocks.length).toBeGreaterThan(0);
      expect(
        promptBlocks.every((block) => block.settings?.maxIterations === 1),
      ).toBe(true);

      const validators = starterFlow.flow.blocks.filter(
        (block): block is RalphUtilityBlock =>
          block.type === "UTILITY" && block.utility.type === "VALIDATOR_JSON",
      );
      expect(validators).toHaveLength(1);
      expect(validators[0]?.utility.schema).toEqual(
        RALPH_VALIDATOR_JSON_SCHEMA,
      );
      expect(
        starterFlow.flow.edges
          .filter((edge) => edge.from === validators[0]?.id)
          .map((edge) => edge.fromOutput),
      ).toEqual(
        expect.arrayContaining([
          "DONE",
          "CONTINUE",
          "RETRY",
          "ERROR",
          "INVALID",
        ]),
      );
    }
  });

  it("routes scope orchestration errors to retained terminal reports", () => {
    for (const starterFlowId of [
      "autonomous-code-improvement-loop",
      "autonomous-ui-improvement-loop",
      "autonomous-refactoring-flow",
      "security-fix-loop",
    ]) {
      const flow = getRalphStarterFlow(starterFlowId)?.flow;
      if (!flow) {
        throw new Error(`Missing starter ${starterFlowId}.`);
      }
      const retainedReport = flow.blocks.find(
        (block) =>
          block.type === "UTILITY" &&
          block.utility.type === "FINAL_REPORT" &&
          block.id.startsWith("retained-"),
      );
      expect(retainedReport).toBeDefined();

      for (const block of flow.blocks) {
        const isScopeInfrastructure =
          block.type === "UTILITY" &&
          (block.utility.type === "SCAN_SCOPE_EVIDENCE" ||
            block.utility.type === "UPDATE_SCOPE_REGISTRY" ||
            block.utility.type === "SELECT_SCOPE" ||
            block.id === "scope-cycle-complete");
        if (!isScopeInfrastructure) {
          continue;
        }
        const errorEdge = flow.edges.find(
          (edge) => edge.from === block.id && edge.fromOutput === "ERROR",
        );
        expect(errorEdge?.to).toBe(
          starterFlowId === "autonomous-code-improvement-loop"
            ? "record-invalid-outcome"
            : retainedReport?.id,
        );
      }
      if (starterFlowId === "autonomous-code-improvement-loop") {
        expect(flow.edges).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              from: "record-invalid-outcome",
              fromOutput: "SUCCESS",
              to: retainedReport?.id,
            }),
          ]),
        );
      }
    }
  });

  it("defines every data-bearing object and uses full-or-empty candidate branches", () => {
    const assertNoUnintendedBareObjects = (
      value: unknown,
      path: string[] = [],
    ): void => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) =>
          assertNoUnintendedBareObjects(entry, [...path, String(index)]),
        );
        return;
      }
      if (typeof value !== "object" || value === null) {
        return;
      }

      const record = value as Record<string, unknown>;
      if (record.type === "object") {
        expect(record.properties).toEqual(expect.any(Object));
        const propertyCount = Object.keys(
          record.properties as Record<string, unknown>,
        ).length;
        if (propertyCount === 0) {
          expect(path.join(".")).toMatch(/selectedCandidate\.anyOf\.1$/u);
          expect(record.additionalProperties).toBe(false);
        }
      }

      Object.entries(record).forEach(([key, entry]) =>
        assertNoUnintendedBareObjects(entry, [...path, key]),
      );
    };

    for (const starterFlow of STARTER_RALPH_FLOWS) {
      for (const block of starterFlow.flow.blocks) {
        if (
          block.type === "UTILITY" &&
          (block.utility.type === "PROMPT_JSON" ||
            block.utility.type === "VALIDATOR_JSON") &&
          block.utility.schema
        ) {
          assertNoUnintendedBareObjects(block.utility.schema);
        }
      }
    }

    for (const { starterId, chooserId } of [
      {
        starterId: "autonomous-ui-improvement-loop",
        chooserId: "choose-ui-improvement",
      },
    ] as const) {
      const chooser = getRalphStarterFlow(starterId)?.flow.blocks.find(
        (block) => block.id === chooserId,
      );
      expect(chooser).toMatchObject({
        type: "UTILITY",
        utility: { type: "PROMPT_JSON" },
      });
      if (
        chooser?.type !== "UTILITY" ||
        chooser.utility.type !== "PROMPT_JSON"
      ) {
        continue;
      }

      const schema = chooser.utility.schema as Record<string, unknown>;
      const properties = schema.properties as Record<string, unknown>;
      const selectedCandidate = properties.selectedCandidate as Record<
        string,
        unknown
      >;
      const branches = selectedCandidate.anyOf as Record<string, unknown>[];
      const fullBranch = branches[0]!;
      const emptyBranch = branches[1]!;
      const fullProperties = fullBranch.properties as Record<string, unknown>;

      expect(branches).toHaveLength(2);
      expect(fullBranch.additionalProperties).toBe(false);
      expect((fullBranch.required as string[]).sort()).toEqual(
        Object.keys(fullProperties).sort(),
      );
      expect(emptyBranch).toMatchObject({
        type: "object",
        properties: {},
        additionalProperties: false,
      });
    }

    const codeChooser = getRalphStarterFlow(
      "autonomous-code-improvement-loop",
    )?.flow.blocks.find((block) => block.id === "choose-improvement");
    if (
      codeChooser?.type !== "UTILITY" ||
      codeChooser.utility.type !== "PROMPT_JSON"
    ) {
      throw new Error("Expected persistent code improvement planner.");
    }
    const codeSchema = codeChooser.utility.schema as {
      properties?: {
        tasks?: {
          items?: {
            properties?: Record<string, unknown>;
            required?: string[];
            additionalProperties?: boolean;
          };
        };
      };
    };
    const taskSchema = codeSchema.properties?.tasks?.items;

    expect(taskSchema?.additionalProperties).toBe(false);
    expect([...(taskSchema?.required ?? [])].sort()).toEqual(
      Object.keys(taskSchema?.properties ?? {}).sort(),
    );
  });

  it("configures unattended recovery, graceful deferral, and bounded repair", () => {
    expect(STARTER_RALPH_FLOWS.map((starter) => starter.id)).toEqual([
      "autonomous-feature-generation-loop",
      "autonomous-code-improvement-loop",
      "autonomous-ui-improvement-loop",
      "autonomous-refactoring-flow",
      "full-feature-implementation",
      "security-fix-loop",
    ]);
    expect(STARTER_RALPH_FLOWS.at(-1)?.tags).toContain("optional");

    for (const starterFlow of STARTER_RALPH_FLOWS) {
      const autonomy = starterFlow.flow.settings?.autonomy;
      expect(autonomy).toMatchObject({
        recoverFailedEnd: true,
        maxRecoveryAttempts: 3,
        transitionExhaustion: "checkpoint",
        recoveryExhaustion: "defer",
      });
      expect(typeof autonomy).toBe("object");
      if (typeof autonomy !== "object" || autonomy === null) {
        continue;
      }

      const deferBlock = starterFlow.flow.blocks.find(
        (block) => block.id === autonomy.deferToBlockId,
      );
      expect(deferBlock).toBeTruthy();
      expect(deferBlock?.type).not.toBe("START");
      expect(deferBlock?.type).not.toBe("END");
    }

    for (const starterFlowId of [
      "autonomous-code-improvement-loop",
      "autonomous-ui-improvement-loop",
      "autonomous-refactoring-flow",
    ]) {
      const flow = getRalphStarterFlow(starterFlowId)?.flow;
      expect(
        flow?.blocks.find((block) => block.id === "count-verification-repair"),
      ).toMatchObject({
        type: "UTILITY",
        utility: {
          type: "LOOP_COUNTER",
          maxAttempts:
            starterFlowId === "autonomous-code-improvement-loop"
              ? "{{maxVerificationRepairPasses:number=4}}"
              : starterFlowId === "autonomous-ui-improvement-loop"
                ? "{{maxVerificationRepairPasses:number=3}}"
                : "{{maxVerificationRepairPasses:number=2}}",
        },
      });
      expect(flow?.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: "count-verification-repair",
            fromOutput: "LIMIT_REACHED",
            to:
              starterFlowId === "autonomous-code-improvement-loop"
                ? "mark-improvement-task-deferred"
                : "defer-scope",
          }),
        ]),
      );
    }
  });

  it("continues code improvements across selected packages", () => {
    const flow = getRalphStarterFlow("autonomous-code-improvement-loop")!.flow;

    expect(
      flow.blocks.some((block) => block.id === "scope-cycle-complete"),
    ).toBe(false);
    expect(
      flow.blocks
        .filter((block) => block.settings?.maxIterations !== undefined)
        .every((block) => block.type === "PROMPT"),
    ).toBe(true);
    expect(flow.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "final-report",
          fromOutput: "SUCCESS",
          to: "scan-scopes",
        }),
        expect.objectContaining({
          from: "mark-improvement-task-deferred",
          fromOutput: "SUCCESS",
          to: "assess-improvement-tasks",
        }),
        expect.objectContaining({
          from: "mark-improvement-task-completed",
          fromOutput: "SUCCESS",
          to: "assess-improvement-tasks",
        }),
      ]),
    );
    expect(
      flow.edges.some(
        (edge) =>
          edge.from === "final-report" &&
          edge.fromOutput === "SUCCESS" &&
          edge.to === "success",
      ),
    ).toBe(false);
  });

  it("continues repository refactoring across selected packages", () => {
    const flow = getRalphStarterFlow("autonomous-refactoring-flow")!.flow;

    expect(
      flow.blocks.some((block) => block.id === "scope-cycle-complete"),
    ).toBe(false);
    expect(
      flow.blocks
        .filter((block) => block.settings?.maxIterations !== undefined)
        .every((block) => block.type === "PROMPT"),
    ).toBe(true);
    expect(flow.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "final-report",
          fromOutput: "SUCCESS",
          to: "scan-scopes",
        }),
        expect.objectContaining({
          from: "record-done-outcome",
          fromOutput: "SUCCESS",
          to: "final-report",
        }),
        expect.objectContaining({
          from: "select-scope",
          fromOutput: "EXHAUSTED",
          to: "record-exhausted-outcome",
        }),
        expect.objectContaining({
          from: "completion-report",
          fromOutput: "SUCCESS",
          to: "success",
        }),
        expect.objectContaining({
          from: "final-report",
          fromOutput: "ERROR",
          to: "retained-outcome-report",
        }),
      ]),
    );
    expect(flow.edges.filter((edge) => edge.to === "select-scope")).toEqual([
      expect.objectContaining({
        from: "update-scope-registry",
        fromOutput: "SUCCESS",
      }),
    ]);
  });

  it("re-audits work-bearing scopes before declaring coverage complete", () => {
    const uiFlow = getRalphStarterFlow("autonomous-ui-improvement-loop")!.flow;
    expect(
      uiFlow.blocks.some((block) => block.id === "mark-scope-result"),
    ).toBe(false);
    expect(uiFlow.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "append-completed-ui-improvement",
          fromOutput: "SUCCESS",
          to: "record-done-outcome",
        }),
        expect.objectContaining({
          from: "record-done-outcome",
          fromOutput: "SUCCESS",
          to: "archive-active-ui-improvement",
        }),
        expect.objectContaining({
          from: "final-report",
          fromOutput: "SUCCESS",
          to: "scan-ui-scopes",
        }),
      ]),
    );

    const refactorFlow = getRalphStarterFlow(
      "autonomous-refactoring-flow",
    )!.flow;
    expect(
      refactorFlow.blocks.some((block) => block.id === "mark-scope-result"),
    ).toBe(false);
    expect(refactorFlow.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "record-selected-refactor",
          fromOutput: "SUCCESS",
          to: "git-snapshot-before",
        }),
        expect.objectContaining({
          from: "final-refactor-scan",
          fromOutput: "DONE",
          to: "record-done-outcome",
        }),
        expect.objectContaining({
          from: "final-report",
          fromOutput: "SUCCESS",
          to: "scan-scopes",
        }),
      ]),
    );

    const securityFlow = getRalphStarterFlow("security-fix-loop")!.flow;
    expect(securityFlow.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "findings-present",
          fromOutput: "MATCH",
          to: "record-security-findings",
        }),
        expect.objectContaining({
          from: "verify-stop-condition",
          fromOutput: "DONE",
          to: "record-done-outcome",
        }),
        expect.objectContaining({
          from: "findings-present",
          fromOutput: "NO_MATCH",
          to: "mark-scope-result",
        }),
        expect.objectContaining({
          from: "mark-scope-result",
          fromOutput: "SUCCESS",
          to: "record-stop-outcome",
        }),
        expect.objectContaining({
          from: "final-report",
          fromOutput: "SUCCESS",
          to: "scan-scopes",
        }),
      ]),
    );
  });

  it("keeps the checklist one-shot while iterative starters advance", () => {
    const checklistFlow = getRalphStarterFlow(
      "full-feature-implementation",
    )!.flow;
    expect(
      checklistFlow.blocks.some(
        (block) =>
          block.type === "UTILITY" &&
          ["BEGIN_SCOPE_CYCLE", "SELECT_SCOPE"].includes(block.utility.type),
      ),
    ).toBe(false);
    expect(checklistFlow.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "mark-tasks-deferred",
          fromOutput: "SUCCESS",
          to: "assess-checklist-tasks",
        }),
        expect.objectContaining({
          from: "record-deferred-outcome",
          fromOutput: "SUCCESS",
          to: "retained-checklist-report",
        }),
      ]),
    );
    expect(
      checklistFlow.edges.some(
        (edge) =>
          edge.from === "final-report" && edge.to === "prepare-feature-brief",
      ),
    ).toBe(false);

    const generationFlow = getRalphStarterFlow(
      "autonomous-feature-generation-loop",
    )!.flow;
    expect(generationFlow.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "record-deferred-goal-outcome",
          fromOutput: "SUCCESS",
          to: "archive-goal",
        }),
        expect.objectContaining({
          from: "record-blocked-goal-outcome",
          fromOutput: "SUCCESS",
          to: "archive-goal",
        }),
        expect.objectContaining({
          from: "final-report",
          fromOutput: "SUCCESS",
          to: "goals-per-run-counter",
        }),
        expect.objectContaining({
          from: "record-goal-portfolio-deferred-outcome",
          fromOutput: "SUCCESS",
          to: "retained-goal-report",
        }),
      ]),
    );
  });

  it("uses run-scoped transient artifacts and bounded durable history", () => {
    const transientVariableNames = new Set([
      "projectCommandsFile",
      "scopeAnalysisFile",
      "candidateFile",
      "reviewFile",
      "conventionsFile",
      "refactorPlanFile",
      "securityReviewFile",
      "gitSnapshotFile",
      "gitDiffFile",
      "autonomousReportFile",
      "autonomousReportMarkdown",
      "improvementReportFile",
      "improvementReportMarkdown",
      "uiReportFile",
      "uiReportMarkdown",
      "refactorReportFile",
      "refactorReportMarkdown",
      "securityReportFile",
      "securityReportMarkdown",
      "featureReportFile",
      "featureReportMarkdown",
    ]);

    for (const starterFlow of STARTER_RALPH_FLOWS) {
      for (const variable of starterFlow.flow.variables ?? []) {
        if (transientVariableNames.has(variable.name)) {
          expect(variable.default).toMatch(/^\{\{run:artifactRoot\}\}\//u);
        }
      }
      for (const block of starterFlow.flow.blocks) {
        if (block.type === "UTILITY" && block.utility.type === "QUERY_JSONL") {
          expect(block.utility.maxResults).toBeGreaterThan(0);
          expect(block.utility.maxResults).toBeLessThanOrEqual(50);
        }
      }
    }
  });

  it("researches provisional portfolios before final code and refactor selection", () => {
    const expectations = [
      {
        id: "autonomous-code-improvement-loop",
        propose: "propose-improvements",
        research: "improvement-research",
        refine: "choose-improvement",
      },
      {
        id: "autonomous-refactoring-flow",
        propose: "propose-refactor-packages",
        research: "refactor-research",
        refine: "audit-against-policy",
      },
    ] as const;

    for (const expectation of expectations) {
      const flow = getRalphStarterFlow(expectation.id)?.flow;
      expect(
        flow?.blocks.find((block) => block.id === expectation.propose),
      ).toMatchObject({ type: "UTILITY", utility: { type: "PROMPT_JSON" } });
      expect(flow?.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: expectation.research,
            fromOutput: "SUCCESS",
            to: expectation.refine,
          }),
        ]),
      );
    }
  });

  it("routes verification from exact enum fields and fails malformed state closed", () => {
    const cases = [
      {
        flowId: "autonomous-code-improvement-loop",
        transformBlockId: "select-verification-command",
        sourceBlockId: "select-improvement-task",
        sourceIsData: true,
        createOutput: (
          verificationTier: string,
          reviewTier: string,
        ): Record<string, unknown> => ({
          tasks: [
            {
              verificationTier,
              reviewTier,
              riskAssessment:
                'Quoted incidental prose: "database migration secret API".',
            },
          ],
        }),
      },
      {
        flowId: "autonomous-ui-improvement-loop",
        transformBlockId: "select-verification-command",
        sourceBlockId: "choose-ui-improvement",
        sourceIsData: false,
        createOutput: (
          verificationTier: string,
          reviewTier: string,
        ): Record<string, unknown> => ({
          selectedCandidate: {
            verificationTier,
            reviewTier,
            visualReviewPlan: [
              'Negated prose: "do not treat accessibility routing as authority".',
            ],
          },
        }),
      },
      {
        flowId: "autonomous-refactoring-flow",
        transformBlockId: "select-validation-command",
        sourceBlockId: "audit-against-policy",
        sourceIsData: false,
        createOutput: (
          verificationTier: string,
          reviewTier: string,
        ): Record<string, unknown> => ({
          verificationTier,
          reviewTier,
          risks: ['Adversarial prose: "security token schema broad strict".'],
        }),
      },
    ] as const;

    for (const testCase of cases) {
      const block = getRalphStarterFlow(testCase.flowId)?.flow.blocks.find(
        (candidate): candidate is RalphUtilityBlock =>
          candidate.id === testCase.transformBlockId &&
          candidate.type === "UTILITY",
      );

      if (!block) {
        throw new Error(`Expected ${testCase.transformBlockId} utility block.`);
      }

      expect(
        evaluateStarterTransform(
          block,
          testCase.sourceBlockId,
          testCase.createOutput("focused", "validator-only"),
          testCase.sourceIsData
            ? testCase.createOutput("focused", "validator-only")
            : undefined,
        ),
      ).toMatchObject({
        tier: "focused",
        command: "focused-check",
        reviewTier: "validator-only",
        protocolValid: true,
      });
      expect(
        evaluateStarterTransform(
          block,
          testCase.sourceBlockId,
          testCase.createOutput("FOCUSED", "trusted"),
          testCase.sourceIsData
            ? testCase.createOutput("FOCUSED", "trusted")
            : undefined,
        ),
      ).toMatchObject({
        tier: "broad",
        command: "broad-check",
        reviewTier: "strict",
        protocolValid: false,
      });
      expect(block.utility.deterministicTransform).toMatchObject({
        type: "verification-command",
        selectionBlockId: testCase.sourceBlockId,
      });
      expect(JSON.stringify(block.utility.deterministicTransform)).not.toMatch(
        /security|secret|migration/u,
      );
    }
  });

  it("keeps strict portfolio task schemas aligned with the planning prompts", () => {
    const expectations = [
      {
        flowId: "autonomous-code-improvement-loop",
        blockId: "choose-improvement",
        fields: [
          "id",
          "title",
          "status",
          "batchKey",
          "dependencies",
          "likelyFiles",
          "priority",
          "evidence",
          "value",
          "currentBehavior",
          "proposedBehavior",
          "acceptanceCriteria",
          "verificationPlan",
          "verificationTier",
          "reviewTier",
          "rollbackNotes",
        ],
      },
    ] as const;

    for (const expectation of expectations) {
      const block = getRalphStarterFlow(expectation.flowId)?.flow.blocks.find(
        (candidate) => candidate.id === expectation.blockId,
      );
      expect(block).toMatchObject({
        type: "UTILITY",
        utility: { type: "PROMPT_JSON" },
      });
      if (
        !block ||
        block.type !== "UTILITY" ||
        block.utility.type !== "PROMPT_JSON"
      ) {
        throw new Error(`Expected ${expectation.blockId} PROMPT_JSON block.`);
      }

      const schema = block.utility.schema as
        | {
            properties?: {
              tasks?: {
                items?: {
                  properties?: Record<string, unknown>;
                  required?: string[];
                  additionalProperties?: boolean;
                };
              };
            };
          }
        | undefined;
      const task = schema?.properties?.tasks?.items;
      const properties = task?.properties;
      expect(Object.keys(properties ?? {})).toEqual(
        expect.arrayContaining([...expectation.fields]),
      );
      expect(task?.additionalProperties).toBe(false);
      expect(task?.required).toEqual(
        expect.arrayContaining([...expectation.fields]),
      );
    }

    const feature = getRalphStarterFlow("full-feature-implementation")?.flow;
    expect(feature?.settings?.autonomy).toMatchObject({
      deferToBlockId: "record-deferred-outcome",
    });
    expect(feature?.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "record-deferred-outcome",
          fromOutput: "SUCCESS",
          to: "retained-checklist-report",
        }),
      ]),
    );
  });

  it("reports autonomy readiness and performs three-way starter upgrades", () => {
    const featureSummary = createRalphStarterFlowSummary(
      getRalphStarterFlow("full-feature-implementation")!,
    );
    const codeSummary = createRalphStarterFlowSummary(
      getRalphStarterFlow("autonomous-code-improvement-loop")!,
    );

    expect(featureSummary.requiredVariableNames).not.toContain(
      "featureRequest",
    );
    expect(featureSummary.autonomyReady).toBe(true);
    expect(featureSummary.hasHumanInputBlocks).toBe(false);
    expect(codeSummary.autonomyReady).toBe(true);
    expect(codeSummary.hasHumanInputBlocks).toBe(false);
    expect(codeSummary.modelBlockCount).toBeGreaterThan(0);
    expect(codeSummary.runCheckCount).toBeGreaterThan(1);
    expect(codeSummary.capabilities).toContain("unattended");
    expect(codeSummary.capabilities).toContain("persistent-artifacts");

    const starter = getRalphStarterFlow("autonomous-code-improvement-loop")!;
    const imported = createImportedRalphStarterFlow(starter, {
      id: "owned-id",
      alias: "owned-alias",
      importedAt: "2026-07-01T00:00:00.000Z",
    });
    const riskTolerance = imported.variables?.find(
      (variable) => variable.name === "riskTolerance",
    );
    if (riskTolerance) {
      riskTolerance.default = "cautious-user-override";
    }

    const nextStarter = JSON.parse(JSON.stringify(starter)) as RalphStarterFlow;
    nextStarter.version += 1;
    const nextDependencyDefault = nextStarter.flow.variables?.find(
      (variable) => variable.name === "allowDependencyChanges",
    );
    if (nextDependencyDefault) {
      nextDependencyDefault.default = "false";
    }

    const upgraded = createUpgradedRalphStarterFlowWithReport(
      imported,
      nextStarter,
      "2026-07-10T00:00:00.000Z",
    );

    expect(upgraded.flow).toMatchObject({
      id: "owned-id",
      alias: "owned-alias",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
      source: {
        id: starter.id,
        version: nextStarter.version,
        templateFingerprint: expect.any(String),
        templateVariableDefaults: expect.any(Object),
      },
    });
    expect(
      upgraded.flow.variables?.find(
        (variable) => variable.name === "riskTolerance",
      )?.default,
    ).toBe("cautious-user-override");
    expect(
      upgraded.flow.variables?.find(
        (variable) => variable.name === "allowDependencyChanges",
      )?.default,
    ).toBe("false");
    expect(upgraded.report.preservedVariableDefaultNames).toContain(
      "riskTolerance",
    );
    expect(upgraded.report.applied).toBe(true);
    expect(upgraded.report.adoptedVariableDefaultNames).toContain(
      "allowDependencyChanges",
    );
    expect(upgraded.report.conflicts).toEqual([]);
  });

  it("three-way merges starter upgrades while preserving conflicting local changes", () => {
    const starter = getRalphStarterFlow("autonomous-code-improvement-loop")!;
    const imported = createImportedRalphStarterFlow(starter, {
      id: "customized-id",
      alias: "customized-alias",
      importedAt: "2026-07-01T00:00:00.000Z",
    });
    imported.description = "Locally customized description";

    const nextStarter = JSON.parse(JSON.stringify(starter)) as RalphStarterFlow;
    nextStarter.version += 1;
    nextStarter.flow.description = "Updated starter description";

    const upgraded = createUpgradedRalphStarterFlowWithReport(
      imported,
      nextStarter,
      "2026-07-10T00:00:00.000Z",
    );

    expect(upgraded.report.applied).toBe(true);
    expect(upgraded.report.conflicts).toEqual([
      expect.stringContaining("description"),
    ]);
    expect(upgraded.flow.description).toBe("Locally customized description");
    expect(upgraded.flow.id).toBe(imported.id);
    expect(upgraded.flow.alias).toBe(imported.alias);
    expect(upgraded.flow.source?.version).toBe(nextStarter.version);
  });
});
