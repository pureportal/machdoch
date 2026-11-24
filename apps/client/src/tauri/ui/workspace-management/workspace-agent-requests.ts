const ASK_AGENT_EVENT = "machdoch:workspace-ask-agent";
const MAX_EXCERPT_CHARS = 12_000;

export interface WorkspaceAgentRequest {
  workspaceRoot: string;
  prompt: string;
}

export const askWorkspaceAgent = (request: WorkspaceAgentRequest): void => {
  window.dispatchEvent(
    new CustomEvent<WorkspaceAgentRequest>(ASK_AGENT_EVENT, {
      detail: request,
    }),
  );
};

export const onWorkspaceAgentRequest = (
  listener: (request: WorkspaceAgentRequest) => void,
): (() => void) => {
  const handle = (event: Event): void => {
    if (event instanceof CustomEvent)
      listener(event.detail as WorkspaceAgentRequest);
  };
  window.addEventListener(ASK_AGENT_EVENT, handle);
  return () => window.removeEventListener(ASK_AGENT_EVENT, handle);
};

const excerpt = (text: string): string =>
  text.length > MAX_EXCERPT_CHARS
    ? `${text.slice(0, MAX_EXCERPT_CHARS)}\n… (${text.length - MAX_EXCERPT_CHARS} more characters)`
    : text;

const fenced = (language: string, text: string): string =>
  `\`\`\`${language}\n${excerpt(text).replace(/```/gu, "` ` `")}\n\`\`\``;

export const diffReviewPrompt = (
  repository: string,
  path: string,
  patch: string,
): string =>
  [
    `Review this change to \`${path}\` in \`${repository}\`. Point out bugs and suggest fixes.`,
    fenced("diff", patch),
  ].join("\n\n");

export const conflictResolutionPrompt = (
  repository: string,
  path: string,
  conflicted: string,
): string =>
  [
    `Resolve the merge conflict in \`${path}\` in \`${repository}\`.`,
    "Keep the intent of both sides, remove every conflict marker and save the file. Do not stage it or continue the operation; I will review the result first.",
    fenced("text", conflicted),
  ].join("\n\n");

export const failedGitActionPrompt = (
  repository: string,
  action: string,
  error: string,
): string =>
  [
    `\`git ${action}\` failed in \`${repository}\`. Find the cause and fix it, then tell me what you changed.`,
    fenced("text", error),
  ].join("\n\n");

export interface FailedCheck {
  name: string;
  url?: string | null;
}

export const failedChecksPrompt = (
  repository: string,
  pullRequest: { number: number; title: string; headBranch: string },
  checks: readonly FailedCheck[],
): string =>
  [
    `These checks failed on pull request #${pullRequest.number} "${pullRequest.title}" (branch \`${pullRequest.headBranch}\`) in \`${repository}\`. Find the cause and fix it.`,
    checks
      .map((check) => `- ${check.name}${check.url ? ` (${check.url})` : ""}`)
      .join("\n"),
  ].join("\n\n");
