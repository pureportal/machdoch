import { runDocumentSchema } from "@machdoch/fleet-protocol";
import {
  type WorkspaceRunCompositeConfiguration,
  type WorkspaceRunConfiguration,
  type WorkspaceRunConfigurationDocument,
  type WorkspaceRunInput,
  type WorkspaceRunRestartPolicy,
  type WorkspaceRunTaskConfiguration,
  type WorkspaceRunType,
} from "../../../shared/workspace-run.js";

export type WorkspaceRunNewConfigurationKind = WorkspaceRunType | "composite";

export interface WorkspaceRunDraftParseResult {
  document: WorkspaceRunConfigurationDocument | null;
  error: string | null;
}

export const DEFAULT_WORKSPACE_RUN_RESTART_POLICY: WorkspaceRunRestartPolicy = {
  onCrash: false,
  maxRestarts: 5,
  windowMs: 60_000,
  backoffMs: 1_000,
  maxBackoffMs: 30_000,
};

export const serializeWorkspaceRunDocument = (
  document: WorkspaceRunConfigurationDocument,
): string => JSON.stringify(document, null, 2);

export const parseWorkspaceRunDraft = (
  draft: string,
): WorkspaceRunDraftParseResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(draft);
  } catch (cause) {
    return {
      document: null,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
  const result = runDocumentSchema.safeParse(parsed);
  if (result.success) return { document: result.data, error: null };
  const issue = result.error.issues[0]!;
  const path = issue.path.join(".");
  return {
    document: null,
    error: path ? `${path}: ${issue.message}` : issue.message,
  };
};

const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);

export const uniqueWorkspaceRunId = (
  usedIds: Iterable<string>,
  preferred: string,
): string => {
  const used = new Set(usedIds);
  const base = slugify(preferred) || "run";
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
};

const configurationIds = (
  document: WorkspaceRunConfigurationDocument,
): string[] => document.configurations.map((configuration) => configuration.id);

const NEW_CONFIGURATION_NAMES: Record<
  WorkspaceRunNewConfigurationKind,
  string
> = {
  service: "New service",
  job: "New job",
  composite: "New group",
};

export const addWorkspaceRunConfiguration = (
  document: WorkspaceRunConfigurationDocument,
  kind: WorkspaceRunNewConfigurationKind,
): { document: WorkspaceRunConfigurationDocument; id: string } => {
  const name = NEW_CONFIGURATION_NAMES[kind];
  const id = uniqueWorkspaceRunId(configurationIds(document), name);
  const primary = document.configurations.length === 0;
  const configuration: WorkspaceRunConfiguration =
    kind === "composite"
      ? {
          id,
          name,
          kind: "composite",
          primary,
          children: [],
          startOrder: "parallel",
        }
      : {
          id,
          name,
          kind: "task",
          primary,
          runType: kind,
          command: "",
          workingDirectory: ".",
          environment: {},
          hotReload: false,
          ports: [],
          urls: [],
          healthCheck: null,
          restartPolicy: { ...DEFAULT_WORKSPACE_RUN_RESTART_POLICY },
        };
  return {
    document: {
      ...document,
      configurations: [...document.configurations, configuration],
    },
    id,
  };
};

export const duplicateWorkspaceRunConfiguration = (
  document: WorkspaceRunConfigurationDocument,
  id: string,
): { document: WorkspaceRunConfigurationDocument; id: string } => {
  const index = document.configurations.findIndex(
    (configuration) => configuration.id === id,
  );
  const source = document.configurations[index];
  if (!source) throw new Error(`Run configuration \`${id}\` does not exist.`);
  const copyId = uniqueWorkspaceRunId(
    configurationIds(document),
    `${source.id}-copy`,
  );
  const copy: WorkspaceRunConfiguration =
    source.kind === "composite"
      ? {
          ...structuredClone(source),
          id: copyId,
          name: `${source.name} copy`,
          primary: false,
          children: [],
        }
      : {
          ...structuredClone(source),
          id: copyId,
          name: `${source.name} copy`,
          primary: false,
        };
  const configurations = [...document.configurations];
  configurations.splice(index + 1, 0, copy);
  return { document: { ...document, configurations }, id: copyId };
};

