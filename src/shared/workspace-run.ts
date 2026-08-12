export const WORKSPACE_RUN_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_RUN_MAX_LOG_ENTRIES = 400 as const;

export type WorkspaceRunLifecycleState =
  | "stopped"
  | "starting"
  | "running"
  | "unhealthy"
  | "restarting"
  | "crashed"
  | "stopping";

export type WorkspaceRunHealthKind = "tcp" | "http";

export interface WorkspaceRunHealthCheck {
  kind: WorkspaceRunHealthKind;
  host?: string | null;
  port?: number | null;
  url?: string | null;
  startupDelayMs: number;
  intervalMs: number;
  timeoutMs: number;
  failureThreshold: number;
  restartOnFailure: boolean;
}

export interface WorkspaceRunRestartPolicy {
  onCrash: boolean;
  maxRestarts: number;
  windowMs: number;
  backoffMs: number;
  maxBackoffMs: number;
}

export interface WorkspaceRunTaskConfiguration {
  id: string;
  name: string;
  kind: "task";
  command: string;
  workingDirectory: string;
  environment: Record<string, string>;
  hotReload: boolean;
  ports: number[];
  urls: string[];
  healthCheck?: WorkspaceRunHealthCheck | null;
  restartPolicy: WorkspaceRunRestartPolicy;
}

export interface WorkspaceRunCompositeConfiguration {
  id: string;
  name: string;
  kind: "composite";
  children: string[];
  startOrder: "parallel" | "sequence";
}

export type WorkspaceRunConfiguration =
  | WorkspaceRunTaskConfiguration
  | WorkspaceRunCompositeConfiguration;

export interface WorkspaceRunConfigurationDocument {
  schemaVersion: typeof WORKSPACE_RUN_SCHEMA_VERSION;
  primaryConfigurationId: string | null;
  configurations: WorkspaceRunConfiguration[];
}

export interface WorkspaceRunLogEntry {
  sequence: number;
  at: number;
  stream: "system" | "stdout" | "stderr";
  line: string;
}

export interface WorkspaceRunLogUpdate {
  configurationId: string;
  startedAt: number;
  entry: WorkspaceRunLogEntry;
}

export interface WorkspaceRunLogBatch {
  workspaceRoot: string;
  entries: WorkspaceRunLogUpdate[];
}

export interface WorkspaceRunFailure {
  at: number;
  kind: "crash" | "health" | "launch" | "restart-limit";
  message: string;
}

export interface WorkspaceRunHealthStatus {
  state: "pending" | "healthy" | "failed";
  checkedAt: number | null;
  consecutiveFailures: number;
  message: string | null;
}

export interface WorkspaceRunConfigurationStatus {
  configuration: WorkspaceRunConfiguration;
  state: WorkspaceRunLifecycleState;
  pid: number | null;
  startedAt: number | null;
  stoppedAt: number | null;
  exitCode: number | null;
  restartCount: number;
  health: WorkspaceRunHealthStatus | null;
  recentFailures: WorkspaceRunFailure[];
  logs: WorkspaceRunLogEntry[];
  children: WorkspaceRunConfigurationStatus[];
}

export interface WorkspaceRunSnapshot {
  workspaceRoot: string;
  primaryConfigurationId: string | null;
  configurations: WorkspaceRunConfigurationStatus[];
}

export interface WorkspaceRunDetection {
  configurationId: string;
  confidence: "high" | "medium";
  evidence: string[];
  uncertainFields: string[];
}

export interface WorkspaceRunDetectionResult {
  document: WorkspaceRunConfigurationDocument;
  detections: WorkspaceRunDetection[];
}

export const createEmptyWorkspaceRunDocument =
  (): WorkspaceRunConfigurationDocument => ({
    schemaVersion: WORKSPACE_RUN_SCHEMA_VERSION,
    primaryConfigurationId: null,
    configurations: [],
  });
