import { normalizeStringList } from "../../helpers/normalize-string-list.helper.js";
import type { ScheduledJob } from "../scheduler.js";

export const getScheduledJobContextPaths = (job: ScheduledJob): string[] => {
  return normalizeStringList([
    ...job.target.contextPaths,
    ...job.target.contextPacks.flatMap((pack) => pack.contextPaths ?? []),
  ]);
};
