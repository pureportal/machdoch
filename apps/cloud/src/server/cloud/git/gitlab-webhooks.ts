import { z } from "zod";
import {
  parsedWebhook,
  pushActivities,
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
    note: z.string(),
    noteable_type: z.string(),
    url: z.string().optional(),
    position: z
      .object({ new_path: z.string().nullable().optional() })
      .nullable()
      .optional(),
  }),
  merge_request: z.object({ iid: z.number() }).optional(),
});

const pipelineSchema = z.object({
  project,
  object_attributes: z.object({ sha: z.string() }),
});

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
  if (event === "Note Hook") {
    const parsed = noteSchema.safeParse(payload);
    if (
      !parsed.success ||
      parsed.data.object_attributes.noteable_type !== "MergeRequest" ||
      !parsed.data.merge_request
    )
      return null;
    const note = parsed.data.object_attributes;
    const sender = parsed.data.user?.username ?? null;
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
    return parsed.success
      ? parsedWebhook(parsed.data.project.id, {
          staleSha: parsed.data.object_attributes.sha,
        })
      : null;
  }
  return null;
}
