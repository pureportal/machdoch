import { z } from "zod";
import { cloudId, revision, type CloudIssue } from "./cloud-contract";
import {
  gitStatusEvents,
  pullRequestStages,
  type CheckRunState,
  type GitStatusEvent,
  type GitChecksState,
  type GitReviewDecision,
  type PullRequestStage,
  type PullRequestState,
} from "./git-automation";
import { gitProviders, type GitProvider } from "./git-providers";
import type { PullRequestStack } from "./pull-request-stacks";

export const maximumGitWebhookBytes = 1024 * 1024;

export const gitProviderSchema = z.enum(gitProviders);

export const gitApiUrlSchema = z
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
  }, "Use an HTTPS API address without credentials.");

const gitToken = z.string().trim().min(20).max(400);

export const gitConnectionInputSchema = z.strictObject({
  revision: z.number().int().min(0),
  apiUrl: gitApiUrlSchema,
  token: gitToken.optional(),
  automate: z.boolean(),
  oauthClientId: z.string().trim().min(1).max(200).nullable().optional(),
  oauthClientSecret: z.string().trim().min(1).max(500).optional(),
});
export type GitConnectionInput = z.infer<typeof gitConnectionInputSchema>;

export const gitAccountInputSchema = z.strictObject({
  revision: z.number().int().min(0),
  apiUrl: gitApiUrlSchema,
  token: gitToken,
});
export type GitAccountInput = z.infer<typeof gitAccountInputSchema>;

const repositorySegment = String.raw`(?!\.{1,2}(?:/|$))[A-Za-z0-9_.-]{1,100}`;

export const gitRepositoryNameSchema = z
  .string()
  .trim()
  .max(255)
  .regex(
    new RegExp(`^${repositorySegment}(?:/${repositorySegment}){1,20}$`, "u"),
    "Use owner/name.",
  );

export const gitRepositoryInputSchema = z.strictObject({
  fullName: gitRepositoryNameSchema,
});

export const gitMergeMethods = ["merge", "squash", "rebase"] as const;
export type GitMergeMethod = (typeof gitMergeMethods)[number];
export const gitMergeInputSchema = z.strictObject({
  method: z.enum(gitMergeMethods),
  headSha: z.string().regex(/^[0-9a-f]{40}$/u),
});
export type GitMergeInput = z.infer<typeof gitMergeInputSchema>;

export const gitReviewDecisionInputs = [
  "approve",
  "request_changes",
  "comment",
] as const;
export type GitReviewInput = (typeof gitReviewDecisionInputs)[number];

export const gitCommentInputSchema = z.strictObject({
  body: z.string().trim().min(1).max(20_000),
});

export const gitReviewInputSchema = z.strictObject({
  decision: z.enum(gitReviewDecisionInputs),
  body: z.string().trim().max(20_000).default(""),
});

export const gitRetargetInputSchema = z.strictObject({
  baseRef: z.string().trim().min(1).max(255),
});

export interface GitRepository {
  id: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  webhook: boolean;
  syncedAt: string | null;
}

export interface GitConnection {
  provider: GitProvider;
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
  oauthClientId: string | null;
  oauthCallbackUrl: string;
  repositories: GitRepository[];
}

export interface GitTeamStatusRules {
  team: { id: string; key: string; name: string };
  statuses: { id: string; name: string; category: string }[];
  rules: Record<GitStatusEvent, string | null>;
}

export interface GitAdministration {
  connections: Partial<Record<GitProvider, GitConnection>>;
  automations: GitTeamStatusRules[];
  credentialStorageAvailable: boolean;
}

export interface GitAccount {
  provider: GitProvider;
  apiUrl: string;
  login: string;
  tokenPrefix: string;
  revision: number;
  connectedAt: string;
  lastUsedAt: string | null;
  lastError: string | null;
}

export interface GitAccounts {
  accounts: Partial<Record<GitProvider, GitAccount>>;
  connections: Partial<Record<GitProvider, { apiUrl: string; oauth: boolean }>>;
  credentialStorageAvailable: boolean;
}

export const gitStatusRuleInputSchema = z.strictObject({
  teamId: cloudId,
  event: z.enum(gitStatusEvents),
  statusId: cloudId.nullable(),
});
export type GitStatusRuleInput = z.infer<typeof gitStatusRuleInputSchema>;

export interface GitRepositoryOption {
  id: string;
  provider: GitProvider;
  fullName: string;
}

export interface GitAvailableRepository {
  fullName: string;
  private: boolean;
}

export interface CloudPullRequest {
  id: string;
  provider: GitProvider;
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
  defaultBranch: string;
  mergeableState: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  checks: GitChecksState | null;
  review: GitReviewDecision | null;
  stage: PullRequestStage;
  closes: boolean;
  mergedAt: string | null;
  updatedAt: string;
  stack: PullRequestStack | null;
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

export interface GitCheckRun {
  name: string;
  state: CheckRunState;
  url: string | null;
}

export interface GitPullRequestFile {
  filename: string;
  previousFilename: string | null;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export const gitUpdateBranchInputSchema = z.strictObject({
  headSha: z.string().regex(/^[0-9a-f]{40}$/u),
});

export interface GitReviewComment {
  id: number;
  author: string;
  body: string;
  path: string;
  line: number | null;
  diffHunk: string;
  url: string;
  createdAt: string;
}

export interface GitReview {
  author: string;
  state: string;
  submittedAt: string | null;
}

export interface CloudPullRequestDetails {
  pullRequest: CloudPullRequest;
  mergeable: boolean | null;
  checks: {
    conclusion: GitChecksState;
    runs: GitCheckRun[];
  };
  reviews: GitReview[];
  comments: GitReviewComment[];
  issues: CloudLinkedIssue[];
  canMerge: boolean;
  actingAs: string;
  mergeMethods: GitMergeMethod[];
}

export const gitRevisionSchema = z.strictObject({ revision });
