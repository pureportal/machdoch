import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  AutomationAction,
  AutomationStep,
  GitIdentity,
} from "../../../lib/cloud-automation-contract";
import {
  renderAutomationText,
  type AutomationVariables,
} from "../../../lib/automation-text";
import { automationMarker } from "../../../lib/git-events";
import { CloudError } from "../access";
import type { CloudGitPullRequests } from "../git/pull-requests";
import type { ActingMode } from "../git/identity";

export type GitAction = Extract<
  AutomationAction,
  {
    kind:
      | "git_comment"
      | "git_review"
      | "git_merge"
      | "git_update_branch"
      | "git_retarget";
  }
>;

type GitStepOutcome = Omit<AutomationStep, "kind">;

const reviewDone = {
  approve: "Approved",
  request_changes: "Requested changes",
  comment: "Reviewed",
} as const;

function actingMode(identity: GitIdentity): ActingMode {
  return identity === "owner" ? "personal" : "organization";
}

function eventPullRequest(variables: AutomationVariables): {
  id: string;
  headSha: string | null;
} {
  const pullRequest = variables.pullRequest as
    | { id?: unknown; headSha?: unknown }
    | null
    | undefined;
  if (typeof pullRequest?.id !== "string")
    throw new CloudError(
      422,
      "pull_request_required",
      "This action needs a pull request.",
    );
  return {
    id: pullRequest.id,
    headSha:
      typeof pullRequest.headSha === "string" ? pullRequest.headSha : null,
  };
}

function marked(text: string): string {
  return `${text}\n\n${automationMarker}`;
}

export async function executeGitAction(
  pullRequests: CloudGitPullRequests,
  owner: CloudActor,
  action: GitAction,
  variables: AutomationVariables,
): Promise<GitStepOutcome> {
  const target = eventPullRequest(variables);
  const mode = actingMode(action.identity);
  const current = await pullRequests.get(owner, target.id);
  if (current.state !== "open")
    return {
      state: "skipped",
      detail: "The pull request is no longer open.",
      link: current.url,
    };
  switch (action.kind) {
    case "git_comment": {
      const body = renderAutomationText(action.body, variables, 19_900).trim();
      if (!body)
        return {
          state: "skipped",
          detail: "The comment is empty.",
          link: null,
        };
      const result = await pullRequests.comment(
        owner,
        target.id,
        marked(body),
        mode,
      );
      return {
        state: "succeeded",
        detail: `Commented as ${result.actingAs}`,
        link: result.url,
      };
    }
    case "git_review": {
      const body = renderAutomationText(action.body, variables, 19_900).trim();
      if (action.decision !== "approve" && !body)
        return {
          state: "skipped",
          detail: "The review needs a message.",
          link: null,
        };
      const result = await pullRequests.review(
        owner,
        target.id,
        { decision: action.decision, body: body ? marked(body) : "" },
        mode,
      );
      return {
        state: "succeeded",
        detail: `${reviewDone[action.decision]} as ${result.actingAs}`,
        link: current.url,
      };
    }
    case "git_merge": {
      const headSha = target.headSha ?? current.headSha;
      if (headSha !== current.headSha)
        return {
          state: "skipped",
          detail: "New commits arrived after the trigger. Nothing was merged.",
          link: current.url,
        };
      const merged = await pullRequests.merge(
        owner,
        target.id,
        { method: action.method, headSha },
        mode,
      );
      return {
        state: "succeeded",
        detail: `Merged into ${merged.baseRef}`,
        link: merged.url,
      };
    }
    case "git_update_branch":
      await pullRequests.updateBranch(owner, target.id, current.headSha, mode);
      return {
        state: "succeeded",
        detail: `Updating ${current.headRef} with ${current.baseRef}`,
        link: current.url,
      };
    case "git_retarget": {
      const baseRef = current.stack?.retargetTo;
      if (!baseRef)
        return {
          state: "skipped",
          detail: "The pull request is not stacked on a merged pull request.",
          link: current.url,
        };
      const retargeted = await pullRequests.retarget(
        owner,
        target.id,
        baseRef,
        mode,
      );
      return {
        state: "succeeded",
        detail: `Retargeted onto ${retargeted.baseRef}`,
        link: retargeted.url,
      };
    }
  }
}
