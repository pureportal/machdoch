import type {
  GitAvailableRepository,
  GitCheckRun,
  GitCommit,
  GitConversationEntry,
  GitMergeInput,
  GitMergeMethod,
  GitPullRequestFile,
  GitReview,
  GitReviewComment,
  GitReviewInput,
} from "../../../lib/cloud-git-contract";
import type {
  GitChecksState,
  PullRequestState,
} from "../../../lib/git-automation";
import type { GitProvider } from "../../../lib/git-providers";
import { GitHubClient } from "./github-client";
import { GitLabClient } from "./gitlab-client";

export interface GitAccess {
  provider: GitProvider;
  apiUrl: string;
  token: string;
}

export interface GitRepositoryRecord {
  externalId: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  webUrl: string;
}

export interface GitPullRequestRecord {
  number: number;
  title: string;
  body: string;
  url: string;
  state: PullRequestState;
  draft: boolean;
  author: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  mergeable: boolean | null;
  mergeableState: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  updatedAt: string;
  mergedAt: string | null;
  requestedReviewers: string[] | null;
}

export interface GitChecks {
  conclusion: GitChecksState;
  runs: GitCheckRun[];
}

export interface GitWebhookTarget {
  url: string;
  secret: string;
}

export interface GitClient {
  readonly mergeMethods: readonly GitMergeMethod[];
  viewer(): Promise<string>;
  repositories(): Promise<GitAvailableRepository[]>;
  repository(fullName: string): Promise<GitRepositoryRecord>;
  pullRequests(fullName: string): Promise<GitPullRequestRecord[]>;
  pullRequest(fullName: string, number: number): Promise<GitPullRequestRecord>;
  checks(fullName: string, number: number, headSha: string): Promise<GitChecks>;
  reviews(fullName: string, number: number): Promise<GitReview[]>;
  files(fullName: string, number: number): Promise<GitPullRequestFile[]>;
  reviewComments(fullName: string, number: number): Promise<GitReviewComment[]>;
  conversation(
    fullName: string,
    number: number,
  ): Promise<GitConversationEntry[]>;
  commits(fullName: string, number: number): Promise<GitCommit[]>;
  merge(fullName: string, number: number, input: GitMergeInput): Promise<void>;
  updateBranch(
    fullName: string,
    number: number,
    headSha: string,
  ): Promise<void>;
  comment(fullName: string, number: number, body: string): Promise<string>;
  review(
    fullName: string,
    number: number,
    input: { decision: GitReviewInput; body: string; headSha: string },
  ): Promise<void>;
  retarget(fullName: string, number: number, baseRef: string): Promise<void>;
  createWebhook(fullName: string, target: GitWebhookTarget): Promise<number>;
  updateWebhook(
    fullName: string,
    id: number,
    target: GitWebhookTarget,
  ): Promise<void>;
  deleteWebhook(fullName: string, id: number): Promise<void>;
}

export const maximumPatchCharacters = 40_000;

export function gitClient(
  access: GitAccess,
  transport: typeof fetch,
): GitClient {
  return access.provider === "github"
    ? new GitHubClient(access, transport)
    : new GitLabClient(access, transport);
}
