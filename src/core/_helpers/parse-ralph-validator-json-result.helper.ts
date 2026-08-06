export const RALPH_VALIDATOR_JSON_DECISIONS = [
  "DONE",
  "CONTINUE",
  "RETRY",
  "ERROR",
] as const;

export type RalphValidatorJsonDecision =
  (typeof RALPH_VALIDATOR_JSON_DECISIONS)[number];

export interface RalphValidatorJsonResult {
  decision: RalphValidatorJsonDecision;
  confidence: string;
  summary: string;
  evidence: string[];
  remainingWork: string[];
}

const EXPECTED_KEYS = [
  "confidence",
  "decision",
  "evidence",
  "remainingWork",
  "summary",
] as const;

const isExactStringArray = (value: unknown): value is string[] => {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
};

export const parseRalphValidatorJsonResult = (
  value: unknown,
): RalphValidatorJsonResult | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== EXPECTED_KEYS.length ||
    keys.some((key, index) => key !== EXPECTED_KEYS[index]) ||
    !RALPH_VALIDATOR_JSON_DECISIONS.includes(
      record.decision as RalphValidatorJsonDecision,
    ) ||
    typeof record.confidence !== "string" ||
    typeof record.summary !== "string" ||
    !isExactStringArray(record.evidence) ||
    !isExactStringArray(record.remainingWork)
  ) {
    return undefined;
  }

  return {
    decision: record.decision as RalphValidatorJsonDecision,
    confidence: record.confidence,
    summary: record.summary,
    evidence: record.evidence,
    remainingWork: record.remainingWork,
  };
};
