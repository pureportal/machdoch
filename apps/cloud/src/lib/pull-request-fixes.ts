import { z } from "zod";
import type { ChangedFileStat } from "@machdoch/fleet-protocol/cloud-delivery";
import type { GitReviewComment } from "./cloud-git-contract";

export const pullRequestFixTasks = ["checks", "review"] as const;
export type PullRequestFixTask = (typeof pullRequestFixTasks)[number];
export const pullRequestFixInputSchema = z.strictObject({
  task: z.enum(pullRequestFixTasks),
});

export interface GitCheckLog {
  name: string;
  url: string | null;
  log: string;
}

export const checkLogByteLimit = 64 * 1024;

const contextBudget = 14_000;
const maximumEntries = 8;
const maximumListedFiles = 40;
const timestampPrefix = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[\d.]+Z ?/u;
const escapeSequence = new RegExp(String.raw`\u001b\[[0-9;?]*[A-Za-z]`, "gu");

export function logExcerpt(log: string, limit: number): string {
  const lines = log
    .replace(escapeSequence, "")
    .split(/\r?\n/u)
    .map((line) => line.replace(timestampPrefix, "").trimEnd())
    .filter(Boolean);
  const lastError = lines.findLastIndex((line) => line.includes("##[error]"));
  const relevant = lastError === -1 ? lines : lines.slice(0, lastError + 1);
  const kept: string[] = [];
  let length = 0;
  for (let index = relevant.length - 1; index >= 0; index--) {
    const line = relevant[index]!;
    if (length + line.length + 1 > limit) break;
    kept.unshift(line);
    length += line.length + 1;
  }
  return kept.length < relevant.length
    ? ["…", ...kept].join("\n")
    : kept.join("\n");
}

function fence(text: string): string {
  const longest = Math.max(
    2,
    ...[...text.matchAll(/`+/gu)].map((match) => match[0].length),
  );
  const marker = "`".repeat(longest + 1);
  return `${marker}text\n${text}\n${marker}`;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function checkSection(failure: GitCheckLog, budget: number): string {
  const excerpt = logExcerpt(failure.log, budget);
  return [
    `## ${failure.name}`,
    failure.url ?? "",
    excerpt ? fence(excerpt) : "The provider returned no log for this check.",
  ]
    .filter(Boolean)
    .join("\n");
}

function commentSection(comment: GitReviewComment, budget: number): string {
  return [
    `## ${comment.path}${comment.line === null ? "" : `:${comment.line}`} (${comment.author})`,
    clip(comment.body.trim(), budget),
    comment.url,
  ].join("\n");
}

export function pullRequestFixSubject(
  task: PullRequestFixTask,
  input: { failures: GitCheckLog[]; comments: GitReviewComment[] },
): { objective: string; acceptanceCriteria: string } {
  if (task === "checks") {
    const failures = input.failures.slice(0, maximumEntries);
    const budget = Math.floor(contextBudget / Math.max(1, failures.length));
    return {
      objective: [
        "Fix the failing checks on this pull request. The log of each failed check is below.",
        ...failures.map((failure) => checkSection(failure, budget)),
        "Find the cause of each failure in its log, fix it on the pull request branch and run the failed checks again. Start your summary with the cause of each failure, then say what you changed.",
      ].join("\n\n"),
      acceptanceCriteria:
        "Every failed check passes. The summary explains the cause of each failure and what changed.",
    };
  }
  const comments = input.comments.slice(0, maximumEntries * 3);
  const budget = Math.floor(contextBudget / Math.max(1, comments.length));
  return {
    objective: [
      "Address the review comments on this pull request.",
      ...comments.map((comment) => commentSection(comment, budget)),
      "Make the requested changes on the pull request branch and run the project checks. In your summary, say what you changed for each comment.",
    ].join("\n\n"),
    acceptanceCriteria:
      "Every review comment is addressed, the checks pass, and the summary says what changed for each comment.",
  };
}

function changeLine(change: ChangedFileStat): string {
  const path =
    change.previousPath && change.previousPath !== change.path
      ? `\`${change.previousPath}\` → \`${change.path}\``
      : `\`${change.path}\``;
  return change.binary
    ? `- ${path} (${change.status})`
    : `- ${path} +${change.additions} −${change.deletions}`;
}

export function pullRequestFixComment(input: {
  purpose: "fix" | "resolve";
  summary: string | null;
  changes: ChangedFileStat[];
  review: string;
  link: string;
}): string {
  const listed = input.changes.slice(0, maximumListedFiles);
  const hidden = input.changes.length - listed.length;
  return [
    `**Machdoch ${input.purpose === "resolve" ? "conflict resolution" : "fix"}:** ${input.summary?.trim() || "Pushed a change."}`,
    listed.length
      ? [
          "**Changed files**",
          ...listed.map(changeLine),
          ...(hidden > 0 ? [`- ${hidden} more`] : []),
        ].join("\n")
      : "",
    input.review,
    input.link,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 60_000);
}
