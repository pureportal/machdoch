/**
 * The prompt the Review changes button sends. Codex runs its native review
 * for it; other providers follow the prompt itself.
 */
export const REVIEW_CHANGES_PROMPT =
  "Review the uncommitted changes in this workspace. Report bugs, regressions and risky edge cases first, ordered by severity, with file and line references. Do not edit any files.";

export const REVIEW_CHANGES_COMMAND = "/review";

/** Expands the `/review` command into the review prompt. */
export const expandReviewChangesCommand = (task: string): string =>
  task.trim().toLowerCase() === REVIEW_CHANGES_COMMAND ? REVIEW_CHANGES_PROMPT : task;

export const isReviewChangesTask = (task: string): boolean =>
  task.trim() === REVIEW_CHANGES_PROMPT;
