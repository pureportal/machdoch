import { randomUUID } from "node:crypto";
import { isAbsolute, sep } from "node:path";
import { createFilesystemToolDefinitions } from "./filesystem-tool-definitions.js";
import { createGitToolDefinitions } from "./git-tool-definitions.js";
import { createShellNetworkToolDefinitions } from "./shell-network-tool-definitions.js";
import {
  createToolErrorResult,
  resolveWorkspaceTarget,
  type AgentToolDefinition,
} from "./agent-tools-shared.js";
import { executeToolCall } from "./agent-tools.js";
import { createProviderAdapter } from "./provider-adapters.js";
import { observeAgentModelCall } from "../model-usage.js";
import { assertInstructionInvocationBudget } from "../instruction-system/index.js";
import type {
  AgentModelAdapter,
  AgentModelToolResult,
  AgentModelTurn,
  ParallelAgentMode,
  ResolvedTaskContext,
  TaskExecutionTimelineEvent,
} from "../types.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";

const MAX_WORKERS = 3;
const MAX_WORKER_TURNS = 8;
const MAX_WORKER_TOOL_CALLS = 24;
const MAX_WORKER_TEXT = 12_000;
const MAX_WORKER_DURATION_MS = 180_000;
const READ_TOOLS = new Set([
  "list_directory",
  "read_file",
  "search_workspace",
  "get_git_status",
  "get_git_diff_summary",
  "get_git_log",
  "fetch_url",
  "search_web",
]);
const SCOPED_TOOLS = new Set(["read_file", "create_file", "replace_in_file"]);
const WRITE_TOOLS = new Set(["create_file", "replace_in_file"]);

class WorkerBoundaryError extends Error {}

const awaitModelCall = async <T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> => {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      finish();
      reject(signal.reason ?? new Error("Parallel work was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        if (settled) return;
        finish();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        finish();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
};

export interface ParallelWorkerPlan {
  id: string;
  objective: string;
  access: "read-only" | "write";
  readPaths: string[];
  writePaths: string[];
}

interface ValidatedWorker extends ParallelWorkerPlan {
  canonicalReadPaths: string[];
  canonicalWritePaths: string[];
}

export interface ParallelAgentSessionOptions {
  config: RuntimeConfig;
  task: string;
  taskContext: ResolvedTaskContext;
  mode: ParallelAgentMode;
  maxWorkers?: number;
  signal?: AbortSignal;
  createWorkerAdapter?: () => Promise<AgentModelAdapter>;
  onProgress?: (event: TaskExecutionTimelineEvent) => void | Promise<void>;
}

export interface ParallelAgentSessionTool {
  definition: AgentToolDefinition;
  hasWorkerFailure(): boolean;
}

const reportWorkerProgress = (
  options: ParallelAgentSessionOptions,
  event: TaskExecutionTimelineEvent,
): void => {
  if (!options.onProgress || options.signal?.aborted) return;
  try {
    void Promise.resolve(options.onProgress(event)).catch((error: unknown) => {
      console.warn("Could not report parallel agent progress:", error);
    });
  } catch (error) {
    console.warn("Could not report parallel agent progress:", error);
  }
};

const workerModelEvent = (
  worker: ValidatedWorker,
  pass: number,
  phase: "started" | "completed" | "failed",
): TaskExecutionTimelineEvent => ({
  kind: "model-call",
  phase,
  label: `Agent ${worker.id} · AI pass ${pass}`,
  tone:
    phase === "failed" ? "danger" : phase === "completed" ? "success" : "info",
});

const workerToolEvent = (
  worker: ValidatedWorker,
  call: AgentModelTurn["toolCalls"][number],
  phase: "started" | "completed" | "failed",
): TaskExecutionTimelineEvent => {
  const target =
    call.arguments.path ?? call.arguments.query ?? call.arguments.url;
  return {
    kind: "tool-call",
    phase,
    label: `Agent ${worker.id} · ${call.name.replaceAll("_", " ")}`,
    ...(typeof target === "string" ? { detail: target.slice(0, 240) } : {}),
    tone:
      phase === "failed"
        ? "danger"
        : phase === "completed"
          ? "success"
          : "info",
    toolName: call.name,
    callId: `${worker.id}:${call.id}`,
  };
};

const canonicalPath = (path: string): string =>
  process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;

const pathsOverlap = (first: string, second: string): boolean =>
  first === second ||
  first.startsWith(`${second}${sep}`) ||
  second.startsWith(`${first}${sep}`);

const normalizePlan = (
  value: unknown,
  maxWorkers: number,
): ParallelWorkerPlan[] => {
  if (!Array.isArray(value) || value.length < 2 || value.length > maxWorkers) {
    throw new Error(
      `Choose ${maxWorkers === 2 ? "two" : "two or three"} independent workers.`,
    );
  }
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Every worker needs an objective and path claims.");
    }
    const worker = entry as Record<string, unknown>;
    const id = typeof worker.id === "string" ? worker.id.trim() : "";
    const objective =
      typeof worker.objective === "string" ? worker.objective.trim() : "";
    if (
      !/^[a-z][a-z0-9_-]{0,31}$/u.test(id) ||
      ids.has(id) ||
      !objective ||
      objective.length > 2_000
    ) {
      throw new Error(
        "Worker ids must be unique and objectives must be self-contained.",
      );
    }
    if (worker.access !== "read-only" && worker.access !== "write") {
      throw new Error(`Worker ${id} has an invalid access mode.`);
    }
    if (
      !Array.isArray(worker.readPaths) ||
      !Array.isArray(worker.writePaths) ||
      [...worker.readPaths, ...worker.writePaths].some(
        (path) =>
          typeof path !== "string" || !path.trim() || path.length > 1_000,
      ) ||
      worker.readPaths.length > 32 ||
      worker.writePaths.length > 32
    ) {
      throw new Error(`Worker ${id} has invalid path claims.`);
    }
    if (worker.access === "read-only" && worker.writePaths.length > 0) {
      throw new Error(`Read-only worker ${id} cannot claim write paths.`);
    }
    if (worker.access === "write" && worker.writePaths.length === 0) {
      throw new Error(`Write worker ${id} needs explicit file paths.`);
    }
    ids.add(id);
    return {
      id,
      objective,
      access: worker.access,
      readPaths: worker.readPaths as string[],
      writePaths: worker.writePaths as string[],
    };
  });
};

