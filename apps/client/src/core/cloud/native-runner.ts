import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  ArtifactInput,
  VerificationEvidence,
} from "@machdoch/fleet-protocol/cloud-artifacts";
import {
  workerLeaseReceiptSchema,
  workerProgressReceiptSchema,
  type RunActivityStatus,
  type WorkerClaim,
  type WorkerFinish,
} from "@machdoch/fleet-protocol/cloud-execution";
import {
  RunnerConnection,
  isTransientRunnerError,
} from "@machdoch/cloud-client";
import {
  RunnerJournal,
  recoverRunner,
  uploadArtifact,
  type TaskRunner,
} from "@machdoch/cloud-client/worker";
import type { ClientCloudBindings, ClientCloudConnection } from "./bindings.js";
import {
  prepareClientWorkspace,
  type ManagedClientWorkspace,
} from "./managed-workspace.js";
import {
  nativeAgentTask,
  reconcileNativeEnvironment,
  runNativeAgent,
} from "./native-agent.js";
import {
  prepareValidationCheckout,
  publishCandidateBranch,
  requireUnchangedCandidate,
  runNativeCheck,
  snapshotNativeCandidate,
} from "./native-candidate.js";

const heartbeatIntervalMs = 15000;
const heartbeatToleranceMs = 60000;
const nativeAgentLabels = {
  machdoch: "Machdoch",
  "codex-cli": "Codex CLI",
  "claude-cli": "Claude Code",
};

class NativeLease {
  readonly signal: AbortSignal;
  private readonly stopped = new AbortController();
  private readonly requests = new AbortController();
  private active = true;
  private renewedAt = Date.now();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  constructor(
    private readonly connection: RunnerConnection,
    private readonly claim: WorkerClaim,
    signal: AbortSignal,
  ) {
    this.signal = AbortSignal.any([signal, this.stopped.signal]);
    this.schedule();
  }
  private schedule(): void {
    if (!this.active || this.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.pending = this.renew();
    }, heartbeatIntervalMs);
  }
  private async renew(): Promise<void> {
    try {
      const receipt = await this.connection.heartbeat(
        this.claim,
        this.requests.signal,
      );
      if (receipt.instruction !== "continue" || receipt.localStopSeconds <= 0)
        throw new Error("Task execution authority ended");
      this.renewedAt = Date.now();
    } catch (error) {
      if (!this.active) return;
      if (
        !isTransientRunnerError(error) ||
        Date.now() - this.renewedAt > heartbeatToleranceMs
      ) {
        this.stopped.abort(error);
        return;
      }
    }
    this.schedule();
  }
  async close(): Promise<void> {
    this.active = false;
    clearTimeout(this.timer);
    this.requests.abort();
    await this.pending;
  }
}

export class NativeClientRunner implements TaskRunner {
  constructor(
    private readonly connectionId: string,
    private readonly bindings: ClientCloudBindings,
    private readonly connection: RunnerConnection,
    private readonly journal: RunnerJournal,
    private readonly storage: string,
    private readonly repairAttempts: number,
  ) {}

  private async linked(): Promise<ClientCloudConnection> {
    const current = await this.bindings.get(this.connectionId);
    if (
      current.status !== "linked" ||
      current.origin !== this.connection.origin ||
      current.registration.profile.target !== "client"
    )
      throw new Error(
        "The client connection changed. Restart execution with its current settings.",
      );
    return current;
  }

