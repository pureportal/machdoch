import { createHash } from "node:crypto";
import type { RalphBlockExecutionResult, RalphFlowBlock } from "../ralph.js";

export interface RalphProgressEvidence {
  transition: number;
  blockId: string;
  output: string;
  channel: string;
  signature: string;
  meaningful: boolean;
  reason: string;
  at: string;
}

export interface RalphProgressState {
  consecutiveNoProgress: number;
  meaningfulTransitions: number;
  lastProgressAt?: string;
  lastProgressTransition?: number;
  channelFingerprints: Record<string, string>;
  recent: RalphProgressEvidence[];
  stalledReason?: string;
}

export interface RalphProgressPolicy {
  maxStagnantTransitions: number;
  maxRepeatedCycle: number;
}

export interface RalphProgressAssessment {
  state: RalphProgressState;
  evidence: RalphProgressEvidence;
  stalled: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
};

const hash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");

const getVerificationDisposition = (
  result: RalphBlockExecutionResult,
): string | undefined => {
  const verification = isRecord(result.data)
    ? result.data.verification
    : undefined;
  const comparison =
    isRecord(verification) && isRecord(verification.comparison)
      ? verification.comparison
      : undefined;
  return typeof comparison?.disposition === "string"
    ? comparison.disposition
    : undefined;
};

