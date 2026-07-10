import {
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loadRuntimeConfig } from "../../core/config.js";
import { discoverCustomizations } from "../../core/customizations.js";
import { executeTask } from "../../core/execution.js";
import {
  createRalphRunLogger,
  createRalphFlowFingerprint,
  readRalphFlow,
  readRalphRunRecord,
  runRalphFlow,
  type RalphFlow,
  type RalphFlowScope,
  type RalphRunCheckpoint,
  type RalphRunLogPaths,
  type RalphRunRecord,
  type RalphRunResult,
} from "../../core/ralph.js";
import {
  DurableSmartScheduler,
  getUserSchedulerWorkspaceRegistryPath,
  getWorkspaceSchedulerStatePath,
  inspectScheduledRalphTarget,
  listRegisteredSchedulerWorkspaces,
  registerSchedulerWorkspace,
  syncScheduledPromptJobs,
  type CreateScheduledJobInput,
  type ScheduledContextPackSnapshot,
  type ScheduledEventTriggerKind,
  type ScheduledJob,
  type ScheduledJobRun,
  type ScheduledJobTriggerInput,
  type ScheduledMacroReference,
  type ScheduledMissedRunPolicy,
  type ScheduledRunEnqueueResult,
  type SchedulerServiceIterationResult,
  type ScheduledTaskExecutor,
  type ScheduledTaskExecutionRequest,
  type ScheduledTriggerFiringMode,
  type ScheduledTriggerEvent,
  type ScheduledTriggerEventInput,
} from "../../core/scheduler.js";
import type { TaskExecutionResult } from "../../core/types.js";
import type {
  ParsedCliArgs,
  SchedulerCliOptions,
} from "./cli-args.js";
import {
  applyContextPathsToTask,
  createImageInputsFromPaths,
} from "./cli-task-run.js";
import { writeStderrLine, writeStdoutLine } from "./cli-io.js";
import { createDiscoveryOptions } from "./cli-output.js";

const fail = (message: string): never => {
  throw new Error(message);
};

const isMissedRunPolicy = (
  value: string | undefined,
): value is ScheduledMissedRunPolicy => {
  return value === "skip" || value === "enqueue-latest" || value === "enqueue-all";
};

const SCHEDULER_EVENT_TRIGGER_KINDS: ReadonlySet<ScheduledEventTriggerKind> =
  new Set([
    "manual",
    "app",
    "workspace-file",
    "git",
    "job-event",
    "webhook",
    "poll",
    "system",
    "calendar",
    "clipboard",
    "integration",
  ]);

const SCHEDULER_TRIGGER_FIRING_MODES: ReadonlySet<ScheduledTriggerFiringMode> =
  new Set(["event", "state"]);

const isPathInside = (root: string, candidate: string): boolean => {
  const relativePath = relative(root, candidate);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
};

const resolveWorkspaceFile = async (
  workspaceRoot: string,
  path: string,
): Promise<string> => {
  const normalizedPath = path.trim();

  if (!normalizedPath) {
    throw new Error("Expected scheduler prompt file path to be non-empty.");
  }

  const resolvedWorkspaceRoot = await realpath(workspaceRoot);
  const candidatePath = isAbsolute(normalizedPath)
    ? normalizedPath
    : resolve(resolvedWorkspaceRoot, normalizedPath);
  const resolvedPath = await realpath(candidatePath);

  if (!isPathInside(resolvedWorkspaceRoot, resolvedPath)) {
    throw new Error("Refusing to read scheduler prompt file outside the workspace.");
  }

  const metadata = await stat(resolvedPath);

  if (!metadata.isFile()) {
    throw new Error("Expected scheduler prompt file path to point to a file.");
  }

  return resolvedPath;
};

export const readSchedulerPromptFile = async (
  workspaceRoot: string,
  path: string,
): Promise<string> => {
  const resolvedPath = await resolveWorkspaceFile(workspaceRoot, path);

  return (await readFile(resolvedPath, "utf8")).trim();
};

