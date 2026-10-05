import type {
  MediaFlow,
  MediaFlowNode,
  MediaModelDescriptor,
  MediaModelAddonDescriptor,
  MediaAssetRecord,
  MediaModelAddonSelection,
} from "./contracts.js";
import {
  createDefaultMediaNodeConfig,
  getMediaNodeDefinition,
  listMediaNodeDefinitions,
  validateMediaFlowDocument,
} from "./node-registry.js";
import { resolveMediaFlowVariables } from "./variables.js";
import { isMediaPoseMap, type MediaPoseMap } from "./pose-map.js";
import { mediaImageSamplingConstraints } from "./image-sampling.js";

export interface MediaFlowAgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface MediaFlowAgentRequest {
  prompt: string;
  flow: MediaFlow;
  messages: MediaFlowAgentMessage[];
  models: (Pick<
    MediaModelDescriptor,
    | "id"
    | "displayName"
    | "target"
    | "installed"
    | "configured"
    | "architecture"
    | "capabilities"
    | "addonCapabilities"
  > & {
    samplingConstraints?: ReturnType<typeof mediaImageSamplingConstraints>;
  })[];
  addons: Pick<
    MediaModelAddonDescriptor,
    | "id"
    | "displayName"
    | "kind"
    | "architecture"
    | "triggerWords"
    | "defaultToken"
  >[];
  assets: { id: string; kind: string; width: number; height: number }[];
}

export interface MediaFlowAgentResult {
  message: string;
  flow: MediaFlow | null;
  poseMaps: { id: string; map: MediaPoseMap }[];
}

export function createMediaFlowAgentRequest({
  prompt,
  flow,
  messages,
  models,
  addons,
  assets,
}: {
  prompt: string;
  flow: MediaFlow;
  messages: MediaFlowAgentMessage[];
  models: readonly MediaModelDescriptor[];
  addons: readonly MediaModelAddonDescriptor[];
  assets: readonly MediaAssetRecord[];
}): MediaFlowAgentRequest {
  return {
    prompt,
    flow,
    messages: messages.slice(-40),
    models: models.map(
      ({
        id,
        displayName,
        target,
        installed,
        configured,
        architecture,
        capabilities,
        addonCapabilities,
      }) => ({
        id,
        displayName,
        target,
        installed,
        configured,
        architecture,
        capabilities,
        addonCapabilities,
        ...(target === "local" && capabilities.includes("text-to-image")
          ? { samplingConstraints: mediaImageSamplingConstraints(architecture) }
          : {}),
      }),
    ),
    addons: addons.map(
      ({
        id,
        displayName,
        kind,
        architecture,
        triggerWords,
        defaultToken,
      }) => ({
        id,
        displayName,
        kind,
        architecture,
        triggerWords,
        defaultToken,
      }),
    ),
    assets: assets.map(({ id, kind, width, height }) => ({
      id,
      kind,
      width,
      height,
    })),
  };
}

export function validateMediaAgentPoseMaps(
  value: unknown,
  flow: MediaFlow | null,
): { id: string; map: MediaPoseMap }[] {
  if (!Array.isArray(value) || value.length > 4)
    throw new Error("The assistant returned invalid pose maps.");
  const ids = new Set<string>();
  const maps = value.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 2 ||
      typeof entry.id !== "string" ||
      !/^[a-z0-9-]{1,64}$/u.test(entry.id) ||
      ids.has(entry.id) ||
      !isMediaPoseMap(entry.map)
    )
      throw new Error("The assistant returned an invalid pose map.");
    ids.add(entry.id);
    return { id: entry.id, map: entry.map };
  });
  const poseSources =
    flow?.nodes.filter(
      (node) =>
        node.type === "source.image" &&
        String(node.config.assetId ?? "").startsWith("pose-map:"),
    ) ?? [];
  const referenced = new Set(
    poseSources.map((node) => String(node.config.assetId)),
  );
  if (
    referenced.size !== maps.length ||
    maps.some((entry) => !referenced.has(`pose-map:${entry.id}`))
  )
    throw new Error(
      "Every generated pose map must be a connected pose source for an image task.",
    );
  for (const source of poseSources) {
    const targets =
      flow?.edges
        .filter(
          (edge) =>
            edge.fromNodeId === source.id &&
            edge.fromPortId === "image" &&
            edge.toPortId === "image",
        )
        .flatMap((edge) =>
          flow.nodes.filter(
            (node) =>
              node.id === edge.toNodeId &&
              (node.type === "task.generate-image" ||
                node.type === "task.edit-image"),
          ),
        ) ?? [];
    if (source.config.referenceRole !== "pose" || targets.length === 0)
      throw new Error(
        "Every generated pose map must be a connected pose source for an image task.",
      );
    const map = maps.find(
      (entry) => source.config.assetId === `pose-map:${entry.id}`,
    )?.map;
    if (
      targets.some((target) => target.config.aspectRatio !== map?.aspectRatio)
    )
      throw new Error(
        "A generated pose map must match the image task aspect ratio.",
      );
  }
  return maps;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseMediaAgentGraph(
  graphJson: string,
  base: MediaFlow,
): MediaFlow {
  const graph: unknown = JSON.parse(graphJson);
  if (
    !isRecord(graph) ||
    typeof graph.name !== "string" ||
    !graph.name.trim() ||
    graph.name.length > 160 ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges) ||
    graph.nodes.length === 0 ||
    graph.nodes.length > 200 ||
    graph.edges.length > 1000
  ) {
    throw new Error("The assistant returned an invalid flow document.");
  }
  const nodes: MediaFlowNode[] = graph.nodes.map((node: unknown) => {
    if (
      !isRecord(node) ||
      typeof node.id !== "string" ||
      !node.id.trim() ||
      typeof node.type !== "string" ||
      typeof node.label !== "string" ||
      !isRecord(node.config)
    ) {
      throw new Error("The assistant returned an invalid node.");
    }
    const definition = listMediaNodeDefinitions().find(
      (entry) => entry.type === node.type,
    );
    if (!definition) throw new Error(`Unknown node type: ${node.type}.`);
    const previous = base.nodes.find(
      (entry) => entry.id === node.id && entry.type === definition.type,
    );
    return {
      id: node.id,
      type: definition.type,
      label: node.label,
      version: 1,
      layer: definition.layer,
      config: {
        ...(previous?.config ?? createDefaultMediaNodeConfig(definition.type)),
        ...node.config,
      },
    };
  });
  const edges = graph.edges.map((edge: unknown) => {
    if (
      !isRecord(edge) ||
      !["id", "fromNodeId", "fromPortId", "toNodeId", "toPortId"].every(
        (key) => typeof edge[key] === "string" && (edge[key] as string).trim(),
      )
    ) {
      throw new Error("The assistant returned an invalid connection.");
    }
    return {
      id: edge.id as string,
      fromNodeId: edge.fromNodeId as string,
      fromPortId: edge.fromPortId as string,
      toNodeId: edge.toNodeId as string,
      toPortId: edge.toPortId as string,
    };
  });
  const flow: MediaFlow = structuredClone({
    ...base,
    name: graph.name.trim(),
    nodes,
    edges,
    updatedAt: new Date().toISOString(),
  });
  const unknownVariable = resolveMediaFlowVariables(flow).issues.find(
    (issue) => issue.code === "VARIABLE_REFERENCE_UNKNOWN",
  );
  if (unknownVariable) throw new Error(unknownVariable.message);
  const issues = validateMediaFlowDocument(flow);
  if (issues.length)
    throw new Error(issues.map((issue) => issue.message).join("\n"));
  return flow;
}

