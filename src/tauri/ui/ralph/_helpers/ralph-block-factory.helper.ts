import type {
  RalphBlockSettings,
  RalphBlockType,
  RalphExecutionOutput,
  RalphFlow,
  RalphFlowBlock,
  RalphPosition,
  RalphUtilityConfig,
  RalphUtilityType,
} from "../../../../core/ralph.js";
import {
  RALPH_GROUP_DEFAULT_SIZE,
  RALPH_NOTE_DEFAULT_SIZE,
  getDefaultCanvasPosition,
  getDisplacedCanvasPosition,
} from "./ralph-canvas-layout.helper";
import {
  formatUtilityTypeLabel,
  titleFromId,
} from "./format-ralph-flow-labels.helper";

const RALPH_BLOCK_DUPLICATE_OFFSET = 36;

export const createBlockId = (
  flow: RalphFlow,
  type: RalphBlockType,
): string => {
  const base = type.toLowerCase().replaceAll("_", "-");
  const usedIds = new Set(flow.blocks.map((block) => block.id));

  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;

    if (!usedIds.has(candidate)) {
      return candidate;
    }
  }

  return `${base}-${Date.now()}`;
};

export const createCopiedBlock = (
  flow: RalphFlow,
  block: RalphFlowBlock,
  position?: RalphPosition,
): RalphFlowBlock | null => {
  if (
    block.type === "START" &&
    flow.blocks.some((candidate) => candidate.type === "START")
  ) {
    return null;
  }

  const id = createBlockId(flow, block.type);
  const cloned = JSON.parse(JSON.stringify(block)) as RalphFlowBlock;
  const fallbackPosition = block.position
    ? {
        x: block.position.x + RALPH_BLOCK_DUPLICATE_OFFSET,
        y: block.position.y + RALPH_BLOCK_DUPLICATE_OFFSET,
      }
    : getDefaultCanvasPosition(flow.blocks.length);
  const nextPosition = getDisplacedCanvasPosition(
    flow,
    position ?? fallbackPosition,
  );

  return {
    ...cloned,
    id,
    title: block.type === "START" ? "Start" : `${block.title} Copy`,
    position: nextPosition,
  };
};