export const createRalphRepositoryProgressFingerprint = (input: {
  files: readonly { path: string; signature: string }[];
  head?: string;
}): string =>
  hash({
    head: input.head ?? "",
    files: input.files
      .map((file) => ({
        path: file.path,
        signature: file.signature,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  });

const getGitFingerprint = (
  result: RalphBlockExecutionResult,
): string | undefined => {
  if (!isRecord(result.data) || !Array.isArray(result.data.files)) {
    return undefined;
  }
  const files = result.data.files.flatMap((entry) =>
    isRecord(entry) &&
    typeof entry.path === "string" &&
    typeof entry.signature === "string"
      ? [{ path: entry.path, signature: entry.signature }]
      : [],
  );
  return createRalphRepositoryProgressFingerprint({
    files,
    ...(typeof result.data.head === "string" ? { head: result.data.head } : {}),
  });
};

const getExecutionFileChangeFingerprint = (
  result: RalphBlockExecutionResult,
): string | undefined => {
  const fileChanges = result.result?.fileChanges;
  if (fileChanges?.status !== "complete") {
    return undefined;
  }
  const files = fileChanges.files
    .filter(
      (file) =>
        !/(?:^|\/)\.machdoch(?:\/|$)/u.test(file.path.replace(/\\/gu, "/")),
    )
    .map((file) => ({
      path: file.path.replace(/\\/gu, "/"),
      operation: file.operation,
      oldObjectId: file.oldObjectId ?? "",
      newObjectId: file.newObjectId ?? "",
      oldCommit: file.oldCommit ?? "",
      newCommit: file.newCommit ?? "",
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  return files.length > 0 ? hash(files) : undefined;
};

const getProgressChannel = (
  block: RalphFlowBlock,
  result: RalphBlockExecutionResult,
): {
  channel: string;
  fingerprint?: string;
  eligible: boolean;
  initialIsProgress?: boolean;
  reason: string;
} => {
  const executionFileChangeFingerprint =
    getExecutionFileChangeFingerprint(result);
  if (executionFileChangeFingerprint) {
    return {
      channel: "repository-execution",
      fingerprint: executionFileChangeFingerprint,
      eligible: true,
      initialIsProgress: true,
      reason: "The execution produced machine-observed repository changes.",
    };
  }

  if (block.type !== "UTILITY") {
    return {
      channel: "control",
      eligible: false,
      reason: "Model and routing output is not objective repository evidence.",
    };
  }

  if (
    block.utility.type === "GIT_SNAPSHOT" ||
    block.utility.type === "GIT_DIFF_SUMMARY"
  ) {
    const fingerprint = getGitFingerprint(result);
    return {
      channel: "repository",
      ...(fingerprint ? { fingerprint } : {}),
      eligible: true,
      reason: "Repository content changed since the previous observation.",
    };
  }
  if (block.utility.type === "MARK_JSON_TASK") {
    return {
      channel: `work-item:${block.utility.path ?? block.id}`,
      fingerprint: hash(result.data),
      eligible: result.output === "SUCCESS",
      initialIsProgress: true,
      reason: "A durable work item changed state.",
    };
  }
  if (block.utility.type === "CHANGE_SCOPE_GUARD") {
    return {
      channel: "scope-verification",
      fingerprint: result.output,
      eligible: result.output === "IN_SCOPE",
      initialIsProgress: true,
      reason: "Changed files passed the configured scope gate.",
    };
  }
  if (block.utility.type === "RUN_CHECK") {
    const disposition = getVerificationDisposition(result);
    return {
      channel: "verification",
      ...(disposition ? { fingerprint: disposition } : {}),
      eligible:
        disposition === "PASSED" ||
        disposition === "IMPROVED_WITH_BASELINE_FAILURES",
      initialIsProgress: true,
      reason: "Verification evidence improved.",
    };
  }

  return {
    channel: `utility:${block.utility.type}`,
    eligible: false,
    reason: "The result is operational evidence, not objective task progress.",
  };
};

const getCycleLength = (
  recent: readonly RalphProgressEvidence[],
  repetitions: number,
): number | undefined => {
  const signatures = recent.map((entry) => entry.signature);
  for (let cycleLength = 1; cycleLength <= 4; cycleLength += 1) {
    const required = cycleLength * repetitions;
    if (signatures.length < required) {
      continue;
    }
    const tail = signatures.slice(-cycleLength);
    let matches = true;
    for (let offset = 2; offset <= repetitions; offset += 1) {
      const prior = signatures.slice(
        signatures.length - cycleLength * offset,
        signatures.length - cycleLength * (offset - 1),
      );
      if (prior.some((value, index) => value !== tail[index])) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return cycleLength;
    }
  }
  return undefined;
};

export const createRalphProgressState = (
  restored?: Partial<RalphProgressState>,
): RalphProgressState => ({
  consecutiveNoProgress:
    typeof restored?.consecutiveNoProgress === "number"
      ? restored.consecutiveNoProgress
      : 0,
  meaningfulTransitions:
    typeof restored?.meaningfulTransitions === "number"
      ? restored.meaningfulTransitions
      : 0,
  ...(restored?.lastProgressAt
    ? { lastProgressAt: restored.lastProgressAt }
    : {}),
  ...(typeof restored?.lastProgressTransition === "number"
    ? { lastProgressTransition: restored.lastProgressTransition }
    : {}),
  channelFingerprints: { ...(restored?.channelFingerprints ?? {}) },
  recent: Array.isArray(restored?.recent)
    ? restored.recent.slice(-32).map((entry) => ({ ...entry }))
    : [],
  ...(restored?.stalledReason ? { stalledReason: restored.stalledReason } : {}),
});

export const assessRalphProgress = (
  state: RalphProgressState,
  block: RalphFlowBlock,
  result: RalphBlockExecutionResult,
  transition: number,
  policy: RalphProgressPolicy,
  now = new Date().toISOString(),
): RalphProgressAssessment => {
  const channel = getProgressChannel(block, result);
  const previousFingerprint = state.channelFingerprints[channel.channel];
  const meaningful = Boolean(
    channel.eligible &&
    channel.fingerprint &&
    (previousFingerprint === undefined
      ? channel.initialIsProgress
      : previousFingerprint !== channel.fingerprint),
  );
  const signature = hash({
    blockId: block.id,
    output: result.output,
    channel: channel.channel,
    fingerprint: channel.fingerprint,
  });
  const evidence: RalphProgressEvidence = {
    transition,
    blockId: block.id,
    output: result.output,
    channel: channel.channel,
    signature,
    meaningful,
    reason: meaningful
      ? channel.reason
      : previousFingerprint === undefined && channel.fingerprint
        ? `Established the ${channel.channel} baseline.`
        : channel.reason,
    at: now,
  };
  const next = createRalphProgressState(state);
  if (channel.fingerprint) {
    next.channelFingerprints[channel.channel] = channel.fingerprint;
  }
  next.recent = [...next.recent, evidence].slice(-32);
  if (meaningful) {
    next.consecutiveNoProgress = 0;
    next.meaningfulTransitions += 1;
    next.lastProgressAt = now;
    next.lastProgressTransition = transition;
    delete next.stalledReason;
  } else {
    next.consecutiveNoProgress += 1;
  }

  const cycleLength = getCycleLength(next.recent, policy.maxRepeatedCycle);
  const stalledByCycle =
    cycleLength !== undefined &&
    !next.recent
      .slice(-cycleLength * policy.maxRepeatedCycle)
      .some((entry) => entry.meaningful);
  const stalledByTransitions =
    policy.maxStagnantTransitions > 0 &&
    next.consecutiveNoProgress >= policy.maxStagnantTransitions;
  if (stalledByCycle) {
    next.stalledReason = `Detected a ${cycleLength}-step semantic cycle repeated ${policy.maxRepeatedCycle} times without objective progress.`;
  } else if (stalledByTransitions) {
    next.stalledReason = `No objective progress was observed for ${next.consecutiveNoProgress} transitions.`;
  }

  return {
    state: next,
    evidence,
    stalled: Boolean(next.stalledReason),
  };
};
