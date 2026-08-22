import {
  splitDueTimesByMissedPolicy,
  type SchedulerDueRunTime,
  type SchedulerMissedRunPolicyJob,
} from "./split-due-times-by-missed-policy.helper.ts";

const createJob = (
  overrides: Partial<SchedulerMissedRunPolicyJob> = {},
): SchedulerMissedRunPolicyJob => ({
  missedRunPolicy: "enqueue-latest",
  missedRunGraceMs: 1_000,
  ...overrides,
});

const createDueTimes = (...scheduledForValues: number[]): SchedulerDueRunTime[] => {
  return scheduledForValues.map((scheduledFor, index) => ({
    triggerId: `trigger-${index + 1}`,
    scheduledFor,
  }));
};

describe("splitDueTimesByMissedPolicy", () => {
  it("returns empty enqueue and skipped sets for empty due times", () => {
    const result = splitDueTimesByMissedPolicy(createJob(), [], 10_000);

    expect(result).toEqual({
      enqueueTimes: [],
      skippedTimes: [],
    });
  });

  it("enqueues every due time for enqueue-all", () => {
    const dueTimes = createDueTimes(1_000, 2_000, 3_000);
    const result = splitDueTimesByMissedPolicy(
      createJob({ missedRunPolicy: "enqueue-all" }),
      dueTimes,
      10_000,
    );

    expect(result.enqueueTimes).toBe(dueTimes);
    expect(result.skippedTimes).toEqual([]);
  });

  it("enqueues only the latest due time for enqueue-latest", () => {
    const dueTimes = createDueTimes(1_000, 2_000, 3_000);
    const result = splitDueTimesByMissedPolicy(
      createJob({ missedRunPolicy: "enqueue-latest" }),
      dueTimes,
      10_000,
    );

    expect(result.enqueueTimes).toEqual([dueTimes[2]]);
    expect(result.skippedTimes).toEqual([dueTimes[0], dueTimes[1]]);
  });

  it("enqueues a single due time for enqueue-latest without skipped runs", () => {
    const dueTimes = createDueTimes(3_000);
    const result = splitDueTimesByMissedPolicy(
      createJob({ missedRunPolicy: "enqueue-latest" }),
      dueTimes,
      10_000,
    );

    expect(result.enqueueTimes).toEqual([dueTimes[0]]);
    expect(result.skippedTimes).toEqual([]);
  });

  it("enqueues the latest skipped-policy due time at the grace boundary", () => {
    const dueTimes = createDueTimes(1_000, 9_000);
    const result = splitDueTimesByMissedPolicy(
      createJob({
        missedRunPolicy: "skip",
        missedRunGraceMs: 1_000,
      }),
      dueTimes,
      10_000,
    );

    expect(result.enqueueTimes).toEqual([dueTimes[1]]);
    expect(result.skippedTimes).toEqual([dueTimes[0]]);
  });

  it("skips every skipped-policy due time just outside the grace boundary", () => {
    const dueTimes = createDueTimes(1_000, 8_999);
    const result = splitDueTimesByMissedPolicy(
      createJob({
        missedRunPolicy: "skip",
        missedRunGraceMs: 1_000,
      }),
      dueTimes,
      10_000,
    );

    expect(result.enqueueTimes).toEqual([]);
    expect(result.skippedTimes).toBe(dueTimes);
  });

  it("treats a future latest due time as within the skipped-policy grace window", () => {
    const dueTimes = createDueTimes(1_000, 11_000);
    const result = splitDueTimesByMissedPolicy(
      createJob({
        missedRunPolicy: "skip",
        missedRunGraceMs: 0,
      }),
      dueTimes,
      10_000,
    );

    expect(result.enqueueTimes).toEqual([dueTimes[1]]);
    expect(result.skippedTimes).toEqual([dueTimes[0]]);
  });
});
