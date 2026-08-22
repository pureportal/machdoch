import type {
  RalphBlockExecutionResult,
  RalphEndBlock,
  RalphFlow,
  RalphRunAutonomyMetadata,
  RalphRunStatus,
} from "../ralph.js";
import type { RalphProgressState } from "./ralph-progress.helper.js";
import type { RalphVerificationDisposition } from "./ralph-verification.helper.js";

export type RalphRunOutcomeStatus =
  | "succeeded"
  | "no-op"
  | "deferred"
  | "blocked"
  | "stalled"
  | "budget-exhausted"
  | "verification-inconclusive"
  | "failed"
  | "cancelled";

export interface RalphRunOutcomeEvidence {
  kind: "work" | "repository" | "scope" | "verification" | "report" | "runtime";
  summary: string;
  blockId?: string;
  fingerprint?: string;
}

export interface RalphRunOutcome {
  status: RalphRunOutcomeStatus;
  verified: boolean;
  retryable: boolean;
  reason: string;
  evidence: RalphRunOutcomeEvidence[];
  limitations: string[];
  nextAction?: string;
}

export interface RalphRepositoryOutcomeEvidence {
  known: boolean;
  root?: string;
  changedFiles: string[];
  headChanged: boolean;
  baselineFingerprint?: string;
  finalFingerprint?: string;
  finalCapturedAt?: string;
  finalSnapshotBlockId?: string;
  reason?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getRecordedWorkOutcome = (
  flow: RalphFlow,
  results: readonly RalphBlockExecutionResult[],
):
  | {
      outcome: "DONE" | "DEFER" | "STOP" | "BLOCKED" | "INVALID";
      blockId: string;
      resultIndex: number;
    }
  | undefined => {
  const outcomeByBlockId = new Map(
    flow.blocks.flatMap((block) =>
      block.type === "UTILITY" &&
      block.utility.type === "APPEND_JSONL" &&
      (block.utility.workOutcome === "DONE" ||
        block.utility.workOutcome === "DEFER" ||
        block.utility.workOutcome === "STOP" ||
        block.utility.workOutcome === "BLOCKED" ||
        block.utility.workOutcome === "INVALID")
        ? [[block.id, block.utility.workOutcome] as const]
        : [],
    ),
  );
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index]!;
    const outcome = isRecord(result.data) ? result.data.workOutcome : undefined;
    const configuredOutcome = outcomeByBlockId.get(result.blockId);
    if (configuredOutcome !== undefined && configuredOutcome === outcome) {
      return {
        outcome: configuredOutcome,
        blockId: result.blockId,
        resultIndex: index,
      };
    }
  }
  return undefined;
};

const BLOCKING_EXECUTION_OUTPUTS = new Set([
  "ERROR",
  "FAILED",
  "INCONCLUSIVE",
  "INVALID",
  "NOT_FOUND",
  "OUT_OF_SCOPE",
  "TIMEOUT",
]);

const getBlockingCauseBefore = (
  results: readonly RalphBlockExecutionResult[],
  resultIndex: number,
): { blockId: string; summary: string } | undefined => {
  for (let index = resultIndex - 1; index >= 0; index -= 1) {
    const result = results[index]!;
    if (
      result.status === "error" ||
      BLOCKING_EXECUTION_OUTPUTS.has(result.output)
    ) {
      return {
        blockId: result.blockId,
        summary: result.error ?? result.summary,
      };
    }
  }

  return undefined;
};

const getVerification = (
  flow: RalphFlow,
  results: readonly RalphBlockExecutionResult[],
):
  | {
      blockId: string;
      disposition: RalphVerificationDisposition;
      reason?: string;
      fingerprint?: string;
    }
  | undefined => {
  const candidateBlockIds = new Set(
    flow.blocks.flatMap((block) =>
      block.type === "UTILITY" &&
      block.utility.type === "RUN_CHECK" &&
      block.utility.verificationRole === "candidate"
        ? [block.id]
        : [],
    ),
  );
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index]!;
    if (!candidateBlockIds.has(result.blockId)) {
      continue;
    }
    const verification = isRecord(result.data)
      ? result.data.verification
      : undefined;
    if (!isRecord(verification) || verification.role !== "candidate") {
      continue;
    }
    const comparison = isRecord(verification.comparison)
      ? verification.comparison
      : undefined;
    if (!comparison) {
      continue;
    }
    const disposition = comparison?.disposition;
    if (
      disposition === "PASSED" ||
      disposition === "REGRESSION" ||
      disposition === "BASELINE_EQUIVALENT_FAILURE" ||
      disposition === "IMPROVED_WITH_BASELINE_FAILURES" ||
      disposition === "ENVIRONMENT_UNAVAILABLE" ||
      disposition === "TIMEOUT" ||
      disposition === "INCONCLUSIVE"
    ) {
      return {
        blockId: result.blockId,
        disposition,
        ...(typeof comparison.reason === "string"
          ? { reason: comparison.reason }
          : {}),
        ...(typeof comparison.candidateFingerprint === "string"
          ? { fingerprint: comparison.candidateFingerprint }
          : {}),
      };
    }
  }
  return undefined;
};

