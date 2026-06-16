import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ToolCallEffect,
  ToolRiskLevel,
} from "../types.js";
import type { ToolName } from "../runtime-contract.generated.js";
import {
  coerceBoolean,
  coerceString,
  createToolErrorResult,
  normalizeWorkspacePath,
  resolveWorkspaceTarget,
  type AgentToolDefinition,
} from "./agent-tools-shared.js";
import {
  compactTraceText,
  createTextSection,
  limitText,
  stringifyUnknown,
} from "./runtime-text.js";

const MAX_RECORDING_STEPS = 200;
const MAX_RECORDED_OUTPUT_CHARS = 800;
const MAX_ARTIFACT_NAME_LENGTH = 80;
const DEFAULT_RECORDING_NAME = "Recorded UI workflow";

const MACRO_RECORDING_SCOPES = [
  "browser",
  "desktop",
  "browser-and-desktop",
] as const;
const MACRO_ARTIFACT_KINDS = ["prompt", "skill", "both"] as const;

type MacroRecordingScope = (typeof MACRO_RECORDING_SCOPES)[number];
type MacroArtifactKind = (typeof MACRO_ARTIFACT_KINDS)[number];

type MacroRecordingStatus = "recording" | "stopped";

interface RecordedMacroStep {
  index: number;
  kind: MacroStepKind;
  toolName: string;
  backingTool: ToolName;
  riskLevel: ToolRiskLevel;
  effect: ToolCallEffect;
  fragility: MacroStepFragility;
  arguments: Record<string, unknown>;
  recordedAt: number;
  outputSummary: string;
  generatedInputs: string[];
  replayNotes: string[];
}

interface MacroArtifactFile {
  workspacePath: string;
  resolvedPath: string;
  content: string;
}

type MacroStepKind =
  | "action"
  | "assertion"
  | "cleanup"
  | "launch"
  | "navigation"
  | "observation"
  | "session"
  | "wait";

type MacroStepFragility = "low" | "medium" | "high";

interface MacroInputDefinition {
  name: string;
  label: string;
  sourceStep: number;
  sensitive: boolean;
}

interface StructuredMacroWorkflow {
  schema: "machdoch.macroRecording";
  schemaVersion: 2;
  name: string;
  scope: MacroRecordingScope;
  recordedAt: string;
  requirements: {
    tools: ToolName[];
    needsDesktopUiControl: boolean;
    needsBrowserControl: boolean;
  };
  replayPolicy: {
    mode: "agent-adaptive";
    preferSemanticLocators: boolean;
    rediscoverDesktopHandles: boolean;
    verifyAfterSideEffects: boolean;
    redactGeneratedInputs: boolean;
  };
  inputs: MacroInputDefinition[];
  steps: Array<{
    index: number;
    kind: MacroStepKind;
    toolName: string;
    toolGroup: ToolName;
    effect: ToolCallEffect;
    riskLevel: ToolRiskLevel;
    fragility: MacroStepFragility;
    arguments: Record<string, unknown>;
    generatedInputs: string[];
    recordedResultSummary: string;
    replayNotes: string[];
  }>;
}

interface MacroRecording {
  id: string;
  name: string;
  scope: MacroRecordingScope;
  includeReadOnlySteps: boolean;
  includeLaunchCommands: boolean;
  literalTextInputs: boolean;
  status: MacroRecordingStatus;
  startedAt: number;
  stoppedAt?: number;
  steps: RecordedMacroStep[];
}

export interface MacroRecorderToolCallInput {
  toolName: string;
  backingTool: ToolName;
  riskLevel: ToolRiskLevel;
  effect: ToolCallEffect;
  arguments: Record<string, unknown>;
  output: string;
}

const DESKTOP_UI_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_ui_monitors",
  "capture_ui_screen",
  "list_ui_windows",
  "capture_ui_window",
  "click_ui_point",
  "drag_ui_pointer",
  "type_ui_text",
  "press_ui_keys",
  "wait_for_ui_duration",
  "wait_for_ui_window",
  "focus_ui_window",
  "list_windows_controls",
  "click_windows_control",
  "set_windows_control_text",
]);

const DESKTOP_LAUNCH_TOOL_NAMES: ReadonlySet<string> = new Set([
  "start_detached_command",
]);

