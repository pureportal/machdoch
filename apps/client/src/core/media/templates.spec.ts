import { createMediaModelCatalog } from "./catalog.js";
import {
  analyzeMediaFlowCardinality,
  compileMediaFlow,
  compileMediaImageOutputBranches,
  readImageRecipeSettings,
} from "./compiler.js";
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
      "conditioned-image-branches",
      "generated-character-idle-loop",
    ]);
    for (const template of templates.filter(
      (candidate) =>
        candidate.category !== "Animation" && candidate.category !== "Advanced",
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

  it("ships an editable conditioned image graph with independent output branches", () => {
    const template = listBuiltInMediaFlowTemplates().find(
      (candidate) => candidate.id === "conditioned-image-branches",
    );
    expect(template).toBeDefined();
    expect(validateMediaFlowDocument(template!.flow)).toEqual([]);
    expect(
      template!.flow.nodes.find((node) => node.id === "source-image")?.config,
    ).toMatchObject({ assetId: "", referenceRole: "base" });
    expect(
      template!.flow.nodes.find((node) => node.id === "reference-image-1")
        ?.config,
    ).toMatchObject({ assetId: "", referenceRole: "style", influence: 1 });
    expect(
      template!.flow.nodes.find((node) => node.id === "reference-image-2")
        ?.config,
    ).toMatchObject({ assetId: "", referenceRole: "detail", influence: 1 });
    expect(
      template!.flow.nodes.find((node) => node.id === "edit")?.config,
    ).toMatchObject({ modelAddons: [], editMask: null });

    expect(compileMediaImageOutputBranches(template!.flow)).toEqual([
      expect.objectContaining({
        id: "png-output",
        format: "png",
        operations: [
          expect.objectContaining({ kind: "crop", width: 384, height: 384 }),
        ],
      }),
      expect.objectContaining({
        id: "webp-output",
        format: "webp",
        operations: [
          expect.objectContaining({
            kind: "text-overlay",
            text: "AI Image Disclaimer",
            position: "bottom-right",
          }),
        ],
      }),
    ]);
    expect(analyzeMediaFlowCardinality(template!.flow)).toMatchObject({
      generatedCandidates: 1,
      maxPublishedOutputs: 2,
    });
  });

  it("compiles the complete masked FLUX.2 recipe with both branches", () => {
    const template = listBuiltInMediaFlowTemplates().find(
      (candidate) => candidate.id === "conditioned-image-branches",
    )!;
    const flow = structuredClone(template.flow);
    const fluxModel = createMediaModelCatalog({
      isOpenAiConfigured: false,
      isLocalFluxInstalled: true,
    }).find((model) => model.id === "local:flux-2-klein-4b")!;
    for (const [nodeId, assetId] of [
      ["source-image", "asset:base"],
      ["reference-image-1", "asset:style"],
      ["reference-image-2", "asset:detail"],
    ]) {
      const node = flow.nodes.find((candidate) => candidate.id === nodeId)!;
      node.config.assetId = assetId;
    }
    const edit = flow.nodes.find((node) => node.id === "edit")!;
    edit.config.modelId = fluxModel.id;
    edit.config.modelAddons = [];
    edit.config.maskStrength = 1;
    edit.config.editMask = {
      schemaVersion: 2,
      sourceAssetId: "asset:base",
      inverted: false,
      strokes: [
        {
          mode: "paint",
          size: 0.12,
          opacity: 0.8,
          softness: 0.55,
          points: [
            { x: 0.35, y: 0.4 },
            { x: 0.65, y: 0.6 },
          ],
        },
      ],
    };

    expect(validateMediaFlowDocument(flow)).toEqual([]);
    const settings = readImageRecipeSettings(flow);
    expect(settings).toMatchObject({
      prompt: "",
      modelId: fluxModel.id,
      baseImageAssetId: "asset:base",
      referenceImages: [
        { assetId: "asset:style", role: "style", influence: 1 },
        { assetId: "asset:detail", role: "detail", influence: 1 },
      ],
      modelAddons: [],
      editMask: expect.objectContaining({ sourceAssetId: "asset:base" }),
    });
    const plan = compileMediaFlow({
      flow,
      models: [fluxModel],
      compiledAt: CREATED_AT,
    });
    expect(plan.status).toBe("ready");
    expect(plan.preflight.estimatedOutputs).toBe(2);
    expect(compileMediaImageOutputBranches(flow)).toMatchObject([
      { id: "png-output", format: "png" },
      { id: "webp-output", format: "webp" },
    ]);
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