const validatePlans = async (
  workers: ParallelWorkerPlan[],
  options: ParallelAgentSessionOptions,
): Promise<ValidatedWorker[]> => {
  if (options.mode === "disabled") {
    throw new Error("Parallel agents are disabled for this session.");
  }
  if (
    workers.some((worker) => worker.access === "write") &&
    (options.mode !== "machdoch" || options.config.mode !== "machdoch")
  ) {
    throw new Error(
      "Write workers require Full Mode and Machdoch execution mode.",
    );
  }
  const validated = await Promise.all(
    workers.map(async (worker) => {
      const resolveClaims = async (paths: string[]): Promise<string[]> => {
        const claims = await Promise.all(
          paths.map(async (path) => {
            const target = await resolveWorkspaceTarget(
              options.config.workspaceRoot,
              path,
            );
            if (
              !target.insideWorkspace ||
              !target.workspacePath ||
              isAbsolute(path)
            ) {
              throw new Error(
                `Worker ${worker.id} claims a path outside the workspace or its root.`,
              );
            }
            return canonicalPath(target.resolvedPath);
          }),
        );
        return [...new Set(claims)];
      };
      return {
        ...worker,
        canonicalReadPaths: await resolveClaims(worker.readPaths),
        canonicalWritePaths: await resolveClaims(worker.writePaths),
      };
    }),
  );

  for (let index = 0; index < validated.length; index += 1) {
    const current = validated[index]!;
    for (const other of validated.slice(index + 1)) {
      if (
        (current.canonicalWritePaths.length > 0 &&
          other.access === "read-only" &&
          other.canonicalReadPaths.length === 0) ||
        (other.canonicalWritePaths.length > 0 &&
          current.access === "read-only" &&
          current.canonicalReadPaths.length === 0)
      ) {
        throw new Error(
          "A worker with unrestricted reads cannot run alongside a write worker.",
        );
      }
      const conflicts =
        current.canonicalWritePaths.some((path) =>
          [...other.canonicalWritePaths, ...other.canonicalReadPaths].some(
            (claim) => pathsOverlap(path, claim),
          ),
        ) ||
        other.canonicalWritePaths.some((path) =>
          current.canonicalReadPaths.some((claim) => pathsOverlap(path, claim)),
        );
      if (conflicts) {
        throw new Error(
          `Workers ${current.id} and ${other.id} have overlapping paths.`,
        );
      }
    }
  }
  return validated;
};

