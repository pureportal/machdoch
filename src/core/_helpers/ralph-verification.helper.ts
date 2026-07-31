import { createHash } from "node:crypto";

export type RalphVerificationDisposition =
  | "PASSED"
  | "REGRESSION"
  | "BASELINE_EQUIVALENT_FAILURE"
  | "IMPROVED_WITH_BASELINE_FAILURES"
  | "ENVIRONMENT_UNAVAILABLE"
  | "TIMEOUT"
  | "INCONCLUSIVE";

export interface RalphVerificationObservation {
  command: string;
  cwd: string;
  exitCode: number | null;
  failureClass:
    | "passed"
    | "test"
    | "typecheck"
    | "lint"
    | "dependency"
    | "collection"
    | "timeout"
    | "command"
    | "unknown";
  failureIds: string[];
  missingDependencies: string[];
  semanticFingerprint: string;
  outputFingerprint: string;
  executionError?: string;
  timedOut?: boolean;
}

export interface RalphVerificationComparison {
  disposition: RalphVerificationDisposition;
  reason: string;
  baselineFingerprint: string;
  candidateFingerprint: string;
  newFailureIds: string[];
  resolvedFailureIds: string[];
  newMissingDependencies: string[];
}

const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu;

const normalizeOutput = (value: string): string => {
  return value
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/\\/gu, "/")
    .replace(
      /\b\d+(?:\.\d+)?\s*(?:ms|s|sec(?:onds?)?|minutes?)\b/giu,
      "<duration>",
    )
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.+-]+Z?\b/gu, "<timestamp>")
    .replace(/\bseed[=: ]+\d+\b/giu, "seed=<value>")
    .replace(/[ \t]+/gu, " ")
    .trim();
};

const normalizeFailureId = (value: string): string => {
  return value
    .replace(/\\/gu, "/")
    .replace(/:\d+(?::\d+)?(?=\b|\))/gu, ":<line>")
    .replace(/\(\d+,\d+\)/gu, "(<line>)")
    .replace(/[ \t]+/gu, " ")
    .trim()
    .toLowerCase();
};

const collectMatches = (text: string, pattern: RegExp, group = 1): string[] => {
  return [...text.matchAll(pattern)]
    .map((match) => match[group])
    .filter((value): value is string => Boolean(value?.trim()))
    .map(normalizeFailureId);
};

const collectFailureIds = (output: string): string[] => {
  const ids = [
    ...collectMatches(output, /^\s*FAILED\s+(\S+)/gimu),
    ...collectMatches(output, /^\s*FAIL\s+(.+?)\s*$/gimu),
    ...collectMatches(
      output,
      /^(.+?\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|cs))(?::\d+(?::\d+)?|\(\d+,\d+\))\s*(?:-|:)?\s*(?:error|warning)\b.*$/gimu,
      0,
    ),
    ...collectMatches(output, /^\s*[×✕✖]\s+(.+?)\s*$/gimu),
    ...collectMatches(output, /^\s*ERROR collecting\s+(.+?)\s*$/gimu),
    ...collectMatches(output, /^\s*(?:error|fatal):\s+(.+?)\s*$/gimu, 0),
  ];

  return [...new Set(ids)].sort();
};

