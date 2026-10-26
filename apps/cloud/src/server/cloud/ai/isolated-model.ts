import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelConnection } from "@machdoch/model-runtime/connections";
import type {
  AgentModelAdapter,
  AgentModelStartParams,
  AgentModelStreamEvent,
  AgentModelToolCall,
  AgentModelToolSpec,
  AgentModelTurn,
} from "@machdoch/model-runtime/types";

const NativeWorker = (
  process.getBuiltinModule(
    "worker_threads",
  ) as typeof import("node:worker_threads")
).Worker;

export class ModelWorkerFailure extends Error {
  constructor(
    readonly code: "worker_timeout" | "worker_failed" | "output_limit",
    readonly status?: number,
  ) {
    super(
      code === "worker_timeout"
        ? "Model processing exceeded its time limit."
        : code === "output_limit"
          ? "Model output exceeded its limit."
          : "Model processing failed.",
    );
  }
}

function runWorker<T>(
  data: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
  onStreamEvent?: (event: AgentModelStreamEvent) => void,
): Promise<T> {
  signal?.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const worker = new NativeWorker(
      resolvePath(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../dist/cloud-model-worker.mjs",
      ),
      {
        workerData: data,
        execArgv: [],
        env: process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {},
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
        stdout: true,
        stderr: true,
      },
    );
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    let processing: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(
      () => finish(undefined, new ModelWorkerFailure("worker_timeout")),
      timeoutMs,
    );
    const aborted = () =>
      finish(
        undefined,
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("Model processing was canceled."),
      );
    function finish(result?: T, error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(processing);
      signal?.removeEventListener("abort", aborted);
      void worker.terminate().then(
        () => {
          if (error) reject(error);
          else resolve(result!);
        },
        () => reject(new ModelWorkerFailure("worker_failed")),
      );
    }
    worker.on("message", (message: unknown) => {
      if (settled) return;
      if (typeof message !== "object" || message === null) {
        finish(undefined, new ModelWorkerFailure("worker_failed"));
        return;
      }
      const frame = message as Record<string, unknown>;
      if (frame.kind === "result") finish(frame.result as T);
      else if (frame.kind === "error")
        finish(
          undefined,
          new ModelWorkerFailure(
            frame.code === "output_limit" ? "output_limit" : "worker_failed",
            typeof frame.status === "number" ? frame.status : undefined,
          ),
        );
      else if (frame.kind === "ready" || frame.kind === "heartbeat") {
        clearTimeout(processing);
        processing = setTimeout(
          () => finish(undefined, new ModelWorkerFailure("worker_timeout")),
          2000,
        );
      } else if (frame.kind === "event") {
        try {
          onStreamEvent?.(frame.event as AgentModelStreamEvent);
        } catch (error) {
          finish(
            undefined,
            error instanceof Error
              ? error
              : new ModelWorkerFailure("worker_failed"),
          );
        }
      } else finish(undefined, new ModelWorkerFailure("worker_failed"));
    });
    worker.once("error", () =>
      finish(undefined, new ModelWorkerFailure("worker_failed")),
    );
    worker.once("exit", () => {
      if (!settled) finish(undefined, new ModelWorkerFailure("worker_failed"));
    });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

export async function createIsolatedModelAdapter(
  connection: ModelConnection,
  tools: AgentModelToolSpec[],
): Promise<AgentModelAdapter> {
  if (connection.fetch)
    throw new Error("Isolated provider workers require an HTTP endpoint.");
  return {
    async startTurn(
      parameters: AgentModelStartParams,
    ): Promise<AgentModelTurn> {
      const {
        signal,
        onStreamEvent,
        onRequestAttempt: _,
        ...request
      } = parameters;
      return runWorker<AgentModelTurn>(
        { kind: "model", connection, tools, request },
        120000,
        signal,
        onStreamEvent,
      );
    },
    async continueTurn(): Promise<never> {
      throw new Error(
        "Each cloud inference call requires its complete request context.",
      );
    },
  };
}

export async function validateInferenceTools(
  tools: AgentModelToolSpec[],
  calls: AgentModelToolCall[],
  signal: AbortSignal,
): Promise<boolean> {
  if (!calls.length) return true;
  const result = await runWorker<unknown>(
    { kind: "validate", tools, calls },
    10000,
    signal,
  );
  if (typeof result !== "boolean")
    throw new ModelWorkerFailure("worker_failed");
  return result;
}