const parseContextPackSnapshot = (
  value: string,
): ScheduledContextPackSnapshot => {
  const parsed = JSON.parse(value) as Partial<ScheduledContextPackSnapshot>;

  if (!parsed || typeof parsed !== "object" || typeof parsed.name !== "string") {
    throw new Error("Expected --context-pack to be a JSON object with a name.");
  }

  return {
    name: parsed.name,
    ...(typeof parsed.instructions === "string"
      ? { instructions: parsed.instructions }
      : {}),
    ...(typeof parsed.prompt === "string" ? { prompt: parsed.prompt } : {}),
    ...(Array.isArray(parsed.contextPaths)
      ? {
          contextPaths: parsed.contextPaths.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
    ...(parsed.variableValues && typeof parsed.variableValues === "object"
      ? {
          variableValues: Object.fromEntries(
            Object.entries(parsed.variableValues).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
        }
      : {}),
  };
};

const parseMacroReference = (value: string): ScheduledMacroReference => {
  const normalized = value.trim();

  if (normalized.startsWith("/")) {
    const name = normalized.slice(1).split(/\s+/u)[0] ?? "macro";

    return {
      name,
      promptInvocation: normalized,
    };
  }

  return {
    name: normalized,
  };
};

const parseScheduledRalphParams = (
  params: string[] | undefined,
): Record<string, string> => {
  const values: Record<string, string> = {};

  for (const param of params ?? []) {
    const separatorIndex = param.indexOf("=");

    if (separatorIndex <= 0) {
      throw new Error("Expected --scheduled-ralph-param to use name=value syntax.");
    }

    const key = param.slice(0, separatorIndex).trim();
    const value = param.slice(separatorIndex + 1);

    if (!key) {
      throw new Error("Expected --scheduled-ralph-param to include a non-empty name.");
    }

    values[key] = value;
  }

  return values;
};

const parseTriggerKind = (value: string): ScheduledEventTriggerKind => {
  if (SCHEDULER_EVENT_TRIGGER_KINDS.has(value as ScheduledEventTriggerKind)) {
    return value as ScheduledEventTriggerKind;
  }

  throw new Error(
    `Expected trigger kind to be one of ${Array.from(
      SCHEDULER_EVENT_TRIGGER_KINDS,
    ).join(", ")}.`,
  );
};

const parseTriggerFiringMode = (
  value: string | undefined,
): ScheduledTriggerFiringMode | undefined => {
  if (!value) {
    return undefined;
  }

  if (SCHEDULER_TRIGGER_FIRING_MODES.has(value as ScheduledTriggerFiringMode)) {
    return value as ScheduledTriggerFiringMode;
  }

  throw new Error("Expected --trigger-firing-mode to be event or state.");
};

const parseTriggerFilters = (
  values: string[] | undefined,
): Record<string, unknown> | undefined => {
  if (!values || values.length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    values.map((entry) => {
      const match = /^(.*?)\s*(>=|<=|!=|=|>|<)\s*(.*?)$/u.exec(entry);

      if (!match || !match[1]?.trim()) {
        throw new Error(
          "Expected --trigger-filter to use path=value or path>=value syntax.",
        );
      }

      const path = match[1].trim();
      const operator = match[2];
      const rawValue = match[3]?.trim() ?? "";
      const value = parseTriggerFilterValue(rawValue);

      return [
        path,
        operator === "=" ? value : { op: operator, value },
      ];
    }),
  );
};

const parseTriggerFilterValue = (value: string): unknown => {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (value === "null") {
    return null;
  }

  const numericValue = Number(value);

  if (value.length > 0 && Number.isFinite(numericValue)) {
    return numericValue;
  }

  if (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith("[") && value.endsWith("]"))
  ) {
    return JSON.parse(value) as unknown;
  }

  return value;
};

const parseTriggerSpec = (
  value: string,
  options: SchedulerCliOptions,
): ScheduledJobTriggerInput => {
  const separatorIndex = value.indexOf(":");
  const kindText =
    separatorIndex > 0 ? value.slice(0, separatorIndex).trim() : "";
  const eventType =
    separatorIndex > 0 ? value.slice(separatorIndex + 1).trim() : value.trim();

  if (!kindText || !eventType) {
    throw new Error(
      "Expected --trigger to use kind:event-type syntax, for example workspace-file:workspace-file.created.",
    );
  }

  const filters = parseTriggerFilters(options.triggerFilters);
  const recoveryFilters = parseTriggerFilters(options.triggerRecoveryFilters);
  const firingMode = parseTriggerFiringMode(options.triggerFiringMode);

  if (
    (options.triggerMaxEvents === undefined) !==
    (options.triggerWindowMs === undefined)
  ) {
    throw new Error(
      "Expected --trigger-max-events and --trigger-window-ms to be provided together.",
    );
  }

  const maxEventsPerWindow =
    options.triggerMaxEvents !== undefined && options.triggerWindowMs !== undefined
      ? {
          maxEvents: options.triggerMaxEvents,
          windowMs: options.triggerWindowMs,
        }
      : undefined;

  return {
    kind: parseTriggerKind(kindText),
    eventType,
    ...(filters ? { filters } : {}),
    ...(recoveryFilters ? { recoveryFilters } : {}),
    ...(firingMode ? { firingMode } : {}),
    ...(options.triggerCooldownMs ? { cooldownMs: options.triggerCooldownMs } : {}),
    ...(options.triggerRepeatMs
      ? { repeatIntervalMs: options.triggerRepeatMs }
      : {}),
    ...(options.triggerDebounceMs ? { debounceMs: options.triggerDebounceMs } : {}),
    ...(options.triggerDedupeKeyTemplate
      ? { dedupeKeyTemplate: options.triggerDedupeKeyTemplate }
      : {}),
    ...(maxEventsPerWindow ? { maxEventsPerWindow } : {}),
  };
};

const createTriggerInputs = (
  options: SchedulerCliOptions,
): ScheduledJobTriggerInput[] | undefined => {
  return options.triggers?.map((trigger) => parseTriggerSpec(trigger, options));
};

const createSchedulerEventInput = (
  args: ParsedCliArgs,
  options: SchedulerCliOptions,
): ScheduledTriggerEventInput => {
  const eventType = options.eventType ?? fail("Expected --event-type.");
  const payload =
    options.eventPayloadJson !== undefined
      ? (JSON.parse(options.eventPayloadJson) as Record<string, unknown>)
      : undefined;

  if (payload !== undefined && (!payload || typeof payload !== "object" || Array.isArray(payload))) {
    throw new Error("Expected --event-payload-json to be a JSON object.");
  }

  return {
    type: eventType,
    ...(options.eventKind ? { kind: parseTriggerKind(options.eventKind) } : {}),
    ...(options.eventSource ? { source: options.eventSource } : {}),
    workspaceRoot: args.workspaceRoot,
    ...(payload ? { payload } : {}),
    ...(options.eventDedupeKey ? { dedupeKey: options.eventDedupeKey } : {}),
    ...(options.eventOccurredAt ? { occurredAt: options.eventOccurredAt } : {}),
  };
};

const createJobInput = async (
  args: ParsedCliArgs,
  options: SchedulerCliOptions,
): Promise<CreateScheduledJobInput> => {
  const schedulerTarget = options.schedulerTarget ?? "prompt";
  const prompt = schedulerTarget === "prompt"
    ? options.promptFile
      ? await readSchedulerPromptFile(args.workspaceRoot, options.promptFile)
      : options.prompt ?? ""
    : "";
  const missedRunPolicy = isMissedRunPolicy(options.missedRunPolicy)
    ? options.missedRunPolicy
    : undefined;
  const triggers = createTriggerInputs(options);
  const target: CreateScheduledJobInput["target"] =
    schedulerTarget === "ralph-flow"
      ? {
          type: "ralph-flow",
          workspaceRoot: args.workspaceRoot,
          ralphFlow: {
            id: options.scheduledRalphFlow ??
              fail("Expected --scheduled-ralph-flow for scheduled Ralph jobs."),
            scope: options.scheduledRalphFlowScope ?? "workspace",
            params: parseScheduledRalphParams(options.scheduledRalphParams),
            ...(options.scheduledRalphRunLogScope
              ? { runLogScope: options.scheduledRalphRunLogScope }
              : {}),
            ...(options.scheduledRalphMaxTransitions !== undefined
              ? { maxTransitions: options.scheduledRalphMaxTransitions }
              : {}),
            ...(options.scheduledRalphProfile
              ? { executionProfile: options.scheduledRalphProfile }
              : {}),
            ...(options.scheduledRalphResumePolicy
              ? { resumePolicy: options.scheduledRalphResumePolicy }
              : {}),
            permissions: {
              allowedRoots: options.scheduledRalphAllowedRoots ?? [
                args.workspaceRoot,
              ],
              allowCommands:
                options.scheduledRalphProfile === "unattended" ||
                (options.scheduledRalphAllowCommands ?? false),
              allowWrites:
                options.scheduledRalphProfile === "unattended" ||
                (options.scheduledRalphAllowWrites ?? false),
              allowNetwork:
                options.scheduledRalphProfile === "unattended" ||
                (options.scheduledRalphAllowNetwork ?? false),
              allowMcpTools:
                options.scheduledRalphProfile === "unattended" ||
                (options.scheduledRalphAllowMcpTools ?? false),
            },
          },
        }
      : {
          workspaceRoot: args.workspaceRoot,
          prompt,
          contextPaths: args.contextPaths ?? [],
          imagePaths: args.imagePaths ?? [],
          contextPacks: (options.contextPacks ?? []).map(parseContextPackSnapshot),
          macros: (options.macros ?? []).map(parseMacroReference),
          ...(args.mode ? { mode: args.mode } : {}),
          ...(args.runtimeProvider ? { provider: args.runtimeProvider } : {}),
          ...(args.model ? { model: args.model } : {}),
          ...(args.reasoning ? { reasoning: args.reasoning } : {}),
        };

  if (options.missedRunPolicy && !missedRunPolicy) {
    fail(
      "Expected --missed-run-policy to be one of skip, enqueue-latest, or enqueue-all.",
    );
  }

  return {
    ...(options.name ? { name: options.name } : {}),
    ...(options.cron
      ? {
          schedule: {
            type: "cron" as const,
            expression: options.cron,
            ...(options.timezone ? { timezone: options.timezone } : {}),
          },
        }
      : options.intervalMs
        ? {
            schedule: {
              type: "interval" as const,
              intervalMs: options.intervalMs,
            },
          }
        : options.delayMs || options.runAt
          ? {
              schedule: {
                type: "delay" as const,
                ...(options.delayMs ? { delayMs: options.delayMs } : {}),
                ...(options.runAt ? { runAt: options.runAt } : {}),
              },
        }
      : {}),
    ...(triggers && triggers.length > 0 ? { triggers } : {}),
    target,
    ...(missedRunPolicy ? { missedRunPolicy } : {}),
    ...(options.missedRunGraceMs ? { missedRunGraceMs: options.missedRunGraceMs } : {}),
    retry: {
      ...(options.retryAttempts ? { maxAttempts: options.retryAttempts } : {}),
      ...(options.retryMinMs ? { minTimeoutMs: options.retryMinMs } : {}),
      ...(options.retryMaxMs ? { maxTimeoutMs: options.retryMaxMs } : {}),
      ...(options.retryFactor ? { factor: options.retryFactor } : {}),
      ...(options.retryRandomize !== undefined
        ? { randomize: options.retryRandomize }
        : {}),
    },
    queue: {
      ...(options.concurrencyKey ? { concurrencyKey: options.concurrencyKey } : {}),
      ...(options.concurrencyLimit
        ? { concurrencyLimit: options.concurrencyLimit }
        : {}),
    },
    ...(options.historyLimit ? { historyLimit: options.historyLimit } : {}),
    ...(options.maxCatchUpRuns ? { maxCatchUpRuns: options.maxCatchUpRuns } : {}),
    ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
    ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}),
    ...(options.maxDurationMs ? { maxDurationMs: options.maxDurationMs } : {}),
  };
};

