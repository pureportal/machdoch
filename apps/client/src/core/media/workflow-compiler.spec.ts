import { describe, expect, it } from "vitest";
import { createMediaModelCatalogSnapshot } from "./catalog.js";
import { compileMediaFlow } from "./compiler.js";
import { createConnectedWorkflowTemplates } from "./workflow-templates.js";
import { workflowTaskFlow } from "./workflow-compiler.js";
import { validateMediaFlowDocument } from "./node-registry.js";

const models = createMediaModelCatalogSnapshot({
  isOpenAiConfigured: false,
  isLocalFluxInstalled: true,
}).models;
const templates = createConnectedWorkflowTemplates();
const compiledAt = "2026-09-14T00:00:00.000Z";

describe("connected workflows", () => {
  it("requires a reference when checking the pixels outside a mask", () => {
    const flow = structuredClone(
      templates.find((item) => item.id === "refine-selected-edit")!.flow,
    );
    flow.edges = flow.edges.filter(
      (edge) => !(edge.toNodeId === "check" && edge.toPortId === "reference"),
    );
    const plan = compileMediaFlow({ flow, models, compiledAt });
    expect(
      plan.diagnostics.some(
        (item) =>
          item.nodeId === "check" &&
          item.message.includes("original image as the reference"),
      ),
    ).toBe(true);
  });

  it("supports a reference-bound boundary mask for an existing edit", () => {
    const flow = structuredClone(
      templates.find((item) => item.id === "refine-edit-boundary")!.flow,
    );
    flow.nodes.find((node) => node.id === "image")!.config.assetId =
      "asset:edited";
    Object.assign(flow.nodes.find((node) => node.id === "check")!.config, {
      modelPath: "C:/models/vision",
    });
    const source = structuredClone(
      flow.nodes.find((node) => node.id === "image")!,
    );
    source.id = "reference";
    source.config.assetId = "asset:original";
    flow.nodes.push(source);
    flow.edges.push({
      id: "mask-reference",
      fromNodeId: source.id,
      fromPortId: "image",
      toNodeId: "mask",
      toPortId: "reference",
    });
    flow.nodes.find((node) => node.id === "mask")!.config.editMask = {
      schemaVersion: 2,
      sourceAssetId: "asset:original",
      inverted: false,
      strokes: [
        {
          mode: "paint",
          size: 0.1,
          opacity: 1,
          softness: 0,
          points: [{ x: 0.5, y: 0.5 }],
        },
      ],
    };
    const plan = compileMediaFlow({ flow, models, compiledAt });
    expect(
      plan.diagnostics.filter((item) => item.severity === "error"),
    ).toEqual([]);
    expect(plan.status).toBe("ready");
    flow.nodes.find((node) => node.id === "mask")!.config.boundaryWidth = 0;
    expect(compileMediaFlow({ flow, models, compiledAt }).status).toBe(
      "blocked",
    );
  });
  it("requires visual criteria, a vision model, and a mask before running an edit refinement", () => {
    const flow = structuredClone(
      templates.find((item) => item.id === "refine-selected-edit")!.flow,
    );
    const plan = compileMediaFlow({ flow, models, compiledAt });
    expect(plan.status).toBe("blocked");
    for (const message of [
      "visual criteria",
      "Choose a model",
      "Paint a selection",
    ])
      expect(
        plan.diagnostics.some((item) => item.message.includes(message)),
      ).toBe(true);
  });

  it("refuses previous-image refinement for a text-generation loop", () => {
    const flow = structuredClone(
      templates.find((item) => item.id === "refine-until-pass")!.flow,
    );
    flow.nodes.find((node) => node.id === "repeat")!.config.inputMode =
      "previous";
    const plan = compileMediaFlow({ flow, models, compiledAt });
    expect(
      plan.diagnostics.some((item) => item.message.includes("previous result")),
    ).toBe(true);
  });

  it("compiles a painted mask, visual reference check, and iterative edit as one workflow", () => {
    const flow = structuredClone(
      templates.find((item) => item.id === "refine-selected-edit")!.flow,
    );
    flow.nodes.find((node) => node.id === "image")!.config.assetId =
      "asset:source";
    flow.nodes.find((node) => node.id === "prompt")!.config.prompt =
      "Change the dress to blue";
    Object.assign(flow.nodes.find((node) => node.id === "check")!.config, {
      criteria: "The dress is blue.\nThe face and pose match the reference.",
      modelPath: "C:/models/vision",
      compareReference: true,
    });
    flow.nodes.find((node) => node.id === "mask")!.config.editMask = {
      schemaVersion: 2,
      sourceAssetId: "asset:source",
      inverted: false,
      strokes: [
        {
          mode: "paint",
          size: 0.1,
          opacity: 1,
          softness: 0,
          points: [{ x: 0.5, y: 0.5 }],
        },
      ],
    };
    const plan = compileMediaFlow({ flow, models, compiledAt });
    expect(
      plan.diagnostics.filter((item) => item.severity === "error"),
    ).toEqual([]);
    expect(plan.steps.some((step) => step.kind === "check-image")).toBe(true);
    expect(plan.steps.some((step) => step.kind === "prepare-mask")).toBe(true);
  });
  it("blocks lossy output and background removal on a connected masked edit", () => {
    for (const [config, message] of [
      [{ outputFormat: "jpeg" }, "Choose PNG"],
      [{ transparentBackground: true }, "Turn off background removal"],
    ] as const) {
      const flow = structuredClone(templates[0]!.flow);
      flow.nodes.find((node) => node.id === "select")!.config.modelPath =
        "C:/models/sam3";
      Object.assign(
        flow.nodes.find((node) => node.id === "edit")!.config,
        config,
      );
      const plan = compileMediaFlow({ flow, models, compiledAt });
      expect(plan.status).toBe("blocked");
      expect(
        plan.diagnostics.some((item) => item.message.includes(message)),
      ).toBe(true);
    }
  });
  it("compiles one upscaled frame into an opaque video without a redundant endpoint connection", () => {
    const flow = structuredClone(
      templates.find((item) => item.id === "upscale-and-animate")!.flow,
    );
    flow.nodes.find((node) => node.id === "image")!.config.assetId =
      "asset:source";
    flow.nodes.find((node) => node.id === "upscale")!.config.modelPath =
      "C:/models/upscaler.pth";
    const videoModel = {
      ...models.find((model) => model.id === "local:flux-2-klein-4b")!,
      id: "local:hunyuan-video-1.5-i2v-step-distilled",
      architecture: "hunyuan-video-1.5-i2v" as const,
      capabilities: ["image-to-video" as const],
    };
    const plan = compileMediaFlow({
      flow,
      models: [...models, videoModel],
      compiledAt,
    });
    expect(
      plan.diagnostics.filter((item) => item.severity === "error"),
    ).toEqual([]);
    expect(plan.status).toBe("ready");
  });

  it("prevents an output branch from bypassing the retry gate", () => {
    const flow = structuredClone(
      templates.find((item) => item.id === "refine-until-pass")!.flow,
    );
    flow.nodes.push({
      ...flow.nodes.find((node) => node.id === "save")!,
      id: "bypass",
    });
    flow.edges.push({
      id: "bypass",
      fromNodeId: "generate",
      fromPortId: "image",
      toNodeId: "bypass",
      toPortId: "image",
    });
    const plan = compileMediaFlow({ flow, models, compiledAt });
    expect(
      plan.diagnostics.some((item) =>
        item.message.includes("through the retry gate"),
      ),
    ).toBe(true);
  });
  it("provides typed templates with separate image and edit prompts", () => {
    for (const template of templates)
      expect(validateMediaFlowDocument(template.flow), template.name).toEqual(
        [],
      );
    const flow = templates[0]!.flow;
    const edit = flow.nodes.find((node) => node.id === "edit")!;
    const task = workflowTaskFlow(flow, edit);
    expect(
      task.nodes.find((node) => node.type === "source.prompt")?.config.prompt,
    ).toContain("dress color to blue");
    expect(
      task.nodes.find((node) => node.type === "source.image")?.config.assetId,
    ).toBe("workflow-input:select:image");
  });

  it("requires a SAM3 model before running a targeted edit", () => {
    const result = compileMediaFlow({
      flow: templates[0]!.flow,
      models,
      compiledAt,
    });
    expect(result.status).toBe("blocked");
    expect(
      result.diagnostics.some(
        (item) =>
          item.nodeId === "select" && item.message.includes("Choose a model"),
      ),
    ).toBe(true);
  });

  it("compiles generation followed by SAM3 and an independently configured edit", () => {
    const flow = structuredClone(templates[0]!.flow);
    flow.nodes.find((node) => node.id === "select")!.config.modelPath =
      "C:/models/sam3";
    const plan = compileMediaFlow({ flow, models, compiledAt });
    expect(
      plan.diagnostics.filter((item) => item.severity === "error"),
    ).toEqual([]);
    expect(plan.status).toBe("ready");
    expect(plan.runtimeBindings.map((binding) => binding.nodeId)).toEqual([
      "generate",
      "edit",
    ]);
  });

  it("rejects reports from a different image and retries outside the loop", () => {
    const flow = structuredClone(
      templates.find((item) => item.id === "refine-until-pass")!.flow,
    );
    flow.nodes.find((node) => node.id === "prompt")!.config.modelPath =
      "C:/models/qwen";
    flow.nodes.find((node) => node.id === "brief")!.config.prompt =
      "A blue bowl";
    flow.nodes.find((node) => node.id === "repeat")!.config.startNodeId =
      "save";
    flow.edges.find(
      (edge) => edge.toNodeId === "gate" && edge.toPortId === "image",
    )!.fromNodeId = "save";
    const plan = compileMediaFlow({ flow, models, compiledAt });
    expect(plan.status).toBe("blocked");
    expect(
      plan.diagnostics.some((item) => item.message.includes("analyzed image")),
    ).toBe(true);
    expect(
      plan.diagnostics.some((item) =>
        item.message.includes("first step to repeat"),
      ),
    ).toBe(true);
  });
});
