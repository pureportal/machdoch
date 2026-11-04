import type {
  WorkspaceRunConfigurationDocument,
  WorkspaceRunDetection,
} from "../../../shared/workspace-run.js";
import { loadInternalTaskModelSelection } from "../internal-task-model";
import { runWorkspaceRunDetection } from "../runtime";

export interface GeneratedWorkspaceRunDetection {
  documentJson: string;
  detections: WorkspaceRunDetection[];
}

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
  if (
    !isRecord(value) ||
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

export const readWorkspaceRunDetectionResponse = (
  response: unknown,
): GeneratedWorkspaceRunDetection => {
  if (!isRecord(response) || !isRecord(response.document)) {
    throw new Error(
      "AI run detection did not return a configuration document.",
    );
  }
  if (!Array.isArray(response.detections)) {
    throw new Error("AI run detection did not return detection metadata.");
  }
  return {
    documentJson: JSON.stringify(response.document),
    detections: response.detections.map(readDetection),
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
  const primaryCount = document.configurations.filter(
    (configuration) => configuration.primary,
  ).length;
  if (document.configurations.length > 0 && primaryCount !== 1) {
    throw new Error(
      "AI run detection must choose exactly one primary configuration.",
    );
  }
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
  if (!(await loadInternalTaskModelSelection())) {
    throw new Error(
      "Choose an internal task model in Settings > Providers before detecting run configurations.",
    );
  }
  return readWorkspaceRunDetectionResponse(
    await runWorkspaceRunDetection(workspaceRoot),
  );
};
