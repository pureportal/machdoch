import { describe, expect, it } from "vitest";
import { createMediaModelCatalogSnapshot } from "@machdoch/media-studio/core/media/catalog.js";
import { compileMediaFlow } from "@machdoch/media-studio/core/media/compiler.js";
import { createConnectedWorkflowTemplates } from "@machdoch/media-studio/core/media/workflow-templates.js";
import {
  createDefaultMediaNodeConfig,
  validateMediaFlowDocument,
} from "@machdoch/media-studio/core/media/node-registry.js";

const catalog = createMediaModelCatalogSnapshot({
  isOpenAiConfigured: false,
  isLocalFluxInstalled: true,
}).models;
const local = catalog.find((model) => model.providerId === "local-diffusers")!;
const sd15 = {
  ...local,
  id: "local:controlnet-test-sd15",
  architecture: "stable-diffusion-1",
  displayName: "SD1.5",
};
const compiledAt = "2026-09-15T00:00:00.000Z";

function flowFor(kind: string) {
  const flow = structuredClone(
    createConnectedWorkflowTemplates().find(
      (template) => template.id === `controlnet-${kind}`,
    )!.flow,
  );
  flow.nodes.find((node) => node.id === "image")!.config.assetId =
    "asset:reference";
  flow.nodes.find((node) => node.id === "prompt")!.config.prompt =
    "A stone castle beside a river";
  return flow;
}

describe("ControlNet workflows", () => {
  it.each(["canny", "depth"])(
    "compiles %s preparation and binds a compatible generator",
    (kind) => {
      const flow = flowFor(kind);
      expect(validateMediaFlowDocument(flow)).toEqual([]);
      const plan = compileMediaFlow({
        flow,
        models: [...catalog, sd15],
        compiledAt,
      });
      expect(
        plan.diagnostics.filter((item) => item.severity === "error"),
      ).toEqual([]);
      expect(plan.status).toBe("ready");
      expect(plan.steps.map((step) => step.kind)).toContain(
        "prepare-control-image",
      );
      expect(plan.steps.map((step) => step.kind)).toContain("apply-controlnet");
      expect(
        plan.runtimeBindings?.find((binding) => binding.nodeId === "generate")
          ?.model.id,
      ).toBe(sd15.id);
    },
  );

  it("rejects incompatible models, invalid control ranges, and image-to-control port mismatches", () => {
    const flow = flowFor("canny");
    expect(compileMediaFlow({ flow, models: catalog, compiledAt }).status).toBe(
      "blocked",
    );
    flow.nodes.find((node) => node.id === "control")!.config.start = 1;
    expect(compileMediaFlow({ flow, models: [sd15], compiledAt }).status).toBe(
      "blocked",
    );
    flow.nodes.find((node) => node.id === "control")!.config.start = 0;
    flow.nodes.find((node) => node.id === "guide")!.config.lowThreshold = 201;
    expect(
      validateMediaFlowDocument(flow).some((issue) =>
        issue.message.includes("threshold"),
      ),
    ).toBe(true);
    flow.nodes.find((node) => node.id === "guide")!.config.lowThreshold = 100;
    flow.edges.find((edge) => edge.toPortId === "controlnet")!.fromPortId =
      "image";
    expect(validateMediaFlowDocument(flow).length).toBeGreaterThan(0);
  });

  it("rejects simultaneous pose and edge controls before generation", () => {
    const flow = flowFor("canny");
    flow.nodes.push({
      id: "pose",
      type: "source.image",
      version: 1,
      label: "Pose",
      layer: "source",
      config: { assetId: "asset:pose", referenceRole: "pose" },
    });
    flow.edges.push({
      id: "pose-generate",
      fromNodeId: "pose",
      fromPortId: "image",
      toNodeId: "generate",
      toPortId: "image",
    });
    const plan = compileMediaFlow({ flow, models: [sd15], compiledAt });
    expect(plan.status).toBe("blocked");
    expect(
      plan.diagnostics.some((item) => item.message.includes("one ControlNet")),
    ).toBe(true);
  });

  it("compiles imported masks bound to the image being edited", () => {
    const flow = flowFor("canny");
    const edit = flow.nodes.find((node) => node.id === "generate")!;
    edit.type = "task.edit-image";
    edit.config = {
      ...createDefaultMediaNodeConfig(edit.type),
      providerPolicy: "local",
      modelId: sd15.id,
    };
    flow.nodes.push(
      {
        id: "mask-image",
        type: "source.image",
        version: 1,
        label: "Mask image",
        layer: "source",
        config: { assetId: "asset:mask" },
      },
      {
        id: "mask-a",
        type: "operation.image-mask",
        version: 1,
        label: "Mask",
        layer: "operation",
        config: { channel: "luminance", invert: false },
      },
      {
        id: "mask-b",
        type: "operation.image-mask",
        version: 1,
        label: "Alpha",
        layer: "operation",
        config: { channel: "alpha", invert: false },
      },
      {
        id: "combine",
        type: "operation.mask-composite",
        version: 1,
        label: "Combine masks",
        layer: "operation",
        config: { operation: "multiply" },
      },
    );
    for (const [source, port, destination, input] of [
      ["image", "image", "generate", "image"],
      ["mask-image", "image", "mask-a", "image"],
      ["image", "image", "mask-a", "reference"],
      ["image", "image", "mask-b", "image"],
      ["mask-a", "mask", "combine", "destination"],
      ["mask-b", "mask", "combine", "source"],
      ["combine", "mask", "generate", "mask"],
    ]) {
      flow.edges.push({
        id: `${source}-${destination}-${input}`,
        fromNodeId: source!,
        fromPortId: port!,
        toNodeId: destination!,
        toPortId: input!,
      });
    }
    const plan = compileMediaFlow({ flow, models: [sd15], compiledAt });
    expect(
      plan.diagnostics.filter((item) => item.severity === "error"),
    ).toEqual([]);
    expect(plan.status).toBe("ready");
    expect(
      plan.steps.filter((step) => step.kind === "prepare-mask"),
    ).toHaveLength(3);
  });
});
