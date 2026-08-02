import { resolveRalphAutonomyPolicy } from "../../../../core/_helpers/resolve-ralph-autonomy-policy.helper.js";
import type { RalphFlow } from "../../../../core/ralph.js";

export const doesRalphFlowRequireWorkspaceWriterLease = (
  flow: Pick<RalphFlow, "settings"> | null,
): boolean =>
  resolveRalphAutonomyPolicy(flow?.settings?.autonomy, undefined).enabled;

export const getRalphKnownFlowWorkspaceWriterLeaseRequirement = (
  flowId: string,
  flow: Pick<RalphFlow, "id" | "settings"> | null,
): boolean | undefined =>
  flow?.id === flowId
    ? doesRalphFlowRequireWorkspaceWriterLease(flow)
    : undefined;

export const getRalphContinuationWorkspaceWriterLeaseRequirement = (
  run: { flow: string; autonomy?: { enabled?: boolean } } | null,
  flow: Pick<RalphFlow, "id" | "settings"> | null,
): boolean | undefined => {
  if (!run) {
    return undefined;
  }

  return run.autonomy?.enabled === true
    ? true
    : getRalphKnownFlowWorkspaceWriterLeaseRequirement(run.flow, flow);
};

export const getRalphWorkspaceWriterBlockingRunForRequirement = <Run>(
  requiresWorkspaceWriterLease: boolean | undefined,
  selectedFlowHasActiveRun: boolean,
  activeRuns: readonly (Run & { requiresWorkspaceWriterLease?: boolean })[],
): Run | null => {
  if (selectedFlowHasActiveRun || requiresWorkspaceWriterLease === false) {
    return null;
  }

  return (
    activeRuns.find((run) => run.requiresWorkspaceWriterLease !== false) ?? null
  );
};

export const getRalphWorkspaceWriterBlockingRun = <Run>(
  flow: Pick<RalphFlow, "settings"> | null,
  selectedFlowHasActiveRun: boolean,
  activeRuns: readonly (Run & { requiresWorkspaceWriterLease?: boolean })[],
): Run | null => {
  return getRalphWorkspaceWriterBlockingRunForRequirement(
    doesRalphFlowRequireWorkspaceWriterLease(flow),
    selectedFlowHasActiveRun,
    activeRuns,
  );
};
