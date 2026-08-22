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
      "generated-character-idle-loop",
    ]);
    for (const template of templates.filter(
      (candidate) => candidate.category !== "Animation",
    )) {
      expect(template.flow.variables.length).toBeGreaterThanOrEqual(2);
      expect(template.flow.presets.length).toBeGreaterThan(0);
      expect(
        template.flow.nodes.some((node) => node.type === "output.asset"),
      ).toBe(true);
      expect(
        template.flow.nodes.some(
          (node) => node.type === "control.human-review",
        ),
      ).toBe(true);
      expect(validateMediaFlowDocument(template.flow)).toEqual([]);
      const plan = compileMediaFlow({
        flow: template.flow,
        models,
        compiledAt: CREATED_AT,
      });
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

  it("ships a connected generated-frame Wan loop with two publication paths", () => {
    const template = listBuiltInMediaFlowTemplates().find(
      (candidate) => candidate.id === "generated-character-idle-loop",
    );
    expect(template).toBeDefined();
    expect(template?.category).toBe("Animation");
    expect(validateMediaFlowDocument(template!.flow)).toEqual([]);

    const models = createMediaModelCatalog({
      isOpenAiConfigured: false,
      isLocalFluxInstalled: true,
      isLocalBiRefNetInstalled: true,
    });
    const flux = models.find(
      (candidate) => candidate.id === "local:flux-2-klein-4b",
    );
    expect(flux).toBeDefined();
    models.push({
      ...flux!,
      id: "local:wan2.2-ti2v-5b",
      providerId: "local-wan",
      displayName: "Wan2.2 TI2V 5B",
      family: "Wan2.2",
      capabilities: [
        "image-to-video",
        "start-end-to-video",
        "transparent-output",
        "alpha-video",
        "video-composite",
      ],
      architecture: "wan-2.2-ti2v",
      addonCapabilities: [],
      installedRevision: "b8fff7315c768468a5333511427288870b2e9635",
    });

    const plan = compileMediaFlow({
      flow: template!.flow,
      models,
      compiledAt: CREATED_AT,
    });
    expect(plan.status).toBe("ready");
    expect(plan.runtimeBindings.map((binding) => binding.modality)).toEqual([
      "image",
      "video",
    ]);
    expect(plan.preflight.estimatedOutputs).toBe(2);
    expect(
      template!.flow.edges.filter(
        (edge) =>
          edge.fromNodeId === "cutout-character-frame" &&
          edge.toNodeId === "generate-idle-loop",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toPortId: "first-frame" }),
        expect.objectContaining({ toPortId: "last-frame" }),
      ]),
    );
    expect(
      template!.flow.nodes.filter((node) => node.type === "output.video"),
    ).toHaveLength(2);
  });

  it("forks an isolated flow without mutating the catalog template", () => {
    const result = instantiateMediaFlowTemplate({
      templateId: "product-cutout-quality",
      flowId: "flow:product-fork",
      createdAt: CREATED_AT,
    });
    result.flow.variables[0]!.name = "Changed locally";

    expect(result.flow.id).toBe("flow:product-fork");
    expect(result.flow.createdAt).toBe(CREATED_AT);
    expect(
      listBuiltInMediaFlowTemplates().find(
        (template) => template.id === "product-cutout-quality",
      )?.flow.variables[0]?.name,
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
    expect(() =>
      instantiateMediaFlowTemplate({
        templateId: "missing",
        flowId: "flow:fork",
        createdAt: CREATED_AT,
      }),
    ).toThrow("was not found");
    expect(() =>
      instantiateMediaFlowTemplate({
        templateId: "text-to-image-variants",
        flowId: " ",
        createdAt: CREATED_AT,
      }),
    ).toThrow("stable flow id");
  });
});
