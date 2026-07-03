import { describe, expect, it } from "vitest";
import {
  STARTER_RALPH_FLOWS,
  createImportedRalphStarterFlow,
  createRalphStarterFlowSummary,
  getRalphStarterFlow,
} from "./ralph-starter-flows.js";
import {
  discoverRalphFlowVariables,
  hasGraphCycle,
  validateRalphFlow,
  type RalphFlowBlock,
} from "./ralph.js";

describe("Ralph starter flows", () => {
  it("bundles valid starter flows with useful summaries", () => {
    expect(STARTER_RALPH_FLOWS).toHaveLength(6);

    for (const starterFlow of STARTER_RALPH_FLOWS) {
      const validation = validateRalphFlow(starterFlow.flow);
      const summary = createRalphStarterFlowSummary(starterFlow);

      expect(validation.valid).toBe(true);
      expect(starterFlow.version).toBeGreaterThan(0);
      expect(summary.version).toBe(starterFlow.version);
      expect(summary.name).toBe(starterFlow.flow.name);
      expect(summary.defaultAlias).toBe(starterFlow.defaultAlias);
      expect(summary.blockCount).toBeGreaterThan(0);
      expect(summary.edgeCount).toBeGreaterThan(0);
      expect(summary.variableCount).toBe(
        discoverRalphFlowVariables(starterFlow.flow).length,
      );
    }
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

    for (const { starterFlowId, runCheckBlockId, minimumVersion } of scopedFlows) {
      const starterFlow = getRalphStarterFlow(starterFlowId);
      const flow = starterFlow?.flow;
      const detectCommands = flow?.blocks.find(
        (block) => block.id === "detect-project-commands",
      );
      const runCheck = flow?.blocks.find((block) => block.id === runCheckBlockId);

      expect(starterFlow?.version).toBeGreaterThanOrEqual(minimumVersion);
      expect(detectCommands).toMatchObject({
        type: "UTILITY",
        utility: {
          type: "DETECT_PROJECT_COMMANDS",
          rootPath: "{{data:select-scope:scope.paths.0}}",
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

    for (const { starterFlowId, runCheckBlockId, minimumVersion } of featureFlows) {
      const starterFlow = getRalphStarterFlow(starterFlowId);
      const flow = starterFlow?.flow;
      const detectCommands = flow?.blocks.find(
        (block) => block.id === "detect-project-commands",
      );
      const runCheck = flow?.blocks.find((block) => block.id === runCheckBlockId);

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
        starterFlowId: "autonomous-code-improvement-loop",
        variableName: "notesFile",
        expectedPath:
          ".machdoch/ralph/code-improvements/RALPH_CODE_IMPROVEMENT_NOTES.md",
        rootFallback: "path=RALPH_CODE_IMPROVEMENT_NOTES.md",
      },
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

  it("includes an autonomous feature-generation loop with bounded goal selection", () => {
    const starterFlow = getRalphStarterFlow("autonomous-feature-generation-loop");
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
    const hasActionableGoal = flow?.blocks.find(
      (block) => block.id === "has-actionable-goal",
    );
    const runVerification = flow?.blocks.find(
      (block) => block.id === "run-verification",
    );

    expect(starterFlow?.defaultAlias).toBe("autonomous-feature-generation-loop");
    expect(starterFlow?.version).toBeGreaterThanOrEqual(7);
    expect(flow).toMatchObject({
      name: "Autonomous Feature Generation Loop",
      settings: { maxTransitions: 500 },
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
      utility: { type: "READ_JSONL" },
    });
    expect(hasActionableGoal).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "CONDITION",
        condition: {
          expression: expect.stringContaining("no_action"),
        },
      },
    });
    expect(passCounter).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "LOOP_COUNTER",
        counterName: expect.stringContaining(
          "{{data:select-next-task:task.id}}",
        ),
        maxAttempts: "{{maxImplementationPasses:number=10}}",
      },
    });
    expect(implementFeature).toMatchObject({
      type: "PROMPT",
      prompt: expect.stringContaining("{{result:validate-goal}}"),
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
          to: "understand-project",
        }),
        expect.objectContaining({
          from: "improve-feature-goal",
          to: "has-actionable-goal",
        }),
        expect.objectContaining({
          from: "has-actionable-goal",
          fromOutput: "NO_MATCH",
          to: "success",
        }),
        expect.objectContaining({
          from: "git-snapshot-before",
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
          to: "blocked",
        }),
        expect.objectContaining({
          from: "goals-per-run-counter",
          to: "detect-project-commands",
        }),
        expect.objectContaining({
          from: "goals-per-run-counter",
          fromOutput: "LIMIT_REACHED",
          to: "success",
        }),
      ]),
    );

    const endBlocks = (flow?.blocks ?? []).filter(
      (block: RalphFlowBlock) => block.type === "END",
    );

    expect(endBlocks.map((block) => block.id).sort()).toEqual([
      "blocked",
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
    const enableInterview = flow?.variables?.find(
      (variable) => variable.name === "enableInterview",
    );
    const runConfiguredChecks = flow?.blocks.find(
      (block) => block.id === "run-configured-checks",
    );

    expect(starterFlow?.version).toBeGreaterThanOrEqual(7);
    expect(enableInterview).toMatchObject({
      type: "boolean",
      default: "false",
    });
    expect(passCounter).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "LOOP_COUNTER",
        counterName: expect.stringContaining(
          "{{data:select-next-task:task.id}}",
        ),
        maxAttempts: "{{maxImplementationPasses:number=8}}",
      },
    });
    expect(implementFeature).toMatchObject({
      type: "PROMPT",
      prompt: expect.stringContaining("{{result:validate-progress}}"),
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
          to: "blocked",
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
    const blocked = flow?.blocks.find((block) => block.id === "blocked");

    expect(starterFlow?.version).toBeGreaterThanOrEqual(8);
    expect(scopeSelectionStrategy).toMatchObject({
      type: "text",
      default: "priority",
    });
    expect(auditAgainstPolicy).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "PROMPT_JSON",
        prompt: expect.stringContaining("Return passes: []"),
      },
    });
    expect(hasActionableRefactor).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "CONDITION",
        condition: {
          expression: expect.stringContaining("passes.length > 0"),
        },
      },
    });
    expect(passCounter).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "LOOP_COUNTER",
        counterName: expect.stringContaining("{{data:select-scope:scope.id}}"),
        maxAttempts: "{{maxRefactorPasses:number=5}}",
      },
    });
    expect(validationDecision).toMatchObject({
      type: "UTILITY",
      utility: {
        condition: {
          expression: expect.stringContaining("detect-project-commands"),
        },
      },
    });
    expect(runValidation).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "RUN_CHECK",
        fallbackCommand: "{{data:detect-project-commands:verificationCommand}}",
        cwd: "{{data:detect-project-commands:rootPath}}",
        timeoutSeconds: 1800,
      },
    });
    expect(refactorPass).toMatchObject({
      type: "PROMPT",
      settings: {
        timeoutSeconds: 3600,
      },
      prompt: expect.stringContaining("{{result:final-refactor-scan}}"),
    });
    expect(refactorPass).toMatchObject({
      type: "PROMPT",
      prompt: expect.stringContaining("{{result:count-refactor-pass}}"),
    });
    expect(fixValidationFailures).toMatchObject({
      type: "PROMPT",
      settings: {
        timeoutSeconds: 3600,
      },
    });
    expect(finalRefactorScan).toMatchObject({
      type: "VALIDATOR",
      settings: {
        timeoutSeconds: 3600,
      },
      prompt: expect.stringContaining("ignore unrelated workspace changes"),
    });
    expect(flow?.blocks.some((block) => block.id === "change-scope-guard")).toBe(
      false,
    );
    expect(blocked).toMatchObject({ type: "END", status: "failed" });
    expect(flow?.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "audit-against-policy",
          fromOutput: "SUCCESS",
          to: "has-actionable-refactor",
        }),
        expect.objectContaining({
          from: "has-actionable-refactor",
          fromOutput: "MATCH",
          to: "git-snapshot-before",
        }),
        expect.objectContaining({
          from: "has-actionable-refactor",
          fromOutput: "NO_MATCH",
          to: "mark-scope-result",
        }),
        expect.objectContaining({
          from: "git-snapshot-before",
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
          to: "blocked",
        }),
        expect.objectContaining({
          from: "final-refactor-scan",
          fromOutput: "CONTINUE",
          to: "count-refactor-pass",
        }),
        expect.objectContaining({
          from: "git-diff-summary",
          fromOutput: "SUCCESS",
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
        expect.objectContaining({
          to: "change-scope-guard",
        }),
        expect.objectContaining({
          from: "change-scope-guard",
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
    const selectScope = flow?.blocks.find((block) => block.id === "select-scope");
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
      type: "VALIDATOR",
      prompt: expect.stringContaining("flow counter enforces"),
    });
    expect(flow?.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "start",
          to: "scan-scopes",
        }),
        expect.objectContaining({
          from: "detect-project-commands",
          to: "research-decision",
        }),
        expect.objectContaining({
          from: "security-research",
          to: "git-snapshot-before",
        }),
        expect.objectContaining({
          from: "findings-present",
          fromOutput: "MATCH",
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
          to: "blocked",
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
    const starterFlow = getRalphStarterFlow(
      "autonomous-code-improvement-loop",
    );
    const flow = starterFlow?.flow;
    const chooseImprovement = flow?.blocks.find(
      (block) => block.id === "choose-improvement",
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

    expect(starterFlow).toMatchObject({
      defaultAlias: "autonomous-code-improvement-loop",
      category: "Code Quality",
    });
    expect(starterFlow?.version).toBeGreaterThanOrEqual(8);
    expect(scopeSelectionStrategy).toMatchObject({
      type: "text",
      default: "priority",
    });
    expect(flow).toMatchObject({
      name: "Autonomous Code Improvement Loop",
      settings: { maxTransitions: 500 },
    });
    expect(chooseImprovement).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "PROMPT_JSON",
        prompt: expect.stringContaining("Return decision IMPLEMENT only"),
      },
    });
    expect(chooseImprovement).toMatchObject({
      utility: {
        prompt: expect.stringContaining("Do not dig for weak work"),
      },
    });
    expect(chooseImprovement).toMatchObject({
      utility: {
        prompt: expect.stringContaining("STOP means this scope is done"),
      },
    });
    expect(actionableDecision).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "CONDITION",
        condition: {
          expression: expect.stringContaining(
            'lastData?.output?.decision === "IMPLEMENT"',
          ),
        },
      },
    });
    expect(passCounter).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "LOOP_COUNTER",
        counterName: expect.stringContaining(
          "{{data:choose-improvement:output.selectedCandidate.id}}",
        ),
        maxAttempts: "{{maxImprovementPasses:number=8}}",
      },
    });
    expect(implementImprovement).toMatchObject({
      type: "PROMPT",
      prompt: expect.stringContaining("{{result:validate-improvement}}"),
    });
    expect(implementImprovement).toMatchObject({
      type: "PROMPT",
      prompt: expect.stringContaining("{{data:independent-review:output}}"),
    });
    expect(independentReview).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "PROMPT_JSON",
        prompt: expect.stringContaining("security regressions"),
      },
    });
    expect(validateImprovement).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "VALIDATOR_JSON",
        prompt: expect.stringContaining("any behavior change is intentional"),
      },
    });
    expect(flow?.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "has-actionable-improvement",
          fromOutput: "NO_MATCH",
          to: "mark-scope-result",
        }),
        expect.objectContaining({
          from: "archive-active-improvement",
          fromOutput: "SUCCESS",
          to: "mark-scope-result",
        }),
        expect.objectContaining({
          from: "git-snapshot-before",
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
          to: "blocked",
        }),
        expect.objectContaining({
          from: "validate-improvement",
          fromOutput: "CONTINUE",
          to: "count-improvement-pass",
        }),
        expect.objectContaining({
          from: "validate-improvement",
          fromOutput: "RETRY",
          to: "count-improvement-pass",
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
    expect(JSON.stringify(flow)).not.toContain("CHANGE_SCOPE_GUARD");
    expect(independentReview).toMatchObject({
      utility: {
        prompt: expect.stringContaining("Ignore unrelated workspace changes"),
      },
    });
    expect(validateImprovement).toMatchObject({
      utility: {
        prompt: expect.stringContaining("Ignore unrelated workspace changes"),
      },
    });
  });

  it("includes an autonomous UI improvement loop with design-policy and runtime visual-review controls", () => {
    const starterFlow = getRalphStarterFlow(
      "autonomous-ui-improvement-loop",
    );
    const flow = starterFlow?.flow;
    const designPolicy = flow?.variables?.find(
      (variable) => variable.name === "designPolicy",
    );
    const scopeSelectionStrategy = flow?.variables?.find(
      (variable) => variable.name === "scopeSelectionStrategy",
    );
    const riskTolerance = flow?.variables?.find(
      (variable) => variable.name === "riskTolerance",
    );
    const enableVisualReview = flow?.variables?.find(
      (variable) => variable.name === "enableVisualReview",
    );
    const targetUrl = flow?.variables?.find(
      (variable) => variable.name === "targetUrl",
    );
    const targetUrlEnvKey = flow?.variables?.find(
      (variable) => variable.name === "targetUrlEnvKey",
    );
    const healthUrlEnvKey = flow?.variables?.find(
      (variable) => variable.name === "healthUrlEnvKey",
    );
    const analyzeScope = flow?.blocks.find(
      (block) => block.id === "analyze-selected-ui-scope",
    );
    const resolveRuntimeUrls = flow?.blocks.find(
      (block) => block.id === "resolve-runtime-urls",
    );
    const passCounter = flow?.blocks.find(
      (block) => block.id === "count-ui-improvement-pass",
    );
    const implementImprovement = flow?.blocks.find(
      (block) => block.id === "implement-ui-improvement",
    );
    const visualReview = flow?.blocks.find(
      (block) => block.id === "visual-review",
    );
    const validateImprovement = flow?.blocks.find(
      (block) => block.id === "validate-ui-improvement",
    );
    const importedAt = "2026-07-02T00:00:00.000Z";
    const importedFlow = starterFlow
      ? createImportedRalphStarterFlow(starterFlow, {
          id: "imported-ui-loop",
          alias: "imported-ui-loop",
          importedAt,
        })
      : undefined;
    const serializedFlow = JSON.stringify(flow);
    const policyText = designPolicy?.default ?? "";

    expect(starterFlow).toMatchObject({
      defaultAlias: "autonomous-ui-improvement-loop",
      category: "Design Quality",
    });
    expect(starterFlow?.version).toBeGreaterThanOrEqual(5);
    expect(flow).toMatchObject({
      name: "Autonomous UI Improvement Loop",
      settings: { maxTransitions: 500 },
    });
    expect(importedFlow).toMatchObject({
      id: "imported-ui-loop",
      alias: "imported-ui-loop",
      source: {
        kind: "starter",
        id: "autonomous-ui-improvement-loop",
        version: starterFlow?.version,
        importedAt,
      },
    });
    expect(designPolicy).toMatchObject({
      type: "text",
    });
    expect(policyText).toContain("clean, minimalist, modern");
    expect(policyText).toContain("responsive and mobile friendly");
    expect(policyText).toContain("badges sparingly");
    expect(policyText).toContain("overexplained helper text");
    expect(policyText).toContain("Use icons only when they improve");
    expect(policyText).toContain("WCAG 2.2");
    expect(policyText).toContain("overlapping text");
    expect(policyText).toContain("hydration-sensitive");
    expect(riskTolerance).toMatchObject({
      type: "text",
      default: "ambitious",
    });
    expect(scopeSelectionStrategy).toMatchObject({
      type: "text",
      default: "ui-first",
    });
    expect(enableVisualReview).toMatchObject({
      type: "boolean",
      default: "true",
    });
    expect(targetUrl).toMatchObject({
      type: "url",
      default: "",
    });
    expect(targetUrlEnvKey).toMatchObject({
      type: "text",
      default: "RALPH_UI_TARGET_URL",
    });
    expect(healthUrlEnvKey).toMatchObject({
      type: "text",
      default: "RALPH_UI_HEALTH_URL",
    });
    expect(analyzeScope).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "PROMPT_JSON",
        prompt: expect.stringContaining("uiScope={{uiScope:text=auto-detect}}"),
      },
    });
    expect(analyzeScope).toMatchObject({
      type: "UTILITY",
      utility: {
        prompt: expect.stringContaining("mark only this scope complete"),
      },
    });
    expect(resolveRuntimeUrls).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "TRANSFORM_JSON",
        expression: expect.stringContaining("process.env"),
      },
    });
    expect(resolveRuntimeUrls).toMatchObject({
      utility: {
        expression: expect.stringContaining("targetUrlEnvKey"),
      },
    });
    expect(passCounter).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "LOOP_COUNTER",
        counterName: expect.stringContaining(
          "{{data:choose-ui-improvement:output.selectedCandidate.id}}",
        ),
        maxAttempts: "{{maxUiImprovementPasses:number=8}}",
      },
    });
    expect(implementImprovement).toMatchObject({
      type: "PROMPT",
      prompt: expect.stringContaining("{{result:validate-ui-improvement}}"),
    });
    expect(implementImprovement).toMatchObject({
      type: "PROMPT",
      prompt: expect.stringContaining("{{data:independent-ui-review:output}}"),
    });
    expect(visualReview).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "UI_ANALYZE",
        targetUrl: "{{data:resolve-runtime-urls:output.targetUrl}}",
        server: {
          mode: "existing",
          healthUrl: "{{data:resolve-runtime-urls:output.healthUrl}}",
        },
      },
    });
    expect(validateImprovement).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "VALIDATOR_JSON",
        prompt: expect.stringContaining("flow counter enforces"),
      },
    });
    expect(serializedFlow).toContain("STOP means this scope is done");
    expect(serializedFlow).toContain("{{scopeSelectionStrategy:text=ui-first}}");
    expect(flow?.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "git-snapshot-before",
          to: "count-ui-improvement-pass",
        }),
        expect.objectContaining({
          from: "count-ui-improvement-pass",
          fromOutput: "CONTINUE",
          to: "implement-ui-improvement",
        }),
        expect.objectContaining({
          from: "count-ui-improvement-pass",
          fromOutput: "LIMIT_REACHED",
          to: "blocked",
        }),
        expect.objectContaining({
          from: "validate-ui-improvement",
          fromOutput: "CONTINUE",
          to: "count-ui-improvement-pass",
        }),
        expect.objectContaining({
          from: "validate-ui-improvement",
          fromOutput: "RETRY",
          to: "count-ui-improvement-pass",
        }),
        expect.objectContaining({
          from: "archive-active-ui-improvement",
          fromOutput: "SUCCESS",
          to: "mark-scope-result",
        }),
        expect.objectContaining({
          from: "archive-active-ui-improvement",
          fromOutput: "NOT_FOUND",
          to: "mark-scope-result",
        }),
        expect.objectContaining({
          from: "mark-scope-result",
          fromOutput: "SUCCESS",
          to: "scope-cycle-complete",
        }),
        expect.objectContaining({
          from: "scope-cycle-complete",
          fromOutput: "NO_MATCH",
          to: "select-scope",
        }),
      ]),
    );
    expect(flow?.edges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "archive-active-ui-improvement",
          to: "read-completed-ui-improvements",
        }),
      ]),
    );
    expect(validateImprovement).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "VALIDATOR_JSON",
        prompt: expect.stringContaining("desktop/mobile overflow"),
      },
    });
    expect(serializedFlow).toContain("Do not start or restart servers");
    expect(serializedFlow).not.toContain("localhost");
    expect(serializedFlow).not.toContain("127.0.0.1");
    expect(serializedFlow).not.toContain("npm run dev");
    expect(serializedFlow).not.toContain("pnpm dev");
    expect(serializedFlow).not.toContain("yarn dev");
    expect(serializedFlow).not.toContain("next dev");
    expect(serializedFlow).not.toContain("tauri dev");
    if (visualReview?.type === "UTILITY") {
      expect(visualReview.utility).toMatchObject({
        type: "UI_ANALYZE",
        server: { mode: "existing" },
      });
      expect(visualReview.utility.server?.command).toBeUndefined();
    }
  });

  it("keeps bundled git-diff validators tolerant of shared workspace changes", () => {
    for (const starterFlow of STARTER_RALPH_FLOWS) {
      const serializedFlow = JSON.stringify(starterFlow.flow);

      expect(serializedFlow).not.toContain("CHANGE_SCOPE_GUARD");
      expect(serializedFlow).not.toContain("change-scope-guard");
      for (const block of starterFlow.flow.blocks) {
        if (block.type === "UTILITY" && block.utility.type === "GIT_DIFF_SUMMARY") {
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

  it("configures visual UI analysis for URL or screenshot evidence", () => {
    const visualReviewBlocks = [
      {
        starterFlowId: "autonomous-code-improvement-loop",
        minimumVersion: 8,
        decisionBlockId: "visual-decision",
        analyzeBlockId: "visual-review",
        expectedTargetUrl: "{{targetUrl:url=}}",
        expectedHealthUrl: "{{healthUrl:url=}}",
      },
      {
        starterFlowId: "autonomous-ui-improvement-loop",
        minimumVersion: 2,
        decisionBlockId: "visual-decision",
        analyzeBlockId: "visual-review",
        expectedTargetUrl: "{{data:resolve-runtime-urls:output.targetUrl}}",
        expectedHealthUrl: "{{data:resolve-runtime-urls:output.healthUrl}}",
      },
      {
        starterFlowId: "autonomous-feature-generation-loop",
        minimumVersion: 7,
        decisionBlockId: "visual-decision",
        analyzeBlockId: "visual-review",
        expectedTargetUrl: "{{targetUrl:url=}}",
        expectedHealthUrl: "{{healthUrl:url=}}",
      },
      {
        starterFlowId: "full-feature-implementation",
        minimumVersion: 7,
        decisionBlockId: "visual-decision",
        analyzeBlockId: "visual-analysis",
        expectedTargetUrl: "{{targetUrl:url=}}",
        expectedHealthUrl: "{{healthUrl:url=}}",
      },
    ] as const;

    for (const {
      starterFlowId,
      minimumVersion,
      decisionBlockId,
      analyzeBlockId,
      expectedTargetUrl,
      expectedHealthUrl,
    } of visualReviewBlocks) {
      const starterFlow = getRalphStarterFlow(starterFlowId);
      const flow = starterFlow?.flow;
      const decisionBlock = flow?.blocks.find(
        (block) => block.id === decisionBlockId,
      );
      const analyzeBlock = flow?.blocks.find(
        (block) => block.id === analyzeBlockId,
      );

      expect(starterFlow?.version).toBeGreaterThanOrEqual(minimumVersion);
      expect(decisionBlock).toMatchObject({
        type: "UTILITY",
        utility: {
          type: "CONDITION",
          condition: {
            expression: expect.stringContaining("screenshotPath"),
          },
        },
      });
      expect(analyzeBlock).toMatchObject({
        type: "UTILITY",
        utility: {
          type: "UI_ANALYZE",
          adapter: "auto",
          targetUrl: expectedTargetUrl,
          screenshotPath: "{{screenshotPath:path=}}",
          server: {
            mode: "existing",
            healthUrl: expectedHealthUrl,
          },
          checks: {
            screenshots: true,
            accessibility: true,
            console: true,
            network: true,
            responsive: true,
          },
          viewports: [
            { name: "desktop", width: 1280, height: 900 },
            { name: "tablet", width: 768, height: 1024 },
            { name: "mobile", width: 390, height: 844 },
            { name: "small-mobile", width: 320, height: 568 },
          ],
          timeoutSeconds: 30,
          fullPage: true,
          waitUntil: "domcontentloaded",
        },
      });
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

    for (const { starterFlowId, minimumVersion, researchBlockId } of researchBlocks) {
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
      "autonomous-code-improvement-loop": "scan-scopes",
      "autonomous-ui-improvement-loop": "scan-ui-scopes",
      "full-feature-implementation": "detect-project-commands",
      "autonomous-refactoring-flow": "scan-scopes",
      "security-fix-loop": "scan-scopes",
    };

    for (const starterFlow of STARTER_RALPH_FLOWS) {
      expect(
        starterFlow.flow.blocks.some((block) => block.type === "ASK_USER"),
      ).toBe(false);
      expect(
        starterFlow.flow.blocks.some((block) => block.id === "configure-template"),
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

    const featureFlow = getRalphStarterFlow("full-feature-implementation")?.flow;
    const featureRequest = featureFlow?.variables?.find(
      (variable) => variable.name === "featureRequest",
    );

    expect(featureRequest).toMatchObject({ required: true, default: "" });
    expect(featureFlow?.blocks.some((block) => block.type === "INTERVIEW"))
      .toBe(true);
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
    expect(starterFlow!.flow.alias).toBe("feature-implementation-checklist-loop");
    expect(validateRalphFlow(imported).valid).toBe(true);
  });
});
