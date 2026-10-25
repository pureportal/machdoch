import { mkdirSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  workerClaimReceiptSchema,
  workerFinishSchema,
  workerGrantIdentitySchema,
} from "@machdoch/fleet-protocol/cloud-execution";
import { stopReceiptSchema } from "@machdoch/cloud-client/stop-receipt";

const phases = [
  "planned",
  "claiming",
  "claimed",
  "starting",
  "running",
  "stopping",
  "reporting",
] as const;
const patchSchema = z.strictObject({
  grant: workerGrantIdentitySchema.optional(),
  claim: workerClaimReceiptSchema.optional(),
  finish: workerFinishSchema.optional(),
});
const environmentSchema = z.strictObject({
  id: z.uuid(),
  role: z.enum(["agent", "validation"]),
  launchRequested: z.boolean(),
  stopReceipt: stopReceiptSchema.nullable(),
});
export const runnerJobSchema = z
  .strictObject({
    claimId: z.uuid(),
    phase: z.enum(phases),
    claim: workerClaimReceiptSchema.nullable(),
    grant: workerGrantIdentitySchema.nullable(),
    finish: workerFinishSchema.nullable(),
    environments: z.array(environmentSchema).min(1).max(8),
  })
  .superRefine((job, context) => {
    if (
      ["claimed", "starting", "running", "stopping"].includes(job.phase) &&
      !job.claim
    )
      context.addIssue({
        code: "custom",
        message: "This phase requires a durable task claim",
      });
    if (job.phase === "reporting" && !job.grant)
      context.addIssue({
        code: "custom",
        message: "Reporting requires a durable attempt identity",
      });
    if (
      job.claim &&
      (!job.grant ||
        job.claim.runId !== job.grant.runId ||
        job.claim.attemptId !== job.grant.attemptId ||
        job.claim.epoch !== job.grant.epoch ||
        job.claim.inputDigest !== job.grant.inputDigest)
    )
      context.addIssue({
        code: "custom",
        message: "The claim and attempt identity differ",
      });
    if (
      job.environments[0]?.role !== "agent" ||
      new Set(job.environments.map((environment) => environment.id)).size !==
        job.environments.length
    )
      context.addIssue({
        code: "custom",
        message: "Invalid environment identities",
      });
    if (
      ["starting", "running", "stopping"].includes(job.phase) &&
      !job.environments[0]?.launchRequested
    )
      context.addIssue({
        code: "custom",
        message: "This phase requires a recorded launch intent",
      });
    for (const environment of job.environments)
      if (
        environment.stopReceipt &&
        environment.stopReceipt.environmentId !== environment.id
      )
        context.addIssue({
          code: "custom",
          message: "Stop receipt belongs to another environment",
        });
    if (
      job.finish &&
      (!job.grant ||
        job.finish.runId !== job.grant.runId ||
        job.finish.attemptId !== job.grant.attemptId ||
        job.finish.epoch !== job.grant.epoch ||
        job.finish.inputDigest !== job.grant.inputDigest)
    )
      context.addIssue({
        code: "custom",
        message: "Completion belongs to another task grant",
      });
  });
export type RunnerJob = z.infer<typeof runnerJobSchema>;

