import type {
  MediaFlow,
  MediaFlowNode,
  MediaFlowTemplateDescriptor,
} from "./contracts.js";
import { createMediaFlowLayout } from "./compiler.js";
import {
  createDefaultMediaNodeConfig,
  getMediaNodeDefinition,
} from "./node-registry.js";

const node = (
  id: string,
  type: MediaFlowNode["type"],
  label: string,
  config: Record<string, unknown> = {},
): MediaFlowNode => ({
  id,
  type,
  version: 1,
  label,
  layer: getMediaNodeDefinition(type)!.layer,
  config: { ...createDefaultMediaNodeConfig(type), ...config },
});
const edge = (
  from: string,
  to: string,
  port = "image",
  fromPort = port,
): MediaFlow["edges"][number] => ({
  id: `${from}-${fromPort}-${to}-${port}`,
  fromNodeId: from,
  fromPortId: fromPort,
  toNodeId: to,
  toPortId: port,
});

export function createConnectedWorkflowTemplates(): MediaFlowTemplateDescriptor[] {
  const create = (
    id: string,
    name: string,
    nodes: MediaFlowNode[],
    edges: MediaFlow["edges"],
  ): MediaFlowTemplateDescriptor => {
    const createdAt = "2026-09-14T00:00:00.000Z";
    const flow: MediaFlow = {
      schemaVersion: 1,
      id: `template:${id}`,
      name,
      description: "",
      createdAt,
      updatedAt: createdAt,
      variables: [],
      variableBindings: {},
      presets: [],
      activePresetId: null,
      nodes,
      edges,
    };
    return {
      schemaVersion: 1,
      id,
      name,
      category: "Advanced",
      description: "",
      tags: [],
      workflowSummary: "",
      privacySummary: "Runs on this device.",
      remoteCapable: false,
      flow,
      layout: createMediaFlowLayout(flow),
    };
  };
  const selection = (background: boolean) =>
    create(
      background ? "replace-background" : "replace-selected-object",
      background ? "Replace background" : "Change selected object",
      [
        node("brief", "source.prompt", "Image prompt", {
          prompt:
            "Full-length studio photograph of a woman in a red dress, neutral gray background",
        }),
        node("generate", "task.generate-image", "Generate image", {
          providerPolicy: "local",
          outputCount: 1,
        }),
        node(
          "select",
          "operation.segment",
          background ? "Select background" : "Select dress",
          { query: background ? "person" : "dress", invert: background },
        ),
        node("edit-prompt", "source.prompt", "Edit prompt", {
          prompt: background
            ? "Replace the entire background and floor with an outdoor garden and stone path in soft, even daylight. Match the person's lighting. Preserve the person and clothing."
            : "Change the dress color to blue. Preserve the fabric, person, pose, and background.",
        }),
        node("edit", "task.edit-image", "Replace selection", {
          providerPolicy: "local",
          modelId: "local:flux-2-klein-4b",
          outputCount: 1,
          editStrength: background ? 1 : 0.65,
          maskStrength: 1,
        }),
        node("save", "output.asset", "Save image", { outputCount: 1 }),
      ],
      [
        edge("brief", "generate", "prompt"),
        edge("generate", "select"),
        edge("select", "edit"),
        edge("select", "edit", "mask"),
        edge("edit-prompt", "edit", "prompt"),
        edge("edit", "save"),
      ],
    );
  const controlTemplates = (["canny", "depth"] as const).map((kind) =>
    create(
      `controlnet-${kind}`,
      kind === "canny" ? "Generate from edges" : "Generate from depth",
      [
        node("image", "source.image", "Reference image"),
        node(
          "guide",
          kind === "canny" ? "operation.canny" : "operation.depth-map",
          kind === "canny" ? "Canny edges" : "Depth map",
        ),
        node("control", "operation.controlnet", "Apply ControlNet", { kind }),
        node("prompt", "source.prompt", "Prompt"),
        node("generate", "task.generate-image", "Generate image", {
          providerPolicy: "local",
        }),
        node("save", "output.asset", "Save image"),
      ],
      [
        edge("image", "guide"),
        edge("guide", "control"),
        edge("control", "generate", "controlnet"),
        edge("prompt", "generate", "prompt"),
        edge("generate", "save"),
      ],
    ),
  );
  return [
    selection(false),
    selection(true),
    create(
      "refine-until-pass",
      "Generate until checks pass",
      [
        node("brief", "source.prompt", "Brief"),
        node("prompt", "task.generate-prompt", "Generate prompt"),
        node("generate", "task.generate-image", "Generate image", {
          providerPolicy: "local",
          outputCount: 1,
        }),
        node("analyze", "operation.quality-analyze", "Analyze quality"),
        node("gate", "control.quality-gate", "Quality gate", {
          onUnknown: "fail",
          onFailure: "repeat",
        }),
        node("repeat", "control.repeat", "Refinement loop", {
          startNodeId: "prompt",
        }),
        node("save", "output.asset", "Save image", { outputCount: 1 }),
      ],
      [
        edge("brief", "prompt", "prompt"),
        edge("prompt", "generate", "prompt"),
        edge("generate", "analyze"),
        edge("generate", "gate"),
        edge("analyze", "gate", "report"),
        edge("gate", "save"),
      ],
    ),
    create(
      "upscale-and-animate",
      "Upscale and animate",
      [
        node("image", "source.image", "Source image"),
        node("upscale", "operation.upscale", "AI upscale"),
        node("motion", "source.prompt", "Motion prompt", {
          prompt:
            "Subtle natural motion, stable camera, preserve the subject and composition",
        }),
        node("video", "task.generate-video", "Animate image", {
          providerPolicy: "local",
          modelId: "local:hunyuan-video-1.5-i2v-step-distilled",
          transparentBackground: false,
          loopMode: "none",
          resolution: "preview-512",
          numFrames: 17,
          numInferenceSteps: 8,
          fps: 8,
          guidanceScale: 1,
        }),
        node("save-image", "output.asset", "Save image", { outputCount: 1 }),
        node("save-video", "output.video", "Save video", { role: "opaque" }),
      ],
      [
        edge("image", "upscale"),
        edge("upscale", "video", "first-frame", "image"),
        edge("motion", "video", "prompt"),
        edge("upscale", "save-image"),
        edge("video", "save-video", "video"),
      ],
    ),
    create(
      "refine-selected-edit",
      "Refine a selected edit",
      [
        node("image", "source.image", "Source image"),
        node("mask", "operation.prepare-mask", "Prepare mask"),
        node("prompt", "source.prompt", "Edit prompt"),
        node("edit", "task.edit-image", "Edit selection", {
          providerPolicy: "local",
          modelId: "local:flux-2-klein-4b",
          outputCount: 1,
        }),
        node("check", "operation.visual-check", "Check image", {
          compareReference: false,
        }),
        node("gate", "control.quality-gate", "Quality gate", {
          onFailure: "repeat",
        }),
        node("repeat", "control.repeat", "Refinement loop", {
          startNodeId: "edit",
          inputMode: "previous",
        }),
        node("save", "output.asset", "Save image", { outputCount: 1 }),
      ],
      [
        edge("image", "mask"),
        edge("mask", "edit"),
        edge("mask", "edit", "mask"),
        edge("prompt", "edit", "prompt"),
        edge("edit", "check"),
        edge("image", "check", "reference", "image"),
        edge("mask", "check", "mask"),
        edge("edit", "gate"),
        edge("check", "gate", "report"),
        edge("gate", "save"),
      ],
    ),
    create(
      "refine-edit-boundary",
      "Refine edit edges",
      [
        node("image", "source.image", "Edited image"),
        node("mask", "operation.prepare-mask", "Select edit boundary", {
          region: "boundary",
          boundaryWidth: 8,
          feather: 2,
        }),
        node("prompt", "source.prompt", "Edge correction", {
          prompt:
            "Blend the subject edges naturally into the existing background. Remove color fringes and halos. Match nearby lighting. Preserve the subject, clothing, and composition.",
        }),
        node("edit", "task.edit-image", "Refine edges", {
          providerPolicy: "local",
          modelId: "local:flux-2-klein-4b",
          outputCount: 1,
          maskStrength: 0.5,
        }),
        node("check", "operation.visual-check", "Check edges", {
          compareReference: false,
          criteria:
            "Subject edges have no visible halo or color fringe.\nLighting at the subject boundary is consistent with the surrounding scene.",
        }),
        node("gate", "control.quality-gate", "Quality gate", {
          onFailure: "repeat",
        }),
        node("repeat", "control.repeat", "Refinement loop", {
          startNodeId: "edit",
          inputMode: "previous",
        }),
        node("save", "output.asset", "Save image", { outputCount: 1 }),
      ],
      [
        edge("image", "mask"),
        edge("mask", "edit"),
        edge("mask", "edit", "mask"),
        edge("prompt", "edit", "prompt"),
        edge("edit", "check"),
        edge("image", "check", "reference", "image"),
        edge("mask", "check", "mask"),
        edge("edit", "gate"),
        edge("check", "gate", "report"),
        edge("gate", "save"),
      ],
    ),
    ...controlTemplates,
  ];
}