const TEXT_INPUT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "type_browser_text",
  "type_ui_text",
  "set_windows_control_text",
]);

const recordingStore = new Map<string, MacroRecording>();
let activeRecordingId: string | undefined;

const isMacroRecordingScope = (
  value: string | undefined,
): value is MacroRecordingScope => {
  return (
    value !== undefined &&
    MACRO_RECORDING_SCOPES.includes(value as MacroRecordingScope)
  );
};

const isMacroArtifactKind = (
  value: string | undefined,
): value is MacroArtifactKind => {
  return (
    value !== undefined &&
    MACRO_ARTIFACT_KINDS.includes(value as MacroArtifactKind)
  );
};

const normalizeRecordingId = (value: string | undefined): string => {
  if (value && /^[a-zA-Z0-9_-]{1,64}$/u.test(value)) {
    return value;
  }

  return crypto.randomUUID();
};

const slugifyArtifactName = (value: string): string => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_ARTIFACT_NAME_LENGTH)
    .replace(/-+$/gu, "");

  return slug.length > 0 ? slug : "recorded-ui-workflow";
};

const normalizeArtifactName = (value: string | undefined): string => {
  return slugifyArtifactName(value ?? DEFAULT_RECORDING_NAME);
};

const normalizeDescription = (
  recording: MacroRecording,
  value: string | undefined,
): string => {
  return (
    value ??
    `Replay the recorded ${recording.scope.replace(/-/gu, " ")} workflow "${recording.name}".`
  ).replace(/\s+/gu, " ");
};

const findRecording = (
  recordingId: string | undefined,
): MacroRecording | undefined => {
  if (recordingId) {
    return recordingStore.get(recordingId);
  }

  if (activeRecordingId) {
    return recordingStore.get(activeRecordingId);
  }

  return [...recordingStore.values()].at(-1);
};

const cloneToolArguments = (
  args: Record<string, unknown>,
): Record<string, unknown> => {
  try {
    return JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
  } catch {
    return { ...args };
  }
};

const createGeneratedInputName = (stepIndex: number): string => {
  return `step_${stepIndex}_text`;
};

const createGeneratedInputLabel = (stepIndex: number): string => {
  return `Text for step ${stepIndex}`;
};

const createPromptInputPlaceholder = (
  inputName: string,
  label: string,
): string => {
  return `\${input:${inputName}:${label}}`;
};

const createRedactedOutputSummary = (
  input: MacroRecorderToolCallInput,
  generatedInputs: string[],
  literalTextInputs: boolean,
): string => {
  if (
    !literalTextInputs &&
    TEXT_INPUT_TOOL_NAMES.has(input.toolName) &&
    generatedInputs.length > 0
  ) {
    return `Text input recorded as prompt input ${generatedInputs.join(", ")}; literal tool output redacted.`;
  }

  return limitText(input.output, MAX_RECORDED_OUTPUT_CHARS);
};

const sanitizeRecordedArguments = (
  toolName: string,
  stepIndex: number,
  args: Record<string, unknown>,
  literalTextInputs: boolean,
): {
  arguments: Record<string, unknown>;
  generatedInputs: string[];
} => {
  const clonedArgs = cloneToolArguments(args);

  if (
    literalTextInputs ||
    !TEXT_INPUT_TOOL_NAMES.has(toolName) ||
    typeof clonedArgs.text !== "string"
  ) {
    return {
      arguments: clonedArgs,
      generatedInputs: [],
    };
  }

  const inputName = createGeneratedInputName(stepIndex);

  clonedArgs.text = createPromptInputPlaceholder(
    inputName,
    createGeneratedInputLabel(stepIndex),
  );

  return {
    arguments: clonedArgs,
    generatedInputs: [inputName],
  };
};

const isReadOnlyEffect = (effect: ToolCallEffect): boolean => {
  return effect === "read" || effect === "external-read";
};

