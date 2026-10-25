import type {
  WorkerClaim,
  WorkerFinish,
  WorkerRegistration,
} from "@machdoch/fleet-protocol/cloud-execution";
import { workerLeaseReceiptSchema } from "@machdoch/fleet-protocol/cloud-execution";
import { RunnerConnection } from "@machdoch/cloud-client";
import { RunnerJournal } from "./journal.ts";
import { recoverRunner } from "./recovery.ts";
import type { RunnerConfiguration } from "./configuration.ts";
import { TaskEnvironments } from "./task-environments.ts";
import { executeTask } from "./task-workflow.ts";
import { createHash } from "node:crypto";
import type { RepositorySource } from "./task-environments.ts";

export type RunnerTarget =
  | { kind: "cloud" }
  | {
      kind: "client-linux";
      checkConnection: () => Promise<void>;
      prepareSource: (
        registration: WorkerRegistration,
        signal: AbortSignal,
      ) => Promise<{
        baseCommit: string;
        bytes: Buffer;
        sha256: string;
      }>;
    };

export class CloudRunner {
  constructor(
    private readonly configuration: RunnerConfiguration,
    private readonly connection: RunnerConnection,
    private readonly journal: RunnerJournal,
    private readonly target: RunnerTarget,
  ) {}
  async runNext(signal: AbortSignal) {
    if (this.journal.current())
      return recoverRunner(this.journal, this.connection);
    signal.throwIfAborted();
    if (this.target.kind === "client-linux")
      await this.target.checkConnection();
    const availability = await this.connection.available(signal);
    this.journal.bindWorker(availability.workerId);
    if (!availability.enabled)
      throw new Error(
        "Runner access is disabled or expired. Enroll or rotate the runner before restarting it.",
      );
    if (!availability.available) return null;
    const registration = await this.connection.registration(signal);
    this.journal.bindWorker(registration.workerId);
    if (registration.profile.target !== this.target.kind)
      throw new Error(
        this.target.kind === "cloud"
          ? "This worker belongs to a client execution profile. Enroll a worker for a cloud profile before starting this runner."
          : "Choose a worker enrolled for a Client (Linux) execution profile.",
      );
    signal.throwIfAborted();
    let source: RepositorySource = { kind: "broker" };
    if (this.target.kind === "client-linux") {
      if (!registration.workspaceBinding)
        throw new Error("Connect this client workspace before running tasks.");
      const prepared = await this.target.prepareSource(registration, signal);
      if (
        prepared.baseCommit !== registration.profile.baseCommit ||
        !Buffer.isBuffer(prepared.bytes) ||
        prepared.bytes.length > 64 * 1024 * 1024 ||
        createHash("sha256").update(prepared.bytes).digest("hex") !==
          prepared.sha256
      )
        throw new Error(
          "The exported source does not match the current execution profile.",
        );
      source = { kind: "local", ...prepared };
    }
    signal.throwIfAborted();
    const planned = this.journal.plan();
    const environments = new TaskEnvironments(
      this.configuration.sandbox,
      this.journal,
      this.connection,
      signal,
      source,
    );
    let claim: WorkerClaim | null = null;
    let failure: unknown;
    let finish: WorkerFinish | null = null;
    const usage = { tokens: 0, requests: 0 };
    try {
      const sandbox = await environments.prepare(planned.environments[0]!.id);
      signal.throwIfAborted();
      this.journal.transition("claiming");
      const anchor = await sandbox.supervisor.anchor();
      signal.throwIfAborted();
      const response = await this.connection.claim(planned.claimId);
      claim = response.claim;
      if (claim) {
        this.journal.transition("claimed", { claim });
        if (
          claim.manifest.profile.target !== this.target.kind ||
          claim.manifest.profile.id !== registration.profile.id ||
          claim.manifest.profile.revision !== registration.profile.revision ||
          claim.manifest.profile.baseCommit !==
            registration.profile.baseCommit ||
          claim.manifest.profile.workspacePath !==
            registration.profile.workspacePath
        )
          throw new Error(
            "The task does not match this worker's accepted execution profile.",
          );
        signal.throwIfAborted();
        this.journal.transition("starting");
        const environment = await environments.start(
          sandbox,
          claim,
          anchor,
          response.localStopSeconds,
        );
        const receipt = workerLeaseReceiptSchema.parse(
          await this.connection.command(
            "accept",
            {
              runId: claim.runId,
              attemptId: claim.attemptId,
              epoch: claim.epoch,
              environmentId: sandbox.environmentId,
              baseCommit: claim.manifest.profile.baseCommit,
              isolation: "microvm",
            },
            environment.signal,
          ),
        );
        if (receipt.instruction !== "continue" || receipt.localStopSeconds <= 0)
          throw new Error("Task execution authority ended");
        this.journal.transition("running");
        finish = await executeTask(
          this.connection,
          claim,
          environments,
          environment,
          usage,
          this.configuration.repairAttempts,
        );
      }
    } catch (error) {
      failure = error;
      if (claim)
        finish = {
          runId: claim.runId,
          attemptId: claim.attemptId,
          epoch: claim.epoch,
          inputDigest: claim.inputDigest,
          outcome: "failed",
          stopped: true,
          summary: (
            (error instanceof Error ? error.message.trim() : "") ||
            "The task could not complete"
          ).slice(0, 20000),
          candidateCommit: null,
          tokensUsed: usage.tokens,
          checks: [],
        };
    } finally {
      try {
        if (finish)
          this.journal.transition(
            this.journal.current()!.environments[0]!.launchRequested
              ? "stopping"
              : "reporting",
            { finish },
          );
      } finally {
        await environments.closeAll();
      }
    }
    const result = await recoverRunner(
      this.journal,
      this.connection,
      failure instanceof Error ? failure.message : undefined,
    );
    if (!result && failure) throw failure;
    return result;
  }
}