export function createMediaAgentNodeContext() {
  return listMediaNodeDefinitions().map(
    ({ type, displayName, summary, inputs, outputs, fields }) => ({
      type,
      displayName,
      summary,
      inputs,
      outputs,
      config: createDefaultMediaNodeConfig(type),
      fields: fields.map(
        ({
          id,
          label,
          description,
          kind,
          min,
          max,
          step,
          integer,
          maxLength,
          allowEmpty,
          readOnly,
          visibleWhen,
          options,
          required,
        }) => ({
          id,
          label,
          description,
          kind,
          min,
          max,
          step,
          integer,
          maxLength,
          allowEmpty,
          readOnly,
          visibleWhen,
          required,
          options: options?.map((option) => option.value),
          ...(kind === "addons" ? {
            selectionExamples: [
              {
                kind: "lora", addonId: "<supplied addon id>", enabled: true,
                modelStrength: 1, textEncoderStrength: null, denoisingSchedule: null,
              },
              {
                kind: "textual-inversion", addonId: "<supplied addon id>", enabled: true,
                token: "<supplied embedding token>", placement: "positive",
              },
            ] satisfies MediaModelAddonSelection[],
          } : {}),
        }),
      ),
    }),
  );
}

export function validateMediaAgentResources(
  flow: MediaFlow,
  request: MediaFlowAgentRequest,
  generatedPoseIds: readonly string[] = [],
): void {
  const previousFlow = resolveMediaFlowVariables(request.flow).flow;
  for (const node of resolveMediaFlowVariables(flow).flow.nodes) {
    const previous = previousFlow.nodes.find(
      (entry) => entry.id === node.id && entry.type === node.type,
    );
    for (const field of getMediaNodeDefinition(node.type)?.fields ?? []) {
      const value = node.config[field.id];
      if (!value) continue;
      const unchanged =
        JSON.stringify(value) === JSON.stringify(previous?.config[field.id]);
      const modelIds =
        field.kind === "model" && typeof value === "string"
          ? [value]
          : field.kind === "model-priority" && Array.isArray(value)
            ? value
            : [];
      if (!unchanged) {
        for (const modelId of modelIds) {
          if (!request.models.some((model) => model.id === modelId))
            throw new Error(`Unknown model: ${modelId}.`);
        }
      }
      if (
        field.kind === "asset" &&
        typeof value === "string" &&
        !generatedPoseIds.some((id) => value === `pose-map:${id}`)
      ) {
        const asset = request.assets.find((entry) => entry.id === value);
        if (!asset && !unchanged) throw new Error(`Unknown asset: ${value}.`);
        if (
          asset &&
          ["source.image", "source.audio", "source.video"].includes(node.type) &&
          node.type !== `source.${asset.kind}`
        )
          throw new Error(`Choose ${node.type === "source.video" ? "a video" : node.type === "source.audio" ? "an audio" : "an image"} asset: ${value}.`);
      }
      if (field.kind === "addons" && Array.isArray(value)) {
        for (const selection of value) {
          if (!isRecord(selection))
            throw new Error("The assistant selected an invalid model addon.");
          const addon = request.addons.find(
            (entry) => entry.id === selection.addonId,
          );
          if (!addon && !unchanged)
            throw new Error("The assistant selected an unknown model addon.");
          if (addon && addon.kind !== selection.kind)
            throw new Error(
              "The assistant selected the wrong model addon type.",
            );
        }
      }
    }
  }
}