const getMacroStepKind = (toolName: string): MacroStepKind => {
  if (
    toolName === "start_browser_session" ||
    toolName === "list_browser_sessions"
  ) {
    return "session";
  }

  if (toolName === "close_browser_session") {
    return "cleanup";
  }

  if (
    toolName === "navigate_browser_page" ||
    toolName === "start_detached_command"
  ) {
    return toolName === "start_detached_command" ? "launch" : "navigation";
  }

  if (
    toolName.startsWith("capture_") ||
    toolName.startsWith("snapshot_") ||
    toolName.startsWith("read_") ||
    toolName.startsWith("inspect_") ||
    toolName.startsWith("list_")
  ) {
    return "observation";
  }

  if (toolName.startsWith("wait_")) {
    return "wait";
  }

  if (toolName.startsWith("compare_")) {
    return "assertion";
  }

  return "action";
};

const isSemanticBrowserLocator = (
  args: Record<string, unknown>,
): boolean => {
  const locatorType = typeof args.locatorType === "string"
    ? args.locatorType
    : undefined;

  return (
    locatorType === "role" ||
    locatorType === "testId" ||
    locatorType === "label" ||
    locatorType === "placeholder" ||
    locatorType === "title" ||
    locatorType === "altText"
  );
};

const isRawBrowserSelector = (args: Record<string, unknown>): boolean => {
  return (
    typeof args.selector === "string" ||
    args.locatorType === "selector"
  );
};

const getMacroStepFragility = (
  toolName: string,
  args: Record<string, unknown>,
): MacroStepFragility => {
  const kind = getMacroStepKind(toolName);

  if (
    toolName === "click_ui_point" ||
    toolName === "drag_ui_pointer" ||
    toolName === "capture_ui_screen"
  ) {
    return "high";
  }

  if (
    toolName === "focus_ui_window" ||
    toolName === "click_windows_control" ||
    toolName === "set_windows_control_text" ||
    typeof args.windowHandle === "string" ||
    typeof args.controlHandle === "string" ||
    typeof args.windowId === "number"
  ) {
    return "medium";
  }

  if (toolName.includes("browser") && isRawBrowserSelector(args)) {
    return "medium";
  }

  if (toolName.includes("browser") && isSemanticBrowserLocator(args)) {
    return "low";
  }

  if (
    kind === "assertion" ||
    kind === "cleanup" ||
    kind === "observation" ||
    kind === "session" ||
    kind === "wait"
  ) {
    return "low";
  }

  return "medium";
};

const createReplayNotes = (
  toolName: string,
  args: Record<string, unknown>,
  fragility: MacroStepFragility,
  generatedInputs: string[],
): string[] => {
  const notes: string[] = [];

  if (generatedInputs.length > 0) {
    notes.push(
      `Substitute prompt input(s) ${generatedInputs.join(", ")} before executing this text step.`,
    );
  }

  if (toolName.includes("browser") && isSemanticBrowserLocator(args)) {
    notes.push(
      "Semantic browser locator recorded; prefer this locator and verify actionability before side effects.",
    );
  } else if (toolName.includes("browser") && isRawBrowserSelector(args)) {
    notes.push(
      "Raw browser selector recorded; inspect the locator before replay because raw selectors are more fragile than role, label, or test id locators.",
    );
  }

  if (
    toolName === "click_ui_point" ||
    toolName === "drag_ui_pointer" ||
    toolName === "capture_ui_screen"
  ) {
    notes.push(
      "Coordinate-based desktop step; recapture the screen/window and adapt coordinates if layout, monitor, DPI, or window position changed.",
    );
  }

  if (
    toolName === "focus_ui_window" ||
    typeof args.windowId === "number" ||
    typeof args.windowHandle === "string" ||
    typeof args.controlHandle === "string"
  ) {
    notes.push(
      "Desktop handles and window ids can be stale; rediscover current windows or controls before replaying this step.",
    );
  }

  if (toolName.startsWith("wait_")) {
    notes.push(
      "Keep this wait as an event-driven stabilization point unless the current UI provides a stronger visible-state wait.",
    );
  }

  if (fragility === "high") {
    notes.push(
      "High-fragility step; verify immediately after execution and stop loudly if the expected state is absent.",
    );
  }

  return notes;
};

