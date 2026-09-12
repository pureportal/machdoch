import type { UserAgentLimitsSettings } from "../../../core/runtime-contract.generated.js";
import {
  getActiveChatOperationIds,
  type ShellPersistedState,
} from "../chat-session.model";
import { getPendingExecutionRetry } from "../chat-session/_helpers/execution-retry";

export const hasPendingChatWork = (
  state: ShellPersistedState,
  settings: UserAgentLimitsSettings,
): boolean =>
  state.queuedSessionMessages.length > 0 ||
  state.sessions.some(
    (session) =>
      getActiveChatOperationIds(session).length > 0 ||
      getPendingExecutionRetry(session, settings) !== null,
  );

export class IdleShutdownMonitor {
  private generation = 0;
  private enabled = false;
  private idleSince: number | null = null;
  private idleRevision: number | null = null;
  private checking = false;

  constructor(private readonly quietPeriodMs = 5_000) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.generation += 1;
    this.idleSince = null;
    this.idleRevision = null;
  }

  async check(
    inspect: () => Promise<{ busy: boolean; revision: number }>,
    shutdown: (revision: number) => Promise<boolean>,
    now = Date.now(),
  ): Promise<boolean> {
    if (!this.enabled || this.checking) return false;
    this.checking = true;
    const generation = this.generation;
    try {
      const work = await inspect();
      if (!this.enabled || generation !== this.generation) return false;
      if (work.busy) {
        this.idleSince = null;
        this.idleRevision = null;
        return false;
      }
      if (work.revision !== this.idleRevision) {
        this.idleSince = now;
        this.idleRevision = work.revision;
      }
      this.idleSince ??= now;
      if (now - this.idleSince < this.quietPeriodMs) return false;
      const finished = await shutdown(work.revision);
      this.idleSince = null;
      this.idleRevision = null;
      if (finished) this.setEnabled(false);
      return finished;
    } catch (error) {
      this.idleSince = null;
      this.idleRevision = null;
      throw error;
    } finally {
      this.checking = false;
    }
  }
}
