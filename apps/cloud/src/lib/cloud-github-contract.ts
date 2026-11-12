import { z } from "zod";
import { cloudId, revision, type CloudIssue } from "./cloud-contract";
import {
  githubAutomationEvents,
  pullRequestStages,
  type CheckRunState,
  type GitHubAutomationEvent,
  type GitHubChecksState,
  type GitHubReviewDecision,
  type PullRequestStage,
  type PullRequestState,
} from "./github-automation";

export const maximumGitHubWebhookBytes = 1024 * 1024;

export const githubApiUrlSchema = z
  .url()
  .max(300)
  .transform((value) => value.replace(/\/+$/u, ""))
  .refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
    );
  }, "Use an HTTPS GitHub API address without credentials.");

export const githubConnectionInputSchema = z.strictObject({
  revision: z.number().int().min(0),
  apiUrl: githubApiUrlSchema,
  token: z.string().trim().min(20).max(400).optional(),
  automate: z.boolean(),
});
export type GitHubConnectionInput = z.infer<typeof githubConnectionInputSchema>;

export const githubRepositoryNameSchema = z
  .string()
  .trim()
  .regex(
    /^(?!\.{1,2}\/)[A-Za-z0-9_.-]{1,100}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/u,
    "Use owner/name.",
  );

export const githubRepositoryInputSchema = z.strictObject({
  fullName: githubRepositoryNameSchema,
});

export const githubMergeMethods = ["merge", "squash", "rebase"] as const;
export const githubMergeInputSchema = z.strictObject({
  method: z.enum(githubMergeMethods),
  headSha: z.string().regex(/^[0-9a-f]{40}$/u),
});
export type GitHubMergeInput = z.infer<typeof githubMergeInputSchema>;

export interface GitHubRepository {
  id: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  webhook: boolean;
  syncedAt: string | null;
}

export interface GitHubConnection {
  apiUrl: string;
  account: string;
  tokenPrefix: string;
  automate: boolean;
  revision: number;
  connectedAt: string;
  syncedAt: string | null;
  lastError: string | null;
  webhookUrl: string;
  webhookSecret: string;
  repositories: GitHubRepository[];
}

export interface GitHubTeamAutomation {
  team: { id: string; key: string; name: string };
  statuses: { id: string; name: string; category: string }[];
  rules: Record<GitHubAutomationEvent, string | null>;
}

export interface GitHubAdministration {
  connection: GitHubConnection | null;
  automations: GitHubTeamAutomation[];
  credentialStorageAvailable: boolean;
}

export const githubAutomationInputSchema = z.strictObject({
  teamId: cloudId,
  event: z.enum(githubAutomationEvents),
  statusId: cloudId.nullable(),
});
export type GitHubAutomationInput = z.infer<typeof githubAutomationInputSchema>;

export interface GitHubAvailableRepository {
  fullName: string;
  private: boolean;
}

export interface CloudPullRequest {
  id: string;
  repository: string;
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
  draft: boolean;
  author: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  mergeableState: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  checks: GitHubChecksState | null;
  review: GitHubReviewDecision | null;
  stage: PullRequestStage;
  closes: boolean;
  mergedAt: string | null;
  updatedAt: string;
}

export interface CloudLinkedIssue {
  id: string;
  identifier: string;
  title: string;
  statusName: string;
  state: CloudIssue["state"];
}

export interface CloudPullRequestListing {
  pullRequest: CloudPullRequest;
  issues: CloudLinkedIssue[];
}

export interface CloudPullRequestList {
  connected: boolean;
  pullRequests: CloudPullRequestListing[];
  counts: Record<PullRequestStage, number>;
}

export const pullRequestListQuerySchema = z.strictObject({
  stage: z.enum(pullRequestStages).optional(),
});

export interface GitHubCheckRun {
  name: string;
  state: CheckRunState;
  url: string | null;
}

export interface GitHubPullRequestFile {
  filename: string;
  previousFilename: string | null;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export const githubUpdateBranchInputSchema = z.strictObject({
  headSha: z.string().regex(/^[0-9a-f]{40}$/u),
});

export interface GitHubReviewComment {
  id: number;
  author: string;
  body: string;
  path: string;
  line: number | null;
  diffHunk: string;
  url: string;
  createdAt: string;
}

export interface GitHubReview {
  author: string;
  state: string;
  submittedAt: string | null;
}

export interface CloudPullRequestDetails {
  pullRequest: CloudPullRequest;
  mergeable: boolean | null;
  checks: {
    conclusion: GitHubChecksState;
    runs: GitHubCheckRun[];
  };
  reviews: GitHubReview[];
  comments: GitHubReviewComment[];
  issues: CloudLinkedIssue[];
  canMerge: boolean;
}

export const githubRevisionSchema = z.strictObject({ revision });