const recordingCapturesTool = (
  recording: MacroRecording,
  input: MacroRecorderToolCallInput,
): boolean => {
  if (recording.status !== "recording") {
    return false;
  }

  if (!recording.includeReadOnlySteps && isReadOnlyEffect(input.effect)) {
    return false;
  }

  const isBrowserTool = input.backingTool === "browser";
  const isDesktopTool =
    DESKTOP_UI_TOOL_NAMES.has(input.toolName) ||
    (recording.includeLaunchCommands &&
      DESKTOP_LAUNCH_TOOL_NAMES.has(input.toolName));

  if (recording.scope === "browser") {
    return isBrowserTool;
  }

  if (recording.scope === "desktop") {
    return isDesktopTool;
  }

  return isBrowserTool || isDesktopTool;
};

const formatStepLine = (step: RecordedMacroStep): string => {
  return [
    `${step.index}. ${step.toolName}`,
    `kind=${step.kind}`,
    `tool=${step.backingTool}`,
    `effect=${step.effect}`,
    `fragility=${step.fragility}`,
    `args=${compactTraceText(stringifyUnknown(step.arguments))}`,
  ].join(" | ");
};

const formatRecordingLines = (recording: MacroRecording): string[] => {
  return [
    `id: ${recording.id}`,
    `name: ${recording.name}`,
    `status: ${recording.status}`,
    `scope: ${recording.scope}`,
    `steps: ${recording.steps.length}`,
    `started: ${new Date(recording.startedAt).toISOString()}`,
    ...(recording.stoppedAt
      ? [`stopped: ${new Date(recording.stoppedAt).toISOString()}`]
      : []),
    ...recording.steps.map(formatStepLine),
  ];
};

const collectGeneratedInputs = (recording: MacroRecording): string[] => {
  return Array.from(
    new Set(recording.steps.flatMap((step) => step.generatedInputs)),
  );
};

const collectPromptTools = (recording: MacroRecording): ToolName[] => {
  const tools: ToolName[] = [];

  for (const step of recording.steps) {
    if (!tools.includes(step.backingTool)) {
      tools.push(step.backingTool);
    }
  }

  return tools;
};

const collectMacroInputDefinitions = (
  recording: MacroRecording,
): MacroInputDefinition[] => {
  return recording.steps.flatMap((step) =>
    step.generatedInputs.map((name) => ({
      name,
      label: createGeneratedInputLabel(step.index),
      sourceStep: step.index,
      sensitive: true,
    })),
  );
};

const formatFrontmatterArray = (key: string, values: string[]): string[] => {
  if (values.length === 0) {
    return [];
  }

  return [key + ":", ...values.map((value) => `- ${value}`)];
};

const formatArtifactArgumentValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  return stringifyUnknown(value).replace(/\s+/gu, " ");
};

const formatArtifactArguments = (
  args: Record<string, unknown>,
): string[] => {
  const entries = Object.entries(args);

  if (entries.length === 0) {
    return ["   - none"];
  }

  return entries.map(
    ([key, value]) => `   - ${key}: ${formatArtifactArgumentValue(value)}`,
  );
};

const createStructuredWorkflowData = (
  recording: MacroRecording,
): StructuredMacroWorkflow => {
  const tools = collectPromptTools(recording);

  return {
    schema: "machdoch.macroRecording",
    schemaVersion: 2,
    name: recording.name,
    scope: recording.scope,
    recordedAt: new Date(recording.startedAt).toISOString(),
    requirements: {
      tools,
      needsDesktopUiControl: tools.includes("shell"),
      needsBrowserControl: tools.includes("browser"),
    },
    replayPolicy: {
      mode: "agent-adaptive",
      preferSemanticLocators: true,
      rediscoverDesktopHandles: true,
      verifyAfterSideEffects: true,
      redactGeneratedInputs: !recording.literalTextInputs,
    },
    inputs: collectMacroInputDefinitions(recording),
    steps: recording.steps.map((step) => ({
        index: step.index,
        kind: step.kind,
        toolName: step.toolName,
        toolGroup: step.backingTool,
        effect: step.effect,
        riskLevel: step.riskLevel,
        fragility: step.fragility,
        arguments: step.arguments,
        generatedInputs: step.generatedInputs,
        recordedResultSummary: step.outputSummary,
        replayNotes: step.replayNotes,
      })),
  };
};

const createStructuredWorkflowJson = (recording: MacroRecording): string => {
  return JSON.stringify(createStructuredWorkflowData(recording), null, 2);
};

