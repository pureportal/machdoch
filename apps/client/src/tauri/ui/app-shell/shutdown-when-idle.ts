import type { UserAgentLimitsSettings } from "../../../core/runtime-contract.generated.js";
import {
  getActiveChatOperationIds,
  isTransientChatOperationMessage,
  type ShellPersistedState,
} from "../chat-session.model";
import { getPendingExecutionRetry } from "../chat-session/_helpers/execution-retry";
import type { ShellStateSnapshot } from "../lib/shell-store";

export interface ShutdownWhenIdleOptions {
  ready: boolean;
  state: ShellPersistedState;
  settings: UserAgentLimitsSettings;
  hasUnsettledWork: () => boolean;
  flush: () => Promise<void>;
}

export const hasPendingLocalChatWork = (
  options: ShutdownWhenIdleOptions,
): boolean =>
  !options.ready ||
  options.hasUnsettledWork() ||
  options.state.sessions.some((session) =>
    session.messages.some(isTransientChatOperationMessage),
  );

export const hasPendingChatWork = (
  state: ShellPersistedState,
  settings: UserAgentLimitsSettings,
): boolean =>
  state.queuedSessionMessages.some(
    (message) =>
      message.status !== "failed" &&
      state.sessions.some((session) => session.id === message.sessionId),
  ) ||
  state.sessions.some(
    (session) =>
      getActiveChatOperationIds(session).length > 0 ||
      getPendingExecutionRetry(session, settings) !== null,
  );

export class PendingChatWorkInspector {
  private snapshot: ShellStateSnapshot<ShellPersistedState> | undefined;

  constructor(
    private readonly loadRevision: () => Promise<number>,
    private readonly loadSnapshot: (
      state: ShellPersistedState,
    ) => Promise<ShellStateSnapshot<ShellPersistedState>>,
  ) {}

  async inspect(
    read: () => ShutdownWhenIdleOptions,
  ): Promise<{ busy: boolean; revision: number }> {
    const options = read();
    if (hasPendingLocalChatWork(options)) return { busy: true, revision: 0 };
    await options.flush();
    const revision = await this.loadRevision();
    let snapshot = this.snapshot;
    if (!snapshot || snapshot.revision !== revision) {
      snapshot = await this.loadSnapshot(options.state);
      this.snapshot = snapshot;
    }
    const current = read();
    return {
      busy:
        hasPendingLocalChatWork(current) ||
        current.state !== options.state ||
        current.settings !== options.settings ||
        hasPendingChatWork(snapshot.state, current.settings),
      revision: snapshot.revision,
    };
  }
}

export class IdleShutdownMonitor {
  private generation = 0;
  private enabled = false;
  private idleSince: number | null = null;
  private checking: number | null = null;

  constructor(private readonly quietPeriodMs = 5_000) {}

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.generation += 1;
    this.idleSince = null;
  }

  async check(
    inspect: () => Promise<{ busy: boolean; revision: number }>,
    shutdown: (revision: number) => Promise<boolean>,
    now?: number,
  ): Promise<boolean> {
    if (!this.enabled || this.checking === this.generation) return false;
    const generation = this.generation;
    this.checking = generation;
    try {
      const work = await inspect();
      if (!this.enabled || generation !== this.generation) return false;
      if (work.busy) {
        this.idleSince = null;
        return false;
      }
      const inspectedAt = now ?? performance.now();
      this.idleSince ??= inspectedAt;
      if (inspectedAt - this.idleSince < this.quietPeriodMs) return false;
      const finished = await shutdown(work.revision);
      if (!this.enabled || generation !== this.generation) return false;
      this.idleSince = null;
      if (finished) this.setEnabled(false);
      return finished;
    } catch (error) {
      if (generation === this.generation) this.idleSince = null;
      throw error;
    } finally {
      if (this.checking === generation) this.checking = null;
    }
  }
}
