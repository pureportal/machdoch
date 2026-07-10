import {
  DEFAULT_RALPH_AUTONOMY_POLICY,
  getRalphAutonomyBackoffSeconds,
  resolveRalphAutonomyPolicy,
} from "./resolve-ralph-autonomy-policy.helper.ts";

describe("resolveRalphAutonomyPolicy", () => {
  it("is disabled by default and enables the bounded default policy explicitly", () => {
    expect(resolveRalphAutonomyPolicy(undefined, undefined)).toEqual(
      DEFAULT_RALPH_AUTONOMY_POLICY,
    );
    expect(resolveRalphAutonomyPolicy(true, undefined)).toMatchObject({
      enabled: true,
      recoverFailedEnd: true,
      maxRecoveryAttempts: 3,
      transitionExhaustion: "checkpoint",
      recoveryExhaustion: "defer",
    });
  });

  it("merges run overrides over persisted flow policy", () => {
    expect(
      resolveRalphAutonomyPolicy(
        {
          maxRecoveryAttempts: 5,
          backoff: {
            initialDelaySeconds: 2,
            multiplier: 3,
            maxDelaySeconds: 20,
          },
          deferToBlockId: "archive",
        },
        {
          maxRecoveryAttempts: 2,
          backoff: { maxDelaySeconds: 8 },
        },
      ),
    ).toEqual({
      enabled: true,
      recoverFailedEnd: true,
      maxRecoveryAttempts: 2,
      backoff: {
        initialDelaySeconds: 2,
        multiplier: 3,
        maxDelaySeconds: 8,
      },
      transitionExhaustion: "checkpoint",
      recoveryExhaustion: "defer",
      deferToBlockId: "archive",
    });
  });

  it("lets a run explicitly disable a flow policy", () => {
    expect(resolveRalphAutonomyPolicy(true, false).enabled).toBe(false);
  });
});

describe("getRalphAutonomyBackoffSeconds", () => {
  it("grows exponentially and remains bounded", () => {
    const policy = resolveRalphAutonomyPolicy(
      {
        backoff: {
          initialDelaySeconds: 2,
          multiplier: 3,
          maxDelaySeconds: 10,
        },
      },
      undefined,
    );

    expect([1, 2, 3, 4].map((attempt) =>
      getRalphAutonomyBackoffSeconds(policy, attempt))).toEqual([2, 6, 10, 10]);
  });
});