const createWorkflowBody = (recording: MacroRecording): string => {
  const generatedInputs = collectGeneratedInputs(recording);
  const stepLines = recording.steps.flatMap((step) => [
    `${step.index}. Run \`${step.toolName}\`.`,
    `   Tool group: ${step.backingTool}`,
    `   Effect: ${step.effect}`,
    "   Arguments:",
    ...formatArtifactArguments(step.arguments),
    ...(step.outputSummary
      ? [`   Recorded result: ${compactTraceText(step.outputSummary)}`]
      : []),
  ]);

  return [
    "Replay this recorded browser or desktop workflow with the available machdoch tools.",
    "",
    "Use the recorded steps as the source of truth. If a selector, URL, window title, or control handle has changed, inspect the current UI and use the closest stable equivalent before continuing. After meaningful side effects, wait explicitly and verify with a read, snapshot, or capture step.",
    "Replay from the structured JSON first, then use the prose notes for recovery. For desktop steps, prefer current UI Automation/window-control data over stale coordinates or handles when available.",
    generatedInputs.length > 0
      ? "Typed values are prompt inputs. Pass them as literal values to the recorded tool arguments."
      : "No prompt inputs were generated for this recording.",
    "",
    `Recording name: ${recording.name}`,
    `Recording scope: ${recording.scope}`,
    `Recorded at: ${new Date(recording.startedAt).toISOString()}`,
    "",
    "Steps:",
    ...stepLines,
    "",
    "Recorded tool-call JSON:",
    "```json",
    createStructuredWorkflowJson(recording),
    "```",
  ].join("\n");
};

const createPromptArtifactContent = (
  artifactName: string,
  description: string,
  recording: MacroRecording,
): string => {
  const tools = collectPromptTools(recording);
  const inputs = collectGeneratedInputs(recording);

  return [
    "---",
    `name: ${artifactName}`,
    `description: ${description}`,
    ...formatFrontmatterArray("tools", tools),
    ...formatFrontmatterArray("inputs", inputs),
    "---",
    "",
    createWorkflowBody(recording),
    "",
  ].join("\n");
};

const createMacroSidecarContent = (recording: MacroRecording): string => {
  return `${createStructuredWorkflowJson(recording)}\n`;
};

const createSkillArtifactContent = (
  artifactName: string,
  description: string,
  recording: MacroRecording,
): string => {
  return [
    "---",
    `name: ${artifactName}`,
    `description: ${description}`,
    "user-invocable: true",
    "argument-hint: Optional task-specific inputs for the recorded workflow.",
    "---",
    "",
    `Use this skill when a user asks to run or adapt the recorded workflow "${recording.name}".`,
    "",
    createWorkflowBody(recording),
    "",
  ].join("\n");
};

const resolveArtifactFile = async (
  workspaceRoot: string,
  workspacePath: string,
  content: string,
  overwrite: boolean,
): Promise<MacroArtifactFile> => {
  const target = await resolveWorkspaceTarget(workspaceRoot, workspacePath);

  if (!target.insideWorkspace) {
    throw new Error(
      `Refusing to write \`${workspacePath}\` because it resolves outside the workspace.`,
    );
  }

  if (existsSync(target.resolvedPath) && !overwrite) {
    throw new Error(
      `The artifact \`${workspacePath}\` already exists. Pass overwrite=true to replace it.`,
    );
  }

  return {
    workspacePath: target.workspacePath ?? normalizeWorkspacePath(workspacePath),
    resolvedPath: target.resolvedPath,
    content,
  };
};

const writeArtifactFile = async (
  artifact: MacroArtifactFile,
): Promise<string> => {
  await mkdir(dirname(artifact.resolvedPath), { recursive: true });
  await writeFile(artifact.resolvedPath, artifact.content, "utf8");

  return artifact.workspacePath;
};

const stopRecording = (recording: MacroRecording): void => {
  if (recording.status === "stopped") {
    return;
  }

  recording.status = "stopped";
  recording.stoppedAt = Date.now();

  if (activeRecordingId === recording.id) {
    activeRecordingId = undefined;
  }
};

