import { createMediaModelCatalog } from "./catalog.js";
import { analyzeMediaFlowCardinality, compileMediaFlow } from "./compiler.js";
import { validateMediaFlowDocument } from "./node-registry.js";
import {
  instantiateMediaFlowTemplate,
  listBuiltInMediaFlowTemplates,
} from "./templates.js";

const CREATED_AT = "2026-07-14T12:00:00.000Z";

describe("built-in media flow templates", () => {
  it("ships executable variable-driven image flows with explicit outputs", () => {
    const templates = listBuiltInMediaFlowTemplates();
    const models = createMediaModelCatalog({
      isOpenAiConfigured: false,
      isLocalFluxInstalled: true,
      isLocalBiRefNetInstalled: true,
    });

    expect(templates.map((template) => template.id)).toEqual([
      "text-to-image-variants",
      "product-cutout-quality",
      "quality-gated-campaign",
    ]);
    for (const template of templates) {
      expect(template.flow.variables.length).toBeGreaterThanOrEqual(2);
      expect(template.flow.presets.length).toBeGreaterThan(0);
      expect(template.flow.nodes.some((node) => node.type === "output.asset")).toBe(true);
      expect(template.flow.nodes.some((node) => node.type === "control.human-review")).toBe(true);
      expect(validateMediaFlowDocument(template.flow)).toEqual([]);
      const plan = compileMediaFlow({ flow: template.flow, models, compiledAt: CREATED_AT });
      expect(plan.status).toBe("ready");
      expect(plan.preflight.estimatedOutputs).toBeGreaterThan(0);
      expect(plan.preflight.requiresHumanReview).toBe(true);
      expect(plan.preflight.generatedCandidates).toBeGreaterThan(
        plan.preflight.estimatedOutputs,
      );
      expect(plan.steps.at(-2)?.kind).toBe("wait-for-review");
      expect(plan.steps.at(-1)?.kind).toBe("ingest-asset");
      expect(plan.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "HUMAN_REVIEW_REQUIRED",
          severity: "info",
        }),
      );
    }
  });

  it("forks an isolated flow and layout without mutating the catalog template", () => {
    const result = instantiateMediaFlowTemplate({
      templateId: "product-cutout-quality",
      flowId: "flow:product-fork",
      createdAt: CREATED_AT,
    });
    result.flow.variables[0]!.name = "Changed locally";

    expect(result.flow.id).toBe("flow:product-fork");
    expect(result.flow.createdAt).toBe(CREATED_AT);
    expect(result.layout.flowId).toBe(result.flow.id);
    expect(result.layout.nodes.map((node) => node.nodeId).sort()).toEqual(
      result.flow.nodes.map((node) => node.id).sort(),
    );
    expect(
      listBuiltInMediaFlowTemplates()
        .find((template) => template.id === "product-cutout-quality")
        ?.flow.variables[0]?.name,
    ).toBe("Creative brief");
  });

  it("bounds publication by both generated candidates and reviewer approvals", () => {
    const template = listBuiltInMediaFlowTemplates().find(
      (candidate) => candidate.id === "text-to-image-variants",
    );
    expect(template).toBeDefined();
    const defaultAnalysis = analyzeMediaFlowCardinality(template!.flow);
    expect(defaultAnalysis).toMatchObject({
      generatedCandidates: 4,
      maxPublishedOutputs: 2,
      requiresHumanReview: true,
    });
    const oneCandidate = {
      ...template!.flow,
      variableBindings: { "variant-count": 1 },
    };
    expect(analyzeMediaFlowCardinality(oneCandidate)).toMatchObject({
      generatedCandidates: 1,
      maxPublishedOutputs: 1,
      requiresHumanReview: true,
    });
  });

  it("rejects unknown templates and empty fork identities", () => {
    expect(() => instantiateMediaFlowTemplate({
      templateId: "missing",
      flowId: "flow:fork",
      createdAt: CREATED_AT,
    })).toThrow("was not found");
    expect(() => instantiateMediaFlowTemplate({
      templateId: "text-to-image-variants",
      flowId: " ",
      createdAt: CREATED_AT,
    })).toThrow("stable flow id");
  });
});
