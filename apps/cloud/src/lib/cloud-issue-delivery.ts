import type { PullRequestStage } from "./git-automation";

export type DeliveryTaskPurpose = "implement" | "check" | "fix" | "resolve";
export type DeliveryReviewDecision =
  | "approved"
  | "changes_requested"
  | "commented";

export interface DeliveryPullRequest {
  id: string;
  repository: string;
  number: number;
  title: string;
  stage: PullRequestStage;
  url: string;
}

export type DeliveryEntry = {
  id: string;
  at: string;
  pullRequestId: string | null;
} & (
  | {
      kind: "task";
      runId: string;
      title: string;
      purpose: DeliveryTaskPurpose;
      state: string;
    }
  | { kind: "opened" | "merged" | "closed" }
  | {
      kind: "review";
      author: string;
      decision: DeliveryReviewDecision;
      body: string;
      url: string | null;
      automated: boolean;
    }
  | {
      kind: "comment";
      author: string;
      body: string;
      url: string | null;
      automated: boolean;
    }
  | {
      kind: "automation";
      automationId: string;
      name: string;
      state:
        | "queued"
        | "running"
        | "waiting"
        | "succeeded"
        | "failed"
        | "skipped";
      detail: string;
      link: string | null;
    }
);

export interface IssueDelivery {
  pullRequests: DeliveryPullRequest[];
  entries: DeliveryEntry[];
  unavailable: string[];
}
