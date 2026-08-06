import { createHash } from "node:crypto";

export type RalphVerificationDisposition =
  | "PASSED"
  | "REGRESSION"
  | "BASELINE_EQUIVALENT_FAILURE"
  | "IMPROVED_WITH_BASELINE_FAILURES"
  | "ENVIRONMENT_UNAVAILABLE"
  | "TIMEOUT"
  | "INCONCLUSIVE";

export type RalphVerificationProcessOutcome =
  | { kind: "passed" }
  | { kind: "failed"; exitCode: number }
  | { kind: "timed-out" }
  | { kind: "execution-error" };

export interface RalphVerificationObservation {
  command: string;
  cwd: string;
  processOutcome: RalphVerificationProcessOutcome;
  outputFingerprint: string;
}

export interface RalphVerificationComparison {
  disposition: RalphVerificationDisposition;
  reason: string;
  baselineFingerprint: string;
  candidateFingerprint: string;
}

const fingerprint = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const normalizeCwd = (cwd: string): string => {
  const normalized = cwd.replace(/\\/gu, "/").replace(/\/+$/u, "");
  return /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
};

const hasExactKeys = (
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean => {
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
};

export const createRalphVerificationObservation = (input: {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  executionError?: string;
  timedOut?: boolean;
}): RalphVerificationObservation => {
  const processOutcome: RalphVerificationProcessOutcome = input.timedOut
    ? { kind: "timed-out" }
    : input.executionError || input.exitCode === null
      ? { kind: "execution-error" }
      : input.exitCode === 0
        ? { kind: "passed" }
        : { kind: "failed", exitCode: input.exitCode };

  return {
    command: input.command.trim(),
    cwd: normalizeCwd(input.cwd),
    processOutcome,
    outputFingerprint: fingerprint({
      stdout: input.stdout ?? "",
      stderr: input.stderr ?? "",
    }),
  };
};

const isProcessOutcome = (
  value: unknown,
): value is RalphVerificationProcessOutcome => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    record.kind === "passed" ||
    record.kind === "timed-out" ||
    record.kind === "execution-error"
  ) {
    return hasExactKeys(record, ["kind"]);
  }
  return (
    record.kind === "failed" &&
    hasExactKeys(record, ["exitCode", "kind"]) &&
      typeof record.exitCode === "number" &&
      Number.isInteger(record.exitCode) &&
      record.exitCode !== 0
  );
};

const isObservation = (
  value: unknown,
): value is RalphVerificationObservation => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    hasExactKeys(record, [
    "command",
    "cwd",
    "outputFingerprint",
    "processOutcome",
    ]) &&
    typeof record.command === "string" &&
    record.command.length > 0 &&
    typeof record.cwd === "string" &&
    record.cwd.length > 0 &&
    typeof record.outputFingerprint === "string" &&
    /^[a-f0-9]{64}$/u.test(record.outputFingerprint) &&
    isProcessOutcome(record.processOutcome)
  );
};

export const compareRalphVerificationObservations = (
  baseline: RalphVerificationObservation,
  candidate: RalphVerificationObservation,
): RalphVerificationComparison => {
  const common = {
    baselineFingerprint:
      typeof baseline?.outputFingerprint === "string"
        ? baseline.outputFingerprint
        : "invalid",
    candidateFingerprint:
      typeof candidate?.outputFingerprint === "string"
        ? candidate.outputFingerprint
        : "invalid",
  };

  if (!isObservation(baseline) || !isObservation(candidate)) {
    return {
      disposition: "INCONCLUSIVE",
      reason: "Baseline or candidate verification state was malformed.",
      ...common,
    };
  }
  if (baseline.command !== candidate.command || baseline.cwd !== candidate.cwd) {
    return {
      disposition: "INCONCLUSIVE",
      reason: "Baseline and candidate used different commands or working directories.",
      ...common,
    };
  }
  if (candidate.processOutcome.kind === "passed") {
    return {
      disposition:
        baseline.processOutcome.kind === "passed"
          ? "PASSED"
          : "IMPROVED_WITH_BASELINE_FAILURES",
      reason:
        baseline.processOutcome.kind === "passed"
          ? "The candidate verification passed."
          : "The candidate passed a verification that failed at baseline.",
      ...common,
    };
  }
  if (candidate.processOutcome.kind === "timed-out") {
    return {
      disposition: "TIMEOUT",
      reason: "The candidate verification timed out.",
      ...common,
    };
  }
  if (candidate.processOutcome.kind === "execution-error") {
    return {
      disposition: "ENVIRONMENT_UNAVAILABLE",
      reason: "The candidate verification process could not be executed.",
      ...common,
    };
  }
  if (baseline.processOutcome.kind === "passed") {
    return {
      disposition: "REGRESSION",
      reason: "The candidate failed a verification that passed at baseline.",
      ...common,
    };
  }
  if (
    baseline.processOutcome.kind === "failed" &&
    baseline.processOutcome.exitCode === candidate.processOutcome.exitCode &&
    baseline.outputFingerprint === candidate.outputFingerprint
  ) {
    return {
      disposition: "BASELINE_EQUIVALENT_FAILURE",
      reason: "The candidate reproduced the exact baseline process failure.",
      ...common,
    };
  }

  return {
    disposition: "INCONCLUSIVE",
    reason: "Both runs failed, but no authoritative structured evidence proves equivalence or regression.",
    ...common,
  };
};
