import { z } from "zod";
import type { WorkerClaim } from "@machdoch/fleet-protocol/cloud-execution";
import { RunnerConnection } from "@machdoch/cloud-client";
import { RunnerJournal } from "./journal.ts";
import { LeaseKeeper } from "./lease-keeper.ts";
import { VirtualMachineSandbox } from "./sandbox/virtual-machine.ts";
import type { SandboxConfiguration } from "./sandbox/configuration.ts";
import {
  guest,
  requireShell,
  importBytes,
  type ActiveEnvironment,
} from "./guest-operations.ts";

interface ManagedEnvironment extends ActiveEnvironment {
  keeper: LeaseKeeper;
}
export type RepositorySource =
  | { kind: "broker" }
  | { kind: "local"; baseCommit: string; bytes: Buffer; sha256: string };
export class TaskEnvironments {
  private source: RepositorySource = { kind: "broker" };
  private resolvedBase: string | null = null;
  private readonly active = new Map<
    string,
    { sandbox: VirtualMachineSandbox; keeper: LeaseKeeper | null }
  >();
  constructor(
    private readonly configuration: SandboxConfiguration,
    private readonly journal: RunnerJournal,
    private readonly connection: RunnerConnection,
    private readonly signal: AbortSignal,
  ) {}
  useSource(source: RepositorySource): void {
    this.source = source;
  }
  get baseCommit(): string {
    if (!this.resolvedBase)
      throw new Error("The task repository has not been prepared");
    return this.resolvedBase;
  }
  async prepare(id: string): Promise<VirtualMachineSandbox> {
    this.signal.throwIfAborted();
    const sandbox = await VirtualMachineSandbox.create(this.configuration, {
      directory: this.journal.directory,
      environmentId: id,
    });
    this.active.set(id, { sandbox, keeper: null });
    return sandbox;
  }
  async start(
    sandbox: VirtualMachineSandbox,
    claim: WorkerClaim,
    anchor: string,
    allowanceSeconds: number,
  ): Promise<ManagedEnvironment> {
    this.signal.throwIfAborted();
    await sandbox.start(
      anchor,
      allowanceSeconds * 1000,
      claim.manifest.profile.maxDurationSeconds * 1000,
      this.source.kind === "broker"
        ? (request, signal) =>
            this.connection.repository(claim, request, signal)
        : undefined,
    );
    const keeper = new LeaseKeeper(
      this.connection,
      claim,
      sandbox,
      this.signal,
    );
    this.active.set(sandbox.environmentId, { sandbox, keeper });
    keeper.start();
    const environment = { sandbox, keeper, signal: keeper.signal };
    const pinned = this.resolvedBase ?? claim.baseCommit;
    if (this.source.kind === "local") {
      if (pinned !== null && this.source.baseCommit !== pinned)
        throw new Error("The local source belongs to another commit.");
      await importBytes(environment, "source.pack", this.source.bytes);
    }
    const source = await guest(
      environment,
      this.source.kind === "broker"
        ? "prepare_repository"
        : "prepare_local_repository",
      this.source.kind === "local"
        ? { commit: this.source.baseCommit }
        : pinned
          ? { commit: pinned }
          : {
              reference: claim.manifest.branch
                ? `refs/heads/${claim.manifest.branch}`
                : "HEAD",
            },
      z.strictObject({ baseCommit: z.string().regex(/^[a-f0-9]{40}$/) }),
    );
    if (pinned !== null && source.baseCommit !== pinned)
      throw new Error("Prepared repository does not match the task");
    this.resolvedBase = source.baseCommit;
    return environment;
  }
  async launch(
    claim: WorkerClaim,
    role: "agent" | "validation",
    bundle?: { bytes: Buffer; candidateCommit: string },
  ): Promise<ManagedEnvironment> {
    const planned = this.journal.addEnvironment(role);
    const sandbox = await this.prepare(planned.id);
    const anchor = await sandbox.supervisor.anchor();
    const receipt = await this.connection.heartbeat(claim, this.signal);
    if (receipt.instruction !== "continue" || receipt.localStopSeconds <= 0)
      throw new Error("Task execution authority ended");
    this.journal.requestLaunch(planned.id);
    const environment = await this.start(
      sandbox,
      claim,
      anchor,
      receipt.localStopSeconds,
    );
    if (bundle) {
      await importBytes(environment, "incoming.bundle", bundle.bytes);
      await requireShell(
        environment,
        `git -c core.hooksPath=/dev/null bundle verify /tmp/machdoch-artifacts/incoming.bundle && git -c core.hooksPath=/dev/null fetch /tmp/machdoch-artifacts/incoming.bundle refs/machdoch/candidate && git -c core.hooksPath=/dev/null checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = '${bundle.candidateCommit}' && git merge-base --is-ancestor '${this.baseCommit}' HEAD`,
        300000,
      );
    }
    if (role === "validation")
      await guest(
        environment,
        "freeze_repository",
        {},
        z.strictObject({ frozen: z.literal(true) }),
      );
    return environment;
  }
  async close(id: string): Promise<void> {
    const environment = this.active.get(id);
    if (!environment) return;
    await environment.keeper?.close();
    const receipt = await environment.sandbox.close();
    this.journal.recordStop(receipt);
    this.active.delete(id);
  }
  async closeAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const id of this.active.keys()) {
      try {
        await this.close(id);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        "Environment termination requires reconciliation",
      );
  }
}