export const recordMacroToolCall = (
  input: MacroRecorderToolCallInput,
): void => {
  const recording = activeRecordingId
    ? recordingStore.get(activeRecordingId)
    : undefined;

  if (!recording || !recordingCapturesTool(recording, input)) {
    return;
  }

  if (recording.steps.length >= MAX_RECORDING_STEPS) {
    stopRecording(recording);
    return;
  }

  const stepIndex = recording.steps.length + 1;
  const sanitized = sanitizeRecordedArguments(
    input.toolName,
    stepIndex,
    input.arguments,
    recording.literalTextInputs,
  );
  const kind = getMacroStepKind(input.toolName);
  const fragility = getMacroStepFragility(
    input.toolName,
    sanitized.arguments,
  );
  const replayNotes = createReplayNotes(
    input.toolName,
    sanitized.arguments,
    fragility,
    sanitized.generatedInputs,
  );

  recording.steps.push({
    index: stepIndex,
    kind,
    toolName: input.toolName,
    backingTool: input.backingTool,
    riskLevel: input.riskLevel,
    effect: input.effect,
    fragility,
    arguments: sanitized.arguments,
    recordedAt: Date.now(),
    outputSummary: createRedactedOutputSummary(
      input,
      sanitized.generatedInputs,
      recording.literalTextInputs,
    ),
    generatedInputs: sanitized.generatedInputs,
    replayNotes,
  });
};

export const resetMacroRecordingsForTests = (): void => {
  recordingStore.clear();
  activeRecordingId = undefined;
};

