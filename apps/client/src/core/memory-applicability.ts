import type { MemoryApplicability } from "@machdoch/fleet-protocol/memory-applicability";
export type { MemoryApplicability } from "@machdoch/fleet-protocol/memory-applicability";

const DAY_MILLISECONDS = 86_400_000;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const RULE_FIELDS = new Set([
  "taskTerms",
  "excludedTaskTerms",
  "expiresAt",
  "verifiedAt",
  "maxAgeDays",
  "enabled",
]);
const RELEVANCE_STOP_WORDS = new Set(
  "a an and are as at be by can create do for from how i in is it of on or please should that the this to use we what when where with you".split(
    " ",
  ),
);

const normalizeText = (value: string): string =>
  value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= MAX_TIMESTAMP;

const matchesTerm = (query: string, term: string): boolean => {
  let offset = query.indexOf(term);

  while (offset !== -1) {
    const before = query.slice(0, offset);
    const after = query.slice(offset + term.length);

    if (
      !/[\p{L}\p{M}\p{N}_]$/u.test(before) &&
      !/^[\p{L}\p{M}\p{N}_]/u.test(after)
    ) {
      return true;
    }

    offset = query.indexOf(term, offset + 1);
  }

  return false;
};

export const normalizeMemoryApplicability = (
  value: unknown,
): MemoryApplicability | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError("Memory applicability must be a plain object.");
  }

  const normalized: MemoryApplicability = {};

  for (const field of Reflect.ownKeys(value)) {
    if (typeof field !== "string" || !RULE_FIELDS.has(field)) {
      throw new TypeError("Unknown memory applicability field.");
    }

    const rule = (value as Record<string, unknown>)[field];

    if (rule === undefined) {
      continue;
    }

    switch (field) {
      case "taskTerms":
      case "excludedTaskTerms": {
        if (!Array.isArray(rule) || rule.length > 32) {
          throw new TypeError(`Memory applicability ${field} must be an array.`);
        }

        const terms: string[] = [];

        for (const term of rule) {
          const normalizedTerm = typeof term === "string" ? normalizeText(term) : "";

          if (normalizedTerm.length > 200 || !/[\p{L}\p{N}]/u.test(normalizedTerm)) {
            throw new TypeError(
              `Memory applicability ${field} must contain nonempty word terms.`,
            );
          }

          terms.push(normalizedTerm);
        }

        if (terms.length > 0) {
          normalized[field] = [...new Set(terms)];
        }
        break;
      }
      case "expiresAt":
      case "verifiedAt":
        if (!isTimestamp(rule)) {
          throw new TypeError(`Memory applicability ${field} must be a timestamp.`);
        }
        normalized[field] = rule;
        break;
      case "maxAgeDays":
        if (
          typeof rule !== "number" ||
          !Number.isFinite(rule) ||
          rule < 0
        ) {
          throw new TypeError(
            "Memory applicability maxAgeDays must be a nonnegative finite number.",
          );
        }
        normalized.maxAgeDays = rule;
        break;
      case "enabled":
        if (typeof rule !== "boolean") {
          throw new TypeError("Memory applicability enabled must be a boolean.");
        }
        normalized.enabled = rule;
        break;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

export const assessMemoryApplicability = (
  entry: {
    kind: string;
    content: string;
    updatedAt: number;
    confidence: number;
    scope?: string;
    applicability?: MemoryApplicability;
  },
  query: string,
  now = Date.now(),
): { applicable: boolean; reasons: string[] } => {
  let rules: MemoryApplicability | undefined;

  try {
    rules = normalizeMemoryApplicability(entry.applicability);
  } catch {
    return { applicable: false, reasons: ["invalid-applicability"] };
  }

  const reasons: string[] = [];

  if (rules?.enabled === false) {
    reasons.push("disabled");
  }

  if (!isTimestamp(now) || !isTimestamp(entry.updatedAt)) {
    reasons.push("invalid-timestamp");
  } else {
    const verifiedAt = rules?.verifiedAt ?? entry.updatedAt;

    if (entry.updatedAt > now || verifiedAt > now) {
      reasons.push("future-evidence");
    }

    if (rules?.expiresAt !== undefined && now >= rules.expiresAt) {
      reasons.push("expired");
    }

    if (
      rules?.maxAgeDays !== undefined &&
      (now - verifiedAt) / DAY_MILLISECONDS > rules.maxAgeDays
    ) {
      reasons.push("too-old");
    }
  }

  if (
    !Number.isFinite(entry.confidence) ||
    entry.confidence < 0 ||
    entry.confidence > 1
  ) {
    reasons.push("invalid-confidence");
  } else if (entry.confidence === 0) {
    reasons.push("no-confidence");
  }

  const normalizedQuery = normalizeText(query);
  const requiredTerms = rules?.taskTerms ?? [];

  if (!requiredTerms.every((term) => matchesTerm(normalizedQuery, term))) {
    reasons.push("unmatched-task-terms");
  }

  if (
    rules?.excludedTaskTerms?.some((term) => matchesTerm(normalizedQuery, term))
  ) {
    reasons.push("excluded-task-term");
  }

  const globalPreference =
    entry.kind === "preference" && entry.scope === "global";

  if (requiredTerms.length === 0 && !globalPreference) {
    const queryWords = new Set(
      normalizedQuery.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}_]*/gu) ?? [],
    );
    const contentWords =
      normalizeText(entry.content).match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}_]*/gu) ?? [];

    if (
      !contentWords.some(
        (word) => !RELEVANCE_STOP_WORDS.has(word) && queryWords.has(word),
      )
    ) {
      reasons.push("irrelevant-content");
    }
  }

  if (reasons.length > 0) {
    return { applicable: false, reasons };
  }

  return {
    applicable: true,
    reasons: [
      requiredTerms.length > 0
        ? "matched-task-terms"
        : globalPreference
          ? "global-preference"
          : "relevant-content",
    ],
  };
};
