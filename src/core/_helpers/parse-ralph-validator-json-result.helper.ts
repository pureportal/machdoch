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
  confidence: number;
  summary: string;
  evidence: string[];
  remainingWork: string[];
}

export const RALPH_VALIDATOR_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "confidence", "summary", "evidence", "remainingWork"],
  properties: {
    decision: {
      type: "string",
      enum: RALPH_VALIDATOR_JSON_DECISIONS,
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    summary: { type: "string" },
    evidence: { type: "array", items: { type: "string" }, maxItems: 30 },
    remainingWork: {
      type: "array",
      items: { type: "string" },
      maxItems: 30,
    },
  },
} as const;

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
    typeof record.confidence !== "number" ||
    !Number.isFinite(record.confidence) ||
    record.confidence < 0 ||
    record.confidence > 1 ||
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
