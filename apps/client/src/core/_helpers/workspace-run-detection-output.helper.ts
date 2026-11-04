import type {
  WorkspaceRunConfiguration,
  WorkspaceRunConfigurationDocument,
  WorkspaceRunDetection,
  WorkspaceRunInput,
} from "../../shared/workspace-run.js";
import { workspaceRunTaskInputIds } from "../../shared/workspace-run-inputs.js";

const MAX_DETECTED_CONFIGURATIONS = 32;
const MAX_DETECTED_INPUTS = 32;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

const nullableString = { type: ["string", "null"] } as const;
const stringArray = { type: "array", items: { type: "string" } } as const;

export const WORKSPACE_RUN_DETECTION_OUTPUT = {
  name: "workspace_run_configurations",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      inputs: {
        type: "array",
        maxItems: MAX_DETECTED_INPUTS,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            type: { type: "string", enum: ["select", "text", "boolean"] },
            label: { type: "string" },
            description: nullableString,
            options: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  value: { type: "string" },
                  label: nullableString,
                },
                required: ["value", "label"],
              },
            },
            defaultText: nullableString,
            defaultBoolean: { type: ["boolean", "null"] },
            required: { type: "boolean" },
            trueValue: nullableString,
            falseValue: nullableString,
          },
          required: [
            "id",
            "type",
            "label",
            "description",
            "options",
            "defaultText",
            "defaultBoolean",
            "required",
            "trueValue",
            "falseValue",
          ],
        },
      },
      configurations: {
        type: "array",
        maxItems: MAX_DETECTED_CONFIGURATIONS,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            kind: { type: "string", enum: ["task", "composite"] },
            runType: { type: "string", enum: ["service", "job"] },
            group: nullableString,
            primary: { type: "boolean" },
            command: nullableString,
            workingDirectory: nullableString,
            environment: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  name: { type: "string" },
                  value: { type: "string" },
                },
                required: ["name", "value"],
              },
            },
            hotReload: { type: "boolean" },
            ports: { type: "array", items: { type: "integer" } },
            urls: stringArray,
            healthCheckKind: { type: "string", enum: ["none", "tcp", "http"] },
            healthCheckPort: { type: ["integer", "null"] },
            healthCheckUrl: nullableString,
            children: stringArray,
            startOrder: { type: "string", enum: ["parallel", "sequence"] },
            confidence: { type: "string", enum: ["high", "medium"] },
            evidence: stringArray,
            uncertainFields: stringArray,
          },
          required: [
            "id",
            "name",
            "kind",
            "runType",
            "group",
            "primary",
            "command",
            "workingDirectory",
            "environment",
            "hotReload",
            "ports",
            "urls",
            "healthCheckKind",
            "healthCheckPort",
            "healthCheckUrl",
            "children",
            "startOrder",
            "confidence",
            "evidence",
            "uncertainFields",
          ],
        },
      },
    },
    required: ["inputs", "configurations"],
  },
} as const;

export interface DetectedRunInput {
  id: string;
  type: "select" | "text" | "boolean";
  label: string;
  description: string | null;
  options: { value: string; label: string | null }[];
  defaultText: string | null;
  defaultBoolean: boolean | null;
  required: boolean;
  trueValue: string | null;
  falseValue: string | null;
}

export interface DetectedRunConfiguration {
  id: string;
  name: string;
  kind: "task" | "composite";
  runType: "service" | "job";
  group: string | null;
  primary: boolean;
  command: string | null;
  workingDirectory: string | null;
  environment: { name: string; value: string }[];
  hotReload: boolean;
  ports: number[];
  urls: string[];
  healthCheckKind: "none" | "tcp" | "http";
  healthCheckPort: number | null;
  healthCheckUrl: string | null;
  children: string[];
  startOrder: "parallel" | "sequence";
  confidence: "high" | "medium";
  evidence: string[];
  uncertainFields: string[];
}

export interface DetectedRunOutput {
  inputs: DetectedRunInput[];
  configurations: DetectedRunConfiguration[];
}

export interface WorkspaceRunDetectionResult {
  document: WorkspaceRunConfigurationDocument;
  detections: WorkspaceRunDetection[];
}

