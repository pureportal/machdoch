import {
  DurableSmartScheduler,
  getUserSchedulerStatePath,
} from "../scheduler.js";

export const createUserRalphWatchScheduler = (
  executor?: ConstructorParameters<typeof DurableSmartScheduler>[0]["executor"],
): DurableSmartScheduler => {
  return new DurableSmartScheduler({
    statePath: getUserSchedulerStatePath(),
    ...(executor ? { executor } : {}),
  });
};
