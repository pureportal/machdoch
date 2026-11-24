import { z } from "zod";
import type { GitIssueFields, GitIssueUpdate } from "./git-client";
import {
  issueFields,
  issueLabelNames,
  parsedWebhook,
  pushActivities,
  tagDeployment,
  zeroSha,
  type ParsedWebhook,
} from "./webhook-payloads";

const project = z.object({ id: z.number(), web_url: z.string().optional() });
const user = z.object({ username: z.string() }).nullable().optional();

const pushSchema = z.object({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  user_username: z.string().nullable().optional(),
  project,
  commits: z
    .array(
      z.object({
        id: z.string(),
        message: z.string(),
        author: z.object({ name: z.string() }),
      }),
    )
    .default([]),
});

const mergeRequestSchema = z.object({
  user,
  project,
  object_attributes: z.object({
    iid: z.number(),
    action: z.string().optional(),
  }),
});

const noteSchema = z.object({
  user,
  project,
  object_attributes: z.object({
    id: z.number().optional(),
    note: z.string(),
    noteable_type: z.string(),
    url: z.string().optional(),
    position: z
      .object({ new_path: z.string().nullable().optional() })
      .nullable()
      .optional(),
  }),
  merge_request: z.object({ iid: z.number() }).optional(),
  issue: z.object({ iid: z.number() }).optional(),
});

const labelList = z.array(z.object({ title: z.string() })).default([]);
const userList = z.array(z.object({ username: z.string() })).default([]);

const issueSchema = z.object({
  user,
  project,
  object_attributes: z.object({
    iid: z.number(),
    title: z.string(),
    description: z.string().nullable().optional(),
    state: z.string(),
    action: z.string().optional(),
    url: z.string(),
  }),
  labels: labelList,
  assignees: userList,
  changes: z
    .object({
      title: z.unknown().optional(),
      description: z.unknown().optional(),
      labels: z.object({ previous: labelList, current: labelList }).optional(),
      assignees: z.object({ previous: userList, current: userList }).optional(),
    })
    .default({}),
});

function issueChanges(
  data: z.infer<typeof issueSchema>,
  current: GitIssueFields,
): GitIssueUpdate {
  const { action } = data.object_attributes;
  const { changes } = data;
  const names = (labels: z.infer<typeof labelList>) =>
    issueLabelNames(labels.map((label) => label.title));
  const previous = names(changes.labels?.previous ?? []);
  const next = names(changes.labels?.current ?? []);
  const has = (list: string[], name: string) =>
    list.some((entry) => entry.toLowerCase() === name.toLowerCase());
  return {
    ...(changes.title ? { title: current.title } : {}),
    ...(changes.description ? { body: current.body } : {}),
    ...(action === "close" || action === "reopen"
      ? { state: current.state }
      : {}),
    ...(changes.assignees ? { assignee: current.assignee } : {}),
    addLabels: next.filter((name) => !has(previous, name)),
    removeLabels: previous.filter((name) => !has(next, name)),
  };
}

const pipelineSchema = z.object({
  project,
  object_attributes: z.object({
    id: z.number().optional(),
    sha: z.string(),
    ref: z.string().optional(),
    status: z.string().optional(),
    tag: z.boolean().optional(),
    url: z.string().optional(),
  }),
});

const deploymentSchema = z.object({
  project,
  status: z.string(),
  deployment_id: z.number(),
  environment: z.string(),
  short_sha: z.string().optional(),
  ref: z.string().optional(),
  deployable_url: z.string().nullable().optional(),
  environment_external_url: z.string().nullable().optional(),
  commit_url: z.string().optional(),
});

function sha(commitUrl: string | undefined): string | null {
  return commitUrl?.match(/\/commit\/([0-9a-f]{40})$/)?.[1] ?? null;
}