const singleLine = (value: string, maximum: number): string =>
  value
    .replace(/\p{Cc}+/gu, " ")
    .trim()
    .slice(0, maximum)
    .trim();

const optionalText = (
  value: string | null,
  maximum: number,
): string | undefined => {
  const text = value === null ? "" : singleLine(value, maximum);
  return text || undefined;
};

const isHttpUrl = (value: string): boolean => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const normalizeWorkingDirectory = (value: string | null): string => {
  const normalized = (value ?? "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "")
    .replace(/\/+$/u, "");
  return normalized || ".";
};

const convertInput = (input: DetectedRunInput): WorkspaceRunInput | null => {
  const id = input.id.trim();
  const label = singleLine(input.label, 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(id) || !label) return null;
  const description = optionalText(input.description, 500);
  const base = { id, label, ...(description ? { description } : {}) };
  if (input.type === "boolean") {
    return {
      ...base,
      type: "boolean",
      default: input.defaultBoolean ?? false,
      trueValue: singleLine(input.trueValue ?? "true", 1_024),
      falseValue: singleLine(input.falseValue ?? "false", 1_024),
    };
  }
  if (input.type === "text") {
    return {
      ...base,
      type: "text",
      default: singleLine(input.defaultText ?? "", 1_024),
      required: input.required,
    };
  }
  const seen = new Set<string>();
  const options = input.options.flatMap((option) => {
    const value = singleLine(option.value, 1_024);
    if (seen.has(value)) return [];
    seen.add(value);
    const optionLabel = optionalText(option.label, 120);
    return [
      {
        value,
        ...(optionLabel && optionLabel !== value ? { label: optionLabel } : {}),
      },
    ];
  });
  if (options.length === 0) return null;
  const defaultValue = input.defaultText ?? undefined;
  return {
    ...base,
    type: "select",
    options: options.slice(0, 64),
    ...(defaultValue !== undefined &&
    options.some((option) => option.value === defaultValue)
      ? { default: defaultValue }
      : {}),
  };
};

const convertTask = (
  configuration: DetectedRunConfiguration,
): WorkspaceRunConfiguration | null => {
  const command = configuration.command?.trim();
  if (!command) return null;
  const job = configuration.runType === "job";
  const urls = Array.from(
    new Set(configuration.urls.map((url) => url.trim()).filter(isHttpUrl)),
  ).slice(0, 32);
  const ports = Array.from(
    new Set(
      configuration.ports.filter(
        (port) => Number.isInteger(port) && port > 0 && port <= 65_535,
      ),
    ),
  ).slice(0, 32);
  const healthCheck =
    job || configuration.healthCheckKind === "none"
      ? null
      : configuration.healthCheckKind === "http"
        ? configuration.healthCheckUrl &&
          isHttpUrl(configuration.healthCheckUrl)
          ? {
              kind: "http" as const,
              url: configuration.healthCheckUrl,
              restartOnFailure: false,
            }
          : null
        : configuration.healthCheckPort &&
            configuration.healthCheckPort > 0 &&
            configuration.healthCheckPort <= 65_535
          ? {
              kind: "tcp" as const,
              port: configuration.healthCheckPort,
              restartOnFailure: false,
            }
          : null;
  const group = optionalText(configuration.group, 60);
  return {
    id: configuration.id,
    name: configuration.name,
    kind: "task",
    primary: false,
    runType: configuration.runType,
    ...(group ? { group } : {}),
    command,
    workingDirectory: normalizeWorkingDirectory(configuration.workingDirectory),
    environment: Object.fromEntries(
      configuration.environment
        .map(({ name, value }) => [name.trim(), value] as const)
        .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)),
    ),
    hotReload: !job && configuration.hotReload,
    ports,
    urls,
    healthCheck,
    restartPolicy: {
      onCrash: false,
      maxRestarts: 5,
      windowMs: 60_000,
      backoffMs: 1_000,
      maxBackoffMs: 30_000,
    },
  };
};

