"use client";

import { Select } from "@/components/ui/select";
import {
  gitIdentities,
  type AutomationAction,
  type GitIdentity,
} from "@/lib/cloud-automation-contract";
import {
  gitMergeMethods,
  gitReviewDecisionInputs,
  type GitMergeMethod,
  type GitReviewInput,
} from "@/lib/cloud-git-contract";
import { TemplateText } from "./automation-template-text";

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

const identityLabels: Record<GitIdentity, string> = {
  owner: "As me",
  organization: "As the organization connection",
};

const decisionLabels: Record<GitReviewInput, string> = {
  approve: "Approve",
  request_changes: "Request changes",
  comment: "Comment",
};

const mergeLabels: Record<GitMergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Merge commit",
  rebase: "Rebase and merge",
};

export function isGitAction(action: AutomationAction): action is GitAction {
  return action.kind.startsWith("git_");
}

export function GitActionFields({
  action,
  variables,
  onChange,
}: {
  action: GitAction;
  variables: string[];
  onChange: (action: GitAction) => void;
}) {
  return (
    <>
      {action.kind === "git_review" && (
        <Select
          aria-label="Decision"
          value={action.decision}
          onChange={(event) =>
            onChange({
              ...action,
              decision: event.target.value as GitReviewInput,
            })
          }
        >
          {gitReviewDecisionInputs.map((decision) => (
            <option key={decision} value={decision}>
              {decisionLabels[decision]}
            </option>
          ))}
        </Select>
      )}
      {action.kind === "git_merge" && (
        <Select
          aria-label="Merge method"
          value={action.method}
          onChange={(event) =>
            onChange({
              ...action,
              method: event.target.value as GitMergeMethod,
            })
          }
        >
          {gitMergeMethods.map((method) => (
            <option key={method} value={method}>
              {mergeLabels[method]}
            </option>
          ))}
        </Select>
      )}
      {(action.kind === "git_comment" || action.kind === "git_review") && (
        <TemplateText
          label={action.kind === "git_comment" ? "Comment" : "Message"}
          value={action.body}
          variables={variables}
          maxLength={20_000}
          onChange={(body) => onChange({ ...action, body })}
        />
      )}
      <Select
        aria-label="Act as"
        value={action.identity}
        onChange={(event) =>
          onChange({
            ...action,
            identity: event.target.value as GitIdentity,
          })
        }
      >
        {gitIdentities.map((identity) => (
          <option key={identity} value={identity}>
            {identityLabels[identity]}
          </option>
        ))}
      </Select>
    </>
  );
}