export class RunnerJournal {
  private readonly database: DatabaseSync;
  constructor(
    readonly directory: string,
    origin: string,
  ) {
    if (!isAbsolute(directory))
      throw new Error("Runner state requires an absolute directory");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(join(directory, "runner.sqlite"));
    try {
      this.database.exec(
        "PRAGMA busy_timeout=250; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS runner_state(id INTEGER PRIMARY KEY CHECK(id=1),origin TEXT NOT NULL,worker_id TEXT,job TEXT CHECK(job IS NULL OR json_valid(job))); CREATE TABLE IF NOT EXISTS runner_history(sequence INTEGER PRIMARY KEY AUTOINCREMENT,claim_id TEXT NOT NULL UNIQUE,job TEXT NOT NULL CHECK(json_valid(job))); COMMIT;",
      );
      const stored = this.database
        .prepare("SELECT origin FROM runner_state WHERE id=1")
        .get() as { origin: string } | undefined;
      if (stored && stored.origin !== origin)
        throw new Error(
          "This runner state directory belongs to another cloud server",
        );
      if (!stored)
        this.database
          .prepare("INSERT INTO runner_state(id,origin) VALUES (1,?)")
          .run(origin);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }
  bindWorker(workerId: string): void {
    z.uuid().parse(workerId);
    const row = this.database
      .prepare("SELECT worker_id FROM runner_state WHERE id=1")
      .get() as { worker_id: string | null };
    if (row.worker_id && row.worker_id !== workerId)
      throw new Error(
        "This runner state directory belongs to another enrolled runner",
      );
    if (!row.worker_id)
      this.database
        .prepare("UPDATE runner_state SET worker_id=? WHERE id=1")
        .run(workerId);
  }
  current(): RunnerJob | null {
    const row = this.database
      .prepare("SELECT job FROM runner_state WHERE id=1")
      .get() as { job: string | null };
    return row.job ? runnerJobSchema.parse(JSON.parse(row.job)) : null;
  }
  plan(): RunnerJob {
    if (this.current())
      throw new Error("Recover the current task before claiming another");
    const job: RunnerJob = {
      claimId: randomUUID(),
      phase: "planned",
      claim: null,
      grant: null,
      finish: null,
      environments: [
        {
          id: randomUUID(),
          role: "agent",
          launchRequested: false,
          stopReceipt: null,
        },
      ],
    };
    this.database
      .prepare("UPDATE runner_state SET job=? WHERE id=1")
      .run(JSON.stringify(job));
    return job;
  }
  transition(
    phase: RunnerJob["phase"],
    changes: z.infer<typeof patchSchema> = {},
  ): RunnerJob {
    const previous = this.current();
    if (!previous) throw new Error("No task is journaled");
    if (phases.indexOf(phase) < phases.indexOf(previous.phase))
      throw new Error("Task recovery cannot move back into execution");
    const patch = patchSchema.parse(changes);
    if (
      previous.claim &&
      patch.claim &&
      JSON.stringify(previous.claim) !== JSON.stringify(patch.claim)
    )
      throw new Error("A journaled grant cannot be replaced");
    const grant = patch.claim
      ? {
          runId: patch.claim.runId,
          attemptId: patch.claim.attemptId,
          epoch: patch.claim.epoch,
          inputDigest: patch.claim.inputDigest,
        }
      : (patch.grant ?? previous.grant);
    if (
      previous.grant &&
      JSON.stringify(previous.grant) !== JSON.stringify(grant)
    )
      throw new Error("A journaled attempt identity cannot be replaced");
    const job = runnerJobSchema.parse({
      ...previous,
      ...patch,
      grant,
      phase,
      environments: previous.environments.map((environment, index) =>
        phase === "starting" && index === 0
          ? { ...environment, launchRequested: true }
          : environment,
      ),
    });
    this.database
      .prepare("UPDATE runner_state SET job=? WHERE id=1")
      .run(JSON.stringify(job));
    return job;
  }
  addEnvironment(role: "agent" | "validation") {
    const job = this.current();
    if (!job || job.phase !== "running")
      throw new Error("Environments require a running task");
    if (
      job.environments.some(
        (environment) =>
          environment.launchRequested && !environment.stopReceipt,
      )
    )
      throw new Error("Stop the active environment before preparing another");
    const environment = {
      id: randomUUID(),
      role,
      launchRequested: false,
      stopReceipt: null,
    };
    const next = runnerJobSchema.parse({
      ...job,
      environments: [...job.environments, environment],
    });
    this.database
      .prepare("UPDATE runner_state SET job=? WHERE id=1")
      .run(JSON.stringify(next));
    return environment;
  }
  requestLaunch(id: string): void {
    const job = this.current();
    if (!job || job.phase !== "running")
      throw new Error("No running task owns this environment");
    if (
      job.environments.some(
        (environment) =>
          environment.id !== id &&
          environment.launchRequested &&
          !environment.stopReceipt,
      )
    )
      throw new Error("Stop the active environment before launching another");
    if (
      !job.environments.some(
        (environment) => environment.id === id && !environment.stopReceipt,
      )
    )
      throw new Error("Environment is unavailable");
    const next = runnerJobSchema.parse({
      ...job,
      environments: job.environments.map((environment) =>
        environment.id === id
          ? { ...environment, launchRequested: true }
          : environment,
      ),
    });
    this.database
      .prepare("UPDATE runner_state SET job=? WHERE id=1")
      .run(JSON.stringify(next));
  }
  recordStop(receipt: z.infer<typeof stopReceiptSchema>): void {
    receipt = stopReceiptSchema.parse(receipt);
    const job = this.current();
    if (!job) throw new Error("No task owns this environment");
    const environment = job.environments.find(
      (item) => item.id === receipt.environmentId,
    );
    if (!environment)
      throw new Error("Stop receipt belongs to another environment");
    if (
      environment.stopReceipt &&
      JSON.stringify(environment.stopReceipt) !== JSON.stringify(receipt)
    )
      throw new Error("A confirmed stop receipt cannot be replaced");
    const next = runnerJobSchema.parse({
      ...job,
      environments: job.environments.map((item) =>
        item.id === receipt.environmentId
          ? { ...item, stopReceipt: receipt }
          : item,
      ),
    });
    this.database
      .prepare("UPDATE runner_state SET job=? WHERE id=1")
      .run(JSON.stringify(next));
  }
  clear(): void {
    const job = this.current();
    if (!job) return;
    if (job.grant && job.phase !== "reporting")
      throw new Error("Report the task outcome before clearing its journal");
    if (
      job.environments.some(
        (environment) =>
          environment.launchRequested && !environment.stopReceipt,
      )
    )
      throw new Error(
        "A native stop receipt is required before clearing this task",
      );
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare("INSERT INTO runner_history(claim_id,job) VALUES (?,?)")
        .run(job.claimId, JSON.stringify(job));
      this.database.exec(
        "DELETE FROM runner_history WHERE sequence NOT IN (SELECT sequence FROM runner_history ORDER BY sequence DESC LIMIT 100); UPDATE runner_state SET job=NULL WHERE id=1; COMMIT",
      );
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}