  async runNext(signal: AbortSignal) {
    const pending = this.journal.current();
    if (pending) {
      for (const environment of pending.environments)
        if (environment.launchRequested && !environment.stopReceipt)
          await reconcileNativeEnvironment(
            this.journal.directory,
            environment.id,
          );
      return recoverRunner(this.journal, this.connection);
    }
    signal.throwIfAborted();
    const current = await this.linked();
    const availability = await this.connection.available(signal);
    this.journal.bindWorker(availability.workerId);
    if (!availability.enabled)
      throw new Error(
        "Runner access is disabled or expired. Enroll or rotate the runner before restarting it.",
      );
    if (!availability.available) return null;
    const registration = await this.connection.registration(signal);
    this.journal.bindWorker(registration.workerId);
    if (
      registration.profile.target !== "client" ||
      registration.workerId !== current.registration.workerId ||
      registration.profile.id !== current.registration.profile.id ||
      registration.profile.revision !== current.registration.profile.revision ||
      registration.workspaceBinding?.workspaceId !== current.binding.workspaceId
    )
      throw new Error(
        "This task profile no longer matches the linked workspace. Reconnect the workspace before running tasks.",
      );
    const planned = this.journal.plan();
    const environmentId = planned.environments[0]!.id;
    const usage = { tokens: 0 };
    let claim: WorkerClaim | null = null;
    let finish: WorkerFinish | null = null;
    let failure: unknown;
    let attemptDirectory: string | null = null;
    try {
      this.journal.transition("claiming");
      claim = (await this.connection.claim(planned.claimId)).claim;
      if (claim) {
        this.journal.transition("claimed", { claim });
        if (
          claim.manifest.profile.target !== "client" ||
          claim.manifest.profile.id !== registration.profile.id ||
          claim.manifest.profile.revision !== registration.profile.revision
        )
          throw new Error(
            "The task does not match this worker's accepted execution profile.",
          );
        const workspace = await prepareClientWorkspace(
          this.storage,
          current,
          claim,
          signal,
        );
        attemptDirectory = workspace.directory;
        this.journal.transition("starting");
        const receipt = workerLeaseReceiptSchema.parse(
          await this.connection.command(
            "accept",
            {
              runId: claim.runId,
              attemptId: claim.attemptId,
              epoch: claim.epoch,
              environmentId,
              baseCommit: claim.manifest.profile.baseCommit,
              isolation: "independent-checkout",
            },
            signal,
          ),
        );
        if (receipt.instruction !== "continue" || receipt.localStopSeconds <= 0)
          throw new Error("Task execution authority ended");
        this.journal.transition("running");
        const lease = new NativeLease(this.connection, claim, signal);
        try {
          finish = await this.execute(
            claim,
            current,
            workspace,
            environmentId,
            lease.signal,
            usage,
          );
        } finally {
          await lease.close();
        }
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
      const job = this.journal.current();
      if (job && finish) {
        for (const environment of job.environments)
          if (environment.launchRequested && !environment.stopReceipt)
            await reconcileNativeEnvironment(
              this.journal.directory,
              environment.id,
            );
        this.journal.transition(
          job.environments[0]!.launchRequested ? "stopping" : "reporting",
          { finish },
        );
      }
    }
    const result = await recoverRunner(
      this.journal,
      this.connection,
      failure instanceof Error ? failure.message : undefined,
    );
    if (result && attemptDirectory)
      await rm(attemptDirectory, { recursive: true, force: true });
    if (!result && failure) throw failure;
    return result;
  }

  private async progress(
    claim: WorkerClaim,
    state: "running" | "validating",
    signal: AbortSignal,
  ): Promise<void> {
    const receipt = workerProgressReceiptSchema.parse(
      await this.connection.command(
        "progress",
        {
          runId: claim.runId,
          attemptId: claim.attemptId,
          epoch: claim.epoch,
          state,
        },
        signal,
      ),
    );
    if (receipt.instruction !== "continue")
      throw new Error("Task execution authority ended");
  }

  private async report(
    claim: WorkerClaim,
    title: string,
    status: RunActivityStatus,
    detail = "",
  ): Promise<void> {
    try {
      await this.connection.command("activity", {
        runId: claim.runId,
        attemptId: claim.attemptId,
        epoch: claim.epoch,
        entries: [{ title, status, detail: detail.slice(0, 2000) }],
      });
    } catch (error) {
      if (!isTransientRunnerError(error)) throw error;
    }
  }

  private async store(
    claim: WorkerClaim,
    kind: ArtifactInput["kind"],
    name: string,
    bytes: Buffer,
    candidateCommit: string,
    signal: AbortSignal,
  ): Promise<string> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await uploadArtifact(
      (operation, input) =>
        this.connection.command(`artifacts/${operation}`, input, signal),
      { runId: claim.runId, attemptId: claim.attemptId, epoch: claim.epoch },
      {
        artifactId: randomUUID(),
        kind,
        name,
        byteLength: bytes.length,
        sha256,
        inputDigest: claim.inputDigest,
        candidateCommit,
      },
      async (offset, length) => bytes.subarray(offset, offset + length),
    );
    return sha256;
  }

