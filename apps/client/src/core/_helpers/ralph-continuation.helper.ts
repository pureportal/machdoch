import type { ResolvedRalphAutonomyPolicy } from "./resolve-ralph-autonomy-policy.helper.js";

export const resolveRalphContinuation = (
  policy: ResolvedRalphAutonomyPolicy,
  variables: Record<string, string>,
  blockId: string,
  kind: "terminal" | "recovery",
): { blockId: string; delaySeconds: number } | undefined => {
  if (
    !policy.enabled ||
    !policy.restartToBlockId ||
    variables.continuous === "false"
  ) {
    return undefined;
  }

  const deferToBlockId =
    kind === "recovery" && policy.recoveryExhaustion === "defer"
      ? policy.deferToBlockId
      : undefined;

  return {
    blockId:
      deferToBlockId && deferToBlockId !== blockId
        ? deferToBlockId
        : policy.restartToBlockId,
    delaySeconds: policy.restartDelaySeconds,
  };
};
