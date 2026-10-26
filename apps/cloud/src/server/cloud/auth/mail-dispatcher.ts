import { MailDeliveryError, sendSignInMail, type MailSender } from "./smtp";
import { CloudMailStore, type MailLease } from "./mail-store";

export class CloudMailDispatcher {
  private readonly active = new Set<Promise<void>>();
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pumping: Promise<void> | undefined;
  private started = false;
  private requested = false;
  private delay = 1000;
  constructor(
    private readonly store: CloudMailStore,
    private readonly send: MailSender = sendSignInMail,
  ) {}

  start(): void {
    if (this.controller.signal.aborted)
      throw new Error("Email dispatcher is closed.");
    if (!this.started) {
      this.started = true;
      this.wake();
    }
  }
  wake(): void {
    if (!this.started || this.controller.signal.aborted) return;
    this.requested = true;
    clearTimeout(this.timer);
    if (!this.pumping) this.timer = setTimeout(() => this.pump(), 0);
    this.timer?.unref();
  }
  private pump(): void {
    if (this.pumping || this.controller.signal.aborted) return;
    this.requested = false;
    this.pumping = this.dispatch()
      .catch((error: unknown) => {
        this.delay = Math.min(15000, this.delay * 2);
        console.error(
          "Email dispatch failed",
          error instanceof Error ? error.name : "Unknown error",
        );
      })
      .finally(() => {
        this.pumping = undefined;
        if (!this.controller.signal.aborted) {
          this.timer = setTimeout(
            () => this.pump(),
            this.requested ? 0 : this.delay,
          );
          this.timer.unref();
        }
      });
  }
  private async dispatch(): Promise<void> {
    await this.store.recover();
    let count = 0;
    while (!this.controller.signal.aborted && this.active.size < 4) {
      const lease = await this.store.claim();
      if (!lease) break;
      count++;
      const task = this.run(lease)
        .catch((error: unknown) =>
          console.error(
            "Email settlement failed",
            error instanceof Error ? error.name : "Unknown error",
          ),
        )
        .finally(() => {
          this.active.delete(task);
          this.wake();
        });
      this.active.add(task);
    }
    this.delay = count ? 1000 : Math.min(15000, this.delay * 2);
  }
  private async run(lease: MailLease): Promise<void> {
    try {
      const mail = await this.store.prepare(lease);
      if (!mail) return;
      this.controller.signal.throwIfAborted();
      await this.send(mail, this.controller.signal);
      await this.store.finish(lease, null);
    } catch (error) {
      if (this.controller.signal.aborted) return;
      await this.store.finish(
        lease,
        error instanceof MailDeliveryError ? error.code : "failed",
      );
    }
  }
  async close(): Promise<void> {
    this.controller.abort();
    clearTimeout(this.timer);
    await this.pumping;
    await Promise.all(this.active);
  }
}
