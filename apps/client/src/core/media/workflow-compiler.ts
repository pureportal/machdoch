import { createMediaFlowFingerprint } from "./canonicalize.js";
import {
  createDefaultMediaNodeConfig,
  orderMediaFlowNodes,
  validateMediaFlowDocument,
} from "./node-registry.js";
import { resolveMediaFlowVariables } from "./variables.js";
import type {
  MediaCompiledPlan,
  MediaCompilerDiagnostic,
  MediaFlow,
  MediaFlowNode,
  MediaExecutionStep,
  MediaModelDescriptor,
  MediaModelAddonDescriptor,
} from "./contracts.js";

export const requiresWorkflowCompilation = (flow: MediaFlow): boolean =>
  flow.nodes.some((node) =>
    [
      "task.generate-prompt",
      "operation.segment",
      "operation.visual-check",
      "operation.prepare-mask",
      "operation.upscale",
      "control.repeat",
    ].includes(node.type),
  ) ||
  flow.nodes.filter((node) =>
    ["task.generate-image", "task.edit-image"].includes(node.type),
  ).length > 1 ||
  flow.nodes.filter((node) => node.type === "source.prompt").length > 1;

export const isConnectedMediaFlow = (flow: MediaFlow): boolean =>
  requiresWorkflowCompilation(flow) ||
  flow.nodes.some((node) => node.type === "control.quality-gate");

export const WORKFLOW_EXECUTABLE_TYPES = new Set([
  "source.prompt",
  "source.image",
  "source.seed",
  "task.generate-prompt",
  "task.generate-image",
  "task.edit-image",
  "task.generate-video",
  "operation.segment",
  "operation.visual-check",
  "operation.prepare-mask",
  "operation.upscale",
  "operation.crop",
  "operation.resize",
  "operation.color-adjust",
  "operation.sharpen",
  "operation.subject-cutout",
  "operation.quality-analyze",
  "control.quality-gate",
  "control.repeat",
  "output.asset",
  "output.video",
]);

export function workflowTaskFlow(
  flow: MediaFlow,
  task: MediaFlowNode,
): MediaFlow {
  const inputs = flow.edges.filter(
    (edge) => edge.toNodeId === task.id && edge.toPortId !== "mask",
  );
  const nodes: MediaFlowNode[] = [];
  const edges: MediaFlow["edges"] = [];
  for (const [index, edge] of inputs.entries()) {
    const source = flow.nodes.find((node) => node.id === edge.fromNodeId);
    const type =
      edge.toPortId === "prompt"
        ? "source.prompt"
        : edge.toPortId === "seed"
          ? "source.seed"
          : "source.image";
    const config = {
      ...createDefaultMediaNodeConfig(type),
      ...(source?.type === type ? source.config : {}),
    };
    if (type === "source.prompt") config.prompt ||= "Workflow prompt";
    if (type === "source.image")
      config.assetId ||= `workflow-input:${edge.fromNodeId}:${edge.fromPortId}`;
    const id = `workflow-input-${index}`;
    nodes.push({
      id,
      type,
      version: 1,
      label: source?.label ?? "Input",
      layer: "source",
      config,
    });
    edges.push({
      ...edge,
      id,
      fromNodeId: id,
      fromPortId:
        type === "source.prompt"
          ? "prompt"
          : type === "source.seed"
            ? "seed"
            : "image",
    });
  }
  const outputType =
    task.type === "task.generate-video" ? "output.video" : "output.asset";
  if (
    task.type === "task.generate-video" &&
    !edges.some((edge) => edge.toPortId === "last-frame")
  ) {
    const first = edges.find((edge) => edge.toPortId === "first-frame");
    if (first)
      edges.push({
        ...first,
        id: "workflow-terminal-frame",
        toPortId: "last-frame",
      });
  }
  nodes.push(task, {
    id: "workflow-output",
    type: outputType,
    label: "Output",
    version: 1,
    layer: "output",
    config: {
      ...createDefaultMediaNodeConfig(outputType),
      ...(outputType === "output.video"
        ? { role: task.config.transparentBackground ? "transparent" : "opaque" }
        : {}),
    },
  });
  edges.push({
    id: "workflow-output",
    fromNodeId: task.id,
    fromPortId: outputType === "output.video" ? "video" : "image",
    toNodeId: "workflow-output",
    toPortId: outputType === "output.video" ? "video" : "image",
  });
  return { ...flow, nodes, edges };
}

interface CompileInput {
  flow: MediaFlow;
  models: readonly MediaModelDescriptor[];
  addons?: readonly MediaModelAddonDescriptor[];
  compiledAt: string;
}

