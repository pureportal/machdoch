import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { loadRuntimeConfig } from "../../core/config.js";
import { discoverCustomizations } from "../../core/customizations.js";
import { executeTask } from "../../core/execution.js";
import {
  createRalphRunLogger,
  readRalphFlow,
  runRalphFlow,
  writeRalphRunRecord,
  type RalphFlow,
  type RalphFlowScope,
  type RalphRunResult,
} from "../../core/ralph.js";
import {
  DurableSmartScheduler,
  getWorkspaceSchedulerStatePath,
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
import { writeStdoutLine } from "./cli-io.js";
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
  const prompt = options.promptFile
    ? await readSchedulerPromptFile(args.workspaceRoot, options.promptFile)
    : options.prompt ?? "";
  const missedRunPolicy = isMissedRunPolicy(options.missedRunPolicy)
    ? options.missedRunPolicy
    : undefined;
  const triggers = createTriggerInputs(options);

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
    target: {
      workspaceRoot: args.workspaceRoot,
      prompt,
      contextPaths: args.contextPaths ?? [],
      imagePaths: args.imagePaths ?? [],
      contextPacks: (options.contextPacks ?? []).map(parseContextPackSnapshot),
      macros: (options.macros ?? []).map(parseMacroReference),
      ...(args.mode ? { mode: args.mode } : {}),
      ...(args.profile ? { profile: args.profile } : {}),
      ...(args.runtimeProvider ? { provider: args.runtimeProvider } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.reasoning ? { reasoning: args.reasoning } : {}),
    },
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
  const config = await loadRuntimeConfig(
    request.workspaceRoot,
    "machdoch",
    request.profile,
    request.model,
    request.provider,
    undefined,
    request.reasoning,
  );
  const customizations = await discoverCustomizations(
    request.workspaceRoot,
    createDiscoveryOptions(config.compatibility.discoverGithubCustomizations),
  );
  const flow = await readRalphFlow(request.workspaceRoot, target.id, {
    scope: flowScope,
  });
  const variableValues = renderScheduledParams(target.params, request);
  assertScheduledRalphPermissions(flow, request, variableValues);
  const runId = `scheduled-${request.run.id}-${flow.id}`;
  const logger = await createRalphRunLogger(request.workspaceRoot, flow, {
    runId,
    variableValues,
    scope: runLogScope,
  });
  const result = await runRalphFlow(flow, config, customizations, {
    variableValues,
    runId: logger.runId,
    logger,
    ...(target.maxTransitions !== undefined
      ? { maxTransitions: target.maxTransitions }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  await writeRalphRunRecord(request.workspaceRoot, flow, result, {
    variableValues,
    runId: logger.runId,
    ...(logger.paths ? { paths: logger.paths } : {}),
    scope: runLogScope,
  });

  return summarizeRalphAsTaskResult(
    `Run Ralph flow ${flow.name} (${flowScope}:${flow.id}).`,
    result,
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
      request.profile,
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
    ...(options?.executor ? { executor: createSchedulerExecutor() } : {}),
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

const summarizeJob = (job: ScheduledJob): Record<string, unknown> => ({
  id: job.id,
  name: job.name,
  status: job.status,
  schedule: job.schedule ?? null,
  triggers: job.triggers,
  triggerLabel: formatSchedulerTriggerLabel(job),
  workspaceRoot: job.target.workspaceRoot,
  prompt: job.target.prompt,
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
      options.action === "retry",
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
    case "create": {
      const job = await scheduler.upsertJob(await createJobInput(args, options));

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
          ? await scheduler.pauseJob(subject)
          : options.action === "resume"
            ? await scheduler.resumeJob(subject)
            : await scheduler.deleteJob(subject);

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
    case "trigger": {
      const subject = options.subject ?? fail("No scheduled job id was provided.");
      const queued = await scheduler.triggerJobNow(subject);
      const runs = await scheduler.runQueuedRuns({ maxRuns: 1 });

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
      const handle = await scheduler.retryRun(subject);
      const runs = await scheduler.runQueuedRuns({ maxRuns: 1 });

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
      const run = await scheduler.cancelRun(subject);

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
