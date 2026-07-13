import type { ProOptions } from "@xyflow/react";

import type {
  RalphAnnotationTone,
  RalphAskUserMode,
  RalphBlockType,
  RalphInputFieldType,
  RalphUtilityType,
  RalphValidationScope,
} from "../../../../core/ralph.js";
import type { RalphProviderOption } from "./format-ralph-flow-labels.helper";
import {
  RUNNABLE_PROVIDER_ORDER,
  type RuntimeProvider,
} from "../../model-catalog";

export type RalphEditorMode = "design" | "generate" | "run" | "review";
export type RalphAiTarget = "flow" | "prompt-block" | "refactor";
export type RalphAiGenerationMode = "do-it" | "interview";
export type RalphRunPanelTab = "setup" | "live" | "history" | "details";
export type ClipboardCopyState = "idle" | "copied" | "failed";
export type RalphInspectorSectionId =
  | "content"
  | "execution"
  | "behavior"
  | "routes"
  | "advanced";
export type RalphAttachmentSelectionKind = "files" | "folders" | "images";

export const LIVE_VARIABLE_PREVIEW_LIMIT = 6;
export const LIVE_EXPANDED_NODE_PREVIEW_LIMIT = 3;
export const ACTIVE_TASK_REGISTRATION_GRACE_MS = 5_000;

export const EDITOR_MODES: Array<{
  id: RalphEditorMode;
  label: string;
}> = [
  { id: "design", label: "Design" },
  { id: "generate", label: "Generate" },
  { id: "run", label: "Run" },
  { id: "review", label: "Review" },
];

export const BLOCK_ACTIONS: Array<{
  type: RalphBlockType;
  label: string;
}> = [
  { type: "START", label: "Start" },
  { type: "PROMPT", label: "Prompt" },
  { type: "VALIDATOR", label: "Validate" },
  { type: "DECISION", label: "Decision" },
  { type: "PACK", label: "Pack" },
  { type: "ASK_USER", label: "Ask User" },
  { type: "INTERVIEW", label: "Interview" },
  { type: "UTILITY", label: "Utility" },
  { type: "NOTE", label: "Note" },
  { type: "GROUP", label: "Group" },
  { type: "END", label: "End" },
];

