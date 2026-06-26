import { describe, expect, it } from "vitest";
import {
  STARTER_RALPH_FLOWS,
  createImportedRalphStarterFlow,
  createRalphStarterFlowSummary,
  getRalphStarterFlow,
} from "./ralph-starter-flows.js";
import {
  validateRalphFlow,
  type RalphFlowBlock,
  type RalphInputBlock,
} from "./ralph.js";

describe("Ralph starter flows", () => {
  it("bundles valid starter flows with useful summaries", () => {
    expect(STARTER_RALPH_FLOWS).toHaveLength(4);

    for (const starterFlow of STARTER_RALPH_FLOWS) {
      const validation = validateRalphFlow(starterFlow.flow);
      const summary = createRalphStarterFlowSummary(starterFlow);

      expect(validation.valid).toBe(true);
      expect(summary.name).toBe(starterFlow.flow.name);
      expect(summary.defaultAlias).toBe(starterFlow.defaultAlias);
      expect(summary.blockCount).toBeGreaterThan(0);
      expect(summary.edgeCount).toBeGreaterThan(0);
      expect(summary.variableCount).toBe(starterFlow.flow.variables?.length ?? 0);
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

  it("exposes user-configurable starter flows without human approval gates", () => {
    for (const starterFlow of STARTER_RALPH_FLOWS) {
      const isAutonomousFeatureLoop =
        starterFlow.id === "autonomous-feature-generation-loop";
      const configureBlock = starterFlow.flow.blocks.find(
        (block): block is RalphInputBlock =>
          block.id === "configure-template" && block.type === "INPUT",
      );

      if (isAutonomousFeatureLoop) {
        expect(configureBlock).toBeUndefined();
        expect(starterFlow.flow.blocks.some((block) => block.type === "INTERVIEW"))
          .toBe(false);
        expect(starterFlow.flow.edges).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              from: "start",
              to: "find-active-goal",
            }),
          ]),
        );
      } else {
        expect(configureBlock).toBeTruthy();
        expect(starterFlow.flow.edges).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              from: "start",
              to: "configure-template",
            }),
          ]),
        );
      }

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
    const featureConfigure = featureFlow?.blocks.find(
      (block): block is RalphInputBlock =>
        block.id === "configure-template" && block.type === "INPUT",
    );

    expect(featureRequest).toMatchObject({ required: true, default: "" });
    expect(featureConfigure?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "featureRequest",
          required: true,
          variableName: "featureRequest",
        }),
      ]),
    );
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
      name: "Feature Implementation Checklist Loop",
    });
    expect(imported.id).not.toBe(starterFlow!.flow.id);
    expect(starterFlow!.flow.alias).toBe("feature-implementation-checklist-loop");
    expect(validateRalphFlow(imported).valid).toBe(true);
  });
});
