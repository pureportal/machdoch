import type {
  MediaFlow,
  MediaFlowNode,
  MediaModelDescriptor,
  MediaModelAddonDescriptor,
} from "./contracts.js";
import {
  createDefaultMediaNodeConfig,
  getMediaNodeDefinition,
  listMediaNodeDefinitions,
  validateMediaFlowDocument,
} from "./node-registry.js";
import { resolveMediaFlowVariables } from "./variables.js";

export interface MediaFlowAgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface MediaFlowAgentRequest {
  prompt: string;
  flow: MediaFlow;
  messages: MediaFlowAgentMessage[];
  models: Pick<
    MediaModelDescriptor,
    | "id"
    | "displayName"
    | "target"
    | "installed"
    | "configured"
    | "architecture"
    | "capabilities"
  >[];
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
  const flow: MediaFlow = {
    ...base,
    name: graph.name.trim(),
    nodes,
    edges,
    updatedAt: new Date().toISOString(),
  };
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
    ({ type, summary, inputs, outputs, fields }) => ({
      type,
      summary,
      inputs,
      outputs,
      config: createDefaultMediaNodeConfig(type),
      fields: fields.map(({ id, kind, min, max, options, required }) => ({
        id,
        kind,
        min,
        max,
        required,
        options: options?.map((option) => option.value),
      })),
    }),
  );
}

export function validateMediaAgentResources(
  flow: MediaFlow,
  request: MediaFlowAgentRequest,
): void {
  const previousFlow = resolveMediaFlowVariables(request.flow).flow;
  for (const node of resolveMediaFlowVariables(flow).flow.nodes) {
    const previous = previousFlow.nodes.find(
      (entry) => entry.id === node.id && entry.type === node.type,
    );
    for (const field of getMediaNodeDefinition(node.type)?.fields ?? []) {
      const value = node.config[field.id];
      if (
        !value ||
        JSON.stringify(value) === JSON.stringify(previous?.config[field.id])
      )
        continue;
      if (
        field.kind === "model" &&
        typeof value === "string" &&
        !request.models.some((model) => model.id === value)
      ) {
        throw new Error(`Unknown model: ${value}.`);
      }
      if (
        field.kind === "asset" &&
        typeof value === "string" &&
        !request.assets.some((asset) => asset.id === value)
      ) {
        throw new Error(`Unknown asset: ${value}.`);
      }
      if (field.kind === "addons" && Array.isArray(value)) {
        for (const selection of value) {
          if (
            !isRecord(selection) ||
            !request.addons.some((addon) => addon.id === selection.addonId)
          ) {
            throw new Error("The assistant selected an unknown model addon.");
          }
        }
      }
    }
  }
}