export const removeWorkspaceRunConfiguration = (
  document: WorkspaceRunConfigurationDocument,
  id: string,
): WorkspaceRunConfigurationDocument => {
  const removed = document.configurations.find(
    (configuration) => configuration.id === id,
  );
  const configurations = document.configurations
    .filter((configuration) => configuration.id !== id)
    .map((configuration) =>
      configuration.kind === "composite"
        ? {
            ...configuration,
            children: configuration.children.filter((child) => child !== id),
          }
        : configuration,
    );
  const needsPrimary =
    removed?.primary === true &&
    configurations.length > 0 &&
    !configurations.some((configuration) => configuration.primary);
  return {
    ...document,
    configurations: needsPrimary
      ? configurations.map((configuration, index) => ({
          ...configuration,
          primary: index === 0,
        }))
      : configurations,
  };
};

export const setPrimaryWorkspaceRunConfiguration = (
  document: WorkspaceRunConfigurationDocument,
  id: string,
): WorkspaceRunConfigurationDocument => ({
  ...document,
  configurations: document.configurations.map((configuration) => ({
    ...configuration,
    primary: configuration.id === id,
  })),
});

const normalizeTaskForRunType = (
  task: WorkspaceRunTaskConfiguration,
): WorkspaceRunTaskConfiguration =>
  task.runType === "job"
    ? {
        ...task,
        healthCheck: null,
        restartPolicy: { ...task.restartPolicy, onCrash: false },
      }
    : task;

export const updateWorkspaceRunConfiguration = (
  document: WorkspaceRunConfigurationDocument,
  id: string,
  next: WorkspaceRunConfiguration,
): WorkspaceRunConfigurationDocument => {
  const normalized =
    next.kind === "task" ? normalizeTaskForRunType(next) : next;
  const renamed = normalized.id !== id;
  return {
    ...document,
    configurations: document.configurations.map((configuration) => {
      if (configuration.id === id) return normalized;
      if (renamed && configuration.kind === "composite") {
        return {
          ...configuration,
          children: configuration.children.map((child) =>
            child === id ? normalized.id : child,
          ),
        };
      }
      return configuration;
    }),
  };
};

export const workspaceRunChildCandidates = (
  document: WorkspaceRunConfigurationDocument,
  compositeId: string,
): WorkspaceRunTaskConfiguration[] => {
  const ownedElsewhere = new Set(
    document.configurations.flatMap((configuration) =>
      configuration.kind === "composite" && configuration.id !== compositeId
        ? configuration.children
        : [],
    ),
  );
  return document.configurations.filter(
    (configuration): configuration is WorkspaceRunTaskConfiguration =>
      configuration.kind === "task" && !ownedElsewhere.has(configuration.id),
  );
};

export const toggleWorkspaceRunChild = (
  composite: WorkspaceRunCompositeConfiguration,
  childId: string,
  included: boolean,
): WorkspaceRunCompositeConfiguration => ({
  ...composite,
  children: included
    ? composite.children.includes(childId)
      ? composite.children
      : [...composite.children, childId]
    : composite.children.filter((child) => child !== childId),
});

export const moveWorkspaceRunChild = (
  composite: WorkspaceRunCompositeConfiguration,
  childId: string,
  offset: -1 | 1,
): WorkspaceRunCompositeConfiguration => {
  const index = composite.children.indexOf(childId);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= composite.children.length) {
    return composite;
  }
  const children = [...composite.children];
  [children[index], children[target]] = [children[target]!, children[index]!];
  return { ...composite, children };
};

export const parseWorkspaceRunPorts = (
  text: string,
): { ports: number[]; error: string | null } => {
  const entries = text
    .split(/[\s,]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const ports: number[] = [];
  for (const entry of entries) {
    const port = Number(entry);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return { ports, error: `${entry} is not a port between 1 and 65535.` };
    }
    if (ports.includes(port)) {
      return { ports, error: `Port ${port} is listed twice.` };
    }
    ports.push(port);
  }
  return { ports, error: null };
};

