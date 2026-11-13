import { z } from "zod";
import type { CloudPullRequest } from "../../../lib/cloud-git-contract";
import { gitReviewDecisionInputs } from "../../../lib/cloud-git-contract";
import { pullRequestStages } from "../../../lib/git-automation";
import { gitProviderLabels } from "../../../lib/git-providers";
import { agentTool, type AgentTool } from "./agent-tool";
import { field, markdownField, pendingOutput } from "./agent-proposal-helpers";
import type { CloudAgentSession } from "./agent-tools";
import { AgentLookupError } from "./agent-workspace";

const maximumPatchCharacters = 4_000;
const maximumFilesCharacters = 40_000;

const pullRequestReference = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .describe("Pull request ID, or repository#number such as acme/app#12.");

async function resolvePullRequest(
  session: CloudAgentSession,
  reference: string,
): Promise<CloudPullRequest> {
  const { actor, services } = session;
  if (z.uuid().safeParse(reference).success)
    return services.pullRequests.get(actor, reference);
  const match = /^(.+)#(\d+)$/u.exec(reference);
  if (!match)
    throw new AgentLookupError(
      "Use a pull request ID or repository#number such as acme/app#12.",
    );
  const repository = match[1]!.toLowerCase();
  const number = Number(match[2]);
  const found = (
    await services.pullRequests.list(actor, undefined)
  ).pullRequests.find(
    (entry) =>
      entry.pullRequest.repository.toLowerCase() === repository &&
      entry.pullRequest.number === number,
  );
  if (!found)
    throw new AgentLookupError(
      `${reference} is unavailable. Call list_pull_requests to see open and recent pull requests.`,
    );
  return found.pullRequest;
}

function summary(pullRequest: CloudPullRequest) {
  return {
    id: pullRequest.id,
    reference: `${pullRequest.repository}#${pullRequest.number}`,
    provider: gitProviderLabels[pullRequest.provider],
    title: pullRequest.title,
    url: pullRequest.url,
    state: pullRequest.state,
    stage: pullRequest.stage,
    draft: pullRequest.draft,
    author: pullRequest.author,
    branch: pullRequest.headRef,
    base: pullRequest.baseRef,
    defaultBranch: pullRequest.defaultBranch,
    headSha: pullRequest.headSha,
    checks: pullRequest.checks,
    review: pullRequest.review,
    stack: pullRequest.stack && {
      basedOn: pullRequest.stack.parent && {
        number: pullRequest.stack.parent.number,
        state: pullRequest.stack.parent.state,
      },
      stackedOnTop: pullRequest.stack.children.map((child) => child.number),
      depth: pullRequest.stack.depth,
      retargetTo: pullRequest.stack.retargetTo,
    },
  };
}

function reference(pullRequest: CloudPullRequest): string {
  return `${pullRequest.repository}#${pullRequest.number}`;
}

export const gitTools: AgentTool[] = [
  agentTool({
    name: "list_pull_requests",
    description:
      "List open and recently closed GitHub pull requests and GitLab merge requests of connected repositories, with their stage, checks, review decision, branches and stack. Optionally filter by stage.",
    schema: z.strictObject({ stage: z.enum(pullRequestStages).optional() }),
    async run(session, input) {
      const list = await session.services.pullRequests.list(
        session.actor,
        input.stage,
      );
      return {
        output: {
          pullRequests: list.pullRequests.slice(0, 100).map((entry) => ({
            ...summary(entry.pullRequest),
            issues: entry.issues.map((issue) => issue.identifier),
          })),
        },
        label: `Found ${list.pullRequests.length} pull request${list.pullRequests.length === 1 ? "" : "s"}`,
      };
    },
  }),
  agentTool({
    name: "read_pull_request",
    description:
      "Read a pull request with its mergeability, check runs, reviews, review comments, stack, linked issues and changed files with patches.",
    schema: z.strictObject({ pullRequest: pullRequestReference }),
    async run(session, input) {
      const { actor, services } = session;
      const pullRequest = await resolvePullRequest(session, input.pullRequest);
      const [details, files] = await Promise.all([
        services.pullRequests.details(actor, pullRequest.id),
        services.pullRequests.files(actor, pullRequest.id),
      ]);
      let budget = maximumFilesCharacters;
      return {
        output: {
          ...summary(details.pullRequest),
          mergeable: details.mergeable,
          checks: details.checks,
          reviews: details.reviews,
          comments: details.comments.map((comment) => ({
            author: comment.author,
            path: comment.path,
            line: comment.line,
            body: comment.body,
          })),
          issues: details.issues.map((issue) => issue.identifier),
          files: files.map((file) => {
            const patch = file.patch?.slice(0, maximumPatchCharacters) ?? null;
            const shown = patch && patch.length <= budget ? patch : null;
            if (shown) budget -= shown.length;
            return {
              filename: file.filename,
              status: file.status,
              additions: file.additions,
              deletions: file.deletions,
              patch: shown,
            };
          }),
        },
        label: `Read ${reference(details.pullRequest)}`,
      };
    },
  }),
  agentTool({
    name: "propose_pull_request_comment",
    description:
      "Propose a comment on an open pull request. It is posted with the user's connected account when they have one, otherwise with the organization connection. Nothing is posted until the user confirms.",
    schema: z.strictObject({
      pullRequest: pullRequestReference,
      body: z.string().trim().min(1).max(20_000),
    }),
    async run(session, input) {
      const pullRequest = await resolvePullRequest(session, input.pullRequest);
      return {
        output: pendingOutput,
        label: `Proposed a comment on ${reference(pullRequest)}`,
        proposal: {
          kind: "pull_request_comment",
          title: `Comment on ${reference(pullRequest)}`,
          fields: [
            { label: "Pull request", value: pullRequest.title },
            ...markdownField("Comment", input.body),
          ],
          pullRequestId: pullRequest.id,
          reference: reference(pullRequest),
          body: input.body,
        },
      };
    },
  }),
  agentTool({
    name: "propose_pull_request_review",
    description:
      "Propose a review on an open pull request: approve, request_changes or comment. A message is required unless approving. Read it with read_pull_request first. Nothing is submitted until the user confirms.",
    schema: z.strictObject({
      pullRequest: pullRequestReference,
      decision: z.enum(gitReviewDecisionInputs),
      body: z.string().trim().max(20_000).default(""),
    }),
    async run(session, input) {
      if (input.decision !== "approve" && !input.body)
        throw new AgentLookupError("Write a message for this review.");
      const pullRequest = await resolvePullRequest(session, input.pullRequest);
      return {
        output: pendingOutput,
        label: `Proposed a review of ${reference(pullRequest)}`,
        proposal: {
          kind: "pull_request_review",
          title: `Review ${reference(pullRequest)}`,
          fields: [
            { label: "Pull request", value: pullRequest.title },
            ...field(
              "Decision",
              input.decision === "request_changes"
                ? "Request changes"
                : input.decision === "approve"
                  ? "Approve"
                  : "Comment",
            ),
            ...markdownField("Message", input.body),
          ],
          pullRequestId: pullRequest.id,
          reference: reference(pullRequest),
          decision: input.decision,
          body: input.body,
        },
      };
    },
  }),
];