export const createMacroRecorderToolDefinitions = (): AgentToolDefinition[] => {
  return [
    {
      spec: {
        name: "start_macro_recording",
        description:
          "Start recording successful browser and/or desktop UI tool calls into an in-memory workflow macro. After starting, run the browser or desktop workflow once, then call save_macro_recording to write a reusable .machdoch prompt or skill.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            recordingId: {
              type: "string",
              description:
                "Optional stable recording id with letters, numbers, underscores, or dashes.",
            },
            name: {
              type: "string",
              description: "Human-readable workflow name.",
            },
            scope: {
              type: "string",
              enum: MACRO_RECORDING_SCOPES,
              description:
                "Which tool calls to capture. Defaults to browser-and-desktop.",
            },
            includeReadOnlySteps: {
              type: "boolean",
              description:
                "Whether captures, snapshots, reads, and waits are recorded. Defaults to true.",
            },
            includeLaunchCommands: {
              type: "boolean",
              description:
                "Whether desktop recordings include start_detached_command launch steps. Defaults to true.",
            },
            literalTextInputs: {
              type: "boolean",
              description:
                "Whether typed text should be recorded literally. Defaults to false, which turns typed values into prompt inputs.",
            },
          },
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      effect: "external-side-effect",
      execute: async (args) => {
        if (activeRecordingId) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "start_macro_recording",
            `A macro recording is already active: ${activeRecordingId}. Stop, save, or discard it before starting another recording.`,
          );
        }

        const requestedScope = coerceString(args, "scope");

        if (requestedScope && !isMacroRecordingScope(requestedScope)) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "start_macro_recording",
            "Expected `scope` to be browser, desktop, or browser-and-desktop.",
          );
        }
        const scope: MacroRecordingScope = isMacroRecordingScope(
          requestedScope,
        )
          ? requestedScope
          : "browser-and-desktop";

        const recordingId = normalizeRecordingId(
          coerceString(args, "recordingId"),
        );

        if (recordingStore.has(recordingId)) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "start_macro_recording",
            `A macro recording named \`${recordingId}\` already exists in this runtime.`,
          );
        }

        const recording: MacroRecording = {
          id: recordingId,
          name: coerceString(args, "name") ?? DEFAULT_RECORDING_NAME,
          scope,
          includeReadOnlySteps:
            coerceBoolean(args, "includeReadOnlySteps") ?? true,
          includeLaunchCommands:
            coerceBoolean(args, "includeLaunchCommands") ?? true,
          literalTextInputs: coerceBoolean(args, "literalTextInputs") ?? false,
          status: "recording",
          startedAt: Date.now(),
          steps: [],
        };

        recordingStore.set(recording.id, recording);
        activeRecordingId = recording.id;

        const lines = formatRecordingLines(recording);

        return {
          toolResult: {
            callId: crypto.randomUUID(),
            name: "start_macro_recording",
            output: lines.join("\n"),
          },
          sections: [
            {
              title: "Macro recording started",
              lines,
            },
          ],
          traceLines: [`start_macro_recording(${recording.id})`],
        };
      },
    },
    {
      spec: {
        name: "list_macro_recordings",
        description:
          "List active and stopped in-memory macro recordings captured during this runtime.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      effect: "read",
      execute: async () => {
        const recordings = [...recordingStore.values()];
        const lines = recordings.flatMap((recording) => [
          `${recording.id} | ${recording.status} | ${recording.scope} | steps=${recording.steps.length} | name=${recording.name}`,
        ]);

        return {
          toolResult: {
            callId: crypto.randomUUID(),
            name: "list_macro_recordings",
            output:
              lines.length > 0
                ? lines.join("\n")
                : "No macro recordings are available in this runtime.",
          },
          sections: [
            {
              title: "Macro recordings",
              lines:
                lines.length > 0
                  ? lines
                  : ["No macro recordings are available."],
            },
          ],
          traceLines: [
            `list_macro_recordings() -> ${recordings.length} recording${recordings.length === 1 ? "" : "s"}`,
          ],
        };
      },
    },
    {
      spec: {
        name: "inspect_macro_recording",
        description:
          "Inspect a macro recording as structured JSON before saving it as a prompt or skill.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            recordingId: {
              type: "string",
              description:
                "Recording id to inspect. Defaults to the active or most recent recording.",
            },
          },
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      effect: "read",
      execute: async (args) => {
        const recording = findRecording(coerceString(args, "recordingId"));

        if (!recording) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "inspect_macro_recording",
            "No matching macro recording was found.",
          );
        }

        const workflowJson = createStructuredWorkflowJson(recording);

        return {
          toolResult: {
            callId: crypto.randomUUID(),
            name: "inspect_macro_recording",
            output: limitText(workflowJson),
          },
          sections: [
            {
              title: "Macro recording",
              lines: formatRecordingLines(recording),
            },
            createTextSection("Structured workflow", workflowJson),
          ],
          traceLines: [`inspect_macro_recording(${recording.id})`],
        };
      },
    },
    {
      spec: {
        name: "stop_macro_recording",
        description:
          "Stop the active macro recording and show the captured browser/desktop workflow steps. The stopped recording can still be saved with save_macro_recording.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            recordingId: {
              type: "string",
              description:
                "Recording id to stop. Defaults to the active recording.",
            },
          },
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      effect: "external-side-effect",
      execute: async (args) => {
        const recording = findRecording(coerceString(args, "recordingId"));

        if (!recording) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "stop_macro_recording",
            "No matching macro recording was found.",
          );
        }

        stopRecording(recording);

        const lines = formatRecordingLines(recording);

        return {
          toolResult: {
            callId: crypto.randomUUID(),
            name: "stop_macro_recording",
            output: lines.join("\n"),
          },
          sections: [
            {
              title: "Macro recording stopped",
              lines,
            },
          ],
          traceLines: [`stop_macro_recording(${recording.id})`],
        };
      },
    },
    {
      spec: {
        name: "save_macro_recording",
        description:
          "Save a captured browser/desktop macro as a reusable machdoch prompt, skill, or both. If the recording is still active, this stops it before writing files.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            recordingId: {
              type: "string",
              description:
                "Recording id to save. Defaults to the active or most recent recording.",
            },
            kind: {
              type: "string",
              enum: MACRO_ARTIFACT_KINDS,
              description:
                "Artifact type to create. Defaults to prompt because prompts are slash-invocable.",
            },
            name: {
              type: "string",
              description:
                "Slash-command or skill name. It will be normalized to a lowercase file-safe slug.",
            },
            description: {
              type: "string",
              description: "Short description for the generated artifact.",
            },
            overwrite: {
              type: "boolean",
              description:
                "Whether an existing generated artifact with the same name may be replaced.",
            },
            includeJsonSidecar: {
              type: "boolean",
              description:
                "Whether to also save a structured .machdoch/macros/*.macro.json sidecar for machine replay and future conversion. Defaults to true.",
            },
          },
        },
      },
      backingTool: "filesystem",
      riskLevel: "low",
      effect: "write",
      execute: async (args, context) => {
        const recording = findRecording(coerceString(args, "recordingId"));

        if (!recording) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "save_macro_recording",
            "No matching macro recording was found.",
          );
        }

        if (recording.steps.length === 0) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "save_macro_recording",
            "Cannot save a macro recording with no captured browser or desktop steps.",
          );
        }

        const requestedKind = coerceString(args, "kind");

        if (requestedKind && !isMacroArtifactKind(requestedKind)) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "save_macro_recording",
            "Expected `kind` to be prompt, skill, or both.",
          );
        }

        stopRecording(recording);

        const kind = requestedKind ?? "prompt";
        const artifactName = normalizeArtifactName(
          coerceString(args, "name") ?? recording.name,
        );
        const description = normalizeDescription(
          recording,
          coerceString(args, "description"),
        );
        const overwrite = coerceBoolean(args, "overwrite") ?? false;
        const includeJsonSidecar =
          coerceBoolean(args, "includeJsonSidecar") ?? true;
        const artifactFiles: MacroArtifactFile[] = [];
        const writtenPaths: string[] = [];

        try {
          if (kind === "prompt" || kind === "both") {
            const promptPath = join(
              ".machdoch",
              "prompts",
              `${artifactName}.prompt.md`,
            );

            artifactFiles.push(
              await resolveArtifactFile(
                context.workspaceRoot,
                promptPath,
                createPromptArtifactContent(
                  artifactName,
                  description,
                  recording,
                ),
                overwrite,
              ),
            );
          }

          if (kind === "skill" || kind === "both") {
            const skillPath = join(
              ".machdoch",
              "skills",
              artifactName,
              "SKILL.md",
            );

            artifactFiles.push(
              await resolveArtifactFile(
                context.workspaceRoot,
                skillPath,
                createSkillArtifactContent(artifactName, description, recording),
                overwrite,
              ),
            );
          }

          if (includeJsonSidecar) {
            const macroPath = join(
              ".machdoch",
              "macros",
              `${artifactName}.macro.json`,
            );

            artifactFiles.push(
              await resolveArtifactFile(
                context.workspaceRoot,
                macroPath,
                createMacroSidecarContent(recording),
                overwrite,
              ),
            );
          }

          for (const artifactFile of artifactFiles) {
            writtenPaths.push(await writeArtifactFile(artifactFile));
          }
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "save_macro_recording",
            error instanceof Error ? error.message : String(error),
          );
        }

        const lines = [
          `recording: ${recording.id}`,
          `kind: ${kind}`,
          `name: ${artifactName}`,
          `steps: ${recording.steps.length}`,
          ...writtenPaths.map((path) => `created: ${path}`),
        ];

        return {
          toolResult: {
            callId: crypto.randomUUID(),
            name: "save_macro_recording",
            output: lines.join("\n"),
          },
          sections: [
            {
              title: "Saved macro recording",
              lines,
            },
            createTextSection("Recorded workflow", createWorkflowBody(recording)),
          ],
          traceLines: [
            `save_macro_recording(${recording.id}) -> ${writtenPaths.join(", ")}`,
          ],
        };
      },
    },
    {
      spec: {
        name: "discard_macro_recording",
        description:
          "Discard an active or stopped in-memory macro recording without writing a prompt or skill.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            recordingId: {
              type: "string",
              description:
                "Recording id to discard. Defaults to the active or most recent recording.",
            },
          },
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      effect: "external-side-effect",
      execute: async (args) => {
        const recording = findRecording(coerceString(args, "recordingId"));

        if (!recording) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "discard_macro_recording",
            "No matching macro recording was found.",
          );
        }

        recordingStore.delete(recording.id);

        if (activeRecordingId === recording.id) {
          activeRecordingId = undefined;
        }

        return {
          toolResult: {
            callId: crypto.randomUUID(),
            name: "discard_macro_recording",
            output: `Discarded macro recording ${recording.id}.`,
          },
          sections: [
            {
              title: "Discarded macro recording",
              lines: [`id: ${recording.id}`],
            },
          ],
          traceLines: [`discard_macro_recording(${recording.id})`],
        };
      },
    },
  ];
};
