export type GitErrorFixAction =
  | "set-upstream"
  | "pull-rebase"
  | "remove-index-lock";

export interface GitErrorFix {
  action: GitErrorFixAction;
  label: string;
  confirm?: string;
}

export interface ExplainedGitError {
  cause: string;
  fix?: GitErrorFix;
}

const RULES: { pattern: RegExp; explanation: ExplainedGitError }[] = [
  {
    pattern:
      /index\.lock'?:? File exists|Another git process seems to be running|Unable to create '.*\.lock'/iu,
    explanation: {
      cause: "Another Git process holds the repository lock.",
      fix: {
        action: "remove-index-lock",
        label: "Remove lock",
        confirm:
          "Remove the index.lock file? Only do this when no other Git program is running.",
      },
    },
  },
  {
    pattern:
      /Authentication failed|could not read Username|could not read Password|terminal prompts disabled|Permission denied \(publickey|returned error: 40[13]|Repository not found/iu,
    explanation: {
      cause:
        "The remote rejected the credentials. Sign in through Git's credential manager or check your SSH key, then try again.",
    },
  },
  {
    pattern:
      /has no upstream branch|no tracking information for the current branch|No upstream branch/iu,
    explanation: {
      cause: "This branch has no upstream branch.",
      fix: { action: "set-upstream", label: "Set upstream" },
    },
  },
  {
    pattern:
      /\(non-fast-forward\)|\(fetch first\)|Updates were rejected because|have diverged|Not possible to fast-forward|Need to specify how to reconcile divergent branches/iu,
    explanation: {
      cause: "The branch and its upstream have both moved on.",
      fix: { action: "pull-rebase", label: "Pull with rebase" },
    },
  },
];

export const explainGitError = (text: string): ExplainedGitError | null =>
  RULES.find((rule) => rule.pattern.test(text))?.explanation ?? null;
