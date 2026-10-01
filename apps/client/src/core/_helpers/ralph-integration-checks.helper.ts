import type {
  RalphBlockExecutionResult,
  RalphFlow,
  RalphUtilityBlock,
} from "../ralph.js";
import { isRalphVerificationObservation } from "./ralph-verification.helper.js";

export const getRalphIntegrationChecks = (
  flow: RalphFlow,
  results: readonly RalphBlockExecutionResult[],
): Array<{ block: RalphUtilityBlock; command: string; cwd: string }> => {
  const blocks = new Map(flow.blocks.map((block) => [block.id, block]));
  const checks = new Map<
    string,
    { block: RalphUtilityBlock; command: string; cwd: string }
  >();
  for (const result of results) {
    const block = blocks.get(result.blockId);
    const data =
      result.data && typeof result.data === "object"
        ? (result.data as Record<string, unknown>)
        : undefined;
    const verification = data?.verification as
      | Record<string, unknown>
      | undefined;
    const observation = verification?.observation;
    if (
      block?.type !== "UTILITY" ||
      block.utility.type !== "RUN_CHECK" ||
      verification?.role === "baseline" ||
      block.utility.verificationRole === "baseline"
    )
      continue;
    const command = isRalphVerificationObservation(observation)
      ? observation.command
      : data?.command;
    const cwd = isRalphVerificationObservation(observation)
      ? observation.cwd
      : data?.cwd;
    if (typeof command !== "string" || typeof cwd !== "string") continue;
    const key = `${cwd}\0${command}`;
    if (
      result.output !== "SUCCESS" ||
      (isRalphVerificationObservation(observation)
        ? observation.processOutcome.kind !== "passed"
        : data?.exitCode !== 0)
    ) {
      checks.delete(key);
      continue;
    }
    checks.set(key, { block, command, cwd });
  }
  return [...checks.values()];
};
