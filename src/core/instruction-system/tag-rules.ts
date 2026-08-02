import { InstructionSystemError, type InstructionTagRule } from "./types.js";

export const MAX_INSTRUCTION_TAGS = 64;
export const MAX_INSTRUCTION_TAG_LENGTH = 80;
export const MAX_INSTRUCTION_TAG_RULE_DEPTH = 8;
export const MAX_INSTRUCTION_TAG_RULE_NODES = 128;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const tagKey = (value: string): string =>
  value.normalize("NFKC").toLocaleLowerCase("en-US");

export const normalizeInstructionTag = (value: string): string => {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!normalized) {
    throw new InstructionSystemError(
      "INSTRUCTION_TAG_INVALID",
      "Instruction tags cannot be empty.",
    );
  }
  if ([...normalized].length > MAX_INSTRUCTION_TAG_LENGTH) {
    throw new InstructionSystemError(
      "INSTRUCTION_TAG_INVALID",
      `Instruction tags cannot exceed ${MAX_INSTRUCTION_TAG_LENGTH} characters.`,
    );
  }
  if (
    normalized.includes(",") ||
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new InstructionSystemError(
      "INSTRUCTION_TAG_INVALID",
      "Instruction tags cannot contain commas or control characters.",
    );
  }
  return normalized;
};

export const normalizeInstructionTags = (
  value: unknown,
  field: string,
): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_INSTRUCTION_TAGS) {
    throw new InstructionSystemError(
      "INSTRUCTION_TAGS_INVALID",
      `${field} must be an array with at most ${MAX_INSTRUCTION_TAGS} tags.`,
    );
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      throw new InstructionSystemError(
        "INSTRUCTION_TAGS_INVALID",
        `${field}[${index}] must be a string.`,
      );
    }
    const tag = normalizeInstructionTag(entry);
    const key = tagKey(tag);
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  }
  return tags;
};

export const normalizeInstructionTagRule = (
  value: unknown,
  field = "match",
): InstructionTagRule => {
  let nodes = 0;
  const visit = (
    candidate: unknown,
    depth: number,
    path: string,
  ): InstructionTagRule => {
    nodes += 1;
    if (
      nodes > MAX_INSTRUCTION_TAG_RULE_NODES ||
      depth > MAX_INSTRUCTION_TAG_RULE_DEPTH
    ) {
      throw new InstructionSystemError(
        "INSTRUCTION_TAG_RULE_TOO_COMPLEX",
        `${field} exceeds the supported Boolean rule complexity.`,
      );
    }
    if (!isRecord(candidate) || typeof candidate.op !== "string") {
      throw new InstructionSystemError(
        "INSTRUCTION_TAG_RULE_INVALID",
        `${path} must be a tag, AND, or OR rule.`,
      );
    }
    const keys = Object.keys(candidate);
    if (candidate.op === "tag") {
      if (
        keys.some((key) => key !== "op" && key !== "tag") ||
        typeof candidate.tag !== "string"
      ) {
        throw new InstructionSystemError(
          "INSTRUCTION_TAG_RULE_INVALID",
          `${path} must contain only op and tag.`,
        );
      }
      return { op: "tag", tag: normalizeInstructionTag(candidate.tag) };
    }
    if (candidate.op !== "and" && candidate.op !== "or") {
      throw new InstructionSystemError(
        "INSTRUCTION_TAG_RULE_INVALID",
        `${path}.op must be tag, and, or or.`,
      );
    }
    if (
      keys.some((key) => key !== "op" && key !== "rules") ||
      !Array.isArray(candidate.rules)
    ) {
      throw new InstructionSystemError(
        "INSTRUCTION_TAG_RULE_INVALID",
        `${path} must contain only op and rules.`,
      );
    }
    if (candidate.rules.length === 0) {
      throw new InstructionSystemError(
        "INSTRUCTION_TAG_RULE_INVALID",
        `${path}.rules cannot be empty.`,
      );
    }
    return {
      op: candidate.op,
      rules: candidate.rules.map((rule, index) =>
        visit(rule, depth + 1, `${path}.rules[${index}]`),
      ),
    };
  };
  return visit(value, 0, field);
};

export const instructionTagRuleMatches = (
  rule: InstructionTagRule,
  workspaceTags: readonly string[],
): boolean => {
  const tags = new Set(workspaceTags.map(tagKey));
  const evaluate = (candidate: InstructionTagRule): boolean => {
    if (candidate.op === "tag") return tags.has(tagKey(candidate.tag));
    return candidate.op === "and"
      ? candidate.rules.every(evaluate)
      : candidate.rules.some(evaluate);
  };
  return evaluate(rule);
};

export const formatInstructionTagRule = (rule: InstructionTagRule): string => {
  if (rule.op === "tag") return rule.tag;
  const separator = rule.op === "and" ? " AND " : " OR ";
  return `(${rule.rules.map(formatInstructionTagRule).join(separator)})`;
};