export function compileConnectedMediaFlow(
  input: CompileInput,
  compileTask: (input: CompileInput) => MediaCompiledPlan,
): MediaCompiledPlan {
  const { flow, compiledAt } = input;
  const resolved = resolveMediaFlowVariables(flow);
  const effective = resolved.flow;
  const fingerprint = createMediaFlowFingerprint(flow);
  const diagnostics: MediaCompilerDiagnostic[] = [];
  const error = (nodeId: string, message: string) =>
    diagnostics.push({
      code: "NODE_SCHEMA_INVALID",
      severity: "error",
      nodeId,
      message,
    });
  for (const issue of resolved.issues) error(issue.nodeId ?? "", issue.message);
  for (const issue of validateMediaFlowDocument(effective))
    error(issue.nodeId, issue.message);
  const bindings: MediaCompiledPlan["runtimeBindings"] = [];
  const resolvedAddons: MediaCompiledPlan["addons"] = [];
  const steps: MediaExecutionStep[] = [];
  const loop = effective.nodes.find((node) => node.type === "control.repeat");
  const descendants = new Set<string>();
  if (loop) {
    const start = String(loop.config.startNodeId);
    const candidate = effective.nodes.find((node) => node.id === start);
    if (
      !candidate ||
      ![
        "task.generate-image",
        "task.edit-image",
        "task.generate-prompt",
        "operation.resize",
        "operation.upscale",
      ].includes(candidate.type)
    )
      error(loop.id, "Choose the first step to repeat.");
    if (
      loop.config.inputMode === "previous" &&
      candidate?.type !== "task.edit-image"
    )
      error(
        loop.id,
        "Choose an Edit image step to refine its previous result.",
      );
    descendants.add(start);
    for (let count = 0; count < effective.nodes.length; count++)
      for (const edge of effective.edges)
        if (descendants.has(edge.fromNodeId)) descendants.add(edge.toNodeId);
    if (
      !effective.nodes.some(
        (node) =>
          node.type === "control.quality-gate" &&
          node.config.onFailure === "repeat" &&
          descendants.has(node.id),
      )
    )
      error(
        loop.id,
        "Connect a quality gate after the repeated step and choose Repeat loop.",
      );
    const ungated = new Set([start]);
    const gates = new Set(
      effective.nodes
        .filter(
          (node) =>
            node.type === "control.quality-gate" &&
            node.config.onFailure === "repeat",
        )
        .map((node) => node.id),
    );
    for (let count = 0; count < effective.nodes.length; count++)
      for (const edge of effective.edges)
        if (ungated.has(edge.fromNodeId) && !gates.has(edge.fromNodeId))
          ungated.add(edge.toNodeId);
    if (
      effective.nodes.some(
        (node) => node.type.startsWith("output.") && ungated.has(node.id),
      )
    )
      error(loop.id, "Connect repeated outputs through the retry gate.");
  }
  for (const node of orderMediaFlowNodes(effective)) {
    if (!WORKFLOW_EXECUTABLE_TYPES.has(node.type))
      error(node.id, `${node.label} cannot run in a connected workflow.`);
    if (
      [
        "task.generate-image",
        "task.edit-image",
        "task.generate-video",
      ].includes(node.type)
    ) {
      const connectedMask = effective.edges.some(
        (edge) => edge.toNodeId === node.id && edge.toPortId === "mask",
      );
      if (connectedMask) {
        if (node.config.outputFormat !== "png")
          error(node.id, "Choose PNG to preserve pixels outside the mask.");
        if (node.config.transparentBackground === true)
          error(node.id, "Turn off background removal when using a mask.");
        if (node.config.editMask != null)
          error(
            node.id,
            "Remove the painted selection before connecting a mask.",
          );
      }
      if (node.config.outputFormat === "svg")
        error(node.id, "Choose a raster image format for this workflow.");
      if (
        node.config.outputCount !== undefined &&
        node.config.outputCount !== 1
      )
        error(node.id, "Set variants to one per workflow attempt.");
      const taskPlan = compileTask({
        ...input,
        flow: workflowTaskFlow(effective, node),
      });
      diagnostics.push(
        ...taskPlan.diagnostics.map((item) => ({ ...item, nodeId: node.id })),
      );
      resolvedAddons.push(...taskPlan.addons);
      const binding = taskPlan.runtimeBindings?.find(
        (item) => item.nodeId === node.id,
      );
      if (binding) {
        bindings.push(binding);
        if (binding.model.target !== "local")
          error(node.id, "Choose a local model for connected workflows.");
        if (
          connectedMask &&
          !binding.model.capabilities.includes("masked-image-edit")
        )
          error(
            node.id,
            "Choose a model that supports masked edits, such as FLUX.2 klein.",
          );
      }
      steps.push(
        ...taskPlan.steps.filter((step) => step.sourceNodeId === node.id),
      );
    } else {
      const kinds: Partial<
        Record<MediaFlowNode["type"], MediaExecutionStep["kind"]>
      > = {
        "source.prompt": "normalize-prompt",
        "source.image": "resolve-asset",
        "source.seed": "resolve-seed",
        "task.generate-prompt": "generate-prompt",
        "operation.segment": "segment-image",
        "operation.prepare-mask": "prepare-mask",
        "operation.visual-check": "check-image",
        "operation.upscale": "upscale-image",
        "operation.crop": "crop-image",
        "operation.resize": "resize-image",
        "operation.color-adjust": "adjust-color",
        "operation.sharpen": "sharpen-image",
        "operation.subject-cutout": "cutout-subject",
        "operation.quality-analyze": "analyze-quality",
        "control.quality-gate": "evaluate-gate",
        "control.repeat": "repeat-flow",
        "output.asset": "ingest-asset",
        "output.video": "ingest-asset",
      };
      const kind = kinds[node.type];
      if (kind)
        steps.push({
          id: `${node.id}:${kind}`,
          sourceNodeId: node.id,
          kind,
          label: node.label,
          target: "local",
          cacheable: false,
        });
    }
    if (
      [
        "task.generate-prompt",
        "operation.segment",
        "operation.visual-check",
        "operation.upscale",
      ].includes(node.type) &&
      !String(node.config.modelPath ?? "").trim()
    )
      error(node.id, `Choose a model for ${node.label}.`);
    if (node.type === "operation.visual-check") {
      if (
        effective.edges.some(
          (edge) => edge.toNodeId === node.id && edge.toPortId === "mask",
        ) &&
        !effective.edges.some(
          (edge) => edge.toNodeId === node.id && edge.toPortId === "reference",
        )
      )
        error(node.id, "Connect the mask's original image as the reference.");
      const criteria = String(node.config.criteria ?? "")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
      if (
        criteria.length < 1 ||
        criteria.length > 8 ||
        criteria.some((line) => line.length > 500)
      )
        error(
          node.id,
          "Enter one to eight visual criteria, one per line (up to 500 characters each).",
        );
    }
    if (node.type === "operation.prepare-mask") {
      const connected = effective.edges.some(
        (edge) => edge.toNodeId === node.id && edge.toPortId === "mask",
      );
      if (!connected && node.config.editMask == null)
        error(node.id, "Paint a selection or connect a mask.");
      if (connected && node.config.editMask != null)
        error(
          node.id,
          "Remove the painted selection before connecting a mask.",
        );
    }
    if (
      node.type === "operation.segment" &&
      !String(node.config.query ?? "").trim()
    )
      error(node.id, "Enter the object to select.");
    if (
      node.type === "source.prompt" &&
      !String(node.config.prompt ?? "").trim()
    )
      error(node.id, "Enter a prompt.");
    if (
      node.type === "source.image" &&
      !String(node.config.assetId ?? "").trim()
    )
      error(node.id, "Choose an image.");
    if (
      (node.type === "operation.quality-analyze" ||
        node.type === "control.quality-gate") &&
      node.config.profile !== "technical-image-baseline"
    )
      error(node.id, "Choose the Technical image checks profile.");
    if (node.type === "control.quality-gate") {
      if (
        node.config.onFailure === "repeat" &&
        (!loop || !descendants.has(node.id))
      )
        error(node.id, "Add a refinement loop that starts before this gate.");
      if (node.config.onUnknown === "human-review")
        error(node.id, "Choose Stop or Continue for an inconclusive check.");
      const report = effective.edges.find(
        (edge) => edge.toNodeId === node.id && edge.toPortId === "report",
      );
      const analyzed = effective.edges.find(
        (edge) =>
          edge.toNodeId === report?.fromNodeId && edge.toPortId === "image",
      );
      const image = effective.edges.find(
        (edge) => edge.toNodeId === node.id && edge.toPortId === "image",
      );
      if (
        analyzed?.fromNodeId !== image?.fromNodeId ||
        analyzed?.fromPortId !== image?.fromPortId
      )
        error(node.id, "Connect the analyzed image to this gate.");
    }
  }
  if (!effective.nodes.some((node) => node.type.startsWith("output.")))
    error("", "Add an image or video output.");
  const model = bindings[0]?.model ?? null;
  return {
    schemaVersion: 1,
    id: `${flow.id}:${fingerprint.slice(7, 18)}`,
    flowId: flow.id,
    flowFingerprint: fingerprint,
    compiledAt,
    status: diagnostics.some((item) => item.severity === "error")
      ? "blocked"
      : "ready",
    model,
    runtimeBindings: bindings,
    addons: resolvedAddons,
    steps,
    diagnostics,
    preflight: {
      target: "local",
      modelId: model?.id ?? null,
      modelLabel:
        bindings.map((item) => item.model.displayName).join(" → ") ||
        "Local workflow",
      requiresRemoteRequest: false,
      requiresModelDownload: false,
      requiresHumanReview: false,
      remoteUploadAssetIds: [],
      generatedCandidates: Number(loop?.config.maxIterations ?? 1),
      estimatedOutputs: effective.nodes.filter((node) =>
        node.type.startsWith("output."),
      ).length,
      estimatedVramGb:
        Math.max(0, ...bindings.map((item) => item.model.minVramGb ?? 0)) ||
        null,
      estimatedDownloadGb: null,
      costHint: "",
      privacySummary: "Runs on this device.",
    },
  };
}
