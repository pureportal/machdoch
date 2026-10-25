import type { WorkerClaim } from "@machdoch/fleet-protocol/cloud-execution";
import { RunnerConnection } from "@machdoch/cloud-client";
import { VirtualMachineSandbox } from "./sandbox/virtual-machine.ts";

export class LeaseKeeper {
  readonly signal: AbortSignal;
  private readonly stopped = new AbortController();
  private readonly requests = new AbortController();
  private active = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  constructor(
    private readonly connection: RunnerConnection,
    private readonly claim: WorkerClaim,
    private readonly sandbox: VirtualMachineSandbox,
    signal: AbortSignal,
  ) {
    this.signal = AbortSignal.any([
      signal,
      this.stopped.signal,
      sandbox.supervisor.signal,
    ]);
  }
  start(): void {
    this.pending = this.renew();
  }
  private async renew(): Promise<void> {
    if (!this.active || this.signal.aborted) return;
    try {
      const anchor = await this.sandbox.supervisor.anchor();
      const receipt = await this.connection.heartbeat(
        this.claim,
        this.requests.signal,
      );
      if (!this.active) return;
      if (receipt.instruction !== "continue" || receipt.localStopSeconds <= 0)
        throw new Error("Task execution authority ended");
      await this.sandbox.supervisor.renew(
        anchor,
        receipt.localStopSeconds * 1000,
      );
    } catch (error) {
      if (this.active) this.stopped.abort(error);
    }
    if (this.active && !this.signal.aborted)
      this.timer = setTimeout(() => {
        this.pending = this.renew();
      }, 15000);
  }
  async close(): Promise<void> {
    this.active = false;
    clearTimeout(this.timer);
    this.requests.abort();
    await this.pending;
  }
}
