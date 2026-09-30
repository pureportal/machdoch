import type { RalphBlockExecutionResult } from "../ralph.js";
import { isRalphVerificationObservation } from "./ralph-verification.helper.js";

export const getRalphTaskVerification = (
  results: readonly RalphBlockExecutionResult[],
  task: Record<string, unknown>,
  verificationBlockId?: string,
  operation?: { runId?: string; operationId?: string },
): Record<string, unknown> | undefined => {
  const completedVerification = task.verification as
    | Record<string, unknown>
    | undefined;
  if (
    task.status === "completed" &&
    operation?.operationId &&
    operation.runId &&
    completedVerification?.operationId === operation.operationId &&
    completedVerification.runId === operation.runId &&
    typeof completedVerification.blockId === "string" &&
    (!verificationBlockId ||
      completedVerification.blockId === verificationBlockId) &&
    typeof completedVerification.planId === "string" &&
    typeof completedVerification.command === "string" &&
    typeof completedVerification.cwd === "string" &&
    typeof completedVerification.fingerprint === "string" &&
    /^[a-f0-9]{64}$/u.test(completedVerification.fingerprint) &&
    Number.isFinite(Date.parse(String(completedVerification.verifiedAt))) &&
    Date.parse(String(completedVerification.verifiedAt)) <=
      Date.parse(String(task.completedAt))
  ) {
    return completedVerification;
  }
  const history = Array.isArray(task.stateHistory) ? task.stateHistory : [];
  const stateChange = history.at(-1) as Record<string, unknown> | undefined;
  const claimedAt = Math.max(
    Date.parse(String(stateChange?.at ?? "")),
    Date.parse(String(task.selectedAt ?? "")),
  );
  if (!Number.isFinite(claimedAt) || stateChange?.to !== task.status) {
    return undefined;
  }
  const result = [...results].reverse().find((entry) => {
    const data = entry.data as Record<string, unknown> | undefined;
    const verification = data?.verification as
      | Record<string, unknown>
      | undefined;
    return verificationBlockId
      ? entry.blockId === verificationBlockId
      : verification?.role === "candidate";
  });
  const data = result?.data as Record<string, unknown> | undefined;
  const verification = data?.verification as
    | Record<string, unknown>
    | undefined;
  const comparison = verification?.comparison as
    | Record<string, unknown>
    | undefined;
  const observation = verification?.observation;
  if (
    !result ||
    result.output !== "SUCCESS" ||
    result.status !== "completed" ||
    typeof verification?.verifiedAt !== "string" ||
    !Number.isFinite(Date.parse(verification.verifiedAt)) ||
    Date.parse(verification.verifiedAt) < claimedAt ||
    verification?.role !== "candidate" ||
    typeof verification.planId !== "string" ||
    !isRalphVerificationObservation(observation) ||
    observation.processOutcome.kind !== "passed" ||
    (comparison?.disposition !== "PASSED" &&
      comparison?.disposition !== "IMPROVED_WITH_BASELINE_FAILURES")
  ) {
    return undefined;
  }
  return {
    blockId: result.blockId,
    planId: verification.planId,
    command: observation.command,
    cwd: observation.cwd,
    fingerprint: observation.outputFingerprint,
    verifiedAt: verification.verifiedAt,
  };
};
