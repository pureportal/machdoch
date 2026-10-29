const OPEN_TAG = "<machdoch-follow-ups>";
const CLOSE_TAG = "</machdoch-follow-ups>";
const MAX_SUGGESTIONS = 3;
const MAX_SUGGESTION_CHARS = 200;

/**
 * Appended to a CLI agent's system instructions so its final answer ends with
 * a few prompts the user might send next. Machdoch strips the block from the
 * answer before showing or storing it, so it never reaches the transcript.
 */
export const FOLLOW_UP_SUGGESTION_INSTRUCTIONS = [
  "After your final answer to the user, add one block with up to three short follow-up prompts the user is likely to send next.",
  "Write each prompt in the user's voice and language, as a direct request (for example \"Add tests for the new parser\"), at most 12 words, without numbering.",
  `Format exactly:\n${OPEN_TAG}\n- first prompt\n- second prompt\n${CLOSE_TAG}`,
  "Put the block only at the very end of your final answer, never inside code blocks or intermediate messages. Leave the block out when no useful follow-up exists.",
].join("\n");

const normalizeSuggestion = (line: string): string =>
  line
    .replace(/^\s*(?:(?:[-*•]|\d+[.)])\s*)+/u, "")
    .replace(/^["'“”]+|["'“”]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

/** Removes the trailing follow-up block and returns the prompts it held. */
export const extractFollowUpSuggestions = (
  text: string,
): { text: string; suggestions: string[] } => {
  const open = text.lastIndexOf(OPEN_TAG);
  if (open === -1) return { text, suggestions: [] };
  const close = text.indexOf(CLOSE_TAG, open);
  const body = text.slice(
    open + OPEN_TAG.length,
    close === -1 ? undefined : close,
  );
  const remainder = close === -1 ? "" : text.slice(close + CLOSE_TAG.length);
  // Only a block at the end is a suggestion block; anything quoted earlier
  // (for example in a code sample) stays part of the answer.
  if (remainder.trim().length > 0) return { text, suggestions: [] };
  const suggestions = mergeFollowUpSuggestions(
    body
      .split(/\r?\n/u)
      .map(normalizeSuggestion)
      .filter((line) => line.length > 0 && line.length <= MAX_SUGGESTION_CHARS),
  );
  return { text: text.slice(0, open).trimEnd(), suggestions };
};

/** Hides a suggestion block, complete or still streaming, from display text. */
export const hideFollowUpBlock = (text: string): string => {
  const open = text.lastIndexOf(OPEN_TAG);
  if (open !== -1) return text.slice(0, open).trimEnd();
  for (let length = OPEN_TAG.length - 1; length > 0; length -= 1) {
    if (text.endsWith(OPEN_TAG.slice(0, length))) {
      return text.slice(0, -length);
    }
  }
  return text;
};

export const mergeFollowUpSuggestions = (
  ...sources: ReadonlyArray<readonly string[]>
): string[] => {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const source of sources) {
    for (const suggestion of source) {
      const normalized = normalizeSuggestion(suggestion);
      const key = normalized.toLowerCase();
      if (!normalized || seen.has(key)) continue;
      seen.add(key);
      merged.push(normalized.slice(0, MAX_SUGGESTION_CHARS));
    }
  }
  return merged.slice(0, MAX_SUGGESTIONS);
};
