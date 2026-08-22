import {
  MAX_INSTRUCTION_PROFILE_DESCRIPTION_LENGTH,
  MAX_INSTRUCTION_PROFILE_NAME_LENGTH,
  MAX_INSTRUCTION_SOURCE_BYTES,
} from "../../../core/instruction-system/limits.js";
import {
  normalizeInstructionTagRule,
  normalizeInstructionTags,
} from "../../../core/instruction-system/tag-rules.js";
import type { InstructionTagRule } from "../../../core/instruction-system/types.js";
import { hasUnpairedUtf16Surrogate } from "../../../shared/unicode.js";

export interface InstructionFormDraft {
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  global: boolean;
  tags: string[];
  match: InstructionTagRule | null;
}

export interface InstructionFormBaseline extends InstructionFormDraft {
  id: string;
}

const codePointLength = (value: string): number => Array.from(value).length;

export const hasAsciiControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });

const normalizedName = (value: string): string =>
  value.trim().normalize("NFKC");

const normalizedDescription = (value: string): string => value.trim();

const normalizedBody = (value: string): string =>
  value.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");

const normalizedRule = (
  rule: InstructionTagRule | null,
): InstructionTagRule | null =>
  rule === null ? null : normalizeInstructionTagRule(rule);

const normalizedTags = (tags: string[]): string[] =>
  normalizeInstructionTags(tags, "tags");

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const instructionBodyByteLength = (body: string): number =>
  new TextEncoder().encode(normalizedBody(body)).byteLength;

export const validateInstructionForm = (
  draft: InstructionFormDraft,
): string | null => {
  const name = normalizedName(draft.name);
  if (!name) return "Enter a name.";
  if (codePointLength(name) > MAX_INSTRUCTION_PROFILE_NAME_LENGTH) {
    return `Name cannot exceed ${MAX_INSTRUCTION_PROFILE_NAME_LENGTH} characters.`;
  }
  if (hasAsciiControlCharacter(name)) {
    return "Name cannot contain control characters.";
  }
  if (hasUnpairedUtf16Surrogate(name)) {
    return "Name must contain valid Unicode text.";
  }
  const description = normalizedDescription(draft.description);
  if (
    codePointLength(description) > MAX_INSTRUCTION_PROFILE_DESCRIPTION_LENGTH
  ) {
    return `Description cannot exceed ${MAX_INSTRUCTION_PROFILE_DESCRIPTION_LENGTH} characters.`;
  }
  if (hasAsciiControlCharacter(description)) {
    return "Description cannot contain control characters.";
  }
  if (hasUnpairedUtf16Surrogate(description)) {
    return "Description must contain valid Unicode text.";
  }
  const body = normalizedBody(draft.body);
  if (!body.trim()) return "Enter instruction content.";
  if (body.includes("\0")) return "Instruction content cannot contain NUL.";
  if (hasUnpairedUtf16Surrogate(body)) {
    return "Instruction content must contain valid Unicode text.";
  }
  const bodyBytes = instructionBodyByteLength(body);
  if (bodyBytes > MAX_INSTRUCTION_SOURCE_BYTES) {
    return `Instruction content is ${bodyBytes} bytes; the limit is ${MAX_INSTRUCTION_SOURCE_BYTES} bytes.`;
  }
  try {
    normalizedTags(draft.tags);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (draft.global && draft.match !== null) {
    return "Global files cannot also use workspace tag matching.";
  }
  if (draft.match !== null) {
    try {
      normalizedRule(draft.match);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return null;
};

export const isInstructionFormDirty = (
  baseline: InstructionFormBaseline | null,
  draft: InstructionFormDraft,
): boolean => {
  if (baseline === null) {
    return (
      normalizedName(draft.name).length > 0 ||
      normalizedDescription(draft.description).length > 0 ||
      normalizedBody(draft.body).length > 0 ||
      draft.enabled !== true ||
      draft.global ||
      draft.tags.length > 0 ||
      draft.match !== null
    );
  }

  let draftTags = draft.tags;
  let draftMatch = draft.match;
  try {
    draftTags = normalizedTags(draft.tags);
    draftMatch = normalizedRule(draft.match);
  } catch {
    return true;
  }
  return (
    normalizedName(draft.name) !== normalizedName(baseline.name) ||
    normalizedDescription(draft.description) !==
      normalizedDescription(baseline.description) ||
    normalizedBody(draft.body) !== normalizedBody(baseline.body) ||
    (draft.global ? true : draft.enabled) !== baseline.enabled ||
    draft.global !== baseline.global ||
    !sameJson(draftTags, baseline.tags) ||
    !sameJson(draft.global ? null : draftMatch, baseline.match)
  );
};