const createWorkerTools = (
  options: ParallelAgentSessionOptions,
  worker: ValidatedWorker,
  scopedReads: boolean,
): AgentToolDefinition[] => {
  const definitions = [
    ...createFilesystemToolDefinitions(),
    ...createGitToolDefinitions(),
    ...createShellNetworkToolDefinitions(options.config),
  ];
  const allowed =
    worker.access === "write"
      ? SCOPED_TOOLS
      : scopedReads
        ? new Set(["read_file"])
        : READ_TOOLS;
  return definitions
    .filter((definition) => allowed.has(definition.spec.name))
    .map((definition) => ({
      ...definition,
      execute: async (args, context) => {
        const path = args.path;
        if (scopedReads && typeof path !== "string") {
          return createToolErrorResult(
            randomUUID(),
            definition.spec.name,
            "This worker can only use scoped file paths.",
          );
        }
        if (typeof path === "string" && scopedReads) {
          const target = await resolveWorkspaceTarget(
            context.workspaceRoot,
            path,
          );
          const claim = canonicalPath(target.resolvedPath);
          const allowedPaths = WRITE_TOOLS.has(definition.spec.name)
            ? worker.canonicalWritePaths
            : [...worker.canonicalReadPaths, ...worker.canonicalWritePaths];
          const claimed = WRITE_TOOLS.has(definition.spec.name)
            ? allowedPaths.includes(claim)
            : allowedPaths.some(
                (path) => claim === path || claim.startsWith(`${path}${sep}`),
              );
          if (!target.insideWorkspace || !claimed) {
            throw new WorkerBoundaryError(
              `Worker ${worker.id} attempted to access an unclaimed path.`,
            );
          }
        }
        return definition.execute(args, context);
      },
    }));
};

