import type { RalphFlow } from "../../../../core/ralph.js";
import { createFlowAlias } from "./create-flow-alias.helper";
import { getDefaultCanvasPosition } from "./ralph-canvas-layout.helper";
import { titleFromId } from "./format-ralph-flow-labels.helper";

const createFlowUuid = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `flow-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
};

export const getFlowAlias = (flow: Pick<RalphFlow, "id" | "alias">): string => {
  return flow.alias?.trim() || flow.id;
};

export const createBlankFlow = (alias: string): RalphFlow => {
  const flowAlias = createFlowAlias(alias);
  const flowId = createFlowUuid();
  const now = new Date().toISOString();

  return {
    schemaVersion: 1,
    id: flowId,
    ...(flowAlias ? { alias: flowAlias } : {}),
    name: titleFromId(flowAlias || "ralph-flow"),
    description: "",
    createdAt: now,
    updatedAt: now,
    variables: [],
    blocks: [
      {
        id: "start",
        type: "START",
        title: "Start",
        position: getDefaultCanvasPosition(0),
      },
      {
        id: "end",
        type: "END",
        title: "End",
        position: getDefaultCanvasPosition(1),
        status: "success",
      },
    ],
    edges: [
      {
        id: "start-success-end",
        from: "start",
        fromOutput: "SUCCESS",
        to: "end",
      },
    ],
  };
};
