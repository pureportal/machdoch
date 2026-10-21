import type { MediaNodeDefinition, MediaNodeFieldDefinition, MediaNodePortDefinition } from "./node-registry.js";
import type { MediaFlowEdge, MediaFlowNode } from "./contracts.js";
import { emptyMediaImageLayout } from "./image-layout.js";

export function mediaImageLayoutInputPorts(node: MediaFlowNode, ports: readonly MediaNodePortDefinition[], edges: readonly MediaFlowEdge[]): readonly MediaNodePortDefinition[] {
  if (node.type !== "task.edit-image" || !edges.some(edge => edge.toNodeId === node.id && edge.toPortId === "layout")) return ports;
  return ports.map(port => port.id === "image" ? { ...port, required: false } : port);
}

export const imageLayoutPort: MediaNodePortDefinition = {
  id: "layout", label: "Layout", dataType: "image-layout", required: false, cardinality: "single", description: "",
};

export const imageLayoutMethodField: MediaNodeFieldDefinition = {
  id: "layoutMethod", label: "Layout method", kind: "select", group: "Basic", required: false,
  defaultValue: "composition", description: "", examples: [],
  options: [
    { value: "composition", label: "Compose", description: "" },
    { value: "native", label: "Native", description: "" },
    { value: "reference", label: "Reference", description: "" },
    { value: "masked", label: "Masked edits", description: "" },
  ],
};

export const IMAGE_LAYOUT_NODE: MediaNodeDefinition = {
  type: "source.image-layout", version: 1, displayName: "Image layout", summary: "", layer: "source",
  category: "Input", paletteVisibility: "default", inputs: [], outputs: [imageLayoutPort],
  privacyEffects: [], costEffects: [],
  fields: [{ id: "imageLayout", label: "Layout", kind: "image-layout", group: "Basic", required: true,
    defaultValue: emptyMediaImageLayout(), description: "", examples: [] }],
};