export const INPUT_FIELD_TYPE_OPTIONS: Array<{
  value: RalphInputFieldType;
  label: string;
}> = [
  { value: "text", label: "Text" },
  { value: "textarea", label: "Textarea" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Boolean" },
  { value: "select", label: "Select" },
  { value: "multiselect", label: "Multi-select" },
  { value: "url", label: "URL" },
  { value: "path", label: "Path" },
  { value: "file", label: "File" },
  { value: "files", label: "Files" },
  { value: "image", label: "Image" },
  { value: "images", label: "Images" },
];

export const ASK_USER_MODE_OPTIONS: Array<{
  value: RalphAskUserMode;
  label: string;
  help: string;
}> = [
  {
    value: "missingOnly",
    label: "Missing Only",
    help: "Continue automatically when required values are already available.",
  },
  {
    value: "alwaysAsk",
    label: "Always Ask",
    help: "Pause every time this block is reached.",
  },
  {
    value: "confirmOnly",
    label: "Confirm Only",
    help: "Pause for a continue/cancel decision without requiring fields.",
  },
];

export const MCP_BLOCK_ACTIONS: Array<{
  type: RalphBlockType;
  label: string;
}> = [
  { type: "MCP_TOOL", label: "Tool" },
  { type: "MCP_RESOURCE", label: "Resource" },
  { type: "MCP_PROMPT", label: "Prompt" },
];

export const UTILITY_TYPE_OPTIONS: RalphUtilityType[] = [
  "WAIT",
  "HTTP_FETCH",
  "POLL",
  "CONDITION",
  "RUN_COMMAND",
  "READ_FILE",
  "WRITE_FILE",
  "READ_JSON",
  "WRITE_JSON",
  "PATCH_JSON",
  "APPEND_JSONL",
  "READ_JSONL",
  "QUERY_JSONL",
  "FILE_EXISTS",
  "DELETE_FILE",
  "MOVE_FILE",
  "ARCHIVE_FILE",
  "LOOP_COUNTER",
  "PROMPT_JSON",
  "VALIDATOR_JSON",
  "SELECT_JSON_TASK",
  "MARK_JSON_TASK",
  "CHANGE_SCOPE_GUARD",
  "SCAN_SCOPE_EVIDENCE",
  "UPDATE_SCOPE_REGISTRY",
  "SELECT_SCOPE",
  "MARK_SCOPE_RESULT",
  "SEARCH_FILES",
  "RUN_CHECK",
  "UI_ANALYZE",
  "GIT_STATUS",
  "GIT_SNAPSHOT",
  "GIT_DIFF_SUMMARY",
  "DETECT_PROJECT_COMMANDS",
  "SET_VARIABLE",
  "TRANSFORM_JSON",
  "VALIDATE_JSON",
  "FINAL_REPORT",
  "NOTIFY",
];

export const RALPH_INSPECTOR_SECTIONS: Array<{
  id: RalphInspectorSectionId;
  label: string;
}> = [
  { id: "content", label: "Content" },
  { id: "behavior", label: "Behavior" },
  { id: "execution", label: "Execution" },
  { id: "advanced", label: "Advanced" },
  { id: "routes", label: "Routes" },
];

export const RALPH_VARIABLE_SNIPPETS = [
  "{{scope:path=ALL}}",
  "{{lastResult}}",
  "{{lastResultSummary}}",
  "{{targetUrl:url=http://localhost:1420}}",
  "{{verificationCommand:string=pnpm typecheck:ui}}",
] as const;

export const RALPH_EDITOR_SHORTCUTS = [
  ["Save flow", "Ctrl+S"],
  ["Undo", "Ctrl+Z"],
  ["Redo", "Ctrl+Shift+Z"],
  ["Duplicate block", "Ctrl+D"],
  ["Clean layout", "Ctrl+L"],
  ["Run flow", "Ctrl+Enter"],
  ["Remove selection", "Delete"],
] as const;

export const PROVIDER_OPTIONS: readonly RalphProviderOption[] = [
  "default",
  ...RUNNABLE_PROVIDER_ORDER,
];

export const DEFAULT_RUNTIME_PROVIDER_OPTIONS: readonly RuntimeProvider[] = [
  ...RUNNABLE_PROVIDER_ORDER,
];

export const createRalphProviderOptions = (
  providers: readonly RuntimeProvider[],
): RalphProviderOption[] => {
  const options: RalphProviderOption[] = ["default"];
  const seen = new Set<RalphProviderOption>(options);

  for (const provider of providers) {
    if (!seen.has(provider)) {
      options.push(provider);
      seen.add(provider);
    }
  }

  return options;
};

export const VALIDATION_SCOPE_OPTIONS: RalphValidationScope["mode"][] = [
  "sinceLastValidator",
  "previousBlock",
  "selectedBlocks",
  "wholeFlow",
];

export const END_STATUS_OPTIONS = [
  "success",
  "failed",
  "cancelled",
  "review",
] as const;

export const ANNOTATION_TONES: RalphAnnotationTone[] = [
  "slate",
  "amber",
  "sky",
  "lime",
  "rose",
  "violet",
];

export const RALPH_CONTEXT_MENU_WIDTH = 224;
export const RALPH_CONTEXT_SUBMENU_WIDTH = 224;
export const RALPH_CONTEXT_MENU_HEIGHT = 300;
export const RALPH_CONTEXT_MENU_MARGIN = 8;
export const RALPH_VALIDATION_JUMP_DURATION_MS = 220;
export const RALPH_NEW_BLOCK_CENTER_DURATION_MS = 180;
export const RALPH_LAYOUT_FIT_DURATION_MS = 240;
export const RALPH_REACT_FLOW_PRO_OPTIONS = {
  hideAttribution: true,
} satisfies ProOptions;