const collectMissingDependencies = (output: string): string[] => {
  const dependencies = [
    ...collectMatches(
      output,
      /(?:cannot find module|module not found(?: error)?|no module named)\s*[:'"]+\s*([^'"\s,]+)/gimu,
    ),
    ...collectMatches(
      output,
      /(?:command not found|is not recognized as (?:an internal|the name of))[: ]+['"]?([^'"\s]+)/gimu,
    ),
    ...collectMatches(
      output,
      /(?:could not resolve|failed to resolve import)\s*['"]([^'"]+)/gimu,
    ),
  ];

  return [...new Set(dependencies)].sort();
};

const classifyFailure = (
  output: string,
  exitCode: number | null,
  missingDependencies: readonly string[],
  executionError?: string,
  timedOut = false,
): RalphVerificationObservation["failureClass"] => {
  if (exitCode === 0 && !executionError) {
    return "passed";
  }
  if (timedOut) {
    return "timeout";
  }
  if (missingDependencies.length > 0) {
    return "dependency";
  }
  if (/\b(?:ERROR collecting|error during collection)\b/iu.test(output)) {
    return "collection";
  }
  if (/\b(?:tsc|typecheck|TS\d{3,5}|type error)\b/iu.test(output)) {
    return "typecheck";
  }
  if (/\b(?:eslint|lint(?:ing)?|biome|ruff)\b/iu.test(output)) {
    return "lint";
  }
  if (
    /\b(?:test|tests|pytest|vitest|jest|spec|assertion|FAILED|FAIL)\b/iu.test(
      output,
    )
  ) {
    return "test";
  }
  if (executionError || exitCode === null) {
    return "command";
  }
  return "unknown";
};

const fingerprint = (value: unknown): string => {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
  const output = normalizeOutput(
    [input.stdout, input.stderr, input.executionError]
      .filter(Boolean)
      .join("\n"),
  );
  const failureIds = collectFailureIds(output);
  const missingDependencies = collectMissingDependencies(output);
  const failureClass = classifyFailure(
    output,
    input.exitCode,
    missingDependencies,
    input.executionError,
    input.timedOut,
  );
  const semanticEvidence = {
    exit: input.exitCode === 0 ? "passed" : "failed",
    failureClass,
    failureIds,
    missingDependencies,
    ...(input.exitCode !== 0 &&
    failureIds.length === 0 &&
    missingDependencies.length === 0
      ? { unstructuredOutputFingerprint: fingerprint(output) }
      : {}),
  };

  return {
    command: input.command.trim(),
    cwd: input.cwd.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase(),
    exitCode: input.exitCode,
    failureClass,
    failureIds,
    missingDependencies,
    semanticFingerprint: fingerprint(semanticEvidence),
    outputFingerprint: fingerprint(output),
    ...(input.executionError ? { executionError: input.executionError } : {}),
    ...(input.timedOut ? { timedOut: true } : {}),
  };
};

const difference = (
  left: readonly string[],
  right: readonly string[],
): string[] => left.filter((value) => !right.includes(value));

export const compareRalphVerificationObservations = (
  baseline: RalphVerificationObservation,
  candidate: RalphVerificationObservation,
): RalphVerificationComparison => {
  const newFailureIds = difference(candidate.failureIds, baseline.failureIds);
  const resolvedFailureIds = difference(
    baseline.failureIds,
    candidate.failureIds,
  );
  const newMissingDependencies = difference(
    candidate.missingDependencies,
    baseline.missingDependencies,
  );
  const common = {
    baselineFingerprint: baseline.semanticFingerprint,
    candidateFingerprint: candidate.semanticFingerprint,
    newFailureIds,
    resolvedFailureIds,
    newMissingDependencies,
  };

  if (
    baseline.command !== candidate.command ||
    baseline.cwd !== candidate.cwd
  ) {
    return {
      disposition: "INCONCLUSIVE",
      reason:
        "Baseline and candidate used different commands or working directories.",
      ...common,
    };
  }
  if (candidate.exitCode === 0 && !candidate.executionError) {
    return {
      disposition:
        baseline.exitCode === 0 && !baseline.executionError
          ? "PASSED"
          : "IMPROVED_WITH_BASELINE_FAILURES",
      reason:
        baseline.exitCode === 0 && !baseline.executionError
          ? "The candidate verification passed."
          : "The candidate passed a verification that failed at baseline.",
      ...common,
    };
  }
  if (candidate.timedOut) {
    return {
      disposition: "TIMEOUT",
      reason: baseline.timedOut
        ? "The required verification timed out both before and after the change."
        : "The candidate verification timed out.",
      ...common,
    };
  }
  if (baseline.exitCode === 0 && !baseline.executionError) {
    return {
      disposition: "REGRESSION",
      reason: "The candidate failed a verification that passed at baseline.",
      ...common,
    };
  }
  if (newMissingDependencies.length > 0) {
    return {
      disposition: "REGRESSION",
      reason:
        "The candidate introduced a missing dependency that was available at baseline.",
      ...common,
    };
  }
  if (
    candidate.failureClass === "dependency" &&
    baseline.failureClass === "dependency"
  ) {
    return {
      disposition: "ENVIRONMENT_UNAVAILABLE",
      reason:
        "A required dependency was unavailable both before and after the change.",
      ...common,
    };
  }
  if (
    candidate.failureClass === "collection" &&
    baseline.failureClass === "collection" &&
    newFailureIds.length === 0
  ) {
    return {
      disposition: "ENVIRONMENT_UNAVAILABLE",
      reason:
        "The required test suite could not be collected before or after the change.",
      ...common,
    };
  }
  if (
    baseline.semanticFingerprint === candidate.semanticFingerprint ||
    (baseline.failureClass === candidate.failureClass &&
      newFailureIds.length === 0 &&
      newMissingDependencies.length === 0 &&
      baseline.failureIds.length + baseline.missingDependencies.length > 0)
  ) {
    return {
      disposition:
        resolvedFailureIds.length > 0
          ? "IMPROVED_WITH_BASELINE_FAILURES"
          : "BASELINE_EQUIVALENT_FAILURE",
      reason:
        resolvedFailureIds.length > 0
          ? "The candidate resolved baseline failures without introducing new ones."
          : "The candidate has the same semantic failures as the baseline.",
      ...common,
    };
  }
  if (newFailureIds.length > 0) {
    return {
      disposition: "REGRESSION",
      reason: "The candidate introduced failures not present at baseline.",
      ...common,
    };
  }

  return {
    disposition: "INCONCLUSIVE",
    reason:
      "Both runs failed, but their output was not structured enough for a safe comparison.",
    ...common,
  };
};
