import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { loadRuntimeConfig } from "../../core/config.js";
import { discoverCustomizations } from "../../core/customizations.js";
import { getUserSchedulerStatePath, DurableSmartScheduler } from "../../core/scheduler.js";
import {
  createRalphRunLogger,
  createRalphFlowWithAgent,
  deleteRalphFlow,
  listRalphRunRecords,
  listRalphFlowRevisions,
  listRalphFlows,
  parseRalphFlowJson,
  readRalphRunLog,
  readRalphFlow,
  resolveRalphFlowReference,
  restoreRalphFlowRevision,
  runRalphFlow,
  validateRalphFlow,
  writeRalphRunRecord,
  writeRalphFlow,
  type RalphFlow,
  type RalphFlowScope,
  type RalphGenerationEvent,
  type RalphRunEvent,
  type RalphRunResult,
} from "../../core/ralph.js";
import {
  RalphWatchService,
  deleteRalphWatch,
  listRalphWatches,
  syncRalphWatchSchedulerJobs,
  upsertRalphWatch,
  type RalphWatchInput,
} from "../../core/ralph-watches.js";
import type { TaskExecutionProgress, TaskExecutionResult } from "../../core/types.js";
import { createSchedulerExecutor } from "./cli-scheduler-commands.js";
import { createDiscoveryOptions } from "./cli-output.js";
import {
  createVerboseProgressReporter,
  printExecutionSummary,
  writeStderrLine,
  writeStdoutLine,
} from "./cli-io.js";
import type { ParsedCliArgs, RalphCliOptions } from "./cli-args.js";

const fail = (message: string): never => {
  throw new Error(message);
};

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
    throw new Error("Expected Ralph prompt file path to be non-empty.");
  }

  const resolvedWorkspaceRoot = await realpath(workspaceRoot);
  const candidatePath = isAbsolute(normalizedPath)
    ? normalizedPath
    : resolve(resolvedWorkspaceRoot, normalizedPath);
  const resolvedPath = await realpath(candidatePath);

  if (!isPathInside(resolvedWorkspaceRoot, resolvedPath)) {
    throw new Error("Refusing to read Ralph prompt file outside the workspace.");
  }

  const metadata = await stat(resolvedPath);

  if (!metadata.isFile()) {
    throw new Error("Expected Ralph prompt file path to point to a file.");
  }

  return resolvedPath;
};

export const readRalphPromptFile = async (
  workspaceRoot: string,
  path: string,
): Promise<string> => {
  const resolvedPath = await resolveWorkspaceFile(workspaceRoot, path);

  return (await readFile(resolvedPath, "utf8")).trim();
};

const readRalphWorkspaceFile = async (
  workspaceRoot: string,
  path: string,
): Promise<string> => {
  const resolvedPath = await resolveWorkspaceFile(workspaceRoot, path);

  return await readFile(resolvedPath, "utf8");
};

const readRalphParamsFile = async (
  workspaceRoot: string,
  path: string,
): Promise<string[]> => {
  const contents = await readRalphWorkspaceFile(workspaceRoot, path);
  const parsed = JSON.parse(contents) as unknown;

  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("Expected --params-file to contain a JSON array of name=value strings.");
  }

  return parsed;
};

const parseVariableValues = (
  params: string[] | undefined,
): Record<string, string> => {
  const values: Record<string, string> = {};

  for (const param of params ?? []) {
    const separatorIndex = param.indexOf("=");

    if (separatorIndex <= 0) {
      throw new Error("Expected --param to use name=value syntax.");
    }

    const key = param.slice(0, separatorIndex).trim();
    const value = param.slice(separatorIndex + 1);

    if (!key) {
      throw new Error("Expected --param to include a non-empty name.");
    }

    values[key] = value;
  }

  return values;
};

const getRalphCommandScope = (options: RalphCliOptions): RalphFlowScope => {
  return options.scope ?? "workspace";
};

const readRalphWatchInput = async (
  args: ParsedCliArgs,
  options: RalphCliOptions,
): Promise<RalphWatchInput> => {
  const raw = options.watchJson ??
    (options.watchJsonFile
      ? await readRalphWorkspaceFile(args.workspaceRoot, options.watchJsonFile)
      : fail("Expected --watch-json or --watch-json-file."));
  const parsed = JSON.parse(raw) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected watch JSON to be an object.");
  }

  return parsed as RalphWatchInput;
};