const runWorker = async (
  worker: ValidatedWorker,
  options: ParallelAgentSessionOptions,
  signal: AbortSignal,
  scopedReads: boolean,
): Promise<{
  id: string;
  status: "completed" | "failed";
  answer: string;
  toolCalls: number;
}> => {
  const tools = createWorkerTools(options, worker, scopedReads);
  const specs = tools.map((tool) => tool.spec);
  const toolMap = new Map(tools.map((tool) => [tool.spec.name, tool]));
  if (signal.aborted)
    throw signal.reason ?? new Error("Parallel work was cancelled.");
  const adapter = await awaitModelCall(
    options.createWorkerAdapter
      ? options.createWorkerAdapter()
      : createProviderAdapter(options.config, specs, undefined),
    signal,
  );
  if (!adapter)
    throw new Error("The selected provider cannot start a worker session.");
  const instructionResolution = options.taskContext.instructionResolution;
  const instructions = instructionResolution?.renderedEnvelope;
  if (!instructionResolution || !instructions)
    throw new Error("The worker instruction snapshot is missing.");
  const systemPrompt = [
    instructions,
    "You are a bounded parallel worker in one Machdoch task. Complete only your objective. Do not delegate or write memory. Return findings and verification evidence. Do not give instructions to the parent.",
    worker.access === "write"
      ? `You may edit only these files: ${worker.writePaths.join(", ")}.`
      : "Read only. Do not modify any resource.",
  ].join("\n\n");
  const userPrompt = `Original task: ${options.task}\n\nYour objective: ${worker.objective}`;
  const initialRequestBytes = Buffer.byteLength(
    JSON.stringify({ systemPrompt, userPrompt, tools: specs }),
    "utf8",
  );
  assertInstructionInvocationBudget(instructionResolution, {
    phase: "initial",
    assembledRequestBytes: initialRequestBytes,
  });
  const workerConfig = {
    ...options.config,
    mode: worker.access === "write" ? ("machdoch" as const) : ("ask" as const),
  };
  const emptyMemory = {
    sessionEnabled: false,
    sessionEntries: [],
    workspaceEnabled: false,
    workspaceEntries: [],
    globalEnabled: false,
    globalEntries: [],
  };
  if (signal.aborted)
    throw signal.reason ?? new Error("Parallel work was cancelled.");
  reportWorkerProgress(options, workerModelEvent(worker, 1, "started"));
  if (signal.aborted)
    throw signal.reason ?? new Error("Parallel work was cancelled.");
  let turn: AgentModelTurn;
  try {
    turn = await awaitModelCall(
      observeAgentModelCall(
        {
          stage: "executor",
          provider: options.config.provider,
          model: options.config.model,
          operation: `parallelWorker:${worker.id}:start`,
          requestBytes: initialRequestBytes,
          toolDefinitions: specs,
        },
        async (onRequestAttempt) =>
          adapter.startTurn({
            model: options.config.model,
            reasoning: options.config.reasoning,
            systemPrompt,
            userPrompt,
            tools: specs,
            signal,
            ...(onRequestAttempt ? { onRequestAttempt } : {}),
          }),
      ),
      signal,
    );
  } catch (error) {
    reportWorkerProgress(options, workerModelEvent(worker, 1, "failed"));
    throw error;
  }
  if (signal.aborted)
    throw signal.reason ?? new Error("Parallel work was cancelled.");
  reportWorkerProgress(options, workerModelEvent(worker, 1, "completed"));
  let toolCalls = 0;
  let answer = "";
  let lastToolBatchFailed = false;
  for (let index = 0; index < MAX_WORKER_TURNS; index += 1) {
    if (signal.aborted) throw new Error("Parallel work was cancelled.");
    answer = turn.text.trim() || answer;
    if (turn.toolCalls.length === 0) {
      if (!answer) throw new Error(`Worker ${worker.id} returned no result.`);
      if (lastToolBatchFailed)
        throw new Error(`Worker ${worker.id} ended after a failed tool call.`);
      return {
        id: worker.id,
        status: "completed",
        answer: answer.slice(0, MAX_WORKER_TEXT),
        toolCalls,
      };
    }
    toolCalls += turn.toolCalls.length;
    if (toolCalls > MAX_WORKER_TOOL_CALLS)
      throw new Error(`Worker ${worker.id} exceeded its tool limit.`);
    const results: AgentModelToolResult[] = [];
    for (const call of turn.toolCalls) {
      if (signal.aborted) throw new Error("Parallel work was cancelled.");
      reportWorkerProgress(options, workerToolEvent(worker, call, "started"));
      if (signal.aborted)
        throw signal.reason ?? new Error("Parallel work was cancelled.");
      const outcome = await executeToolCall(
        workerConfig,
        emptyMemory,
        undefined,
        toolMap,
        call,
        undefined,
        undefined,
        signal,
      ).catch(async (error: unknown) => {
        reportWorkerProgress(options, workerToolEvent(worker, call, "failed"));
        throw error;
      });
      if (!outcome.result) {
        reportWorkerProgress(options, workerToolEvent(worker, call, "failed"));
        throw new Error(`Worker ${worker.id} produced no tool result.`);
      }
      if (signal.aborted)
        throw signal.reason ?? new Error("Parallel work was cancelled.");
      reportWorkerProgress(
        options,
        workerToolEvent(
          worker,
          call,
          outcome.result.toolResult.isError ? "failed" : "completed",
        ),
      );
      results.push(outcome.result.toolResult);
    }
    lastToolBatchFailed = results.some((result) => result.isError === true);
    if (signal.aborted)
      throw signal.reason ?? new Error("Parallel work was cancelled.");
    reportWorkerProgress(
      options,
      workerModelEvent(worker, index + 2, "started"),
    );
    if (signal.aborted)
      throw signal.reason ?? new Error("Parallel work was cancelled.");
    try {
      turn = await awaitModelCall(
        observeAgentModelCall(
          {
            stage: "executor",
            provider: options.config.provider,
            model: options.config.model,
            operation: `parallelWorker:${worker.id}:continue`,
            requestBytes: Buffer.byteLength(JSON.stringify(results), "utf8"),
            toolDefinitions: specs,
          },
          async (onRequestAttempt) =>
            adapter.continueTurn({
              toolResults: results,
              signal,
              ...(onRequestAttempt ? { onRequestAttempt } : {}),
            }),
        ),
        signal,
      );
    } catch (error) {
      reportWorkerProgress(
        options,
        workerModelEvent(worker, index + 2, "failed"),
      );
      throw error;
    }
    if (signal.aborted)
      throw signal.reason ?? new Error("Parallel work was cancelled.");
    reportWorkerProgress(
      options,
      workerModelEvent(worker, index + 2, "completed"),
    );
    if (signal.aborted)
      throw signal.reason ?? new Error("Parallel work was cancelled.");
    answer = turn.text.trim() || answer;
    if (turn.toolCalls.length === 0) {
      if (!answer) throw new Error(`Worker ${worker.id} returned no result.`);
      if (lastToolBatchFailed)
        throw new Error(`Worker ${worker.id} ended after a failed tool call.`);
      return {
        id: worker.id,
        status: "completed",
        answer: answer.slice(0, MAX_WORKER_TEXT),
        toolCalls,
      };
    }
  }
  throw new Error(`Worker ${worker.id} exceeded its turn limit.`);
};