export const createEdgeId = (
  flow: RalphFlow,
  from: string,
  output: RalphExecutionOutput,
  to: string,
): string => {
  const safeOutput = String(output)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32);
  const base = `${from}-${safeOutput || "out"}-${to}`.slice(0, 110);
  const usedIds = new Set(flow.edges.map((edge) => edge.id));

  if (!usedIds.has(base)) {
    return base;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`.slice(0, 119);

    if (!usedIds.has(candidate)) {
      return candidate;
    }
  }

  return `${base}-${Date.now()}`.slice(0, 119);
};

export const createDefaultUtilityConfig = (
  type: RalphUtilityType,
): RalphUtilityConfig => {
  switch (type) {
    case "WAIT":
      return { type, mode: "delay", delaySeconds: 1 };
    case "HTTP_FETCH":
      return {
        type,
        method: "GET",
        url: "{{url:url}}",
        timeoutSeconds: 30,
        maxOutputBytes: 1_000_000,
      };
    case "POLL":
      return {
        type,
        method: "GET",
        url: "{{url:url}}",
        intervalSeconds: 30,
        maxAttempts: null,
        ignoreErrors: true,
        condition: {
          style: "simple",
          expression: "status == 200",
        },
      };
    case "CONDITION":
      return {
        type,
        condition: {
          style: "javascript",
          expression: 'variables.enabled === "true"',
        },
      };
    case "RUN_COMMAND":
      return { type, command: "npm test", timeoutSeconds: 120 };
    case "RUN_CHECK":
      return {
        type,
        command: "npm run typecheck",
        fallbackCommand: "",
        timeoutSeconds: 120,
      };
    case "UI_ANALYZE":
      return {
        type,
        adapter: "browser",
        targetUrl: "{{targetUrl:url=http://localhost:1420}}",
        server: {
          mode: "existing",
          healthUrl: "{{targetUrl:url=http://localhost:1420}}",
          reuseExisting: true,
        },
        checks: {
          screenshots: true,
          accessibility: true,
          console: true,
          network: true,
          responsive: true,
        },
        viewports: [
          { name: "desktop", width: 1280, height: 900 },
          { name: "tablet", width: 768, height: 1024 },
          { name: "mobile", width: 390, height: 844 },
          { name: "small-mobile", width: 320, height: 568 },
        ],
        timeoutSeconds: 30,
        fullPage: true,
        waitUntil: "domcontentloaded",
      };
    case "READ_FILE":
      return { type, path: "{{file:path}}" };
    case "WRITE_FILE":
      return { type, path: "{{file:path}}", content: "{{lastResult}}" };
    case "READ_JSON":
      return { type, path: "{{file:path}}" };
    case "WRITE_JSON":
      return { type, path: "{{file:path}}", input: "{{lastResult}}" };
    case "PATCH_JSON":
      return {
        type,
        path: "{{file:path}}",
        input: "{}",
        jsonPatchMode: "merge",
      };
    case "APPEND_JSONL":
      return { type, path: "{{file:path}}", input: "{{lastResult}}" };
    case "READ_JSONL":
      return { type, path: "{{file:path}}", maxResults: 100 };
    case "QUERY_JSONL":
      return {
        type,
        path: "{{file:path}}",
        maxResults: 100,
        condition: {
          style: "json-path",
          path: "$.status",
          operator: "equals",
          value: "done",
        },
      };
    case "FILE_EXISTS":
      return { type, path: "{{file:path}}" };
    case "DELETE_FILE":
      return { type, path: "{{file:path}}" };
    case "MOVE_FILE":
      return {
        type,
        path: "{{file:path}}",
        outputPath: "{{destination:path}}",
      };
    case "ARCHIVE_FILE":
      return {
        type,
        path: "{{file:path}}",
        rootPath: ".machdoch/ralph/archive",
      };
    case "LOOP_COUNTER":
      return {
        type,
        path: ".machdoch/ralph/counters.json",
        counterName: "loop",
        maxAttempts: 10,
      };
    case "PROMPT_JSON":
      return {
        type,
        prompt: "Return structured JSON for {{lastResultSummary}}.",
        schema: { type: "object" },
        maxAttempts: 2,
      };
    case "VALIDATOR_JSON":
      return {
        type,
        prompt:
          "Review the current run evidence and return a JSON validator decision.",
        maxAttempts: 2,
      };
    case "SELECT_JSON_TASK":
      return {
        type,
        path: "{{checklistFile:path=.machdoch/ralph/tasks.json}}",
        jsonPath: "tasks",
        strategy: "start-to-end",
      };
    case "MARK_JSON_TASK":
      return {
        type,
        path: "{{checklistFile:path=.machdoch/ralph/tasks.json}}",
        jsonPath: "tasks",
        status: "done",
      };
    case "CHANGE_SCOPE_GUARD":
      return {
        type,
        cwd: ".",
        input: "{{data:select-scope:scope}}",
        baseline: "{{result:git-snapshot-before}}",
      };
    case "SCAN_SCOPE_EVIDENCE":
      return {
        type,
        rootPath: ".",
        excludePaths: "node_modules, dist, build, coverage, target, .next, .machdoch",
        maxDepth: 4,
        maxResults: 200,
      };
    case "UPDATE_SCOPE_REGISTRY":
      return {
        type,
        flowAlias: "{{flowAlias:string=scope-registry}}",
        strategy: "round-robin",
        includeMarkdown: true,
      };
    case "SELECT_SCOPE":
      return {
        type,
        flowAlias: "{{flowAlias:string=scope-registry}}",
        strategy: "round-robin",
      };
    case "MARK_SCOPE_RESULT":
      return {
        type,
        flowAlias: "{{flowAlias:string=scope-registry}}",
      };
    case "SEARCH_FILES":
      return { type, rootPath: ".", pattern: "{{query:string}}" };
    case "GIT_STATUS":
      return { type, cwd: "." };
    case "GIT_SNAPSHOT":
      return {
        type,
        cwd: ".",
        outputPath: ".machdoch/ralph/git-snapshot.json",
      };
    case "GIT_DIFF_SUMMARY":
      return {
        type,
        cwd: ".",
        outputPath: ".machdoch/ralph/git-diff-summary.json",
      };
    case "DETECT_PROJECT_COMMANDS":
      return {
        type,
        rootPath: ".",
        outputPath: ".machdoch/ralph/project-commands.json",
      };
    case "SET_VARIABLE":
      return { type, variableName: "value", value: "{{lastResultSummary}}" };
    case "TRANSFORM_JSON":
      return { type, expression: "input" };
    case "VALIDATE_JSON":
      return {
        type,
        schema: {
          type: "object",
        },
      };
    case "FINAL_REPORT":
      return {
        type,
        path: ".machdoch/ralph/final-report.json",
        outputPath: ".machdoch/ralph/final-report.md",
      };
    case "NOTIFY":
      return { type, message: "{{lastResultSummary}}" };
  }
};

export const createBlock = (
  flow: RalphFlow,
  type: RalphBlockType,
): RalphFlowBlock => {
  const id = createBlockId(flow, type);
  const position = getDefaultCanvasPosition(flow.blocks.length);
  const settings: RalphBlockSettings = {
    workspace: { mode: "default" },
    provider: "default",
    reasoning: "default",
    webAccess: true,
    fileAccess: true,
    maxIterations: 1,
    internalValidatorEnabled: false,
    retry: { mode: "infinite", maxRetries: null },
  };
  const title = titleFromId(id);

  switch (type) {
    case "START":
      return { id, type, title: "Start", position };
    case "PROMPT":
      return { id, type, title, position, prompt: "", settings };
    case "VALIDATOR":
      return {
        id,
        type,
        title,
        position,
        prompt: "",
        validationScope: { mode: "sinceLastValidator" },
        settings,
      };
    case "DECISION":
      return {
        id,
        type,
        title,
        position,
        prompt: "",
        labels: ["YES", "NO"],
        settings,
      };
    case "PACK":
      return {
        id,
        type,
        title,
        position,
        packIds: [],
        propagationMode: "untilOverridden",
        settings,
      };
    case "ASK_USER":
      return {
        id,
        type,
        title: "Ask User",
        position,
        mode: "missingOnly",
        prompt: "Collect the values needed before continuing.",
        fields: [
          {
            id: "details",
            label: "Details",
            type: "textarea",
            required: false,
            skippable: true,
            variableName: "details",
          },
        ],
        submitLabel: "Continue",
        cancelLabel: "Cancel",
        timeoutSeconds: null,
        settings,
      };
    case "INTERVIEW":
      return {
        id,
        type,
        title: "Interview",
        position,
        prompt: "Clarify the request until there is enough detail to continue.",
        completionCriteria: "The request is specific enough to implement and test.",
        maxTurns: 5,
        questionsPerTurn: 3,
        outputVariableName: `${id.replace(/[^A-Za-z0-9_]+/gu, "_")}_interview`,
        submitLabel: "Continue",
        cancelLabel: "Cancel interview",
        settings,
      };
    case "UTILITY":
      return {
        id,
        type,
        title: formatUtilityTypeLabel("WAIT"),
        position,
        utility: createDefaultUtilityConfig("WAIT"),
        settings: {
          workspace: { mode: "default" },
          retry: { mode: "infinite", maxRetries: null },
        },
      };
    case "MCP_TOOL":
      return {
        id,
        type,
        title,
        position,
        serverId: "",
        toolName: "",
        arguments: {},
        settings,
      };
    case "MCP_RESOURCE":
      return {
        id,
        type,
        title,
        position,
        serverId: "",
        uri: "",
        settings,
      };
    case "MCP_PROMPT":
      return {
        id,
        type,
        title,
        position,
        serverId: "",
        promptName: "",
        arguments: {},
        settings,
      };
    case "MEDIA_FLOW":
      return {
        id,
        type,
        title: "Run Media Flow",
        position,
        flowId: "",
        revisionId: "",
        inputBindings: {},
        outputBindings: {},
        runPolicy: "wait",
        approvalPolicy: "inherit-workspace",
        settings: {
          workspace: { mode: "default" },
          retry: { mode: "finite", maxRetries: 0 },
        },
      };
    case "NOTE":
      return {
        id,
        type,
        title: "Note",
        position,
        size: RALPH_NOTE_DEFAULT_SIZE,
        text: "",
        tone: "amber",
        tags: [],
        pinnedBlockIds: [],
      };
    case "GROUP":
      return {
        id,
        type,
        title: titleFromId(id),
        position,
        size: RALPH_GROUP_DEFAULT_SIZE,
        tone: "slate",
        description: "",
        childBlockIds: [],
        collapsed: false,
        locked: false,
        moveChildren: true,
        layoutMode: "freeform",
        executionBoundary: { mode: "none" },
      };
    case "END":
      return { id, type, title: "End", position, status: "success" };
  }
};
