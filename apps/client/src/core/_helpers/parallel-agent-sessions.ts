import { randomUUID } from "node:crypto";
import { createToolErrorResult } from "./agent-tools-shared.js";
import {
  createManagedTaskExecutionTimeout,
  resolveTaskExecutionTimeouts,
} from "./task-execution-timeouts.js";
import {
  WorkerBoundaryError,
  workerResult,
  type ParallelWorkerState,
} from "./parallel-agent-worker-state.js";
import { runWorker, reportWorkerProgress } from "./parallel-agent-worker.js";
import { normalizePlan, validatePlans } from "./parallel-agent-plans.js";
import type {
  ParallelAgentSessionOptions,
  ParallelAgentSessionTool,
  ValidatedWorker,
} from "./parallel-agent-types.js";
export type {
  ParallelAgentSessionOptions,
  ParallelAgentSessionTool,
  ParallelWorkerPlan,
} from "./parallel-agent-types.js";

const MAX_WORKERS = 3;

export const createParallelAgentSessionTool = (
  options: ParallelAgentSessionOptions,
): ParallelAgentSessionTool => {
  const maxWorkers = Number.isSafeInteger(options.maxWorkers)
    ? Math.min(MAX_WORKERS, Math.max(2, options.maxWorkers!))
    : MAX_WORKERS;
  const workerFailures = new Set<string>();
  let running = false;
  let boundaryFailure = false;
  return {
    hasWorkerFailure: () =>
      running || boundaryFailure || workerFailures.size > 0,
    getCompletionBlocker: () => {
      if (boundaryFailure) {
        return "A parallel worker violated its declared file scope. Review the worker results and workspace changes.";
      }
      if (running) {
        return "Parallel workers are still running. Wait for their results before completing the task.";
      }
      return undefined;
    },
    definition: {
      spec: {
        name: "run_parallel_agents",
        description: `Run ${maxWorkers === 2 ? "two" : "two or three"} independent objectives in fresh concurrent agent sessions, then inspect their ordered results and toolErrors before completing the parent task. Use only when independent work saves time. Full Mode permits explicitly scoped file edits. Failed workers retain partial findings. Review their changes and finish any required work yourself or retry the workers. Report the parent task as blocked if required work remains incomplete.`,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            workers: {
              type: "array",
              minItems: 2,
              maxItems: maxWorkers,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,31}$" },
                  objective: { type: "string", minLength: 1, maxLength: 2_000 },
                  access: {
                    type: "string",
                    enum:
                      options.mode === "machdoch" &&
                      options.config.mode === "machdoch"
                        ? ["read-only", "write"]
                        : ["read-only"],
                  },
                  readPaths: {
                    type: "array",
                    maxItems: 32,
                    items: { type: "string", minLength: 1, maxLength: 1_000 },
                  },
                  writePaths: {
                    type: "array",
                    maxItems: 32,
                    items: { type: "string", minLength: 1, maxLength: 1_000 },
                  },
                },
                required: [
                  "id",
                  "objective",
                  "access",
                  "readPaths",
                  "writePaths",
                ],
              },
            },
          },
          required: ["workers"],
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      effect: "read",
      execute: async (args) => {
        if (running)
          return createToolErrorResult(
            randomUUID(),
            "run_parallel_agents",
            "Parallel agents are already running. Wait for their results before starting another group.",
          );
        running = true;
        try {
          if (options.signal?.aborted) {
            return createToolErrorResult(
              randomUUID(),
              "run_parallel_agents",
              "Parallel work was cancelled.",
            );
          }
          let workers: ValidatedWorker[];
          try {
            workers = await validatePlans(
              normalizePlan(args.workers, maxWorkers),
              options,
            );
          } catch (error) {
            return createToolErrorResult(
              randomUUID(),
              "run_parallel_agents",
              error instanceof Error ? error.message : String(error),
            );
          }
          if (options.signal?.aborted) {
            return createToolErrorResult(
              randomUUID(),
              "run_parallel_agents",
              "Parallel work was cancelled.",
            );
          }
          const attempts = workers.map((worker) => {
            const key = JSON.stringify([
              worker.id,
              worker.objective,
              worker.access,
              [...worker.canonicalReadPaths].sort(),
              [...worker.canonicalWritePaths].sort(),
            ]);
            workerFailures.add(key);
            return key;
          });
          const controller = new AbortController();
          const onAbort = () => controller.abort(options.signal?.reason);
          options.signal?.addEventListener("abort", onAbort, { once: true });
          if (options.signal?.aborted) onAbort();
          try {
            const scopedReads = workers.some(
              (worker) => worker.access === "write",
            );
            const states: ParallelWorkerState[] = workers.map(() => ({
              toolCalls: 0,
              successfulWrites: 0,
              answer: "",
              toolErrors: [],
            }));
            const outcomes = await Promise.allSettled(
              workers.map(async (worker, index) => {
                const state = states[index]!;
                const attempt = attempts[index]!;
                const workerController = new AbortController();
                const onGroupAbort = () =>
                  workerController.abort(controller.signal.reason);
                controller.signal.addEventListener("abort", onGroupAbort, {
                  once: true,
                });
                if (controller.signal.aborted) onGroupAbort();
                const timeout = createManagedTaskExecutionTimeout(
                  workerController.signal,
                  resolveTaskExecutionTimeouts({}),
                );
                const markActivity = () => {
                  if (timeout.signal.aborted) return;
                  timeout.markActivity();
                  options.onStreamActivity?.();
                };
                const workerOptions: ParallelAgentSessionOptions = {
                  ...options,
                  onStreamActivity: markActivity,
                };
                try {
                  reportWorkerProgress(workerOptions, {
                    kind: "agent",
                    phase: "started",
                    label: `Agent ${worker.id}`,
                    detail: worker.objective,
                    tone: "info",
                  });
                  await runWorker(
                    worker,
                    workerOptions,
                    timeout.signal,
                    scopedReads,
                    (error) => {
                      boundaryFailure = true;
                      controller.abort(error);
                    },
                    state,
                  );
                  timeout.signal.throwIfAborted();
                  workerFailures.delete(attempt);
                  reportWorkerProgress(options, {
                    kind: "agent",
                    phase: "completed",
                    label: `Agent ${worker.id}`,
                    tone: "success",
                  });
                  return workerResult(worker.id, state);
                } catch (error) {
                  if (error instanceof WorkerBoundaryError) {
                    boundaryFailure = true;
                    controller.abort(error);
                  }
                  reportWorkerProgress(options, {
                    kind: "agent",
                    phase: "failed",
                    label: `Agent ${worker.id}`,
                    detail:
                      error instanceof Error ? error.message : String(error),
                    tone: "danger",
                  });
                  return workerResult(
                    worker.id,
                    state,
                    error ?? new Error("Worker failed."),
                  );
                } finally {
                  controller.signal.removeEventListener("abort", onGroupAbort);
                  workerController.abort();
                  timeout.cleanup();
                }
              }),
            );
            const results = outcomes.map((outcome, index) =>
              outcome.status === "fulfilled"
                ? outcome.value
                : workerResult(
                    workers[index]!.id,
                    states[index]!,
                    outcome.reason ?? new Error("Worker failed."),
                  ),
            );
            return {
              toolResult: {
                callId: randomUUID(),
                name: "run_parallel_agents",
                isError: results.some((result) => result.status === "failed"),
                output: JSON.stringify(results),
              },
              sections: [
                {
                  title: "Parallel agents",
                  lines: results.map(
                    (result) => `${result.id}: ${result.status}`,
                  ),
                },
              ],
              traceLines: [
                `parallel agents: ${results.map((result) => `${result.id} ${result.status}`).join(", ")}`,
              ],
            };
          } finally {
            options.signal?.removeEventListener("abort", onAbort);
            controller.abort();
          }
        } finally {
          running = false;
        }
      },
    },
  };
};
