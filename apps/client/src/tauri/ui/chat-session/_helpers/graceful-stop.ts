import { getAgentControlEndpoint, sendAgentControl } from "../../agent-control-client";

/** How long a provider gets to wind its turn down before the run is killed. */
export const GRACEFUL_STOP_GRACE_MS = 8_000;

const gracefulStops = new Set<string>();

/**
 * Stops a running task. A run that accepts interrupts first ends its provider
 * turn cleanly, which keeps the partial answer; it is killed if it is still
 * running after the grace period. A second stop request kills it at once.
 */
export const stopDesktopTask = async (
  taskId: string,
  options: {
    isActive: () => boolean;
    hardCancel: () => Promise<void>;
    graceMs?: number;
  },
): Promise<void> => {
  const canInterrupt =
    getAgentControlEndpoint(taskId)?.capabilities.includes("interrupt") === true;
  if (!canInterrupt || gracefulStops.has(taskId)) {
    gracefulStops.delete(taskId);
    await options.hardCancel();
    return;
  }
  gracefulStops.add(taskId);
  try {
    await sendAgentControl(taskId, { type: "interrupt" });
  } catch {
    gracefulStops.delete(taskId);
    await options.hardCancel();
    return;
  }
  setTimeout(() => {
    if (!gracefulStops.delete(taskId) || !options.isActive()) return;
    void options.hardCancel();
  }, options.graceMs ?? GRACEFUL_STOP_GRACE_MS);
};