export const createParallelAgentSessionTool = (
  options: ParallelAgentSessionOptions,
): ParallelAgentSessionTool => {
  const maxWorkers = Number.isSafeInteger(options.maxWorkers)
    ? Math.min(MAX_WORKERS, Math.max(2, options.maxWorkers!))
    : MAX_WORKERS;
  let workerFailure = false;
  return {
    hasWorkerFailure: () => workerFailure,
    definition: {
      spec: {
        name: "run_parallel_agents",
        description: `Run ${maxWorkers === 2 ? "two" : "two or three"} independent objectives in fresh concurrent agent sessions, then inspect their ordered results before completing the parent task. Use only when independent work saves time. Full Mode permits explicitly scoped file edits.`,
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
                  id: { type: "string" },
                  objective: { type: "string" },
                  access: {
                    type: "string",
                    enum:
                      options.mode === "machdoch" &&
                      options.config.mode === "machdoch"
                        ? ["read-only", "write"]
                        : ["read-only"],
                  },
                  readPaths: { type: "array", items: { type: "string" } },
                  writePaths: { type: "array", items: { type: "string" } },
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
        const controller = new AbortController();
        const onAbort = () => controller.abort(options.signal?.reason);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) onAbort();
        try {
          const scopedReads = workers.some(
            (worker) => worker.access === "write",
          );
          const outcomes = await Promise.allSettled(
            workers.map(async (worker) => {
              const workerController = new AbortController();
              const onGroupAbort = () =>
                workerController.abort(controller.signal.reason);
              controller.signal.addEventListener("abort", onGroupAbort, {
                once: true,
              });
              if (controller.signal.aborted) onGroupAbort();
              const deadline = setTimeout(
                () =>
                  workerController.abort(
                    new Error(`Worker ${worker.id} timed out.`),
                  ),
                MAX_WORKER_DURATION_MS,
              );
              try {
                reportWorkerProgress(options, {
                  kind: "agent",
                  phase: "started",
                  label: `Agent ${worker.id}`,
                  detail: worker.objective,
                  tone: "info",
                });
                const result = await runWorker(
                  worker,
                  options,
                  workerController.signal,
                  scopedReads,
                );
                reportWorkerProgress(options, {
                  kind: "agent",
                  phase: "completed",
                  label: `Agent ${worker.id}`,
                  tone: "success",
                });
                return result;
              } catch (error) {
                if (error instanceof WorkerBoundaryError)
                  controller.abort(error);
                reportWorkerProgress(options, {
                  kind: "agent",
                  phase: "failed",
                  label: `Agent ${worker.id}`,
                  detail:
                    error instanceof Error ? error.message : String(error),
                  tone: "danger",
                });
                throw error;
              } finally {
                clearTimeout(deadline);
                controller.signal.removeEventListener("abort", onGroupAbort);
                workerController.abort();
              }
            }),
          );
          const results = outcomes.map((outcome, index) =>
            outcome.status === "fulfilled"
              ? outcome.value
              : {
                  id: workers[index]!.id,
                  status: "failed" as const,
                  answer:
                    outcome.reason instanceof Error
                      ? outcome.reason.message.slice(0, MAX_WORKER_TEXT)
                      : String(outcome.reason).slice(0, MAX_WORKER_TEXT),
                  toolCalls: 0,
                },
          );
          if (results.some((result) => result.status === "failed"))
            workerFailure = true;
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
      },
    },
  };
};