const readTemplatePath = (value: unknown, path: string): unknown => {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }

    return (current as Record<string, unknown>)[segment];
  }, value);
};

const renderScheduledTemplate = (
  template: string,
  request: ScheduledTaskExecutionRequest,
): string => {
  const record = {
    job: request.job,
    run: request.run,
    event: request.event,
    payload: request.event?.payload,
    workspaceRoot: request.workspaceRoot,
  };

  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/gu, (_match, path: string) => {
    const value = readTemplatePath(record, path);

    return value === undefined || value === null ? "" : String(value);
  });
};

const renderScheduledParams = (
  params: Record<string, string>,
  request: ScheduledTaskExecutionRequest,
): Record<string, string> => {
  return Object.fromEntries(
    Object.entries(params).map(([name, value]) => [
      name,
      renderScheduledTemplate(value, request),
    ]),
  );
};

const renderRalphVariableTemplate = (
  value: string | undefined,
  variables: Record<string, string>,
): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  return value.replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/gu, (_match, name: string) =>
    variables[name] ?? "",
  );
};

const isAllowedScheduledPath = (
  candidatePath: string,
  allowedRoots: string[],
): boolean => {
  return allowedRoots.some((root) => isPathInside(root, candidatePath));
};

const resolveScheduledFlowPath = (
  workspaceRoot: string,
  path: string | undefined,
  variables: Record<string, string>,
): string | undefined => {
  const rendered = renderRalphVariableTemplate(path, variables)?.trim();

  if (!rendered) {
    return undefined;
  }

  return isAbsolute(rendered) ? resolve(rendered) : resolve(workspaceRoot, rendered);
};

const assertScheduledPathAllowed = (
  label: string,
  workspaceRoot: string,
  path: string | undefined,
  variables: Record<string, string>,
  allowedRoots: string[],
): void => {
  const resolved = resolveScheduledFlowPath(workspaceRoot, path, variables);

  if (!resolved) {
    return;
  }

  if (!isAllowedScheduledPath(resolved, allowedRoots)) {
    throw new Error(`${label} resolves outside the watch allowed roots: ${resolved}`);
  }
};

const assertAgentBlockAllowed = (
  blockId: string,
  permissions: NonNullable<ScheduledTaskExecutionRequest["ralphFlow"]>["permissions"],
): void => {
  if (
    permissions?.allowCommands &&
    permissions.allowWrites &&
    permissions.allowNetwork &&
    permissions.allowMcpTools
  ) {
    return;
  }

  throw new Error(
    `Scheduled Ralph block \`${blockId}\` uses agent execution. Automatic agent blocks require allowCommands, allowWrites, allowNetwork, and allowMcpTools.`,
  );
};

const assertScheduledRalphPermissions = (
  flow: RalphFlow,
  request: ScheduledTaskExecutionRequest,
  variableValues: Record<string, string>,
): void => {
  const permissions = request.ralphFlow?.permissions ?? {
    allowedRoots: [request.workspaceRoot],
    allowCommands: false,
    allowWrites: false,
    allowNetwork: false,
    allowMcpTools: false,
  };
  const allowedRoots = permissions.allowedRoots.map((root) => resolve(root));
  const executionWorkspaceRoot = resolve(request.workspaceRoot);

  if (!isAllowedScheduledPath(executionWorkspaceRoot, allowedRoots)) {
    throw new Error(
      `Scheduled Ralph execution workspace resolves outside the watch allowed roots: ${executionWorkspaceRoot}`,
    );
  }

  for (const block of flow.blocks) {
    const blockWorkspace = block.settings?.workspace?.mode === "custom"
      ? block.settings.workspace.path
      : undefined;

    assertScheduledPathAllowed(
      `Block ${block.id} workspace`,
      request.workspaceRoot,
      blockWorkspace,
      variableValues,
      allowedRoots,
    );

    for (const attachment of block.settings?.attachments ?? []) {
      if (attachment.source === "path") {
        assertScheduledPathAllowed(
          `Block ${block.id} attachment`,
          request.workspaceRoot,
          attachment.value,
          variableValues,
          allowedRoots,
        );
      }
    }

    if (
      block.type === "PROMPT" ||
      block.type === "VALIDATOR" ||
      block.type === "DECISION" ||
      block.type === "INTERVIEW"
    ) {
      assertAgentBlockAllowed(block.id, permissions);
      continue;
    }

    if (
      block.type === "MCP_TOOL" ||
      block.type === "MCP_RESOURCE" ||
      block.type === "MCP_PROMPT"
    ) {
      if (!permissions.allowMcpTools) {
        throw new Error(`Scheduled Ralph block \`${block.id}\` requires MCP permission.`);
      }
      continue;
    }

    if (block.type !== "UTILITY") {
      continue;
    }

    const utility = block.utility;

    if (utility.type === "HTTP_FETCH" || utility.type === "POLL") {
      if (!permissions.allowNetwork) {
        throw new Error(`Scheduled Ralph utility \`${block.id}\` requires network permission.`);
      }
    }

    if (
      utility.type === "RUN_COMMAND" ||
      utility.type === "RUN_CHECK" ||
      utility.type === "GIT_STATUS"
    ) {
      if (!permissions.allowCommands) {
        throw new Error(`Scheduled Ralph utility \`${block.id}\` requires command permission.`);
      }
      assertScheduledPathAllowed(
        `Utility ${block.id} cwd`,
        request.workspaceRoot,
        utility.cwd,
        variableValues,
        allowedRoots,
      );
    }

    if (utility.type === "READ_FILE") {
      assertScheduledPathAllowed(
        `Utility ${block.id} path`,
        request.workspaceRoot,
        utility.path,
        variableValues,
        allowedRoots,
      );
    }

    if (utility.type === "WRITE_FILE") {
      if (!permissions.allowWrites) {
        throw new Error(`Scheduled Ralph utility \`${block.id}\` requires write permission.`);
      }
      assertScheduledPathAllowed(
        `Utility ${block.id} path`,
        request.workspaceRoot,
        utility.path,
        variableValues,
        allowedRoots,
      );
    }

    if (utility.type === "SEARCH_FILES") {
      assertScheduledPathAllowed(
        `Utility ${block.id} rootPath`,
        request.workspaceRoot,
        utility.rootPath,
        variableValues,
        allowedRoots,
      );
    }

    if (utility.type === "UI_ANALYZE") {
      if ((utility.targetUrl || utility.url || utility.server?.healthUrl) && !permissions.allowNetwork) {
        throw new Error(`Scheduled Ralph utility \`${block.id}\` requires network permission.`);
      }
      if (utility.server?.command && !permissions.allowCommands) {
        throw new Error(`Scheduled Ralph utility \`${block.id}\` requires command permission.`);
      }
      assertScheduledPathAllowed(
        `Utility ${block.id} screenshotPath`,
        request.workspaceRoot,
        utility.screenshotPath,
        variableValues,
        allowedRoots,
      );
    }
  }
};

