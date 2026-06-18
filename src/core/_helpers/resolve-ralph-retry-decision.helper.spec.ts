import type { RalphFlowBlock, RalphRetryPolicy } from "../ralph.ts";
import {
  DEFAULT_RALPH_RETRY_POLICY,
  getRalphRetryPolicy,
  resolveRalphRetryDecision,
  retryAllowsAnotherRalphAttempt,
} from "./resolve-ralph-retry-decision.helper.ts";

const createBlock = (
  retry?: RalphRetryPolicy,
): Pick<RalphFlowBlock, "settings"> => {
  return retry ? { settings: { retry } } : {};
};

describe("getRalphRetryPolicy", () => {
  it.each([undefined, null, {}, { settings: {} }] as const)(
    "returns the default infinite retry policy for empty block input %#",
    (block) => {
      expect(getRalphRetryPolicy(block)).toEqual(DEFAULT_RALPH_RETRY_POLICY);
    },
  );

  it("returns an explicit retry policy without changing null or zero boundaries", () => {
    const policy: RalphRetryPolicy = {
      mode: "finite",
      maxRetries: 0,
      delaySeconds: 0,
    };

    expect(getRalphRetryPolicy(createBlock(policy))).toBe(policy);
  });
});

describe("retryAllowsAnotherRalphAttempt", () => {
  it("allows every current error count for infinite retry policies", () => {
    expect(
      retryAllowsAnotherRalphAttempt(
        { mode: "infinite", maxRetries: null, delaySeconds: 0 },
        0,
      ),
    ).toBe(true);
    expect(
      retryAllowsAnotherRalphAttempt(
        { mode: "infinite", maxRetries: 0, delaySeconds: 3 },
        Number.POSITIVE_INFINITY,
      ),
    ).toBe(true);
  });

  it.each([
    [{ mode: "finite", maxRetries: null }, 0, true],
    [{ mode: "finite", maxRetries: null }, 1, false],
    [{ mode: "finite", maxRetries: 0 }, 0, true],
    [{ mode: "finite", maxRetries: 0 }, 1, false],
    [{ mode: "finite", maxRetries: 2 }, 2, true],
    [{ mode: "finite", maxRetries: 2 }, 3, false],
  ] satisfies Array<[RalphRetryPolicy, number, boolean]>)(
    "checks finite retry boundary %# with error count %s",
    (policy, currentErrorCount, expected) => {
      expect(retryAllowsAnotherRalphAttempt(policy, currentErrorCount)).toBe(
        expected,
      );
    },
  );
});

describe("resolveRalphRetryDecision", () => {
  it("retries with the default policy when there is no explicit ERROR route", () => {
    expect(
      resolveRalphRetryDecision({
        block: createBlock(),
        currentErrorCount: 1,
        hasExplicitErrorRoute: false,
      }),
    ).toEqual({
      shouldRetry: true,
      policy: DEFAULT_RALPH_RETRY_POLICY,
      delaySeconds: 0,
      nextAttempt: 2,
      usesDefaultErrorRoute: false,
    });
  });

  it("uses an explicit ERROR route instead of the default implicit retry policy", () => {
    expect(
      resolveRalphRetryDecision({
        block: createBlock(),
        currentErrorCount: 1,
        hasExplicitErrorRoute: true,
      }),
    ).toEqual({
      shouldRetry: false,
      policy: DEFAULT_RALPH_RETRY_POLICY,
      delaySeconds: 0,
      usesDefaultErrorRoute: true,
    });
  });

  it("lets an explicit retry policy override an explicit ERROR route", () => {
    const policy: RalphRetryPolicy = {
      mode: "finite",
      maxRetries: 2,
      delaySeconds: 5,
    };

    expect(
      resolveRalphRetryDecision({
        block: createBlock(policy),
        currentErrorCount: 2,
        hasExplicitErrorRoute: true,
      }),
    ).toEqual({
      shouldRetry: true,
      policy,
      delaySeconds: 5,
      nextAttempt: 3,
      usesDefaultErrorRoute: false,
    });
  });

  it("stops retrying when a finite retry policy reaches its boundary", () => {
    const policy: RalphRetryPolicy = {
      mode: "finite",
      maxRetries: 1,
      delaySeconds: 2,
    };

    expect(
      resolveRalphRetryDecision({
        block: createBlock(policy),
        currentErrorCount: 2,
        hasExplicitErrorRoute: false,
      }),
    ).toEqual({
      shouldRetry: false,
      policy,
      delaySeconds: 2,
      usesDefaultErrorRoute: false,
    });
  });
});
