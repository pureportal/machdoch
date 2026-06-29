import { describe, expect, it } from "vitest";
import {
  STARTER_RALPH_FLOWS,
  createImportedRalphStarterFlow,
  createRalphStarterFlowSummary,
  getRalphStarterFlow,
} from "./ralph-starter-flows.js";
import {
  discoverRalphFlowVariables,
  validateRalphFlow,
  type RalphFlowBlock,
} from "./ralph.js";

describe("Ralph starter flows", () => {
  it("bundles valid starter flows with useful summaries", () => {
    expect(STARTER_RALPH_FLOWS).toHaveLength(5);

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

  it("includes an endless autonomous feature-generation loop", () => {
    const starterFlow = getRalphStarterFlow("autonomous-feature-generation-loop");
    const flow = starterFlow?.flow;

    expect(starterFlow?.defaultAlias).toBe("autonomous-feature-generation-loop");
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
    expect(flow?.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "goals-per-run-counter",
          to: "find-active-goal",
        }),
        expect.objectContaining({
          from: "find-active-goal",
          fromOutput: "MISSING",
          to: "detect-project-commands",
        }),
      ]),
    );

    const endBlocks = (flow?.blocks ?? []).filter(
      (block: RalphFlowBlock) => block.type === "END",
    );

    expect(endBlocks).toHaveLength(1);
    expect(endBlocks[0]?.id).toBe("blocked");
  });

  it("ships the refactor starter with validation fallback, scoped guard baseline, and pass counter", () => {
    const starterFlow = getRalphStarterFlow("autonomous-refactoring-flow");
    const flow = starterFlow?.flow;
    const passCounter = flow?.blocks.find(
      (block) => block.id === "count-refactor-pass",
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
    const scopeGuard = flow?.blocks.find(
      (block) => block.id === "change-scope-guard",
    );
    const blocked = flow?.blocks.find((block) => block.id === "blocked");

    expect(starterFlow?.version).toBeGreaterThanOrEqual(3);
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
        timeoutSeconds: 1800,
      },
    });
    expect(refactorPass).toMatchObject({
      type: "PROMPT",
      settings: {
        timeoutSeconds: 3600,
      },
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
    });
    expect(scopeGuard).toMatchObject({
      type: "UTILITY",
      utility: {
        type: "CHANGE_SCOPE_GUARD",
        baseline: "{{result:git-snapshot-before}}",
        input: expect.stringContaining("allowedPaths"),
      },
    });
    expect(blocked).toMatchObject({ type: "END", status: "failed" });
    expect(flow?.edges).toEqual(
      expect.arrayContaining([
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
    expect(flow).toMatchObject({
      name: "Autonomous Code Improvement Loop",
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
          to: "read-completed-improvements",
        }),
      ]),
    );
  });

  it("starts bundled templates autonomously without ask-user gates", () => {
    const expectedStartTargets: Record<string, string> = {
      "autonomous-feature-generation-loop": "find-active-goal",
      "autonomous-code-improvement-loop": "scan-scopes",
      "full-feature-implementation": "detect-project-commands",
      "autonomous-refactoring-flow": "scan-scopes",
      "security-fix-loop": "research-decision",
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
