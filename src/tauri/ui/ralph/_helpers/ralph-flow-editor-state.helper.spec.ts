import type { NodeChange } from "@xyflow/react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type {
  RalphFlow,
  RalphFlowBlock,
  RalphInputField,
  RalphPromptBlock,
} from "../../../../core/ralph.js";
import { RALPH_FLOW_SCHEMA_VERSION } from "../../../../core/ralph.js";
import {
  arePositionsEqual,
  areSizesEqual,
  createDefaultInputField,
  createSetupVariableErrorId,
  createUniqueInputFieldId,
  formatSaveFlowMessage,
  getCanvasMenuPlacement,
  getFlowLayoutKey,
  getFlowSnapshot,
  isEditableShortcutTarget,
  isLockedNodePositionChange,
  shouldSyncUtilityTitle,
  updatePromptLikeText,
} from "./ralph-flow-editor-state.helper";
import type { RalphCanvasNode } from "./ralph-canvas-layout.helper";

const createPromptBlock = (patch: Partial<RalphPromptBlock> = {}): RalphPromptBlock => ({
  id: "prompt",
  type: "PROMPT",
  title: "Prompt",
  prompt: "old prompt",
  position: { x: 10, y: 20 },
  ...patch,
});

describe("Ralph flow editor state helpers", () => {
  it("creates stable variable error ids and default input fields", () => {
    const existingFields: RalphInputField[] = [
      {
        id: "field",
        label: "Field",
        type: "text",
        required: false,
        skippable: false,
        variableName: "field",
      },
    ];

    expect(createSetupVariableErrorId("needs value")).toBe(
      "ralph-variable-needs_value-error",
    );
    expect(createSetupVariableErrorId("")).toBe("ralph-variable-value-error");
    expect(createUniqueInputFieldId(existingFields)).toBe("field_2");
    expect(createDefaultInputField(existingFields)).toMatchObject({
      id: "field_2",
      label: "Field_2",
      type: "text",
      variableName: "field_2",
    });
  });

  it("formats save results without depending on the runtime result object", () => {
    expect(
      formatSaveFlowMessage({
        validation: { errors: ["missing target"], warnings: [] },
      }),
    ).toBe("Saved with 1 error(s). Fix them before running.");
    expect(
      formatSaveFlowMessage({
        validation: { errors: [], warnings: ["unused route"] },
      }),
    ).toBe("Saved with 1 warning(s).");
    expect(
      formatSaveFlowMessage({
        validation: { errors: [], warnings: [] },
      }),
    ).toBe("Flow saved.");
  });

  it("updates only prompt-like block text fields", () => {
    expect(updatePromptLikeText(createPromptBlock(), "next")).toMatchObject({
      prompt: "next",
    });

    const noteBlock: RalphFlowBlock = {
      id: "note",
      type: "NOTE",
      title: "Note",
      text: "old note",
      position: { x: 0, y: 0 },
    };
    expect(updatePromptLikeText(noteBlock, "next")).toMatchObject({
      text: "next",
    });

    const startBlock: RalphFlowBlock = {
      id: "start",
      type: "START",
      title: "Start",
      position: { x: 0, y: 0 },
    };
    expect(updatePromptLikeText(startBlock, "next")).toBe(startBlock);
  });

  it("recognizes default utility titles that should follow utility type changes", () => {
    expect(shouldSyncUtilityTitle("", "WAIT")).toBe(true);
    expect(shouldSyncUtilityTitle("Utility 2", "WAIT")).toBe(true);
    expect(shouldSyncUtilityTitle("Wait", "WAIT")).toBe(true);
    expect(shouldSyncUtilityTitle("Custom title", "WAIT")).toBe(false);
  });

  it("builds flow snapshots and layout keys from persisted flow data", () => {
    const flow: RalphFlow = {
      schemaVersion: RALPH_FLOW_SCHEMA_VERSION,
      id: "flow",
      name: "Flow",
      alias: "flow",
      blocks: [
        createPromptBlock({ id: "first", position: { x: 10, y: 20 } }),
        {
          id: "second",
          type: "PROMPT",
          title: "Prompt",
          prompt: "old prompt",
        },
      ],
      edges: [],
    };

    expect(getFlowSnapshot(null)).toBe("");
    expect(getFlowSnapshot(flow)).toBe(JSON.stringify(flow));
    expect(getFlowLayoutKey(flow)).toBe("first:10:20|second:auto:auto");
  });

  it("compares canvas positions, sizes, and locked position changes", () => {
    const position = { x: 4, y: 8 };
    const size = { width: 120, height: 80 };
    const change: NodeChange<RalphCanvasNode> = {
      type: "position",
      id: "locked",
      position,
    };

    expect(arePositionsEqual(position, { x: 4, y: 8 })).toBe(true);
    expect(arePositionsEqual(undefined, { x: 4, y: 8 })).toBe(false);
    expect(areSizesEqual(size, { width: 120, height: 80 })).toBe(true);
    expect(areSizesEqual(undefined, { width: 120, height: 80 })).toBe(false);
    expect(isLockedNodePositionChange(change, new Set(["locked"]))).toBe(true);
    expect(isLockedNodePositionChange(change, new Set(["other"]))).toBe(false);
  });

  it("uses pointer coordinates for canvas context menus outside a browser viewport", () => {
    const placement = getCanvasMenuPlacement(
      { clientX: 500, clientY: 500 } as ReactMouseEvent,
      { estimatedWidth: 100, estimatedHeight: 80 },
    );

    expect(placement).toEqual({ left: 500, top: 500 });
  });

  it("treats missing DOM targets as non-editable", () => {
    expect(isEditableShortcutTarget(null)).toBe(false);
    expect(isEditableShortcutTarget({} as EventTarget)).toBe(false);
  });
});