const getChangedFiles = (
  flow: RalphFlow,
  results: readonly RalphBlockExecutionResult[],
): { known: boolean; files: string[]; blockId?: string } => {
  const repositoryEvidenceBlockIds = new Set(
    flow.blocks.flatMap((block) =>
      block.type === "UTILITY" &&
      (block.utility.type === "GIT_STATUS" ||
        block.utility.type === "GIT_SNAPSHOT" ||
        block.utility.type === "GIT_DIFF_SUMMARY" ||
        block.utility.type === "CHANGE_SCOPE_GUARD")
        ? [block.id]
        : [],
    ),
  );
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index]!;
    if (
      !repositoryEvidenceBlockIds.has(result.blockId) ||
      !isRecord(result.data)
    ) {
      continue;
    }
    if (Array.isArray(result.data.guardedFiles)) {
      return {
        known: true,
        files: result.data.guardedFiles.filter(
          (entry): entry is string => typeof entry === "string",
        ),
        blockId: result.blockId,
      };
    }
    if (Array.isArray(result.data.changedSinceBaselineFiles)) {
      return {
        known: true,
        files: result.data.changedSinceBaselineFiles.filter(
          (entry): entry is string => typeof entry === "string",
        ),
        blockId: result.blockId,
      };
    }
    if (Array.isArray(result.data.changedFiles)) {
      return {
        known: true,
        files: result.data.changedFiles.filter(
          (entry): entry is string => typeof entry === "string",
        ),
        blockId: result.blockId,
      };
    }
    if (Array.isArray(result.data.files)) {
      const files = result.data.files.flatMap((entry) =>
        isRecord(entry) && typeof entry.path === "string" ? [entry.path] : [],
      );
      return { known: true, files, blockId: result.blockId };
    }
  }
  return { known: false, files: [] };
};

const getScopeEvidence = (
  flow: RalphFlow,
  results: readonly RalphBlockExecutionResult[],
): { output: string; blockId: string } | undefined => {
  const scopeBlockIds = new Set(
    flow.blocks.flatMap((block) =>
      block.type === "UTILITY" && block.utility.type === "CHANGE_SCOPE_GUARD"
        ? [block.id]
        : [],
    ),
  );
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index]!;
    if (
      scopeBlockIds.has(result.blockId) &&
      (result.output === "IN_SCOPE" ||
        result.output === "OUT_OF_SCOPE" ||
        result.output === "EMPTY")
    ) {
      return { output: result.output, blockId: result.blockId };
    }
  }
  return undefined;
};

const hasFinalReport = (
  flow: RalphFlow,
  results: readonly RalphBlockExecutionResult[],
): boolean => {
  const reportIds = new Set(
    flow.blocks.flatMap((block) =>
      block.type === "UTILITY" && block.utility.type === "FINAL_REPORT"
        ? [block.id]
        : [],
    ),
  );
  return results.some(
    (result) => reportIds.has(result.blockId) && result.output === "SUCCESS",
  );
};

const createOutcome = (
  status: RalphRunOutcomeStatus,
  reason: string,
  options: {
    verified?: boolean;
    retryable?: boolean;
    evidence?: RalphRunOutcomeEvidence[];
    limitations?: string[];
    nextAction?: string;
  } = {},
): RalphRunOutcome => ({
  status,
  verified: options.verified ?? false,
  retryable: options.retryable ?? false,
  reason,
  evidence: options.evidence ?? [],
  limitations: options.limitations ?? [],
  ...(options.nextAction ? { nextAction: options.nextAction } : {}),
});