const createUserScheduler = (withExecutor = false): DurableSmartScheduler => {
  return new DurableSmartScheduler({
    statePath: getUserSchedulerStatePath(),
    ...(withExecutor ? { executor: createSchedulerExecutor() } : {}),
  });
};

const deleteWatchSchedulerJob = async (
  scheduler: DurableSmartScheduler,
  watchId: string,
): Promise<void> => {
  const jobs = await scheduler.listJobs();
  const dedupeKey = `ralph-watch:${watchId}`;

  for (const job of jobs) {
    if (job.dedupeKey === dedupeKey && job.status !== "deleted") {
      await scheduler.deleteJob(job.id);
    }
  }
};

const printWatchLines = (
  watches: Awaited<ReturnType<typeof listRalphWatches>>,
): void => {
  writeStdoutLine(`ralph watches: ${watches.length}`);

  for (const watch of watches) {
    writeStdoutLine(
      `- ${watch.id} [${watch.enabled ? "enabled" : "disabled"}] flow=${watch.flow.scope}:${watch.flow.id} roots=${watch.roots.length}`,
    );
    writeStdoutLine(`  workspace: ${watch.executionWorkspaceRoot}`);
  }
};

const runRalphWatchService = async (args: ParsedCliArgs): Promise<void> => {
  const scheduler = createUserScheduler(true);
  const service = new RalphWatchService({
    scheduler,
    onError: (watch, error) => {
      writeStderrLine(
        `ralph watch ${watch.id} error: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
    onEvent: (watch, event, result) => {
      writeStdoutLine(
        `ralph watch ${watch.id}: ${event.type} ${event.relativePath} enqueued=${result.enqueued.length}`,
      );
    },
  });

  await service.start();

  if (args.json) {
    printJson({
      status: "running",
      watches: await listRalphWatches(),
      schedulerStatePath: getUserSchedulerStatePath(),
    });
  } else {
    writeStdoutLine("ralph watch service: running");
    writeStdoutLine("Press Ctrl+C to stop.");
  }

  await new Promise<void>((resolvePromise) => {
    const stop = (): void => {
      service.stop();
      resolvePromise();
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
};

const summarizeFlow = (flow: RalphFlow): Record<string, unknown> => {
  return {
    schemaVersion: flow.schemaVersion,
    id: flow.id,
    alias: flow.alias ?? null,
    name: flow.name,
    description: flow.description ?? null,
    settings: flow.settings ?? null,
    variables: flow.variables ?? [],
    blocks: flow.blocks,
    edges: flow.edges,
    createdAt: flow.createdAt ?? null,
    updatedAt: flow.updatedAt ?? null,
  };
};

const summarizeRun = (result: RalphRunResult): Record<string, unknown> => {
  return {
    flow: result.flow,
    status: result.status,
    summary: result.summary,
    missingVariables: result.missingVariables,
    unknownVariables: result.unknownVariables,
    events: result.events,
    blockResults: result.blockResults.map((blockResult) => ({
      blockId: blockResult.blockId,
      output: blockResult.output,
      status: blockResult.status,
      attempt: blockResult.attempt,
      summary: blockResult.summary,
      error: blockResult.error ?? null,
      execution: blockResult.result
        ? {
            status: blockResult.result.status,
            summary: blockResult.result.summary,
            reason: blockResult.result.reason ?? null,
          }
        : null,
    })),
  };
};

const getRalphEventBlockId = (event: RalphRunEvent): string | undefined => {
  switch (event.type) {
    case "block-start":
    case "block-output":
    case "retry":
    case "crash":
    case "end":
      return event.blockId;
    case "edge-route":
      return event.from;
  }
};

const getRalphEventActiveBlockId = (event: RalphRunEvent): string | undefined => {
  return event.type === "edge-route" ? event.to : getRalphEventBlockId(event);
};

const createRalphEventProgressMessage = (
  event: RalphRunEvent,
  blockTitleById: Map<string, string>,
): string => {
  const blockId = getRalphEventBlockId(event);
  const title = blockId ? blockTitleById.get(blockId) ?? blockId : "unknown block";

  switch (event.type) {
    case "block-start":
      return `Running Ralph block \`${title}\`.`;
    case "block-output":
      return `Ralph block \`${title}\` returned ${event.output}.`;
    case "edge-route":
      return `Routing ${event.output} from \`${title}\` to \`${blockTitleById.get(event.to) ?? event.to}\`.`;
    case "retry":
      return `Retrying Ralph block \`${title}\`: ${event.reason}`;
    case "crash":
      return `Ralph flow crashed at \`${title}\`: ${event.reason}`;
    case "end":
      return event.summary;
  }
};

const createRalphEventTimeline = (
  event: RalphRunEvent,
  blockTitleById: Map<string, string>,
): NonNullable<TaskExecutionProgress["timelineEvent"]> => {
  const blockId = getRalphEventBlockId(event);
  const activeBlockId = getRalphEventActiveBlockId(event);
  const activeBlockTitle = activeBlockId
    ? blockTitleById.get(activeBlockId) ?? activeBlockId
    : undefined;
  const metadata: NonNullable<
    NonNullable<TaskExecutionProgress["timelineEvent"]>["metadata"]
  > = {
    ralphEventType: event.type,
  };

  if (blockId) {
    metadata.ralphBlockId = blockId;
    metadata.ralphBlockTitle = blockTitleById.get(blockId) ?? blockId;
  }

  if (activeBlockId) {
    metadata.ralphActiveBlockId = activeBlockId;
    metadata.ralphActiveBlockTitle = activeBlockTitle ?? activeBlockId;
  }

  if (event.type === "block-start" || event.type === "retry") {
    metadata.ralphAttempt = event.attempt;
  }

  if (
    event.type === "block-output" ||
    event.type === "edge-route" ||
    event.type === "crash"
  ) {
    metadata.ralphOutput = event.output;
  }

  if (event.type === "edge-route") {
    metadata.ralphNextBlockId = event.to;
    metadata.ralphNextBlockTitle = blockTitleById.get(event.to) ?? event.to;
  }

  return {
    kind: event.type === "block-output" ? "output" : "state",
    phase:
      event.type === "crash"
        ? "failed"
        : event.type === "end" || event.type === "block-output"
          ? "completed"
          : "started",
    label: createRalphEventProgressMessage(event, blockTitleById),
    ...(event.type === "retry" || event.type === "crash"
      ? { detail: event.reason }
      : {}),
    tone:
      event.type === "crash"
        ? "danger"
        : event.type === "retry"
          ? "warning"
          : "info",
    metadata,
  };
};

const createRalphEventProgressReporter = (
  flow: RalphFlow,
  mode: TaskExecutionProgress["mode"],
): ((event: RalphRunEvent) => void) => {
  const blockTitleById = new Map(
    flow.blocks.map((block) => [block.id, block.title] as const),
  );
  const report = createVerboseProgressReporter(writeStderrLine, {
    structured: true,
  });

  return (event): void => {
    const progress: TaskExecutionProgress = {
      task: `Ralph flow \`${flow.name}\``,
      mode,
      state: "executing",
      message: createRalphEventProgressMessage(event, blockTitleById),
      executedTools: [],
      outputSections: [],
      cancellable: true,
      timelineEvent: createRalphEventTimeline(event, blockTitleById),
    };

    void report(progress);
  };
};

const createRalphGenerationProgressMessage = (
  event: RalphGenerationEvent,
): string => {
  if (event.message.trim()) {
    return event.message;
  }

  switch (event.type) {
    case "queued":
      return "Ralph flow generation is queued.";
    case "started":
      return "Ralph flow generation started.";
    case "round-start":
      return `Starting Ralph generation round ${event.round ?? "?"}.`;
    case "generator-start":
      return "Starting Ralph generator.";
    case "generator-output":
      return "Ralph generator produced output.";
    case "generator-file-written":
      return "Ralph generated flow file was written.";
    case "schema-validation-start":
      return "Validating generated Ralph flow schema.";
    case "schema-validation-result":
      return "Generated Ralph flow schema validation finished.";
    case "validator-start":
      return "Starting Ralph generation validator.";
    case "validator-result":
      return "Ralph generation validator finished.";
    case "fallback-provider":
      return "Ralph generation is trying a fallback provider.";
    case "retry-feedback":
      return "Ralph generation is retrying with feedback.";
    case "created":
      return "Ralph flow generation completed.";
    case "blocked":
      return "Ralph flow generation is blocked.";
    case "cancelled":
      return "Ralph flow generation was cancelled.";
    case "failed":
      return "Ralph flow generation failed.";
  }
};

const createRalphGenerationTimeline = (
  event: RalphGenerationEvent,
): NonNullable<TaskExecutionProgress["timelineEvent"]> => {
  const metadata: NonNullable<
    NonNullable<TaskExecutionProgress["timelineEvent"]>["metadata"]
  > = {
    ralphGenerationEventType: event.type,
    ralphGenerationRunId: event.generationRunId,
  };

  if (event.round !== undefined) {
    metadata.ralphGenerationRound = event.round;
  }

  if (event.maxRounds !== undefined) {
    metadata.ralphGenerationMaxRounds = event.maxRounds;
  }

  if (event.actor) {
    metadata.ralphGenerationActor = event.actor;
  }

  if (event.flowPath) {
    metadata.ralphGenerationFlowPath = event.flowPath;
  }

  if (event.generationFlowPath) {
    metadata.ralphGenerationTempFlowPath = event.generationFlowPath;
  }

  if (event.validationValid !== undefined) {
    metadata.ralphGenerationValidationValid = event.validationValid;
  }

  if (event.validationErrorCount !== undefined) {
    metadata.ralphGenerationValidationErrorCount = event.validationErrorCount;
  }

  if (event.validationWarningCount !== undefined) {
    metadata.ralphGenerationValidationWarningCount = event.validationWarningCount;
  }

  if (event.validatorDecision) {
    metadata.ralphGenerationValidatorDecision = event.validatorDecision;
  }

  if (event.status) {
    metadata.ralphGenerationStatus = event.status;
  }

  if (event.blockCount !== undefined) {
    metadata.ralphGenerationBlockCount = event.blockCount;
  }

  if (event.edgeCount !== undefined) {
    metadata.ralphGenerationEdgeCount = event.edgeCount;
  }

  if (event.durationMs !== undefined) {
    metadata.ralphGenerationDurationMs = event.durationMs;
  }

  const phase: NonNullable<TaskExecutionProgress["timelineEvent"]>["phase"] =
    event.type === "created"
      ? "completed"
      : event.type === "blocked" || event.type === "failed"
        ? "failed"
        : event.type === "cancelled"
          ? "rejected"
          : event.type === "retry-feedback"
            ? "requested-continuation"
            : event.type.endsWith("-result") || event.type === "generator-file-written"
              ? "completed"
              : "started";
  const kind: NonNullable<TaskExecutionProgress["timelineEvent"]>["kind"] =
    event.type === "generator-start" || event.type === "generator-output"
      ? "model-call"
      : event.type === "validator-start" ||
          event.type === "validator-result" ||
          event.type === "schema-validation-start" ||
          event.type === "schema-validation-result"
        ? "validator"
        : event.type === "retry-feedback" || event.type === "fallback-provider"
          ? "retry"
          : event.type === "generator-file-written"
            ? "output"
            : "state";
  const tone: NonNullable<TaskExecutionProgress["timelineEvent"]>["tone"] =
    event.type === "created"
      ? "success"
      : event.type === "blocked" || event.type === "failed" || event.type === "cancelled"
        ? "danger"
        : event.type === "retry-feedback" || event.type === "fallback-provider"
          ? "warning"
          : "info";

  return {
    kind,
    phase,
    label: createRalphGenerationProgressMessage(event),
    tone,
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.model ? { model: event.model } : {}),
    metadata,
  };
};

const createRalphGenerationProgressReporter = (
  mode: TaskExecutionProgress["mode"],
): ((event: RalphGenerationEvent) => void) => {
  const report = createVerboseProgressReporter(writeStderrLine, {
    structured: true,
  });

  return (event): void => {
    const progress: TaskExecutionProgress = {
      task: "Ralph flow generation",
      mode,
      state:
        event.type === "created"
          ? "completed"
          : event.type === "cancelled"
            ? "cancelled"
            : event.type === "blocked" || event.type === "failed"
              ? "blocked"
              : event.type === "schema-validation-start" ||
                  event.type === "schema-validation-result" ||
                  event.type === "validator-start" ||
                  event.type === "validator-result"
                ? "verifying"
                : "executing",
      message: createRalphGenerationProgressMessage(event),
      executedTools: [],
      outputSections: [],
      cancellable: true,
      timelineEvent: createRalphGenerationTimeline(event),
    };

    void report(progress);
  };
};

const summarizeGenerationActorResult = (
  result: TaskExecutionResult,
): Record<string, unknown> => {
  return {
    status: result.status,
    summary: result.summary,
    reason: result.reason ?? null,
    executedTools: result.executedTools,
  };
};

const printJson = (value: unknown): void => {
  writeStdoutLine(JSON.stringify(value, null, 2));
};

const printFlowLines = (flow: RalphFlow, path: string): void => {
  writeStdoutLine(`flow: ${flow.id}`);
  if (flow.alias) {
    writeStdoutLine(`alias: ${flow.alias}`);
  }
  writeStdoutLine(`name: ${flow.name}`);
  writeStdoutLine(`path: ${path}`);

  if (flow.description) {
    writeStdoutLine(`description: ${flow.description}`);
  }

  writeStdoutLine(`variables: ${flow.variables?.length ?? 0}`);
  for (const variable of flow.variables ?? []) {
    writeStdoutLine(
      `- ${variable.name}:${variable.type}${variable.default !== undefined ? `=${variable.default}` : ""}`,
    );
  }

  writeStdoutLine(`blocks: ${flow.blocks.length}`);
  for (const block of flow.blocks) {
    writeStdoutLine(`- ${block.id} [${block.type}] ${block.title}`);
  }

  writeStdoutLine(`edges: ${flow.edges.length}`);
  for (const edge of flow.edges) {
    writeStdoutLine(`- ${edge.from}.${edge.fromOutput} -> ${edge.to}`);
  }
};

const getPromptText = async (
  args: ParsedCliArgs,
  options: RalphCliOptions,
): Promise<string> => {
  if (options.prompt && options.promptFile) {
    fail("Use either --prompt or --prompt-file for `machdoch ralph create`, not both.");
  }

  if (options.promptFile) {
    return readRalphPromptFile(args.workspaceRoot, options.promptFile);
  }

  return options.prompt ?? "";
};

export const printRalphSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const options = args.ralph ?? fail("No Ralph action was provided.");
  const scope = getRalphCommandScope(options);

  switch (options.action) {
    case "watches": {
      const watchAction = options.watchAction ?? "list";
      const scheduler = createUserScheduler(false);

      switch (watchAction) {
        case "list": {
          const watches = await listRalphWatches();

          if (args.json) {
            printJson({
              watches,
              schedulerStatePath: getUserSchedulerStatePath(),
            });
            return;
          }

          printWatchLines(watches);
          return;
        }
        case "create": {
          const input = await readRalphWatchInput(args, options);
          const watch = await upsertRalphWatch(input);
          await syncRalphWatchSchedulerJobs(scheduler);

          if (args.json) {
            printJson({
              watch,
              schedulerStatePath: getUserSchedulerStatePath(),
            });
            return;
          }

          writeStdoutLine(`ralph watch saved: ${watch.id}`);
          writeStdoutLine(`flow: ${watch.flow.scope}:${watch.flow.id}`);
          writeStdoutLine(`workspace: ${watch.executionWorkspaceRoot}`);
          return;
        }
        case "delete": {
          const subject = options.subject ??
            fail("Expected a watch id after `machdoch ralph watches delete`.");
          const watch = await deleteRalphWatch(subject);
          await deleteWatchSchedulerJob(scheduler, watch.id);

          if (args.json) {
            printJson({ deleted: watch });
            return;
          }

          writeStdoutLine(`ralph watch deleted: ${watch.id}`);
          return;
        }
        case "sync": {
          await syncRalphWatchSchedulerJobs(scheduler);

          if (args.json) {
            printJson({
              synced: true,
              watches: await listRalphWatches(),
              schedulerStatePath: getUserSchedulerStatePath(),
            });
            return;
          }

          writeStdoutLine("ralph watches synced");
          return;
        }
        case "run": {
          await runRalphWatchService(args);
          return;
        }
      }
    }
    case "list": {
      const flows = await listRalphFlows(args.workspaceRoot, { scope });

      if (args.json) {
        printJson({ workspaceRoot: args.workspaceRoot, scope, flows });
        return;
      }

      writeStdoutLine(`ralph flows (${scope}): ${flows.length}`);
      for (const flow of flows) {
        writeStdoutLine(
          `- ${flow.id}${flow.alias ? ` alias=${flow.alias}` : ""} blocks=${flow.blockCount} edges=${flow.edgeCount} vars=${flow.variableCount}`,
        );
        if (flow.description) {
          writeStdoutLine(`  ${flow.description}`);
        }
      }
      return;
    }
    case "show": {
      const subject = options.subject ?? fail("Expected a flow id or alias after `machdoch ralph show`.");
      const resolution = await resolveRalphFlowReference(args.workspaceRoot, subject, {
        scope,
      });
      const flow = await readRalphFlow(args.workspaceRoot, resolution.id, {
        allowInvalid: true,
        scope,
      });

      if (args.json) {
        printJson({ flow: summarizeFlow(flow), path: resolution.path, scope });
        return;
      }

      printFlowLines(flow, resolution.path);
      return;
    }
    case "validate": {
      const subject = options.subject ??
        fail("Expected a flow id or alias after `machdoch ralph validate`.");
      const resolution = await resolveRalphFlowReference(args.workspaceRoot, subject, {
        scope,
      });
      const path = resolution.path;
      const flow = resolution.flow;
      const validation = validateRalphFlow(flow);

      if (args.json) {
        printJson({ path, scope, validation });
        return;
      }

      writeStdoutLine(validation.valid ? "valid: true" : "valid: false");
      for (const error of validation.errors) {
        writeStdoutLine(`error: ${error}`);
      }
      for (const warning of validation.warnings) {
        writeStdoutLine(`warning: ${warning}`);
      }
      return;
    }
    case "delete": {
      const subject = options.subject ??
        fail("Expected a flow id or alias after `machdoch ralph delete`.");
      const result = await deleteRalphFlow(args.workspaceRoot, subject, { scope });

      if (args.json) {
        printJson({ ...result, scope });
        return;
      }

      writeStdoutLine(`ralph delete: ${result.id}`);
      writeStdoutLine(`path: ${result.path}`);
      if (result.deletedRevisions) {
        writeStdoutLine(`revisions: ${result.revisionDirectory}`);
      }
      return;
    }
    case "revisions": {
      const subject = options.subject ??
        fail("Expected a flow id or alias after `machdoch ralph revisions`.");
      const revisions = await listRalphFlowRevisions(args.workspaceRoot, subject, {
        scope,
      });

      if (args.json) {
        printJson({ flow: subject, scope, revisions });
        return;
      }

      writeStdoutLine(`ralph revisions: ${revisions.length}`);
      for (const revision of revisions) {
        writeStdoutLine(
          `- ${revision.id} ${revision.createdAt} blocks=${revision.blockCount} edges=${revision.edgeCount} valid=${revision.valid ? "true" : "false"}`,
        );
      }
      return;
    }
    case "runs": {
      const runs = await listRalphRunRecords(args.workspaceRoot, {
        ...(options.subject ? { flowId: options.subject } : {}),
        scope,
      });

      if (args.json) {
        printJson({ scope, runs });
        return;
      }

      writeStdoutLine(`ralph runs: ${runs.length}`);
      for (const run of runs) {
        writeStdoutLine(
          `- ${run.id} ${run.status} ${run.createdAt} flow=${run.flowName} blocks=${run.blockCount} events=${run.eventCount}`,
        );
        writeStdoutLine(`  ${run.summary}`);
      }
      return;
    }
    case "log": {
      const subject = options.subject ??
        fail("Expected a run id after `machdoch ralph log`.");
      const log = await readRalphRunLog(
        args.workspaceRoot,
        subject,
        options.trace ? "trace" : "simple",
        { scope },
      );

      if (args.json) {
        printJson(log);
        return;
      }

      writeStdoutLine(log.content);
      return;
    }
    case "restore": {
      const subject = options.subject ??
        fail("Expected a flow id or alias after `machdoch ralph restore`.");
      const revision = options.revision ??
        fail("Expected --revision for `machdoch ralph restore`.");
      const result = await restoreRalphFlowRevision(
        args.workspaceRoot,
        subject,
        revision,
        { scope },
      );

      if (args.json) {
        printJson({
          path: result.path,
          scope,
          flow: summarizeFlow(result.flow),
          validation: result.validation,
          revision: result.revision,
        });
        return;
      }

      writeStdoutLine(`ralph restore: ${result.flow.id}`);
      writeStdoutLine(`revision: ${result.revision.id}`);
      writeStdoutLine(`path: ${result.path}`);
      for (const error of result.validation.errors) {
        writeStdoutLine(`error: ${error}`);
      }
      for (const warning of result.validation.warnings) {
        writeStdoutLine(`warning: ${warning}`);
      }
      return;
    }
    case "save": {
      const subject = options.subject ??
        fail("Expected a flow id or alias after `machdoch ralph save`.");
      const rawFlow = options.flowJson ??
        (options.flowJsonFile
          ? await readRalphWorkspaceFile(args.workspaceRoot, options.flowJsonFile)
          : fail("Expected --flow-json or --flow-json-file for `machdoch ralph save`."));
      const flow = parseRalphFlowJson(rawFlow);

      const normalizedSubject = subject.trim().toLowerCase();
      const subjectMatchesFlow =
        flow.id === normalizedSubject ||
        flow.alias?.trim().toLowerCase() === normalizedSubject;

      if (!subjectMatchesFlow) {
        fail(
          `Expected --flow-json to contain Ralph flow id or alias \`${subject}\`, got \`${flow.id}\`.`,
        );
      }

      const path = await writeRalphFlow(args.workspaceRoot, flow, {
        createRevision: true,
        reason: "manual-save",
        allowInvalid: true,
        scope,
      });
      const storedFlow = await readRalphFlow(args.workspaceRoot, flow.id, {
        allowInvalid: true,
        scope,
      });
      const validation = validateRalphFlow(storedFlow);

      if (args.json) {
        printJson({ path, scope, flow: summarizeFlow(storedFlow), validation });
        return;
      }

      writeStdoutLine(`ralph save: ${storedFlow.id}`);
      writeStdoutLine(`path: ${path}`);
      for (const error of validation.errors) {
        writeStdoutLine(`error: ${error}`);
      }
      for (const warning of validation.warnings) {
        writeStdoutLine(`warning: ${warning}`);
      }
      return;
    }
    case "run": {
      const subject = options.subject ??
        fail("Expected a flow id or alias after `machdoch ralph run`.");
      const config = await loadRuntimeConfig(
        args.workspaceRoot,
        "machdoch",
        args.profile,
        args.model,
        args.runtimeProvider,
        args.agentLimits,
        args.reasoning,
      );
      const customizations = await discoverCustomizations(
        args.workspaceRoot,
        createDiscoveryOptions(config.compatibility.discoverGithubCustomizations),
      );
      const flow = await readRalphFlow(args.workspaceRoot, subject, { scope });
      const fileParams = options.paramsFile
        ? await readRalphParamsFile(args.workspaceRoot, options.paramsFile)
        : [];
      const variableValues = parseVariableValues([
        ...(options.params ?? []),
        ...fileParams,
      ]);
      const logger = await createRalphRunLogger(args.workspaceRoot, flow, {
        variableValues,
        scope: "workspace",
      });
      const result = await runRalphFlow(flow, config, customizations, {
        variableValues,
        runId: logger.runId,
        logger,
        ...(options.maxTransitions !== undefined
          ? { maxTransitions: options.maxTransitions }
          : {}),
        ...(args.json
          ? {
              onEvent: createRalphEventProgressReporter(flow, config.mode),
            }
          : {}),
      });
      const runRecord = await writeRalphRunRecord(args.workspaceRoot, flow, result, {
        variableValues,
        runId: logger.runId,
        ...(logger.paths ? { paths: logger.paths } : {}),
        scope: "workspace",
      });

      if (args.json) {
        printJson({
          scope,
          run: summarizeRun(result),
          runLogPath: runRecord.paths.simpleMarkdownPath,
          runRecordPath: runRecord.path,
          traceLogPath: runRecord.paths.traceJsonlPath,
        });
        return;
      }

      writeStdoutLine(`ralph run: ${result.status}`);
      writeStdoutLine(result.summary);
      writeStdoutLine(`run log: ${runRecord.paths.simpleMarkdownPath}`);
      writeStdoutLine(`trace log: ${runRecord.paths.traceJsonlPath}`);
      for (const event of result.events) {
        if (event.type === "edge-route") {
          writeStdoutLine(`- ${event.from}.${event.output} -> ${event.to}`);
        } else if (event.type === "crash") {
          writeStdoutLine(`- crash ${event.blockId}.${event.output}: ${event.reason}`);
        }
      }

      for (const blockResult of result.blockResults) {
        if (blockResult.result?.response || blockResult.result?.outputSections.length) {
          printExecutionSummary(blockResult.result);
        }
      }
      return;
    }
    case "create": {
      const name = options.name ?? options.subject ??
        fail("Expected --name or a flow alias for `machdoch ralph create`.");
      const prompt = await getPromptText(args, options);

      if (!prompt.trim()) {
        fail("Expected --prompt or --prompt-file for `machdoch ralph create`.");
      }

      const existingFlowJson = options.existingFlowJson ??
        (options.existingFlowJsonFile
          ? await readRalphWorkspaceFile(args.workspaceRoot, options.existingFlowJsonFile)
          : undefined);
      const existingFlow = existingFlowJson
        ? parseRalphFlowJson(existingFlowJson)
        : undefined;
      const config = await loadRuntimeConfig(
        args.workspaceRoot,
        "machdoch",
        args.profile,
        args.model,
        args.runtimeProvider,
        args.agentLimits,
        args.reasoning,
      );
      const customizations = await discoverCustomizations(
        args.workspaceRoot,
        createDiscoveryOptions(config.compatibility.discoverGithubCustomizations),
      );
      const result = await createRalphFlowWithAgent(args.workspaceRoot, {
        name,
        prompt,
        scope,
        config,
        customizations,
        ...(existingFlow ? { existingFlow } : {}),
        ...(options.target ? { target: options.target } : {}),
        ...(options.generationMode ? { mode: options.generationMode } : {}),
        ...(options.maxRounds ? { maxRounds: options.maxRounds } : {}),
        ...(args.json
          ? {
              onGenerationEvent: createRalphGenerationProgressReporter(config.mode),
            }
          : {}),
      });

      if (args.json) {
        printJson({
          generationRunId: result.generationRunId ?? null,
          status: result.status,
          flowPath: result.flowPath,
          generationLogPath: result.generationLogPath ?? null,
          traceLogPath: result.traceLogPath ?? null,
          rounds: result.rounds,
          validation: result.validation,
          summary: result.summary,
          flow: result.flow ? summarizeFlow(result.flow) : null,
          events: result.events,
          generatorResults: result.generatorResults.map(summarizeGenerationActorResult),
          validatorResults: result.validatorResults.map(summarizeGenerationActorResult),
        });
        return;
      }

      writeStdoutLine(`ralph create: ${result.status}`);
      writeStdoutLine(`path: ${result.flowPath}`);
      if (result.generationLogPath) {
        writeStdoutLine(`generation log: ${result.generationLogPath}`);
      }
      if (result.traceLogPath) {
        writeStdoutLine(`trace log: ${result.traceLogPath}`);
      }
      writeStdoutLine(`rounds: ${result.rounds}`);
      writeStdoutLine(result.summary);
      for (const error of result.validation.errors) {
        writeStdoutLine(`error: ${error}`);
      }
      for (const warning of result.validation.warnings) {
        writeStdoutLine(`warning: ${warning}`);
      }
      return;
    }
  }
};
