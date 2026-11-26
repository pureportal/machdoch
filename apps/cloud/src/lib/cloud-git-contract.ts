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
  connectionId: cloudId.optional(),
  revision: z.number().int().min(0),
  apiUrl: gitApiUrlSchema,
  token: gitToken.optional(),
  automate: z.boolean(),
  codeAccess: z.boolean(),
  oauthClientId: z.string().trim().min(1).max(200).nullable().optional(),
  oauthClientSecret: z.string().trim().min(1).max(500).optional(),
});
export type GitConnectionInput = z.infer<typeof gitConnectionInputSchema>;

export const gitHubAppSetupInputSchema = z.strictObject({
  apiUrl: gitApiUrlSchema,
  owner: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u, "Enter a GitHub login.")
    .nullable(),
});
export type GitHubAppSetupInput = z.infer<typeof gitHubAppSetupInputSchema>;

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

export const gitAutoMergeInputSchema = z.strictObject({
  enabled: z.boolean(),
  method: z.enum(gitMergeMethods),
});
export type GitAutoMergeInput = z.infer<typeof gitAutoMergeInputSchema>;

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
  teamId: string | null;
  issueSync: boolean;
}

export interface GitConnection {
  id: string;
  provider: GitProvider;
  apiUrl: string;
  account: string;
  tokenPrefix: string;
  automate: boolean;
  codeAccess: boolean;
  revision: number;
  enabledBy: string | null;
  connectedAt: string;
  syncedAt: string | null;
  lastDeliveryAt: string | null;
  lastError: string | null;
  webhookUrl: string;
  webhookSecret: string;
  oauthClientId: string | null;
  oauthCallbackUrl: string;
  app: { slug: string; configureUrl: string } | null;
  repositories: GitRepository[];
}

export interface GitTeamStatusRules {
  team: { id: string; key: string; name: string };
  statuses: { id: string; name: string; category: string }[];
  rules: Record<GitStatusEvent, string | null>;
}

export interface GitReviewSettings {
  reviewGuides: boolean;
  mergeIssues: boolean;
  commitLinks: boolean;
  backlinksPrivate: boolean;
  backlinksPublic: boolean;
  backlinkDescriptions: boolean;
  revision: number;
}

export const gitReviewSettingsInputSchema = z.strictObject({
  reviewGuides: z.boolean(),
  mergeIssues: z.boolean(),
  commitLinks: z.boolean(),
  backlinksPrivate: z.boolean(),
  backlinksPublic: z.boolean(),
  backlinkDescriptions: z.boolean(),
  revision: z.number().int().min(0),
});
export type GitReviewSettingsInput = z.infer<
  typeof gitReviewSettingsInputSchema
>;

export const gitRepositorySettingsInputSchema = z.strictObject({
  teamId: cloudId.nullable(),
  issueSync: z.boolean(),
});
export type GitRepositorySettingsInput = z.infer<
  typeof gitRepositorySettingsInputSchema
>;

export interface GitAdministration {
  connections: GitConnection[];
  automations: GitTeamStatusRules[];
  settings: GitReviewSettings;
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
  repositoryId: string;
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
  requestedReviewers: string[];
  stack: PullRequestStack | null;
}

export interface CloudLinkedIssue {
  id: string;
  identifier: string;
  title: string;
  statusName: string;
  state: CloudIssue["state"];
  closes: boolean;
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

export interface CloudReviewInbox {
  accounts: { provider: GitProvider; login: string }[];
  pullRequests: CloudPullRequestListing[];
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

export interface GitConversationEntry {
  id: string;
  kind: "comment" | "review";
  author: string;
  body: string;
  state: string | null;
  url: string | null;
  createdAt: string;
}

export interface GitCommit {
  sha: string;
  message: string;
  author: string;
  url: string | null;
  committedAt: string | null;
}

export interface GitIssueCommit {
  sha: string;
  repository: string;
  message: string;
  author: string;
  url: string | null;
  closes: boolean;
  linkedAt: string;
}

export interface CloudIssueGitActivity {
  pullRequests: CloudPullRequest[];
  commits: GitIssueCommit[];
}

export interface CloudPullRequestDetails {
  pullRequest: CloudPullRequest;
  body: string;
  mergeable: boolean | null;
  checks: {
    conclusion: GitChecksState;
    runs: GitCheckRun[];
  };
  reviews: GitReview[];
  comments: GitReviewComment[];
  conversation: GitConversationEntry[];
  commits: GitCommit[];
  issues: CloudLinkedIssue[];
  issueSuggestion: boolean;
  canMerge: boolean;
  fixable: boolean;
  autoMerge: boolean;
  actingAs: string | null;
  agentLogin: string;
  mergeMethods: GitMergeMethod[];
}

export const gitRevisionSchema = z.strictObject({ revision });

export const gitReviewGuideInputSchema = z.strictObject({
  providerId: cloudId,
  model: z.string().trim().min(1).max(200),
});
export type GitReviewGuideInput = z.infer<typeof gitReviewGuideInputSchema>;

export interface GitReviewGuideSection {
  title: string;
  purpose: string;
  impact: string;
  files: string[];
}

export interface GitReviewGuide {
  id: string;
  headSha: string;
  state: "waiting" | "ready" | "failed";
  error: string | null;
  sections: GitReviewGuideSection[];
  createdAt: string;
}

export interface GitReviewGuideState {
  enabled: boolean;
  guide: GitReviewGuide | null;
}