const choosePrimary = (
  configurations: WorkspaceRunConfiguration[],
  requestedPrimaryIds: ReadonlySet<string>,
): WorkspaceRunConfiguration[] => {
  const primaryId =
    configurations.find((configuration) =>
      requestedPrimaryIds.has(configuration.id),
    )?.id ??
    configurations.find((configuration) => configuration.kind === "composite")
      ?.id ??
    configurations.find(
      (configuration) =>
        configuration.kind === "task" && configuration.runType === "service",
    )?.id ??
    configurations[0]?.id;
  return configurations.map((configuration) => ({
    ...configuration,
    primary: configuration.id === primaryId,
  }));
};

export const convertDetectedRunOutput = (
  output: DetectedRunOutput,
  workingDirectoryExists: (workingDirectory: string) => boolean,
): WorkspaceRunDetectionResult => {
  const inputIds = new Set<string>();
  const inputs = output.inputs.flatMap((input) => {
    const converted = convertInput(input);
    if (!converted || inputIds.has(converted.id)) return [];
    inputIds.add(converted.id);
    return [converted];
  });

  const ids = new Set<string>();
  const detected = new Map<string, DetectedRunConfiguration>();
  const tasks = output.configurations.flatMap((configuration) => {
    const id = configuration.id.trim().toLowerCase();
    const name = singleLine(configuration.name, 120);
    if (
      configuration.kind !== "task" ||
      !IDENTIFIER_PATTERN.test(id) ||
      !name ||
      ids.has(id)
    ) {
      return [];
    }
    const task = convertTask({ ...configuration, id, name });
    if (
      !task ||
      task.kind !== "task" ||
      !workingDirectoryExists(task.workingDirectory) ||
      workspaceRunTaskInputIds(task).some((inputId) => !inputIds.has(inputId))
    ) {
      return [];
    }
    ids.add(id);
    detected.set(id, configuration);
    return [task];
  });

  const taskIds = new Set(tasks.map((task) => task.id));
  const ownedChildren = new Set<string>();
  const composites = output.configurations.flatMap(
    (configuration): WorkspaceRunConfiguration[] => {
      const id = configuration.id.trim().toLowerCase();
      const name = singleLine(configuration.name, 120);
      if (
        configuration.kind !== "composite" ||
        !IDENTIFIER_PATTERN.test(id) ||
        !name ||
        ids.has(id)
      ) {
        return [];
      }
      const children = Array.from(
        new Set(
          configuration.children
            .map((child) => child.trim().toLowerCase())
            .filter((child) => taskIds.has(child) && !ownedChildren.has(child)),
        ),
      ).slice(0, 32);
      if (children.length === 0) return [];
      for (const child of children) ownedChildren.add(child);
      ids.add(id);
      detected.set(id, configuration);
      const group = optionalText(configuration.group, 60);
      return [
        {
          id,
          name,
          kind: "composite",
          primary: false,
          ...(group ? { group } : {}),
          children,
          startOrder: configuration.startOrder,
        },
      ];
    },
  );

  const requestedPrimaryIds = new Set(
    output.configurations
      .filter((configuration) => configuration.primary)
      .map((configuration) => configuration.id.trim().toLowerCase()),
  );
  const configurations = choosePrimary(
    [...tasks, ...composites].slice(0, MAX_DETECTED_CONFIGURATIONS),
    requestedPrimaryIds,
  );
  const referencedInputIds = new Set(
    tasks.flatMap((task) =>
      task.kind === "task" ? workspaceRunTaskInputIds(task) : [],
    ),
  );

  return {
    document: {
      schemaVersion: 2,
      inputs: inputs.filter((input) => referencedInputIds.has(input.id)),
      configurations,
    },
    detections: configurations.map((configuration) => {
      const source = detected.get(configuration.id)!;
      return {
        configurationId: configuration.id,
        confidence: source.confidence,
        evidence: source.evidence
          .map((entry) => singleLine(entry, 300))
          .filter(Boolean)
          .slice(0, 8),
        uncertainFields: source.uncertainFields
          .map((entry) => singleLine(entry, 60))
          .filter(Boolean)
          .slice(0, 8),
      };
    }),
  };
};
