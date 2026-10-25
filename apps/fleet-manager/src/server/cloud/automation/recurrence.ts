import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { previewRecurrence } from "@machdoch/recurrence";
import type { CloudActor } from "../../../lib/cloud-contract";
import type { RecurrencePreviewRequest } from "../../../lib/cloud-recurrence-contract";
import { CloudError, isCloudError, requireMembership } from "../access";
import type { CloudDatabase } from "../database";
import type { SchedulePlan, SchedulePlanInput } from "./schedule-plan";

const NativeWorker = (
  process.getBuiltinModule(
    "worker_threads",
  ) as typeof import("node:worker_threads")
).Worker;
type Preview = ReturnType<typeof previewRecurrence>;

export class CloudRecurrencePreview {
  private readonly active = new Map<string, number>();
  constructor(private readonly database: CloudDatabase) {}

  preview(
    actor: CloudActor,
    input: RecurrencePreviewRequest,
    signal?: AbortSignal,
  ): Promise<Preview> {
    return this.evaluate<Preview>(actor, input, signal);
  }

  plan(actor: CloudActor, plan: SchedulePlanInput): Promise<SchedulePlan> {
    return this.evaluate<SchedulePlan>(actor, {
      recurrence: plan.recurrence,
      count: 1,
      plan,
    });
  }

  private async evaluate<T>(
    actor: CloudActor,
    input: RecurrencePreviewRequest & { plan?: SchedulePlanInput },
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const now = await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<{ now: Date }>("SELECT clock_timestamp() AS now")
      ).rows[0]!.now.getTime();
    });
    const after = input.after ?? now;
    const count = this.active.get(actor.organizationId) ?? 0;
    if (
      count >= 2 ||
      [...this.active.values()].reduce((sum, value) => sum + value, 0) >= 4
    )
      throw new CloudError(
        429,
        "recurrence_busy",
        "A schedule preview is already running. Try again shortly.",
      );
    this.active.set(actor.organizationId, count + 1);
    try {
      const result = await new Promise<T>((done, reject) => {
        const worker = new NativeWorker(
          resolve(
            dirname(fileURLToPath(import.meta.url)),
            "../../../../dist/cloud-recurrence-worker.mjs",
          ),
          {
            workerData: {
              recurrence: input.recurrence,
              after,
              count: input.count,
              fromActivation: input.fromActivation,
              plan: input.plan,
            },
            execArgv: [],
            env: {},
            stdout: true,
            stderr: true,
            resourceLimits: {
              maxOldGenerationSizeMb: 96,
              maxYoungGenerationSizeMb: 16,
              stackSizeMb: 4,
            },
          },
        );
        worker.stdout.resume();
        worker.stderr.resume();
        let settled = false;
        const timer = setTimeout(
          () =>
            finish(
              undefined,
              new CloudError(
                422,
                "search_limit",
                "The schedule preview exceeded its time limit. Narrow the range or simplify the rule.",
              ),
            ),
          2500,
        );
        const abort = () =>
          finish(
            undefined,
            new CloudError(
              408,
              "preview_canceled",
              "The schedule preview was canceled.",
            ),
          );
        function finish(value?: T, error?: Error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          void worker.terminate().then(
            () => {
              if (value) done(value);
              else
                reject(
                  error ??
                    new CloudError(
                      422,
                      "search_limit",
                      "The schedule preview could not finish. Reduce its rules or exclusions.",
                    ),
                );
            },
            () =>
              reject(
                new CloudError(
                  503,
                  "recurrence_unavailable",
                  "Schedule preview is unavailable. Try again shortly.",
                ),
              ),
          );
        }
        worker.once("message", (value: unknown) => {
          if (
            value &&
            typeof value === "object" &&
            "ok" in value &&
            value.ok === true &&
            "result" in value
          )
            finish(value.result as T);
          else if (
            value &&
            typeof value === "object" &&
            "code" in value &&
            typeof value.code === "string" &&
            "message" in value &&
            typeof value.message === "string"
          )
            finish(
              undefined,
              new CloudError(
                422,
                value.code.slice(0, 80),
                value.message.slice(0, 500),
              ),
            );
          else finish();
        });
        worker.once("error", () => finish());
        worker.once("exit", () => finish());
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }).catch((error: unknown) => {
        if (isCloudError(error)) throw error;
        throw new CloudError(
          422,
          "invalid_recurrence",
          "The recurrence could not be processed. Review its structure and simplify it.",
        );
      });
      await this.database.transaction((sql) => requireMembership(sql, actor));
      return result;
    } finally {
      const remaining = this.active.get(actor.organizationId)! - 1;
      if (remaining) this.active.set(actor.organizationId, remaining);
      else this.active.delete(actor.organizationId);
    }
  }
}