export function parseGitLabWebhook(
  event: string,
  payload: unknown,
): ParsedWebhook | null {
  if (event === "Push Hook" || event === "Tag Push Hook") {
    const parsed = pushSchema.safeParse(payload);
    if (!parsed.success) return null;
    const data = parsed.data;
    return parsedWebhook(data.project.id, {
      sender: data.user_username ?? null,
      deployment: tagDeployment(data.ref, data.after, data.before === zeroSha),
      activities: pushActivities({
        ref: data.ref,
        before: data.before,
        after: data.after,
        forced: false,
        compareUrl: data.project.web_url
          ? `${data.project.web_url}/-/compare/${data.before}...${data.after}`
          : null,
        commits: data.commits.map((commit) => ({
          id: commit.id,
          message: commit.message,
          author: commit.author.name,
        })),
      }),
    });
  }
  if (event === "Merge Request Hook") {
    const parsed = mergeRequestSchema.safeParse(payload);
    if (!parsed.success) return null;
    const { iid, action } = parsed.data.object_attributes;
    const sender = parsed.data.user?.username ?? null;
    const kind =
      action === "approval"
        ? ("review_approved" as const)
        : action === "unapproval"
          ? ("review_dismissed" as const)
          : null;
    return parsedWebhook(parsed.data.project.id, {
      sender,
      fetchPullRequest: iid,
      staleNumber: iid,
      activities: kind
        ? [
            {
              kind,
              pullRequestNumber: iid,
              review: {
                state: kind === "review_approved" ? "approved" : "dismissed",
                body: "",
                author: sender ?? "",
              },
            },
          ]
        : [],
    });
  }
  if (event === "Issue Hook") {
    const parsed = issueSchema.safeParse(payload);
    if (!parsed.success) return null;
    const attributes = parsed.data.object_attributes;
    const current = issueFields({
      title: attributes.title,
      body: attributes.description,
      state: attributes.state === "closed" ? "completed" : "open",
      labels: parsed.data.labels.map((label) => label.title),
      assignee: parsed.data.assignees[0]?.username,
      url: attributes.url,
    });
    if (!current) return null;
    return parsedWebhook(parsed.data.project.id, {
      sender: parsed.data.user?.username ?? null,
      issue: {
        number: attributes.iid,
        current,
        changes: issueChanges(parsed.data, current),
        comment: null,
        removed: false,
      },
    });
  }
  if (event === "Note Hook") {
    const parsed = noteSchema.safeParse(payload);
    if (!parsed.success) return null;
    const note = parsed.data.object_attributes;
    const sender = parsed.data.user?.username ?? null;
    if (note.noteable_type === "Issue" && parsed.data.issue && note.id)
      return parsedWebhook(parsed.data.project.id, {
        sender,
        issue: {
          number: parsed.data.issue.iid,
          current: null,
          changes: { addLabels: [], removeLabels: [] },
          comment: {
            externalId: String(note.id),
            body: note.note.slice(0, 20_000),
            author: sender ?? "",
          },
          removed: false,
        },
      });
    if (note.noteable_type !== "MergeRequest" || !parsed.data.merge_request)
      return null;
    return parsedWebhook(parsed.data.project.id, {
      sender,
      activities: [
        {
          kind: "comment_created",
          pullRequestNumber: parsed.data.merge_request.iid,
          comment: {
            body: note.note.slice(0, 20_000),
            author: sender ?? "",
            url: note.url ?? null,
            path: note.position?.new_path ?? null,
          },
        },
      ],
    });
  }
  if (event === "Pipeline Hook") {
    const parsed = pipelineSchema.safeParse(payload);
    if (!parsed.success) return null;
    const pipeline = parsed.data.object_attributes;
    return parsedWebhook(parsed.data.project.id, {
      staleSha: pipeline.sha,
      deployment:
        pipeline.status === "success" && pipeline.id !== undefined
          ? {
              source: "workflow_run",
              environment: null,
              version: (pipeline.tag && pipeline.ref
                ? pipeline.ref
                : pipeline.sha.slice(0, 12)
              ).slice(0, 40),
              sha: pipeline.sha,
              externalId: `workflow_run:${pipeline.id}`,
              url: pipeline.url ?? null,
            }
          : null,
    });
  }
  if (event === "Deployment Hook") {
    const parsed = deploymentSchema.safeParse(payload);
    if (!parsed.success || parsed.data.status !== "success") return null;
    const data = parsed.data;
    const commit = sha(data.commit_url);
    if (!commit) return null;
    return parsedWebhook(data.project.id, {
      deployment: {
        source: "deployment",
        environment: data.environment,
        version: (data.ref ?? commit.slice(0, 12)).slice(0, 40),
        sha: commit,
        externalId: `deployment:${data.deployment_id}`,
        url: data.environment_external_url || data.deployable_url || null,
      },
    });
  }
  return null;
}
