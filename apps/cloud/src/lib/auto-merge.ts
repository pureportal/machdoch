import type { GitCheckRun, GitReview } from "./cloud-git-contract";

export interface GitMergePolicy {
  requiredChecks: string[];
  requiredApprovals: number;
  codeOwnerReviews: boolean;
  mergeQueue: boolean;
}

export interface CodeOwnerRule {
  pattern: RegExp;
  owners: string[];
}

export const codeOwnersPaths = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
] as const;

function patternExpression(pattern: string): RegExp {
  const anchored = pattern.startsWith("/") || /\/./u.test(pattern);
  const directory = pattern.endsWith("/");
  const trimmed = pattern.replace(/^\//u, "").replace(/\/$/u, "");
  const body = trimmed
    .split(/(\*\*\/|\/\*\*|\*\*|\*|\?)/u)
    .map((part) => {
      if (part === "**/") return "(?:.*/)?";
      if (part === "/**") return "/.*";
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      if (part === "?") return "[^/]";
      return part.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    })
    .join("");
  const contents = directory || !trimmed.endsWith("/*") ? "(?:/.*)?" : "";
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${body}${contents}$`, "u");
}

export function parseCodeOwners(text: string): CodeOwnerRule[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.replace(/(^|\s)#.*$/u, "").trim())
    .filter(Boolean)
    .map((line) => {
      const [pattern, ...owners] = line.split(/\s+/u);
      return { pattern: patternExpression(pattern!), owners };
    });
}

export function codeOwners(
  rules: readonly CodeOwnerRule[],
  path: string,
): string[] {
  return rules.findLast((rule) => rule.pattern.test(path))?.owners ?? [];
}

export type AutoMergeDecision =
  | { action: "merge" | "enqueue" }
  | { action: "wait" | "block"; reason: string };

export interface AutoMergeInput {
  policy: GitMergePolicy;
  runs: readonly GitCheckRun[];
  reviews: readonly GitReview[];
  files: readonly string[];
  codeOwners: readonly CodeOwnerRule[];
  teams: ReadonlyMap<string, readonly string[]>;
}

function checksDecision(
  policy: GitMergePolicy,
  runs: readonly GitCheckRun[],
): AutoMergeDecision | null {
  const required = policy.requiredChecks.length
    ? policy.requiredChecks
    : [...new Set(runs.map((run) => run.name))];
  const states = required.map((name) => ({
    name,
    states: runs.filter((run) => run.name === name).map((run) => run.state),
  }));
  if (states.some((check) => check.states.includes("failure")))
    return {
      action: "block",
      reason: "Repository checks failed on the pull request.",
    };
  const missing = states.find((check) => !check.states.length);
  if (missing)
    return {
      action: "wait",
      reason: `Waiting for the required check ${missing.name}.`,
    };
  return states.some((check) => check.states.includes("pending"))
    ? { action: "wait", reason: "Waiting for repository checks." }
    : null;
}

function ownedBy(
  owner: string,
  login: string,
  teams: ReadonlyMap<string, readonly string[]>,
): boolean {
  const name = owner.replace(/^@/u, "").toLowerCase();
  const user = login.toLowerCase();
  if (!name.includes("/")) return name === user;
  return (
    [...teams]
      .find(([team]) => team.toLowerCase() === name)?.[1]
      .some((member) => member.toLowerCase() === user) ?? false
  );
}

function reviewsDecision(input: AutoMergeInput): AutoMergeDecision | null {
  const { policy, reviews } = input;
  if (!policy.codeOwnerReviews && policy.requiredApprovals === 0) return null;
  const changes = reviews.find(
    (review) => review.state === "CHANGES_REQUESTED",
  );
  if (changes)
    return { action: "block", reason: `${changes.author} requested changes.` };
  const approvers = reviews
    .filter((review) => review.state === "APPROVED")
    .map((review) => review.author);
  const missingApprovals = policy.requiredApprovals - approvers.length;
  if (missingApprovals > 0)
    return {
      action: "wait",
      reason: `Waiting for ${missingApprovals} more ${missingApprovals === 1 ? "approval" : "approvals"}.`,
    };
  if (!policy.codeOwnerReviews) return null;
  const missingOwners = new Set(
    input.files.flatMap((file) => {
      const owners = codeOwners(input.codeOwners, file);
      return owners.some((owner) =>
        approvers.some((login) => ownedBy(owner, login, input.teams)),
      )
        ? []
        : owners;
    }),
  );
  return missingOwners.size
    ? {
        action: "wait",
        reason: `Waiting for a code owner review from ${[...missingOwners].join(", ")}.`,
      }
    : null;
}

export function autoMergeDecision(input: AutoMergeInput): AutoMergeDecision {
  return (
    checksDecision(input.policy, input.runs) ??
    reviewsDecision(input) ?? {
      action: input.policy.mergeQueue ? "enqueue" : "merge",
    }
  );
}

export function codeOwnerTeams(
  rules: readonly CodeOwnerRule[],
  files: readonly string[],
): string[] {
  return [
    ...new Set(
      files
        .flatMap((file) => codeOwners(rules, file))
        .filter((owner) => owner.startsWith("@") && owner.includes("/"))
        .map((owner) => owner.slice(1)),
    ),
  ];
}