const summarizeRalphAsTaskResult = (
  task: string,
  result: RalphRunResult,
  metadata: {
    flowId: string;
    flowName: string;
    scope: RalphFlowScope;
    runLogScope: RalphFlowScope;
    schedulerAttempt: number;
    resumedFromRunId?: string;
    reconciledFromRunId?: string;
  },
): TaskExecutionResult => {
  const status: TaskExecutionResult["status"] =
    result.status === "completed"
      ? "executed"
      : result.status === "stopped"
        ? "cancelled"
        : "blocked";

  return {
    task,
    mode: "machdoch",
    status,
    summary: result.summary,
    executedTools: [],
    ...(status !== "executed" ? { reason: result.summary } : {}),
    metadata: {
      ralphFlow: {
        flowId: metadata.flowId,
        flowName: metadata.flowName,
        scope: metadata.scope,
        runId: result.runId,
        status: result.status,
        runLogScope: metadata.runLogScope,
        schedulerAttempt: metadata.schedulerAttempt,
        resumedFromCheckpoint: Boolean(metadata.resumedFromRunId),
        ...(metadata.resumedFromRunId
          ? { resumedFromRunId: metadata.resumedFromRunId }
          : {}),
        reconciledDurableRun: Boolean(metadata.reconciledFromRunId),
        ...(metadata.reconciledFromRunId
          ? { reconciledFromRunId: metadata.reconciledFromRunId }
          : {}),
      },
    },
    outputSections: [
      {
        title: "Ralph Run",
        lines: [
          `Flow: ${result.flow}`,
          `Status: ${result.status}`,
          ...(result.runId ? [`Run: ${result.runId}`] : []),
        ],
      },
    ],
  };
};

const SCHEDULER_FLEET_LOCK_STALE_MS = 2 * 60_000;

export const isSchedulerFleetServiceHeartbeatFresh = async (
  ownerPath: string,
  now = Date.now(),
): Promise<boolean> => {
  try {
    const metadata = await stat(ownerPath);
    return now - metadata.mtimeMs <= SCHEDULER_FLEET_LOCK_STALE_MS;
  } catch {
    return false;
  }
};

export const acquireSchedulerFleetServiceLock = async (): Promise<{
  touch: () => Promise<void>;
  release: () => Promise<void>;
}> => {
  const lockPath = `${getUserSchedulerWorkspaceRegistryPath()}.service-lock`;
  const ownerPath = join(lockPath, "owner");
  const token = `${process.pid}:${Date.now()}`;

  try {
    await mkdir(lockPath, { recursive: false });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error
      ? String(error.code)
      : "";

    if (code !== "EEXIST") {
      throw error;
    }

    if (await isSchedulerFleetServiceHeartbeatFresh(ownerPath)) {
      throw new Error("A scheduler fleet service is already running.", {
        cause: error,
      });
    }

    await rm(lockPath, { recursive: true, force: true });
    await mkdir(lockPath, { recursive: false });
  }

  await writeFile(ownerPath, token, "utf8");

  const assertOwnership = async (): Promise<void> => {
    let currentToken: string;

    try {
      currentToken = await readFile(ownerPath, "utf8");
    } catch (error) {
      throw new Error("Scheduler fleet service lost its ownership lock.", {
        cause: error,
      });
    }

    if (currentToken !== token) {
      throw new Error("Scheduler fleet service lost its ownership lock.");
    }
  };

  return {
    touch: async () => {
      await assertOwnership();
      const now = new Date();
      await utimes(ownerPath, now, now);
      await assertOwnership();
    },
    release: async () => {
      try {
        if ((await readFile(ownerPath, "utf8")) === token) {
          await rm(lockPath, { recursive: true, force: true });
        }
      } catch {
        // A stale or externally removed fleet lock needs no cleanup.
      }
    },
  };
};

export const awaitSchedulerFleetWorkerSettlement = async (
  workers: Iterable<Promise<void>>,
  touchOwnership: () => Promise<void>,
  heartbeatMs = Math.max(
    1_000,
    Math.floor(SCHEDULER_FLEET_LOCK_STALE_MS / 3),
  ),
): Promise<void> => {
  let heartbeatFailure: unknown;
  let heartbeatChain = Promise.resolve();
  const queueHeartbeat = (): void => {
    heartbeatChain = heartbeatChain
      .then(touchOwnership)
      .catch((error: unknown) => {
        heartbeatFailure ??= error;
      });
  };

  queueHeartbeat();
  const timer = setInterval(queueHeartbeat, Math.max(1, heartbeatMs));

  try {
    await Promise.allSettled([...workers]);
  } finally {
    clearInterval(timer);
    await heartbeatChain;
  }

  if (heartbeatFailure) {
    throw heartbeatFailure;
  }
};

interface ScheduledRalphRecovery {
  checkpoint?: RalphRunCheckpoint;
  paths: RalphRunLogPaths;
  record: RalphRunRecord;
  scheduledRunId: string;
}

const createScheduledRalphRunId = (
  scheduledRunId: string,
  flowId: string,
): string => `scheduled-${scheduledRunId}-${flowId}`;

const createScheduledRalphResumePaths = (
  recordPath: string,
  record: RalphRunRecord,
): RalphRunLogPaths => {
  const directory = dirname(recordPath);

  return {
    id: record.id,
    directory,
    recordPath,
    simpleJsonlPath:
      record.logPaths?.simpleJsonlPath ?? join(directory, "simple.jsonl"),
    simpleMarkdownPath:
      record.logPaths?.simpleMarkdownPath ?? join(directory, "simple.md"),
    traceJsonlPath:
      record.logPaths?.traceJsonlPath ?? join(directory, "trace.jsonl"),
  };
};

const readScheduledRalphRecovery = async (
  request: ScheduledTaskExecutionRequest,
  flow: RalphFlow,
  runLogScope: RalphFlowScope,
): Promise<ScheduledRalphRecovery | undefined> => {
  const target = request.ralphFlow;
  const resumePolicy =
    target?.resumePolicy ??
    (target?.executionProfile === "unattended" ? "recoverable" : "never");

  if (
    resumePolicy !== "recoverable" ||
    (request.run.attempt <= 1 && !request.run.parentRunId)
  ) {
    return undefined;
  }

  const scheduledRunIds = [
    ...(request.run.attempt > 1 ? [request.run.id] : []),
    ...(request.run.parentRunId ? [request.run.parentRunId] : []),
  ];

  for (const scheduledRunId of scheduledRunIds) {
    const runId = createScheduledRalphRunId(scheduledRunId, flow.id);

    try {
      const { path, record } = await readRalphRunRecord(
        request.workspaceRoot,
        runId,
        { scope: runLogScope },
      );

      if (record.id !== runId || record.flowId !== flow.id) {
        throw new Error(
          `Ralph recovery record identity mismatch: expected run \`${runId}\` for flow \`${flow.id}\`, found run \`${record.id}\` for flow \`${record.flowId}\`.`,
        );
      }

      const isParentRecord = scheduledRunId !== request.run.id;
      if (
        isParentRecord &&
        (record.status === "completed" || record.status === "stopped")
      ) {
        // A manual child retry of a terminal parent is an intentional rerun.
        continue;
      }

      if (record.status === "stopped") {
        const previousAttempt = [...request.run.attemptHistory]
          .reverse()
          .find((attempt) => attempt.attempt < request.run.attempt);
        const followsRetryableSchedulerFailure =
          !isParentRecord &&
          (previousAttempt?.status === "failed" ||
            previousAttempt?.status === "timed_out");

        if (!followsRetryableSchedulerFailure) {
          throw new Error(
            `Ralph run \`${record.id}\` is stopped but is not the checkpoint of a retryable scheduler attempt.`,
          );
        }
      }

      if (
        record.status !== "completed" && !record.checkpoint
      ) {
        throw new Error(
          `Ralph run \`${record.id}\` is ${record.status} but has no durable checkpoint.`,
        );
      }

      return {
        ...(record.checkpoint ? { checkpoint: record.checkpoint } : {}),
        paths: createScheduledRalphResumePaths(path, record),
        record,
        scheduledRunId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message === `Ralph run \`${runId}\` was not found.`) {
        // A process can stop before its first durable side effect/record.
        continue;
      }

      throw new Error(
        `Refusing to restart scheduled Ralph run ${runId} because its durable recovery record could not be read: ${message}`,
        { cause: error },
      );
    }
  }

  return undefined;
};

