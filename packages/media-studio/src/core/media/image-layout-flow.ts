import type { ImageRecipeSettings, MediaFlow, MediaFlowEdge, MediaFlowNode } from "./contracts.js";
import { mediaImageLayoutError, parseMediaImageLayout, type MediaImageLayoutMethod } from "./image-layout.js";

export function attachMediaImageLayout(nodes: MediaFlowNode[], edges: MediaFlowEdge[], taskId: string, settings: ImageRecipeSettings): void {
  if (!settings.imageLayout) return;
  if (!settings.layoutMethod) throw new Error("Choose a layout method.");
  const task = nodes.find((node) => node.id === taskId)!;
  task.config.layoutMethod = settings.layoutMethod;
  nodes.push({ id: "image-layout", type: "source.image-layout", label: "Layout", layer: "source", version: 1,
    config: { imageLayout: parseMediaImageLayout(settings.imageLayout) } });
  edges.push({ id: "layout-to-image", fromNodeId: "image-layout", fromPortId: "layout", toNodeId: taskId, toPortId: "layout" });
}

export function readMediaImageLayoutSettings(flow: MediaFlow, task: MediaFlowNode): Pick<ImageRecipeSettings, "imageLayout" | "layoutMethod"> {
  const edge = flow.edges.find((entry) => entry.toNodeId === task.id && entry.toPortId === "layout");
  if (!edge) return {};
  const value = flow.nodes.find((node) => node.id === edge.fromNodeId)?.config.imageLayout;
  if (mediaImageLayoutError(value)) return {};
  return { imageLayout: parseMediaImageLayout(value), layoutMethod: task.config.layoutMethod as MediaImageLayoutMethod };
}
