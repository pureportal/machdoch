export interface SchedulerDueRunTime {
  triggerId: string;
  scheduledFor: number;
}

export interface SchedulerMissedRunPolicyJob {
  missedRunPolicy: "skip" | "enqueue-latest" | "enqueue-all";
  missedRunGraceMs: number;
}

export interface SplitDueTimesByMissedPolicyResult {
  enqueueTimes: SchedulerDueRunTime[];
  skippedTimes: SchedulerDueRunTime[];
}

export const splitDueTimesByMissedPolicy = (
  job: SchedulerMissedRunPolicyJob,
  dueTimes: SchedulerDueRunTime[],
  now: number,
): SplitDueTimesByMissedPolicyResult => {
  if (dueTimes.length === 0) {
    return { enqueueTimes: [], skippedTimes: [] };
  }

  const latest = dueTimes.at(-1);

  if (latest === undefined) {
    return { enqueueTimes: [], skippedTimes: [] };
  }

  switch (job.missedRunPolicy) {
    case "enqueue-all":
      return {
        enqueueTimes: dueTimes,
        skippedTimes: [],
      };
    case "enqueue-latest":
      return {
        enqueueTimes: [latest],
        skippedTimes: dueTimes.slice(0, -1),
      };
    case "skip": {
      const enqueueLatest = now - latest.scheduledFor <= job.missedRunGraceMs;

      return {
        enqueueTimes: enqueueLatest ? [latest] : [],
        skippedTimes: enqueueLatest ? dueTimes.slice(0, -1) : dueTimes,
      };
    }
  }
};
