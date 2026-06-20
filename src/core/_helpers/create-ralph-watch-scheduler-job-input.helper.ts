import type { CreateScheduledJobInput } from "../scheduler.js";
import type { RalphWatchDefinition } from "../ralph-watches.js";

export const createRalphWatchSchedulerJobInput = (
  watchDefinition: RalphWatchDefinition,
): CreateScheduledJobInput => ({
  name: watchDefinition.name ?? `Ralph watch ${watchDefinition.id}`,
  triggers: [
    {
      kind: "workspace-file",
      eventType: "workspace-file.*",
      filters: { "payload.watchId": watchDefinition.id },
      debounceMs: watchDefinition.debounceMs,
      ...(watchDefinition.cooldownMs ? { cooldownMs: watchDefinition.cooldownMs } : {}),
      dedupeKeyTemplate: "{payload.watchId}:{payload.eventType}:{payload.path}:{payload.mtimeMs}",
      maxEventsPerWindow: watchDefinition.maxEventsPerWindow,
    },
  ],
  target: {
    type: "ralph-flow",
    workspaceRoot: watchDefinition.executionWorkspaceRoot,
    ralphFlow: {
      scope: watchDefinition.flow.scope,
      id: watchDefinition.flow.id,
      params: watchDefinition.params,
      ...(watchDefinition.runLogScope ? { runLogScope: watchDefinition.runLogScope } : {}),
      ...(watchDefinition.maxTransitions !== undefined
        ? { maxTransitions: watchDefinition.maxTransitions }
        : {}),
      permissions: watchDefinition.permissions,
    },
  },
  retry: { maxAttempts: 1 },
  queue: {
    concurrencyKey: `ralph-watch:${watchDefinition.id}`,
    concurrencyLimit: watchDefinition.concurrencyLimit,
  },
  dedupeKey: `ralph-watch:${watchDefinition.id}`,
});