export const formatWorkspaceRunEnvironment = (
  environment: Record<string, string>,
): string =>
  Object.entries(environment)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

export const parseWorkspaceRunEnvironment = (
  text: string,
): { environment: Record<string, string>; error: string | null } => {
  const environment: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const separator = line.indexOf("=");
    const key = separator < 0 ? line.trim() : line.slice(0, separator).trim();
    if (separator <= 0 || !key) {
      return { environment, error: `Use KEY=value for "${line.trim()}".` };
    }
    environment[key] = line.slice(separator + 1);
  }
  return { environment, error: null };
};

export const parseWorkspaceRunUrls = (
  text: string,
): { urls: string[]; error: string | null } => {
  const urls: string[] = [];
  for (const entry of text.split(/\s+/u).filter(Boolean)) {
    let valid = false;
    try {
      const protocol = new URL(entry).protocol;
      valid = protocol === "http:" || protocol === "https:";
    } catch {
      valid = false;
    }
    if (!valid) return { urls, error: `${entry} is not an http or https URL.` };
    if (!urls.includes(entry)) urls.push(entry);
  }
  return { urls, error: null };
};

export interface WorkspaceRunConfigurationIssue {
  configurationId: string;
  message: string;
}

export const workspaceRunConfigurationIssues = (
  document: WorkspaceRunConfigurationDocument,
): WorkspaceRunConfigurationIssue[] => {
  const idCounts = new Map<string, number>();
  for (const configuration of document.configurations) {
    idCounts.set(configuration.id, (idCounts.get(configuration.id) ?? 0) + 1);
  }
  return document.configurations.flatMap((configuration) => {
    const messages: string[] = [];
    if (!/^[A-Za-z0-9_.-]{1,96}$/u.test(configuration.id)) {
      messages.push(
        "Use letters, numbers, dots, dashes, or underscores for the ID.",
      );
    } else if ((idCounts.get(configuration.id) ?? 0) > 1) {
      messages.push(`The ID ${configuration.id} is used more than once.`);
    }
    if (
      !configuration.name.trim() ||
      configuration.name.trim() !== configuration.name
    ) {
      messages.push("Enter a name without leading or trailing spaces.");
    }
    if (configuration.kind === "task") {
      if (!configuration.command.trim()) messages.push("Enter a command.");
      if (!configuration.workingDirectory.trim()) {
        messages.push("Enter a working directory.");
      }
      const health = configuration.healthCheck;
      if (health?.kind === "tcp" && !health.port) {
        messages.push("The TCP health check needs a port.");
      }
      if (health?.kind === "http" && !health.url?.trim()) {
        messages.push("The HTTP health check needs a URL.");
      }
    } else if (configuration.children.length === 0) {
      messages.push("Choose at least one configuration to start.");
    }
    return messages.map((message) => ({
      configurationId: configuration.id,
      message,
    }));
  });
};

export const workspaceRunInputIds = (
  inputs: readonly WorkspaceRunInput[],
): string[] => inputs.map((input) => input.id);

export const addWorkspaceRunInput = (
  document: WorkspaceRunConfigurationDocument,
): WorkspaceRunConfigurationDocument => {
  const id = uniqueWorkspaceRunId(
    workspaceRunInputIds(document.inputs),
    "input",
  );
  return {
    ...document,
    inputs: [
      ...document.inputs,
      { id, label: "Input", type: "text", default: "", required: false },
    ],
  };
};

export const changeWorkspaceRunInputType = (
  input: WorkspaceRunInput,
  type: WorkspaceRunInput["type"],
): WorkspaceRunInput => {
  const base = {
    id: input.id,
    label: input.label,
    description: input.description,
  };
  if (type === "select") {
    return {
      ...base,
      type,
      options: [{ value: "default" }],
      default: "default",
    };
  }
  if (type === "boolean") {
    return {
      ...base,
      type,
      default: false,
      trueValue: "true",
      falseValue: "false",
    };
  }
  return { ...base, type, default: "", required: false };
};
