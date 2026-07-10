import type {
  RalphAutonomyPolicy,
  RalphAutonomySetting,
} from "../ralph.js";

export interface ResolvedRalphAutonomyPolicy {
  enabled: boolean;
  recoverFailedEnd: boolean;
  maxRecoveryAttempts: number;
  backoff: {
    initialDelaySeconds: number;
    multiplier: number;
    maxDelaySeconds: number;
  };
  transitionExhaustion: "checkpoint" | "crash";
  recoveryExhaustion: "defer" | "block";
  deferToBlockId?: string;
}

export const DEFAULT_RALPH_AUTONOMY_POLICY: Readonly<ResolvedRalphAutonomyPolicy> = {
  enabled: false,
  recoverFailedEnd: true,
  maxRecoveryAttempts: 3,
  backoff: {
    initialDelaySeconds: 1,
    multiplier: 2,
    maxDelaySeconds: 30,
  },
  transitionExhaustion: "checkpoint",
  recoveryExhaustion: "defer",
};

const toNonNegativeFiniteNumber = (
  value: unknown,
  fallback: number,
): number => {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
};

const toNonNegativeInteger = (value: unknown, fallback: number): number => {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
};

const getPolicyRecord = (
  setting: RalphAutonomySetting | undefined,
): RalphAutonomyPolicy | undefined => {
  return typeof setting === "object" && setting !== null ? setting : undefined;
};

const getSettingEnabled = (
  setting: RalphAutonomySetting | undefined,
  fallback: boolean,
): boolean => {
  if (typeof setting === "boolean") {
    return setting;
  }

  if (setting) {
    return setting.enabled ?? true;
  }

  return fallback;
};

export const resolveRalphAutonomyPolicy = (
  flowSetting: RalphAutonomySetting | undefined,
  runSetting: RalphAutonomySetting | undefined,
): ResolvedRalphAutonomyPolicy => {
  const flowPolicy = getPolicyRecord(flowSetting);
  const runPolicy = getPolicyRecord(runSetting);
  const initialDelaySeconds = toNonNegativeFiniteNumber(
    runPolicy?.backoff?.initialDelaySeconds ??
      flowPolicy?.backoff?.initialDelaySeconds,
    DEFAULT_RALPH_AUTONOMY_POLICY.backoff.initialDelaySeconds,
  );
  const maxDelaySeconds = Math.max(
    initialDelaySeconds,
    toNonNegativeFiniteNumber(
      runPolicy?.backoff?.maxDelaySeconds ?? flowPolicy?.backoff?.maxDelaySeconds,
      DEFAULT_RALPH_AUTONOMY_POLICY.backoff.maxDelaySeconds,
    ),
  );
  const configuredMultiplier = toNonNegativeFiniteNumber(
    runPolicy?.backoff?.multiplier ?? flowPolicy?.backoff?.multiplier,
    DEFAULT_RALPH_AUTONOMY_POLICY.backoff.multiplier,
  );

  return {
    enabled: getSettingEnabled(
      runSetting,
      getSettingEnabled(flowSetting, DEFAULT_RALPH_AUTONOMY_POLICY.enabled),
    ),
    recoverFailedEnd:
      runPolicy?.recoverFailedEnd ?? flowPolicy?.recoverFailedEnd ??
      DEFAULT_RALPH_AUTONOMY_POLICY.recoverFailedEnd,
    maxRecoveryAttempts: toNonNegativeInteger(
      runPolicy?.maxRecoveryAttempts ?? flowPolicy?.maxRecoveryAttempts,
      DEFAULT_RALPH_AUTONOMY_POLICY.maxRecoveryAttempts,
    ),
    backoff: {
      initialDelaySeconds,
      multiplier: Math.max(1, configuredMultiplier),
      maxDelaySeconds,
    },
    transitionExhaustion:
      runPolicy?.transitionExhaustion ?? flowPolicy?.transitionExhaustion ??
      DEFAULT_RALPH_AUTONOMY_POLICY.transitionExhaustion,
    recoveryExhaustion:
      runPolicy?.recoveryExhaustion ?? flowPolicy?.recoveryExhaustion ??
      DEFAULT_RALPH_AUTONOMY_POLICY.recoveryExhaustion,
    ...((runPolicy?.deferToBlockId ?? flowPolicy?.deferToBlockId)?.trim()
      ? {
          deferToBlockId: (
            runPolicy?.deferToBlockId ?? flowPolicy?.deferToBlockId ?? ""
          ).trim(),
        }
      : {}),
  };
};

export const getRalphAutonomyBackoffSeconds = (
  policy: Pick<ResolvedRalphAutonomyPolicy, "backoff">,
  attempt: number,
): number => {
  const exponent = Math.max(0, Math.trunc(attempt) - 1);
  const delay =
    policy.backoff.initialDelaySeconds * policy.backoff.multiplier ** exponent;

  return Math.min(
    policy.backoff.maxDelaySeconds,
    Number.isFinite(delay) ? delay : policy.backoff.maxDelaySeconds,
  );
};
