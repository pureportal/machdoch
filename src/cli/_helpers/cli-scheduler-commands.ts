import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { loadRuntimeConfig } from "../../core/config.js";
import { discoverCustomizations } from "../../core/customizations.js";
import { executeTask } from "../../core/execution.js";
import {
  DurableSmartScheduler,
  getWorkspaceSchedulerStatePath,
  syncScheduledPromptJobs,
  type CreateScheduledJobInput,
  type ScheduledContextPackSnapshot,
  type ScheduledJob,
  type ScheduledJobRun,
  type ScheduledMacroReference,
  type ScheduledMissedRunPolicy,
  type ScheduledRunEnqueueResult,
  type ScheduledTaskExecutor,
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

const resolveWorkspaceFile = (workspaceRoot: string, path: string): string => {
  return isAbsolute(path) ? path : resolve(workspaceRoot, path);
};

const readPromptFile = async (
  workspaceRoot: string,
  path: string,
): Promise<string> => {
  const resolvedPath = resolveWorkspaceFile(workspaceRoot, path);

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

const createJobInput = async (
  args: ParsedCliArgs,
  options: SchedulerCliOptions,
): Promise<CreateScheduledJobInput> => {
  const prompt = options.promptFile
    ? await readPromptFile(args.workspaceRoot, options.promptFile)
    : options.prompt ?? "";
  const missedRunPolicy = isMissedRunPolicy(options.missedRunPolicy)
    ? options.missedRunPolicy
    : undefined;

  if (options.missedRunPolicy && !missedRunPolicy) {
    fail(
      "Expected --missed-run-policy to be one of skip, enqueue-latest, or enqueue-all.",
    );
  }

  return {
    ...(options.name ? { name: options.name } : {}),
    schedule: options.cron
      ? {
          type: "cron",
          expression: options.cron,
          ...(options.timezone ? { timezone: options.timezone } : {}),
        }
      : options.intervalMs
        ? {
            type: "interval",
            intervalMs: options.intervalMs,
          }
        : {
            type: "delay",
            ...(options.delayMs ? { delayMs: options.delayMs } : {}),
            ...(options.runAt ? { runAt: options.runAt } : {}),
          },
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

const createSchedulerExecutor = (): ScheduledTaskExecutor => ({
  execute: async (request, options): Promise<TaskExecutionResult> => {
    const config = await loadRuntimeConfig(
      request.workspaceRoot,
      request.mode,
      request.profile,
      request.model,
      request.provider,
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

const summarizeJob = (job: ScheduledJob): Record<string, unknown> => ({
  id: job.id,
  name: job.name,
  status: job.status,
  schedule: job.schedule,
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

const printJson = (value: unknown): void => {
  writeStdoutLine(JSON.stringify(value, null, 2));
};

const printJobLines = (jobs: ScheduledJob[]): void => {
  writeStdoutLine(`scheduled jobs: ${jobs.length}`);

  for (const job of jobs) {
    writeStdoutLine(
      `- ${job.id} [${job.status}] ${job.name} next=${job.nextRunAt ? new Date(job.nextRunAt).toISOString() : "none"}`,
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