const executeScheduledRalphFlow = async (
  request: ScheduledTaskExecutionRequest,
  options: Parameters<ScheduledTaskExecutor["execute"]>[1],
): Promise<TaskExecutionResult> => {
  const target = request.ralphFlow;

  if (!target) {
    throw new Error("Scheduled Ralph target was missing from the execution request.");
  }

  const flowScope = target.scope as RalphFlowScope;
  const runLogScope = (target.runLogScope ?? "workspace") as RalphFlowScope;
  const flow = target.flowSnapshot ?? await readRalphFlow(
    request.workspaceRoot,
    target.id,
    { scope: flowScope },
  );
  const actualFlowFingerprint = createRalphFlowFingerprint(flow);

  if (
    target.flowFingerprint &&
    target.flowFingerprint !== actualFlowFingerprint
  ) {
    throw new Error(
      `Scheduled Ralph snapshot fingerprint mismatch for ${flow.id}; expected ${target.flowFingerprint}, found ${actualFlowFingerprint}.`,
    );
  }
  const recovery = await readScheduledRalphRecovery(
    request,
    flow,
    runLogScope,
  );
  if (recovery?.record.status === "completed") {
    return summarizeRalphAsTaskResult(
      `Run Ralph flow ${flow.name} (${flowScope}:${flow.id}).`,
      {
        runId: recovery.record.id,
        flow: flow.id,
        status: recovery.record.status,
        summary: recovery.record.summary,
        events: recovery.record.events,
        // Durable records intentionally store a compact block summary rather
        // than the full in-memory execution results. The task summary only
        // needs the terminal status and run identity.
        blockResults: [],
        missingVariables: [],
        unknownVariables: [],
        validation: {
          ...recovery.record.validation,
          errorIssues: [],
          warningIssues: [],
          variables: flow.variables ?? [],
        },
      },
      {
        flowId: flow.id,
        flowName: flow.name,
        scope: flowScope,
        runLogScope,
        schedulerAttempt: request.run.attempt,
        reconciledFromRunId: recovery.record.id,
      },
    );
  }
  const renderedVariableValues = renderScheduledParams(target.params, request);
  const variableValues = recovery?.record.variableValues ?? renderedVariableValues;
  const readiness = await inspectScheduledRalphTarget(
    request.workspaceRoot,
    target,
    { flow, params: variableValues },
  );

  if (!readiness.ready) {
    throw new Error(
      `Scheduled Ralph target is no longer unattended-ready: ${readiness.errors.join(" ")}`,
    );
  }
  assertScheduledRalphPermissions(flow, request, variableValues);
  const config = await loadRuntimeConfig(
    request.workspaceRoot,
    "machdoch",
    request.model,
    request.provider,
    undefined,
    request.reasoning,
  );
  const customizations = await discoverCustomizations(
    request.workspaceRoot,
    {
      ...createDiscoveryOptions(config.compatibility.discoverGithubCustomizations),
      ralphFlow: {
        id: flow.id,
        scope: flowScope,
      },
    },
  );
  const runId =
    recovery?.record.id ?? createScheduledRalphRunId(request.run.id, flow.id);
  const logger = await createRalphRunLogger(request.workspaceRoot, flow, {
    runId,
    variableValues,
    ...(recovery ? { paths: recovery.paths, append: true } : {}),
    scope: runLogScope,
  });
  const result = await runRalphFlow(flow, config, customizations, {
    variableValues,
    runId: logger.runId,
    logger,
    ...(target.executionProfile === "unattended" ? { autonomy: true } : {}),
    ...(recovery?.checkpoint ? { checkpoint: recovery.checkpoint } : {}),
    ...(target.maxTransitions !== undefined
      ? { maxTransitions: target.maxTransitions }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return summarizeRalphAsTaskResult(
    `Run Ralph flow ${flow.name} (${flowScope}:${flow.id}).`,
    result,
    {
      flowId: flow.id,
      flowName: flow.name,
      scope: flowScope,
      runLogScope,
      schedulerAttempt: request.run.attempt,
      ...(recovery ? { resumedFromRunId: recovery.record.id } : {}),
    },
  );
};

export const createSchedulerExecutor = (): ScheduledTaskExecutor => ({
  execute: async (request, options): Promise<TaskExecutionResult> => {
    if (request.targetType === "ralph-flow") {
      return executeScheduledRalphFlow(request, options);
    }

    const config = await loadRuntimeConfig(
      request.workspaceRoot,
      request.mode,
      request.model,
      request.provider,
      undefined,
      request.reasoning,
    );
    const task = await applyContextPathsToTask(
      request.task,
      request.contextPaths,
      request.workspaceRoot,
    );
    const customizations = await discoverCustomizations(
      request.workspaceRoot,
      createDiscoveryOptions(config.compatibility.discoverGithubCustomizations),
    );
    const imageInputs = await createImageInputsFromPaths(
      request.imagePaths,
      request.workspaceRoot,
      config,
    );

    return executeTask(task, config, customizations, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.maxDurationMs ? { maxDurationMs: options.maxDurationMs } : {}),
      ...(imageInputs.length > 0 ? { imageInputs } : {}),
    });
  },
});

const createScheduler = (
  workspaceRoot: string,
  options?: { executor?: boolean },
): DurableSmartScheduler => {
  return new DurableSmartScheduler({
    statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
    workspaceRoot,
    ...(options?.executor ? { executor: createSchedulerExecutor() } : {}),
  });
};

export interface SchedulerFleetIterationResult {
  workspaces: Array<{
    workspaceRoot: string;
    recovered: number;
    queued: number;
    runs: number;
    error?: string;
  }>;
  recovered: number;
  queued: number;
  runs: number;
}

export const runSchedulerFleetIteration = async (
  options: {
    schedulerFactory?: (workspaceRoot: string) => DurableSmartScheduler;
  } = {},
): Promise<SchedulerFleetIterationResult> => {
  const workspaceRoots = await listRegisteredSchedulerWorkspaces();
  const workspaces = await Promise.all(workspaceRoots.map(async (workspaceRoot) => {
    try {
      const workspaceScheduler = options.schedulerFactory?.(workspaceRoot) ??
        createScheduler(workspaceRoot, { executor: true });
      const recovered = await workspaceScheduler.recoverAbandonedRuns(
        "Scheduler fleet service recovered an abandoned running run.",
      );
      const due = await workspaceScheduler.runDueJobs({ recoverAbandoned: false });
      return {
        workspaceRoot,
        recovered: recovered.length,
        queued: due.queued.length,
        runs: due.runs.length,
      };
    } catch (error) {
      return {
        workspaceRoot,
        recovered: 0,
        queued: 0,
        runs: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));

  return {
    workspaces,
    recovered: workspaces.reduce((total, workspace) => total + workspace.recovered, 0),
    queued: workspaces.reduce((total, workspace) => total + workspace.queued, 0),
    runs: workspaces.reduce((total, workspace) => total + workspace.runs, 0),
  };
};

export const pollSchedulerFleetWorkspaces = async (
  options: {
    schedulerFactory?: (workspaceRoot: string) => DurableSmartScheduler;
  } = {},
): Promise<SchedulerFleetIterationResult> => {
  const workspaceRoots = await listRegisteredSchedulerWorkspaces();
  const workspaces = await Promise.all(workspaceRoots.map(async (workspaceRoot) => {
    try {
      const workspaceScheduler = options.schedulerFactory?.(workspaceRoot) ??
        createScheduler(workspaceRoot);
      const recovered = await workspaceScheduler.recoverAbandonedRuns(
        "Scheduler fleet poll recovered an abandoned running run.",
      );
      const queued = await workspaceScheduler.enqueueDueRuns();

      return {
        workspaceRoot,
        recovered: recovered.length,
        queued: queued.length,
        runs: 0,
      };
    } catch (error) {
      return {
        workspaceRoot,
        recovered: 0,
        queued: 0,
        runs: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));

  return {
    workspaces,
    recovered: workspaces.reduce((total, workspace) => total + workspace.recovered, 0),
    queued: workspaces.reduce((total, workspace) => total + workspace.queued, 0),
    runs: 0,
  };
};

const waitForSchedulerFleetPoll = async (
  durationMs: number,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolveWait) => {
    const timer = setTimeout(resolveWait, durationMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolveWait();
      },
      { once: true },
    );
  });
};

const formatSchedulerTrigger = (
  trigger: ScheduledJob["triggers"][number],
): string => {
  if (trigger.kind === "time") {
    switch (trigger.schedule.type) {
      case "cron":
        return `cron ${trigger.schedule.expression} (${trigger.schedule.timezone})`;
      case "interval":
        return `interval ${trigger.schedule.intervalMs}ms`;
      case "delay":
        return `delay until ${new Date(trigger.schedule.runAt).toISOString()}`;
    }
  }

  return `${trigger.kind}:${trigger.eventType}`;
};

const formatSchedulerTriggerLabel = (job: ScheduledJob): string => {
  if (job.triggers.length === 0) {
    return "no triggers";
  }

  return job.triggers.map(formatSchedulerTrigger).join(", ");
};

const summarizeScheduledRalphTarget = (
  target: NonNullable<ScheduledJob["target"]["ralphFlow"]>,
): Record<string, unknown> => {
  const { flowSnapshot, ...publicTarget } = target;

  return {
    ...publicTarget,
    readiness: {
      ready: true,
      variables: (flowSnapshot?.variables ?? []).map((variable) => ({
        name: variable.name,
        type: variable.type,
        required: variable.required,
        ...(variable.default !== undefined ? { default: variable.default } : {}),
      })),
      humanInputBlocks: (flowSnapshot?.blocks ?? [])
        .filter((block) => block.type === "ASK_USER" || block.type === "INTERVIEW")
        .map((block) => block.id),
    },
  };
};

const summarizeJob = (job: ScheduledJob): Record<string, unknown> => ({
  id: job.id,
  name: job.name,
  status: job.status,
  schedule: job.schedule ?? null,
  triggers: job.triggers,
  triggerLabel: formatSchedulerTriggerLabel(job),
  targetType: job.target.type,
  workspaceRoot: job.target.workspaceRoot,
  prompt: job.target.prompt,
  ralphFlow: job.target.ralphFlow
    ? summarizeScheduledRalphTarget(job.target.ralphFlow)
    : null,
  nextRunAt: job.nextRunAt ?? null,
  lastStartedAt: job.lastStartedAt ?? null,
  lastFinishedAt: job.lastFinishedAt ?? null,
  queue: job.queue,
  retry: job.retry,
  dedupeKey: job.dedupeKey ?? null,
  ttlMs: job.ttlMs ?? null,
  maxDurationMs: job.maxDurationMs ?? null,
});

const summarizeRun = (run: ScheduledJobRun): Record<string, unknown> => ({
  id: run.id,
  jobId: run.jobId,
  source: run.source,
  status: run.status,
  scheduledFor: run.scheduledFor,
  enqueuedAt: run.enqueuedAt,
  updatedAt: run.updatedAt,
  attempt: run.attempt,
  maxAttempts: run.maxAttempts,
  queueKey: run.queueKey,
  startedAt: run.startedAt ?? null,
  finishedAt: run.finishedAt ?? null,
  nextAttemptAt: run.nextAttemptAt ?? null,
  expiresAt: run.expiresAt ?? null,
  error: run.error ?? null,
  summary: run.result?.summary ?? null,
});

const summarizeEvent = (event: ScheduledTriggerEvent): Record<string, unknown> => ({
  id: event.id,
  type: event.type,
  kind: event.kind,
  source: event.source,
  workspaceRoot: event.workspaceRoot ?? null,
  payload: event.payload,
  dedupeKey: event.dedupeKey ?? null,
  occurredAt: event.occurredAt,
  receivedAt: event.receivedAt,
  matches: event.matches,
});

const printJson = (value: unknown): void => {
  writeStdoutLine(JSON.stringify(value, null, 2));
};

const printJobLines = (jobs: ScheduledJob[]): void => {
  writeStdoutLine(`scheduled jobs: ${jobs.length}`);

  for (const job of jobs) {
    writeStdoutLine(
      `- ${job.id} [${job.status}] ${job.name} triggers=${formatSchedulerTriggerLabel(job)} next=${job.nextRunAt ? new Date(job.nextRunAt).toISOString() : "event"}`,
    );
    writeStdoutLine(`  workspace: ${job.target.workspaceRoot}`);
    writeStdoutLine(`  queue: ${job.queue.concurrencyKey} (${job.queue.concurrencyLimit})`);
  }
};

const printRunLines = (runs: ScheduledJobRun[]): void => {
  writeStdoutLine(`scheduled runs: ${runs.length}`);

  for (const run of runs) {
    writeStdoutLine(
      `- ${run.id} [${run.status}] job=${run.jobId} attempts=${run.attempt}/${run.maxAttempts}`,
    );
    writeStdoutLine(
      `  scheduled: ${new Date(run.scheduledFor).toISOString()} updated: ${new Date(run.updatedAt).toISOString()}`,
    );
    if (run.error) {
      writeStdoutLine(`  error: ${run.error}`);
    }
  }
};

const printEventLines = (events: ScheduledTriggerEvent[]): void => {
  writeStdoutLine(`scheduler events: ${events.length}`);

  for (const event of events) {
    writeStdoutLine(
      `- ${event.id} [${event.kind}] ${event.type} matches=${event.matches.length}`,
    );
    writeStdoutLine(
      `  received: ${new Date(event.receivedAt).toISOString()} source: ${event.source}`,
    );
  }
};

const printEnqueueResult = (
  result: ScheduledRunEnqueueResult,
  json: boolean,
): void => {
  if (json) {
    printJson({
      handle: result.handle,
      run: summarizeRun(result.run),
      deduplicated: result.deduplicated,
    });
    return;
  }

  writeStdoutLine(`run: ${result.run.id}`);
  writeStdoutLine(`job: ${result.run.jobId}`);
  writeStdoutLine(`status: ${result.run.status}`);
  writeStdoutLine(`deduplicated: ${result.deduplicated ? "true" : "false"}`);
};

export const printSchedulerSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const options = args.scheduler ?? fail("No scheduler action was provided.");
  const scheduler = createScheduler(args.workspaceRoot, {
    executor:
      options.action === "run-due" ||
      options.action === "trigger" ||
      options.action === "retry" ||
      options.action === "service",
  });

  switch (options.action) {
    case "list": {
      const jobs = await scheduler.listJobs();

      if (args.json) {
        printJson({
          workspaceRoot: args.workspaceRoot,
          jobs: jobs.map(summarizeJob),
        });
        return;
      }

      printJobLines(jobs);
      return;
    }
    case "inspect-ralph": {
      const flowId = options.subject ?? fail("No Ralph flow id was provided.");
      const readiness = await inspectScheduledRalphTarget(
        args.workspaceRoot,
        {
          id: flowId,
          scope: options.scheduledRalphFlowScope ?? "workspace",
          params: parseScheduledRalphParams(options.scheduledRalphParams),
          ...(options.scheduledRalphProfile
            ? { executionProfile: options.scheduledRalphProfile }
            : {}),
          ...(options.scheduledRalphResumePolicy
            ? { resumePolicy: options.scheduledRalphResumePolicy }
            : {}),
          permissions: {
            allowedRoots: options.scheduledRalphAllowedRoots ?? [args.workspaceRoot],
            allowCommands: true,
            allowWrites: true,
            allowNetwork: true,
            allowMcpTools: true,
          },
        },
      );

      if (args.json) {
        printJson(readiness);
        return;
      }

      writeStdoutLine(`Ralph readiness: ${readiness.ready ? "ready" : "blocked"}`);
      for (const error of readiness.errors) {
        writeStdoutLine(`error: ${error}`);
      }
      for (const warning of readiness.warnings) {
        writeStdoutLine(`warning: ${warning}`);
      }
      return;
    }
    case "create": {
      const job = await scheduler.upsertJob(
        await createJobInput(args, options),
        options.requestId,
      );

      if (args.json) {
        printJson({ job: summarizeJob(job) });
        return;
      }

      writeStdoutLine(`created job: ${job.id}`);
      writeStdoutLine(`name: ${job.name}`);
      writeStdoutLine(
        `next run: ${job.nextRunAt ? new Date(job.nextRunAt).toISOString() : "none"}`,
      );
      return;
    }
    case "pause":
    case "resume":
    case "delete": {
      const subject = options.subject ?? fail("No scheduled job id was provided.");
      const job =
        options.action === "pause"
          ? await scheduler.pauseJob(subject, options.requestId)
          : options.action === "resume"
            ? await scheduler.resumeJob(subject, options.requestId)
            : await scheduler.deleteJob(subject, options.requestId);

      if (args.json) {
        printJson({ job: summarizeJob(job) });
        return;
      }

      writeStdoutLine(`${options.action}d job: ${job.id}`);
      writeStdoutLine(`status: ${job.status}`);
      return;
    }
    case "runs": {
      const runs = await scheduler.listRuns(options.subject);

      if (args.json) {
        printJson({
          workspaceRoot: args.workspaceRoot,
          runs: runs.map(summarizeRun),
        });
        return;
      }

      printRunLines(runs);
      return;
    }
    case "events": {
      const events = await scheduler.listEvents();

      if (args.json) {
        printJson({
          workspaceRoot: args.workspaceRoot,
          events: events.map(summarizeEvent),
        });
        return;
      }

      printEventLines(events);
      return;
    }
    case "event": {
      const result = await scheduler.recordEventAndEnqueueRuns(
        createSchedulerEventInput(args, options),
      );

      if (args.json) {
        printJson({
          event: summarizeEvent(result.event),
          enqueued: result.enqueued.map((entry) => ({
            handle: entry.handle,
            run: summarizeRun(entry.run),
            deduplicated: entry.deduplicated,
          })),
        });
        return;
      }

      writeStdoutLine(`event: ${result.event.id}`);
      writeStdoutLine(`type: ${result.event.type}`);
      writeStdoutLine(`enqueued runs: ${result.enqueued.length}`);
      return;
    }
    case "run-due": {
      const result = await scheduler.runDueJobs();

      if (args.json) {
        printJson({
          queued: result.queued.map(summarizeRun),
          runs: result.runs.map(summarizeRun),
        });
        return;
      }

      writeStdoutLine(`queued due runs: ${result.queued.length}`);
      printRunLines(result.runs);
      return;
    }
    case "run-all-due": {
      await registerSchedulerWorkspace(args.workspaceRoot);
      const result = await runSchedulerFleetIteration();

      if (args.json) {
        printJson(result);
        return;
      }

      writeStdoutLine(`scheduler workspaces: ${result.workspaces.length}`);
      writeStdoutLine(`recovered runs: ${result.recovered}`);
      writeStdoutLine(`queued due runs: ${result.queued}`);
      writeStdoutLine(`finished runs: ${result.runs}`);
      return;
    }
    case "poll-all": {
      const result = await pollSchedulerFleetWorkspaces();

      if (args.json) {
        printJson(result);
        return;
      }

      writeStdoutLine(`scheduler workspaces: ${result.workspaces.length}`);
      writeStdoutLine(`recovered runs: ${result.recovered}`);
      writeStdoutLine(`queued due runs: ${result.queued}`);
      return;
    }
    case "service": {
      const controller = new AbortController();
      const stop = (): void => {
        if (!controller.signal.aborted) {
          controller.abort("Scheduler service stopped.");
        }
      };

      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);

      try {
        if (options.serviceStartEventType) {
          const startEvent = await scheduler.recordEventAndEnqueueRuns({
            type: options.serviceStartEventType,
            ...(options.serviceStartEventKind
              ? { kind: parseTriggerKind(options.serviceStartEventKind) }
              : {}),
            source: "scheduler-service",
            workspaceRoot: args.workspaceRoot,
            ...(options.serviceStartEventDedupeKey
              ? { dedupeKey: options.serviceStartEventDedupeKey }
              : {}),
          });

          if (!args.json) {
            writeStdoutLine(
              `scheduler service event: ${startEvent.event.type} enqueued=${startEvent.enqueued.length}`,
            );
          }
        }

        const serviceOptions = {
          ...(options.servicePollMs !== undefined
            ? { pollIntervalMs: options.servicePollMs }
            : {}),
          ...(options.serviceIdleShutdownMs !== undefined
            ? { idleShutdownMs: options.serviceIdleShutdownMs }
            : {}),
          ...(options.serviceAbandonedRunStaleMs !== undefined
            ? { abandonedRunStaleMs: options.serviceAbandonedRunStaleMs }
            : {}),
          ...(options.serviceMaxIterations !== undefined
            ? { maxIterations: options.serviceMaxIterations }
            : {}),
          ...(options.serviceMaxRunsPerTick !== undefined
            ? { maxRunsPerTick: options.serviceMaxRunsPerTick }
            : {}),
          signal: controller.signal,
          ...(!args.json
            ? {
                onIteration: (iteration: SchedulerServiceIterationResult) => {
                  if (
                    iteration.recovered.length === 0 &&
                    iteration.queued.length === 0 &&
                    iteration.runs.length === 0
                  ) {
                    return;
                  }

                  writeStdoutLine(
                    `scheduler service: recovered=${iteration.recovered.length} queued=${iteration.queued.length} finished=${iteration.runs.length}`,
                  );
                },
              }
            : {}),
        };
        const result = await scheduler.runService(serviceOptions);

        if (args.json) {
          printJson(result);
          return;
        }

        writeStdoutLine(`scheduler service iterations: ${result.iterations}`);
        writeStdoutLine(`recovered runs: ${result.recoveredRuns}`);
        writeStdoutLine(`queued due runs: ${result.queuedRuns}`);
        writeStdoutLine(`finished runs: ${result.finishedRuns}`);
        return;
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    }
    case "service-all": {
      const controller = new AbortController();
      const stop = (): void => {
        if (!controller.signal.aborted) {
          controller.abort("Scheduler fleet service stopped.");
        }
      };
      const serviceLock = await acquireSchedulerFleetServiceLock();
      const pollIntervalMs = options.servicePollMs ?? 30_000;
      const maxIterations = options.serviceMaxIterations;
      let iterations = 0;
      let recovered = 0;
      let queued = 0;
      let runs = 0;
      const activeWorkspaceWorkers = new Map<string, Promise<void>>();

      writeStderrLine(
        `[${new Date().toISOString()}] scheduler fleet service started pid=${process.pid}.`,
      );

      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);

      try {
        while (!controller.signal.aborted) {
          await serviceLock.touch();
          const workspaceRoots = await listRegisteredSchedulerWorkspaces();
          const pollResults = await Promise.all(
            workspaceRoots.map(async (workspaceRoot) => {
              try {
                const workspaceScheduler = createScheduler(workspaceRoot, {
                  executor: true,
                });
                const recoveredRuns = await workspaceScheduler.recoverAbandonedRuns(
                  "Scheduler fleet service recovered an abandoned running run.",
                );
                const enqueued = await workspaceScheduler.enqueueDueRuns();

                if (!activeWorkspaceWorkers.has(workspaceRoot)) {
                  const worker = workspaceScheduler.runQueuedRuns(
                    options.serviceMaxRunsPerTick !== undefined
                      ? {
                          maxRuns: options.serviceMaxRunsPerTick,
                          signal: controller.signal,
                        }
                      : { signal: controller.signal },
                  ).then((finishedRuns) => {
                    runs += finishedRuns.length;
                  }).catch((error) => {
                    writeStderrLine(
                      `[${new Date().toISOString()}] scheduler fleet worker ${workspaceRoot}: ${error instanceof Error ? error.message : String(error)}`,
                    );
                  }).finally(() => {
                    activeWorkspaceWorkers.delete(workspaceRoot);
                  });
                  activeWorkspaceWorkers.set(workspaceRoot, worker);
                }

                return {
                  workspaceRoot,
                  recovered: recoveredRuns.length,
                  queued: enqueued.length,
                };
              } catch (error) {
                writeStderrLine(
                  `[${new Date().toISOString()}] scheduler fleet poll ${workspaceRoot}: ${error instanceof Error ? error.message : String(error)}`,
                );
                return { workspaceRoot, recovered: 0, queued: 0 };
              }
            }),
          );
          iterations += 1;
          const iterationRecovered = pollResults.reduce(
            (total, workspace) => total + workspace.recovered,
            0,
          );
          const iterationQueued = pollResults.reduce(
            (total, workspace) => total + workspace.queued,
            0,
          );
          recovered += iterationRecovered;
          queued += iterationQueued;

          if (!args.json && (iterationRecovered || iterationQueued)) {
            writeStdoutLine(
              `scheduler fleet: workspaces=${workspaceRoots.length} recovered=${iterationRecovered} queued=${iterationQueued} active=${activeWorkspaceWorkers.size}`,
            );
          }
          if (args.json && (iterationRecovered || iterationQueued)) {
            writeStderrLine(
              `[${new Date().toISOString()}] scheduler fleet status workspaces=${workspaceRoots.length} recovered=${iterationRecovered} queued=${iterationQueued} active=${activeWorkspaceWorkers.size}.`,
            );
          }

          if (maxIterations !== undefined && iterations >= maxIterations) {
            break;
          }

          await waitForSchedulerFleetPoll(pollIntervalMs, controller.signal);
        }

        if (maxIterations !== undefined) {
          await awaitSchedulerFleetWorkerSettlement(
            activeWorkspaceWorkers.values(),
            serviceLock.touch,
          );
        }

        if (args.json) {
          printJson({ iterations, recoveredRuns: recovered, queuedRuns: queued, finishedRuns: runs });
        }
        return;
      } finally {
        if (activeWorkspaceWorkers.size > 0) {
          if (!controller.signal.aborted) {
            controller.abort("Scheduler fleet service is stopping.");
          }
        }
        try {
          if (activeWorkspaceWorkers.size > 0) {
            await awaitSchedulerFleetWorkerSettlement(
              activeWorkspaceWorkers.values(),
              serviceLock.touch,
            );
          }
        } finally {
          writeStderrLine(
            `[${new Date().toISOString()}] scheduler fleet service stopped iterations=${iterations} recovered=${recovered} queued=${queued} finished=${runs}.`,
          );
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          await serviceLock.release();
        }
      }
    }
    case "trigger": {
      const subject = options.subject ?? fail("No scheduled job id was provided.");
      const queued = await scheduler.triggerJobNow(
        subject,
        options.requestId ?? options.dedupeKey,
      );
      const runs =
        queued.run.status === "queued"
          ? await scheduler.runQueuedRuns({ maxRuns: 1 })
          : [];

      if (args.json) {
        printJson({
          queued: {
            handle: queued.handle,
            run: summarizeRun(queued.run),
            deduplicated: queued.deduplicated,
          },
          runs: runs.map(summarizeRun),
        });
        return;
      }

      printEnqueueResult(queued, false);
      printRunLines(runs);
      return;
    }
    case "retry": {
      const subject = options.subject ?? fail("No scheduled run id was provided.");
      const handle = await scheduler.retryRun(
        subject,
        options.requestId ?? options.dedupeKey,
      );
      const runs =
        handle.status === "queued"
          ? await scheduler.runQueuedRuns({ maxRuns: 1 })
          : [];

      if (args.json) {
        printJson({ handle, runs: runs.map(summarizeRun) });
        return;
      }

      writeStdoutLine(`retry run: ${handle.runId}`);
      printRunLines(runs);
      return;
    }
    case "cancel": {
      const subject = options.subject ?? fail("No scheduled run id was provided.");
      const run = await scheduler.cancelRun(
        subject,
        "Scheduled run cancelled.",
        options.requestId,
      );

      if (args.json) {
        printJson({ run: summarizeRun(run) });
        return;
      }

      writeStdoutLine(`cancelled run: ${run.id}`);
      writeStdoutLine(`status: ${run.status}`);
      return;
    }
    case "sync-prompts": {
      const result = await syncScheduledPromptJobs(
        scheduler,
        args.workspaceRoot,
      );

      if (args.json) {
        printJson({
          workspaceRoot: result.workspaceRoot,
          discovered: result.discovered,
          syncedJobs: result.syncedJobs.map(summarizeJob),
          pausedJobs: result.pausedJobs.map(summarizeJob),
        });
        return;
      }

      writeStdoutLine(`scheduled prompt definitions: ${result.discovered.length}`);
      writeStdoutLine(`synced jobs: ${result.syncedJobs.length}`);
      writeStdoutLine(`paused prompt jobs: ${result.pausedJobs.length}`);
      for (const definition of result.discovered) {
        const warnings =
          definition.warnings.length > 0
            ? ` warnings=${definition.warnings.join("; ")}`
            : "";
        writeStdoutLine(
          `- ${definition.path} enabled=${definition.enabled ? "true" : "false"}${warnings}`,
        );
      }
      return;
    }
  }
};
