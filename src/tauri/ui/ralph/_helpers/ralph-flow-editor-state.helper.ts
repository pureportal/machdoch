import type { NodeChange } from "@xyflow/react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type {
  RalphFlow,
  RalphFlowBlock,
  RalphInputField,
  RalphPosition,
  RalphUtilityType,
} from "../../../../core/ralph.js";
import type { RalphCanvasNode } from "./ralph-canvas-layout.helper";
import {
  RALPH_CONTEXT_MENU_HEIGHT,
  RALPH_CONTEXT_MENU_MARGIN,
  RALPH_CONTEXT_MENU_WIDTH,
} from "./ralph-flow-editor-options.helper";
import {
  formatUtilityTypeLabel,
  titleFromId,
} from "./format-ralph-flow-labels.helper";

export interface RalphPersistedFlowValidationResult {
  validation: {
    errors: readonly unknown[];
    warnings: readonly unknown[];
  };
}

export interface RalphCanvasMenuPlacement {
  left: number;
  top: number;
}

export const MAX_RALPH_HISTORY_ENTRIES = 80;

export const createSetupVariableErrorId = (variableName: string): string =>
  `ralph-variable-${variableName.replace(/[^A-Za-z0-9_-]+/gu, "_") || "value"}-error`;

export const createUniqueInputFieldId = (
  fields: readonly RalphInputField[],
  baseId = "field",
): string => {
  const existingIds = new Set(fields.map((field) => field.id));

  if (!existingIds.has(baseId)) {
    return baseId;
  }

  for (let index = fields.length + 1; index < 1_000; index += 1) {
    const candidate = `${baseId}_${index}`;

    if (!existingIds.has(candidate)) {
      return candidate;
    }
  }

  return `${baseId}_${Date.now()}`;
};

export const createDefaultInputField = (
  fields: readonly RalphInputField[],
): RalphInputField => {
  const id = createUniqueInputFieldId(fields);

  return {
    id,
    label: titleFromId(id),
    type: "text",
    required: false,
    skippable: false,
    variableName: id.replace(/-/gu, "_"),
  };
};

export const getCanvasMenuPlacement = (
  event: ReactMouseEvent | MouseEvent,
  options: {
    estimatedWidth?: number;
    estimatedHeight?: number;
  } = {},
): RalphCanvasMenuPlacement => {
  const margin = RALPH_CONTEXT_MENU_MARGIN;
  const estimatedWidth = options.estimatedWidth ?? RALPH_CONTEXT_MENU_WIDTH;
  const estimatedHeight = options.estimatedHeight ?? RALPH_CONTEXT_MENU_HEIGHT;
  const maxLeft =
    typeof window === "undefined"
      ? event.clientX
      : Math.max(margin, window.innerWidth - estimatedWidth - margin);
  const menuHeight =
    typeof window === "undefined"
      ? estimatedHeight
      : Math.min(estimatedHeight, window.innerHeight - margin * 2);
  const maxTop =
    typeof window === "undefined"
      ? event.clientY
      : Math.max(margin, window.innerHeight - menuHeight - margin);

  return {
    left: Math.max(margin, Math.min(event.clientX, maxLeft)),
    top: Math.max(margin, Math.min(event.clientY, maxTop)),
  };
};

export const isEditableShortcutTarget = (target: EventTarget | null): boolean => {
  if (
    typeof HTMLElement === "undefined" ||
    !(target instanceof HTMLElement)
  ) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
};

export const formatSaveFlowMessage = (
  result: RalphPersistedFlowValidationResult,
): string => {
  if (result.validation.errors.length > 0) {
    return `Saved with ${result.validation.errors.length} error(s). Fix them before running.`;
  }

  if (result.validation.warnings.length > 0) {
    return `Saved with ${result.validation.warnings.length} warning(s).`;
  }

  return "Flow saved.";
};

export const formatRevisionDate = (createdAt: string): string => {
  const date = new Date(createdAt);

  if (Number.isNaN(date.getTime())) {
    return createdAt;
  }

  return date.toLocaleString();
};

export const updatePromptLikeText = (
  block: RalphFlowBlock,
  prompt: string,
): RalphFlowBlock => {
  switch (block.type) {
    case "PROMPT":
    case "VALIDATOR":
    case "DECISION":
    case "INTERVIEW":
      return { ...block, prompt };
    case "ASK_USER":
      return { ...block, prompt };
    case "NOTE":
      return { ...block, text: prompt };
    case "GROUP":
      return { ...block, description: prompt };
    case "START":
    case "PACK":
    case "UTILITY":
    case "MCP_TOOL":
    case "MCP_RESOURCE":
    case "MCP_PROMPT":
    case "MEDIA_FLOW":
    case "END":
      return block;
  }
};

export const shouldSyncUtilityTitle = (
  title: string,
  previousType: RalphUtilityType,
): boolean => {
  const trimmedTitle = title.trim();

  return (
    trimmedTitle.length === 0 ||
    /^Utility(?:\s+\d+)?$/iu.test(trimmedTitle) ||
    trimmedTitle === formatUtilityTypeLabel(previousType)
  );
};

export const isGroupChildMoveSuppressed = (event: MouseEvent | TouchEvent): boolean => {
  return "ctrlKey" in event && event.ctrlKey;
};

export const getFlowSnapshot = (flow: RalphFlow | null): string => {
  return flow ? JSON.stringify(flow) : "";
};

export const getFlowLayoutKey = (flow: RalphFlow | null): string => {
  if (!flow) {
    return "";
  }

  return flow.blocks
    .map((block) => {
      const x = block.position?.x ?? "auto";
      const y = block.position?.y ?? "auto";

      return `${block.id}:${x}:${y}`;
    })
    .join("|");
};

export const getCanvasNodePositions = (
  nodes: RalphCanvasNode[],
): Map<string, RalphCanvasNode["position"]> => {
  return new Map(nodes.map((node) => [node.id, node.position]));
};

export const arePositionsEqual = (
  current: RalphPosition | undefined,
  next: RalphCanvasNode["position"],
): boolean => {
  if (!current) {
    return false;
  }

  return current.x === next.x && current.y === next.y;
};

export const areSizesEqual = (
  current: RalphFlowBlock["size"] | undefined,
  next: { width: number; height: number },
): boolean => {
  if (!current) {
    return false;
  }

  return current.width === next.width && current.height === next.height;
};

export const isLockedNodePositionChange = (
  change: NodeChange<RalphCanvasNode>,
  lockedBlockIds: ReadonlySet<string>,
): boolean => {
  return change.type === "position" && lockedBlockIds.has(change.id);
};
