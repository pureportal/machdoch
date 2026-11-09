import type { UserAgentLimitsSettings } from "../../../core/runtime-contract.generated.js";
import {
  isTransientChatOperationMessage,
  type ShellPersistedState,
} from "../chat-session.model";

export interface WorkInspection {
  busy: boolean;
  revision: number;
}

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

export const inspectPendingChatWork = async (
  read: () => ShutdownWhenIdleOptions,
  inspectPersisted: () => Promise<WorkInspection>,
): Promise<WorkInspection> => {
  const options = read();
  if (hasPendingLocalChatWork(options)) return { busy: true, revision: 0 };
  await options.flush();
  const persisted = await inspectPersisted();
  const current = read();
  return {
    busy:
      persisted.busy ||
      hasPendingLocalChatWork(current) ||
      current.state !== options.state ||
      current.settings !== options.settings,
    revision: persisted.revision,
  };
};

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
    inspect: () => Promise<WorkInspection>,
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
