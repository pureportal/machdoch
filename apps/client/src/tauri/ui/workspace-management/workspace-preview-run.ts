import {
  WORKSPACE_RUN_SCHEMA_VERSION,
  workspaceRunPrimaryConfigurationId,
  type WorkspaceRunConfiguration,
  type WorkspaceRunConfigurationDocument,
  type WorkspaceRunConfigurationStatus,
  type WorkspaceRunInputValues,
  type WorkspaceRunSnapshot,
} from "../../../shared/workspace-run.js";
import { parseWorkspaceRunDraft } from "./workspace-run-editor-model";

const restartPolicy = {
  onCrash: false,
  maxRestarts: 5,
  windowMs: 60_000,
  backoffMs: 1_000,
  maxBackoffMs: 30_000,
};

let previewDocument: WorkspaceRunConfigurationDocument = {
  schemaVersion: WORKSPACE_RUN_SCHEMA_VERSION,
  inputs: [
    {
      id: "mode",
      label: "Mode",
      type: "select",
      options: [
        { value: "development", label: "Development" },
        { value: "production", label: "Production" },
      ],
      default: "development",
    },
  ],
  configurations: [
    {
      id: "web",
      name: "Web app",
      kind: "task",
      primary: false,
      runType: "service",
      group: "App",
      command: "pnpm run dev --mode ${input:mode}",
      workingDirectory: ".",
      environment: { NODE_ENV: "development" },
      hotReload: true,
      ports: [5173],
      urls: ["http://127.0.0.1:5173"],
      healthCheck: {
        kind: "http",
        url: "http://127.0.0.1:5173",
        restartOnFailure: false,
      },
      restartPolicy,
    },
    {
      id: "api",
      name: "API server",
      kind: "task",
      primary: false,
      runType: "service",
      group: "App",
      command: "pnpm run start:api",
      workingDirectory: "services/api",
      environment: { PORT: "4000" },
      hotReload: false,
      ports: [4000],
      urls: [],
      healthCheck: {
        kind: "tcp",
        host: null,
        port: 4000,
        restartOnFailure: true,
      },
      restartPolicy: { ...restartPolicy, onCrash: true },
    },
    {
      id: "migrate",
      name: "Migrate database",
      kind: "task",
      primary: false,
      runType: "job",
      group: "Database",
      command: "pnpm run db:migrate",
      workingDirectory: ".",
      environment: {},
      hotReload: false,
      ports: [],
      urls: [],
      healthCheck: null,
      restartPolicy,
    },
    {
      id: "stack",
      name: "Full stack",
      kind: "composite",
      primary: true,
      children: ["api", "web"],
      startOrder: "sequence",
    },
  ],
};

const runningSince = new Map<string, number>();

const statusFor = (
  configuration: WorkspaceRunConfiguration,
  configurations: readonly WorkspaceRunConfiguration[],
): WorkspaceRunConfigurationStatus => {
  const children =
    configuration.kind === "composite"
      ? configuration.children.map((id) => {
          const child = configurations.find((candidate) => candidate.id === id);
          if (!child)
            throw new Error(`Run configuration ${id} does not exist.`);
          return statusFor(child, configurations);
        })
      : [];
  const startedAt =
    configuration.kind === "composite"
      ? (children.find((child) => child.startedAt !== null)?.startedAt ?? null)
      : (runningSince.get(configuration.id) ?? null);
  return {
    configuration,
    state: startedAt === null ? "stopped" : "running",
    pid: null,
    startedAt,
    stoppedAt: null,
    exitCode: null,
    restartCount: 0,
    health: null,
    recentFailures: [],
    logs: [],
    inputValues: {},
    children,
  };
};

const previewSnapshot = (workspaceRoot: string): WorkspaceRunSnapshot => ({
  workspaceRoot,
  primaryConfigurationId: workspaceRunPrimaryConfigurationId(
    previewDocument.configurations,
  ),
  inputs: previewDocument.inputs,
  configurations: previewDocument.configurations.map((configuration) =>
    statusFor(configuration, previewDocument.configurations),
  ),
});

export const loadPreviewWorkspaceRunDocument =
  (): WorkspaceRunConfigurationDocument => structuredClone(previewDocument);

export const loadPreviewWorkspaceRunSnapshot = (
  workspaceRoot: string,
): WorkspaceRunSnapshot => previewSnapshot(workspaceRoot);

export const precheckPreviewWorkspaceRunJson = (
  documentJson: string,
): WorkspaceRunConfigurationDocument => {
  const parsed = parseWorkspaceRunDraft(documentJson);
  if (!parsed.document)
    throw new Error(parsed.error ?? "Invalid run configuration.");
  return parsed.document;
};

export const savePreviewWorkspaceRunDocument = (
  workspaceRoot: string,
  document: WorkspaceRunConfigurationDocument,
): WorkspaceRunSnapshot => {
  previewDocument = structuredClone(document);
  return previewSnapshot(workspaceRoot);
};

export const runPreviewWorkspaceRunAction = (
  workspaceRoot: string,
  action: "start" | "stop" | "restart",
  configurationId: string | undefined,
  _inputs?: WorkspaceRunInputValues,
): WorkspaceRunSnapshot => {
  const target = previewDocument.configurations.find(
    (configuration) =>
      configuration.id ===
      (configurationId ??
        workspaceRunPrimaryConfigurationId(previewDocument.configurations)),
  );
  const ids =
    target?.kind === "composite" ? target.children : target ? [target.id] : [];
  for (const id of ids) {
    if (action === "stop") runningSince.delete(id);
    else runningSince.set(id, Date.now());
  }
  return previewSnapshot(workspaceRoot);
};
