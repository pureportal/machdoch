import type {
  WorkspaceRunConfigurationDocument,
  WorkspaceRunDetection,
} from "../../../shared/workspace-run.js";
import { runInternalDesktopTask } from "../internal-task-model";

export interface GeneratedWorkspaceRunDetection {
  documentJson: string;
  detections: WorkspaceRunDetection[];
}

const RUN_DETECTION_RESULT_PATTERN =
  /<machdoch_workspace_run_detection>\s*([\s\S]*?)\s*<\/machdoch_workspace_run_detection>/iu;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readStringArray = (value: unknown, field: string): string[] => {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`AI run detection returned an invalid ${field}.`);
  }
  return value;
};

const readDetection = (value: unknown): WorkspaceRunDetection => {
  if (!isRecord(value)) {
    throw new Error("AI run detection returned invalid detection metadata.");
  }
  if (
    typeof value.configurationId !== "string" ||
    (value.confidence !== "high" && value.confidence !== "medium")
  ) {
    throw new Error("AI run detection returned invalid detection metadata.");
  }
  return {
    configurationId: value.configurationId,
    confidence: value.confidence,
    evidence: readStringArray(value.evidence, "detection evidence"),
    uncertainFields: readStringArray(
      value.uncertainFields,
      "detection uncertainty",
    ),
  };
};

export const createWorkspaceRunDetectionTask = (): string =>
  [
    "Inspect the active workspace and draft viable launch configurations for its applications and servers.",
    "Use the available read-only workspace tools to inspect manifests, scripts, project files, documentation, and existing launch or container configuration. Do not execute project commands and do not modify files.",
    "Choose commands only from workspace evidence. Do not select from or assume a fixed catalog of frameworks or launch-command variants. Omit ports, URLs, and health checks that cannot be established from the workspace.",
    "Each task workingDirectory must be relative to the active workspace, use forward slashes, exist in the workspace, and be the directory from which its command should run. Do not put directory-changing commands in command.",
    "Return only one JSON object between <machdoch_workspace_run_detection> and </machdoch_workspace_run_detection>.",
    "The object must have document and detections fields. document must use this exact shape:",
    '{"schemaVersion":1,"primaryConfigurationId":null,"configurations":[{"id":"stable-id","name":"Name","kind":"task","command":"workspace-supported command","workingDirectory":".","environment":{},"hotReload":false,"ports":[],"urls":[],"healthCheck":null,"restartPolicy":{"onCrash":false,"maxRestarts":5,"windowMs":60000,"backoffMs":1000,"maxBackoffMs":30000}}]}',
    'A composite configuration instead uses {"id":"stable-id","name":"Name","kind":"composite","children":["task-id"],"startOrder":"parallel"}. Composite children must be task ids. Use a composite primary only when multiple independent tasks must launch together.',
    'detections must be an array with one item per drafted configuration: {"configurationId":"id","confidence":"high","evidence":["workspace evidence"],"uncertainFields":["fieldName"]}. confidence may be "high" or "medium".',
    "Return an empty configurations and detections array with a null primaryConfigurationId when the workspace has no evidenced launch configuration.",
  ].join("\n\n");

export const extractWorkspaceRunDetection = (
  response: string,
): GeneratedWorkspaceRunDetection => {
  const payload = RUN_DETECTION_RESULT_PATTERN.exec(response)?.[1]?.trim();
  if (!payload) {
    throw new Error("AI run detection did not return configuration JSON.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`AI run detection returned invalid JSON: ${detail}`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.document)) {
    throw new Error(
      "AI run detection did not return a configuration document.",
    );
  }
  if (!Array.isArray(parsed.detections)) {
    throw new Error("AI run detection did not return detection metadata.");
  }

  return {
    documentJson: JSON.stringify(parsed.document),
    detections: parsed.detections.map(readDetection),
  };
};

export const validateWorkspaceRunDetections = (
  document: WorkspaceRunConfigurationDocument,
  detections: readonly WorkspaceRunDetection[],
): void => {
  const configurationIds = new Set(
    document.configurations.map((configuration) => configuration.id),
  );
  const detectionIds = new Set(
    detections.map((detection) => detection.configurationId),
  );
  if (
    detections.length !== document.configurations.length ||
    detectionIds.size !== detections.length ||
    [...detectionIds].some((id) => !configurationIds.has(id))
  ) {
    throw new Error(
      "AI run detection metadata does not match its configurations.",
    );
  }
};

export const generateWorkspaceRunDetection = async (
  workspaceRoot: string,
): Promise<GeneratedWorkspaceRunDetection> => {
  const taskRun = await runInternalDesktopTask(
    workspaceRoot,
    createWorkspaceRunDetectionTask(),
    {
      mode: "ask",
      taskId: `workspace-run-detection-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    },
  );
  if (taskRun.execution.status !== "executed") {
    throw new Error(
      taskRun.execution.reason ??
        taskRun.execution.summary ??
        "AI run detection did not complete.",
    );
  }
  const response =
    taskRun.execution.response?.markdown ?? taskRun.execution.summary;
  return extractWorkspaceRunDetection(response);
};
