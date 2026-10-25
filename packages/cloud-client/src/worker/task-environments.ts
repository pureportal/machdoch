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
  private readonly active = new Map<
    string,
    { sandbox: VirtualMachineSandbox; keeper: LeaseKeeper | null }
  >();
  constructor(
    private readonly configuration: SandboxConfiguration,
    private readonly journal: RunnerJournal,
    private readonly connection: RunnerConnection,
    private readonly signal: AbortSignal,
    private readonly source: RepositorySource,
  ) {}
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
    if (this.source.kind === "local") {
      if (this.source.baseCommit !== claim.manifest.profile.baseCommit)
        throw new Error("The local source belongs to another commit.");
      await importBytes(environment, "source.pack", this.source.bytes);
    }
    const source = await guest(
      environment,
      this.source.kind === "broker"
        ? "prepare_repository"
        : "prepare_local_repository",
      { commit: claim.manifest.profile.baseCommit },
      z.strictObject({ baseCommit: z.string() }),
    );
    if (source.baseCommit !== claim.manifest.profile.baseCommit)
      throw new Error("Prepared repository does not match the task");
    return environment;
  }
  async restore(
    claim: WorkerClaim,
    role: "agent" | "validation",
    bundle: Buffer,
    candidateCommit: string,
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
    await importBytes(environment, "incoming.bundle", bundle);
    await requireShell(
      environment,
      `git -c core.hooksPath=/dev/null bundle verify /tmp/machdoch-artifacts/incoming.bundle && git -c core.hooksPath=/dev/null fetch /tmp/machdoch-artifacts/incoming.bundle refs/machdoch/candidate && git -c core.hooksPath=/dev/null checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = '${candidateCommit}' && git merge-base --is-ancestor '${claim.manifest.profile.baseCommit}' HEAD`,
      300000,
    );
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
