import type { MediaFlow } from "./contracts.js";
import { resolveMediaFlowVariables } from "./variables.js";

export const resolveMediaNodePrompt = (flow: MediaFlow, nodeId: string) => {
  const resolved = resolveMediaFlowVariables(flow).flow;
  const node = resolved.nodes.find((entry) => entry.id === nodeId);
  const connections = resolved.edges.filter(
    (edge) => edge.toNodeId === nodeId && edge.toPortId === "prompt",
  );
  const source =
    connections.length === 1
      ? resolved.nodes.find((entry) => entry.id === connections[0]!.fromNodeId)
      : null;
  return {
    sourceNodeId: source?.type === "source.prompt" ? source.id : null,
    prompt:
      source?.type === "source.prompt" &&
      typeof source.config.prompt === "string"
        ? source.config.prompt
        : null,
    negativePrompt:
      typeof node?.config.negativePrompt === "string"
        ? node.config.negativePrompt
        : "",
  };
};