export const deriveRalphRunOutcome = (input: {
  flow: RalphFlow;
  lifecycleStatus: RalphRunStatus;
  terminalBlockId?: string;
  blockResults: readonly RalphBlockExecutionResult[];
  autonomy?: RalphRunAutonomyMetadata;
  progress?: RalphProgressState;
  repositoryEvidence?: RalphRepositoryOutcomeEvidence;
}): RalphRunOutcome => {
  const {
    flow,
    lifecycleStatus,
    terminalBlockId,
    blockResults,
    autonomy,
    progress,
    repositoryEvidence,
  } = input;
  const strict = autonomy?.enabled === true;
  const terminal = flow.blocks.find(
    (block): block is RalphEndBlock =>
      block.id === terminalBlockId && block.type === "END",
  );
  const recorded = getRecordedWorkOutcome(flow, blockResults);
  const invalidCause =
    recorded?.outcome === "INVALID"
      ? getBlockingCauseBefore(blockResults, recorded.resultIndex)
      : undefined;
  const verification = getVerification(flow, blockResults);
  const graphChanges = getChangedFiles(flow, blockResults);
  const changes = repositoryEvidence
    ? {
        known: repositoryEvidence.known,
        files: repositoryEvidence.changedFiles,
        blockId: graphChanges.blockId,
      }
    : graphChanges;
  const scope = getScopeEvidence(flow, blockResults);
  const report = hasFinalReport(flow, blockResults);
  const evidence: RalphRunOutcomeEvidence[] = [];
  const limitations: string[] = [];

  if (recorded) {
    evidence.push({
      kind: "work",
      blockId: recorded.blockId,
      summary: `The durable work journal recorded ${recorded.outcome}.`,
    });
  }
  if (invalidCause) {
    evidence.push({
      kind: "runtime",
      blockId: invalidCause.blockId,
      summary: invalidCause.summary,
    });
  }
  if (changes.known) {
    evidence.push({
      kind: "repository",
      ...(changes.blockId ? { blockId: changes.blockId } : {}),
      summary:
        changes.files.length > 0 || repositoryEvidence?.headChanged
          ? `${changes.files.length} changed file(s)${repositoryEvidence?.headChanged ? " and a new Git revision" : ""} were observed since the engine baseline.`
          : "The repository evidence showed no changed files.",
      ...(repositoryEvidence?.finalFingerprint
        ? { fingerprint: repositoryEvidence.finalFingerprint }
        : {}),
    });
  } else if (repositoryEvidence?.reason) {
    evidence.push({
      kind: "runtime",
      summary: repositoryEvidence.reason,
      ...(repositoryEvidence.baselineFingerprint
        ? { fingerprint: repositoryEvidence.baselineFingerprint }
        : {}),
    });
  }
  if (scope) {
    evidence.push({
      kind: "scope",
      blockId: scope.blockId,
      summary: `The change-scope gate returned ${scope.output}.`,
    });
  }
  if (verification) {
    evidence.push({
      kind: "verification",
      blockId: verification.blockId,
      summary: `${verification.disposition}: ${verification.reason ?? "semantic verification completed."}`,
      ...(verification.fingerprint
        ? { fingerprint: verification.fingerprint }
        : {}),
    });
  }
  if (report) {
    evidence.push({
      kind: "report",
      summary: "The final report completed.",
    });
  }

  if (lifecycleStatus === "stopped") {
    return createOutcome("cancelled", "The run was cancelled.", {
      evidence,
      retryable: true,
      nextAction: "Resume from the retained checkpoint.",
    });
  }
  if (progress?.stalledReason) {
    return createOutcome("stalled", progress.stalledReason, {
      evidence,
      retryable: true,
      nextAction:
        "Resume with a different approach or resolve the blocker described by the latest evidence.",
    });
  }
  if (autonomy?.exhaustion?.kind === "max-transitions") {
    return createOutcome("budget-exhausted", autonomy.exhaustion.reason, {
      evidence,
      retryable: autonomy.exhaustion.recoverable,
      ...(autonomy.exhaustion.recoverable
        ? {
            nextAction:
              "Resume the checkpoint with an additional transition budget.",
          }
        : {}),
    });
  }
  if (recorded?.outcome === "BLOCKED") {
    return createOutcome(
      "blocked",
      "The durable work journal recorded a concrete blocker.",
      {
        evidence,
        retryable: true,
        nextAction: "Resolve the recorded blocker, then resume.",
      },
    );
  }
  if (recorded?.outcome === "INVALID") {
    return createOutcome(
      "blocked",
      invalidCause
        ? `The durable work journal recorded INVALID after ${invalidCause.blockId} reported: ${invalidCause.summary}`
        : "The durable work journal recorded invalid execution state.",
      {
        evidence,
        retryable: true,
        nextAction:
          "Resolve the reported execution error, then resume from the retained checkpoint.",
      },
    );
  }
  if (
    recorded?.outcome === "DEFER" ||
    terminal?.outcome === "deferred" ||
    autonomy?.deferred.length
  ) {
    return createOutcome(
      "deferred",
      autonomy?.deferred.at(-1)?.reason ??
        "Work was explicitly deferred with durable state.",
      {
        evidence,
        retryable: true,
        nextAction:
          "Resume when the deferred prerequisite or retry condition is ready.",
      },
    );
  }
  if (lifecycleStatus === "crashed") {
    return createOutcome("failed", "The execution lifecycle crashed.", {
      evidence,
      retryable: true,
      nextAction: "Inspect the crash evidence and resume from the checkpoint.",
    });
  }
  if (terminal?.outcome === "failed") {
    return createOutcome(
      "failed",
      "The flow explicitly reported an unsuccessful outcome.",
      {
        evidence,
        retryable: true,
        nextAction:
          "Inspect the final evidence, repair the failure, and resume.",
      },
    );
  }
  if (strict && verification?.disposition === "REGRESSION") {
    return createOutcome(
      "failed",
      "Candidate verification introduced a regression.",
      {
        evidence,
        retryable: true,
        nextAction:
          "Repair the new failures and rerun the frozen verification plan.",
      },
    );
  }
  if (
    strict &&
    (verification?.disposition === "ENVIRONMENT_UNAVAILABLE" ||
      verification?.disposition === "TIMEOUT" ||
      verification?.disposition === "INCONCLUSIVE")
  ) {
    return createOutcome(
      "verification-inconclusive",
      verification.reason ?? "Candidate verification was inconclusive.",
      {
        evidence,
        retryable: true,
        nextAction:
          "Run the same verification command and working directory used for the baseline.",
      },
    );
  }
  if (strict && scope?.output === "OUT_OF_SCOPE") {
    return createOutcome(
      "failed",
      "Changed files violated the selected work scope.",
      {
        evidence,
        retryable: true,
        nextAction:
          "Revert or justify out-of-scope changes, then rerun the scope gate.",
      },
    );
  }
  if (lifecycleStatus === "blocked" || terminal?.outcome === "blocked") {
    return createOutcome(
      "blocked",
      "The run reached a concrete blocker and did not claim completion.",
      {
        evidence,
        retryable: true,
        nextAction: "Resolve the reported blocker, then resume.",
      },
    );
  }

  if (!strict) {
    return createOutcome(
      lifecycleStatus === "completed" ? "succeeded" : "blocked",
      lifecycleStatus === "completed"
        ? "The flow reached its configured successful end."
        : "The flow did not reach a successful end.",
      {
        verified: lifecycleStatus === "completed",
        evidence,
        retryable: lifecycleStatus !== "completed",
      },
    );
  }

  const requestedNoOp =
    terminal?.outcome === "no-op" || recorded?.outcome === "STOP";
  if (requestedNoOp) {
    if (
      changes.known &&
      changes.files.length === 0 &&
      !repositoryEvidence?.headChanged &&
      report
    ) {
      return createOutcome(
        "no-op",
        "The run found no justified work and verified that it left the repository unchanged.",
        { verified: true, evidence },
      );
    }
    return createOutcome(
      "verification-inconclusive",
      "The run requested a no-op outcome without proving both an unchanged repository and a final report.",
      {
        evidence,
        retryable: true,
        nextAction:
          "Capture repository evidence and finalize the no-op report.",
      },
    );
  }

  if (!verification) {
    return createOutcome(
      "verification-inconclusive",
      "No comparable candidate verification evidence was produced.",
      {
        evidence,
        retryable: true,
        nextAction:
          "Run the same verification command and working directory used for the baseline.",
      },
    );
  }
  if (
    !changes.known ||
    (changes.files.length === 0 && !repositoryEvidence?.headChanged)
  ) {
    return createOutcome(
      "verification-inconclusive",
      "The run did not prove that meaningful repository output was produced.",
      {
        evidence,
        retryable: true,
        nextAction: "Capture and inspect the final repository diff.",
      },
    );
  }
  if (scope?.output !== "IN_SCOPE") {
    return createOutcome(
      scope?.output === "OUT_OF_SCOPE" ? "failed" : "verification-inconclusive",
      scope?.output === "OUT_OF_SCOPE"
        ? "Changed files violated the selected work scope."
        : "The run did not prove that changed files were within scope.",
      {
        evidence,
        retryable: true,
        nextAction:
          "Revert or justify out-of-scope changes, then rerun the scope gate.",
      },
    );
  }
  if (!report) {
    return createOutcome(
      "verification-inconclusive",
      "The run did not complete its final evidence report.",
      {
        evidence,
        retryable: true,
        nextAction: "Complete the final report from the captured evidence.",
      },
    );
  }
  if (verification.disposition === "BASELINE_EQUIVALENT_FAILURE") {
    limitations.push(
      "The verification command still fails, but it has no semantic failures beyond the frozen baseline.",
    );
  }

  return createOutcome(
    "succeeded",
    "Repository changes passed scope and semantic baseline verification, and the final report completed.",
    { verified: true, evidence, limitations },
  );
};
