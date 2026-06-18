import type { RalphFlowBlock, RalphRetryPolicy } from "../ralph.js";

export const DEFAULT_RALPH_RETRY_POLICY: Readonly<RalphRetryPolicy> = {
  mode: "infinite",
  maxRetries: null,
  delaySeconds: 0,
};

export interface RalphRetryDecisionInput {
  block: Pick<RalphFlowBlock, "settings"> | null | undefined;
  currentErrorCount: number;
  hasExplicitErrorRoute: boolean;
}

export interface RalphRetryDecision {
  shouldRetry: boolean;
  policy: RalphRetryPolicy;
  delaySeconds: number;
  nextAttempt?: number;
  usesDefaultErrorRoute: boolean;
}

export const getRalphRetryPolicy = (
  block: Pick<RalphFlowBlock, "settings"> | null | undefined,
): RalphRetryPolicy => {
  return block?.settings?.retry ?? { ...DEFAULT_RALPH_RETRY_POLICY };
};

export const retryAllowsAnotherRalphAttempt = (
  policy: RalphRetryPolicy,
  currentErrorCount: number,
): boolean => {
  if (policy.mode === "infinite") {
    return true;
  }

  return currentErrorCount <= (policy.maxRetries ?? 0);
};

export const resolveRalphRetryDecision = ({
  block,
  currentErrorCount,
  hasExplicitErrorRoute,
}: RalphRetryDecisionInput): RalphRetryDecision => {
  const policy = getRalphRetryPolicy(block);
  const usesDefaultErrorRoute =
    hasExplicitErrorRoute && block?.settings?.retry === undefined;
  const shouldRetry =
    !usesDefaultErrorRoute &&
    retryAllowsAnotherRalphAttempt(policy, currentErrorCount);

  return {
    shouldRetry,
    policy,
    delaySeconds: policy.delaySeconds ?? 0,
    ...(shouldRetry ? { nextAttempt: currentErrorCount + 1 } : {}),
    usesDefaultErrorRoute,
  };
};