  private async execute(
    claim: WorkerClaim,
    connection: ClientCloudConnection,
    workspace: ManagedClientWorkspace,
    initialEnvironmentId: string,
    signal: AbortSignal,
    usage: { tokens: number },
  ): Promise<WorkerFinish> {
    const { manifest } = claim;
    const profile = manifest.profile;
    if (profile.target !== "client")
      throw new Error("This task requires a linked client profile.");
    const identity = {
      runId: claim.runId,
      attemptId: claim.attemptId,
      epoch: claim.epoch,
      inputDigest: claim.inputDigest,
      stopped: true as const,
    };
    let environmentId = initialEnvironmentId;
    let feedback = "";
    let previousTree: string | null = null;
    const agentLabel = nativeAgentLabels[profile.agent];
    for (let attempt = 0; ; attempt++) {
      await this.progress(claim, "running", signal);
      await this.report(
        claim,
        attempt ? `${agentLabel} repairing failed checks` : `${agentLabel} started`,
        "started",
        connection.binding.name,
      );
      const { result, receipt } = await runNativeAgent({
        agent: profile.agent,
        model: profile.model,
        task: nativeAgentTask(manifest, feedback),
        workingDirectory: workspace.workspaceRoot,
        stateDirectory: this.journal.directory,
        environmentId,
        timeoutMs: Math.max(
          1,
          Math.min(
            profile.maxDurationSeconds * 1000,
            Date.parse(claim.deadlineAt) - Date.now(),
          ),
        ),
        signal,
      });
      this.journal.recordStop(receipt);
      usage.tokens += result.tokens;
      await this.report(
        claim,
        `${agentLabel} finished`,
        result.status === "executed" ? "passed" : "failed",
        result.summary,
      );
      await this.progress(claim, "validating", signal);
      const candidate = await snapshotNativeCandidate(
        workspace.checkoutRoot,
        profile.baseCommit,
        join(workspace.directory, "artifacts"),
        signal,
      );
      if (candidate.tree === previousTree)
        throw new Error(
          "Verification failed and the agent did not change the candidate",
        );
      previousTree = candidate.tree;
      await this.store(
        claim,
        "candidate",
        "candidate.bundle",
        candidate.bundle,
        candidate.candidateCommit,
        signal,
      );
      await this.store(
        claim,
        "diff",
        "changes.patch",
        candidate.patch,
        candidate.candidateCommit,
        signal,
      );
      if (result.status !== "executed" || usage.tokens > profile.maxTokens)
        return {
          ...identity,
          outcome: "failed",
          summary:
            result.status !== "executed"
              ? result.summary
              : "The agent exceeded the task token allowance.",
          candidateCommit: candidate.candidateCommit,
          tokensUsed: usage.tokens,
          checks: [],
        };
      const validation = await prepareValidationCheckout({
        directory: join(workspace.directory, `validation-${attempt + 1}`),
        repositoryRoot: connection.repositoryRoot,
        baseCommit: profile.baseCommit,
        bundlePath: candidate.bundlePath,
        candidateCommit: candidate.candidateCommit,
        signal,
      });
      const checks: WorkerFinish["checks"] = [];
      const failed: VerificationEvidence[] = [];
      for (const [index, check] of profile.requiredChecks.entries()) {
        await this.progress(claim, "validating", signal);
        const evidence = await runNativeCheck(
          validation,
          profile.workspacePath,
          check,
          candidate.candidateCommit,
          signal,
        );
        const evidenceDigest = await this.store(
          claim,
          "verification",
          `check-${index + 1}.json`,
          Buffer.from(JSON.stringify(evidence)),
          candidate.candidateCommit,
          signal,
        );
        const passed =
          evidence.exitCode === 0 &&
          evidence.signal === null &&
          !evidence.timedOut;
        await this.report(
          claim,
          `Check ${check.name} ${passed ? "passed" : "failed"}`,
          passed ? "passed" : "failed",
          check.command,
        );
        checks.push({
          name: check.name,
          passed,
          candidateCommit: candidate.candidateCommit,
          evidenceDigest,
        });
        if (!passed) failed.push(evidence);
      }
      await requireUnchangedCandidate(validation, signal);
      if (!failed.length) {
        const branch = await publishCandidateBranch({
          repositoryRoot: connection.repositoryRoot,
          bundlePath: candidate.bundlePath,
          title: manifest.title,
          runId: claim.runId,
          signal,
        });
        await this.report(claim, `Branch ${branch} created`, "passed");
        return {
          ...identity,
          outcome: "succeeded",
          summary: `${result.summary.slice(0, 15000)}\n\nChecks passed: ${checks.map((check) => check.name).join(", ")}.\nBranch: ${branch}`,
          candidateCommit: candidate.candidateCommit,
          tokensUsed: usage.tokens,
          checks,
        };
      }
      if (attempt >= this.repairAttempts)
        return {
          ...identity,
          outcome: "failed",
          summary: `Verification failed: ${failed.map((check) => check.name).join(", ")}.`,
          candidateCommit: candidate.candidateCommit,
          tokensUsed: usage.tokens,
          checks,
        };
      feedback = failed
        .map(
          (check) =>
            `### ${check.name}\nCommand: ${check.command}\nExit code: ${check.exitCode ?? "none"}${check.timedOut ? " (timed out)" : ""}\n\n${check.stderr.slice(-3000)}\n${check.stdout.slice(-3000)}`,
        )
        .join("\n\n");
      environmentId = this.journal.addEnvironment("agent").id;
      this.journal.requestLaunch(environmentId);
    }
  }
}
