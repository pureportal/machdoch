import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import type { ChatContextReference } from "../../../lib/cloud-chat-contract";
import { relayedPrompt } from "../../../lib/agent-relay";
import type { GitProvider } from "../../../lib/git-providers";
import { CloudError, requireMembership } from "../access";
import type { CloudAttachments } from "../attachments/attachments";
import type { CloudDatabase, CloudSql } from "../database";
import { usersForLogins } from "../git/accounts";
import { readUserSettings } from "../settings-store";
import { conversationChats } from "./chat-records";
import { reserveMessage } from "./chat-store";
import { lockInference, reapInference } from "./inference-records";

type RelayOrigin =
  | { source: "issue_comment"; commentId: string }
  | { source: "pull_request_comment"; pullRequestId: string; url: string };

export interface PullRequestComment {
  provider: GitProvider;
  apiUrl: string;
  repositoryId: string;
  number: number;
  login: string;
  body: string;
  url: string;
}

async function relayModel(
  sql: CloudSql,
  actor: CloudActor,
): Promise<{ providerId: string; model: string }> {
  const providers = (
    await sql.query<{ id: string; models: string[] }>(
      "SELECT id,models FROM cloud_ai_providers WHERE organization_id=$1 AND enabled ORDER BY name,id",
      [actor.organizationId],
    )
  ).rows;
  const offered = (choice: { providerId: string; model: string }) =>
    providers.some(
      (provider) =>
        provider.id === choice.providerId &&
        provider.models.includes(choice.model),
    );
  const preferred = (await readUserSettings(sql, actor))["agent.model"];
  if (preferred && offered(preferred)) return preferred;
  const latest = (
    await sql.query<{ providerId: string; model: string }>(
      `SELECT t.provider_id AS "providerId",t.model FROM cloud_chat_turns t
      JOIN cloud_chats ch ON ch.organization_id=t.organization_id AND ch.id=t.chat_id
      WHERE ${conversationChats} ORDER BY t.created_at DESC,t.id DESC LIMIT 1`,
      [actor.organizationId, actor.userId],
    )
  ).rows[0];
  if (latest && offered(latest)) return latest;
  const provider = providers.find((entry) => entry.models.length);
  if (!provider)
    throw new CloudError(
      409,
      "ai_provider_required",
      "Add an AI provider to use the agent.",
    );
  return { providerId: provider.id, model: provider.models[0]! };
}

export class CloudAgentRelays {
  constructor(
    private readonly database: CloudDatabase,
    private readonly files: CloudAttachments,
  ) {}

  issueComment(actor: CloudActor, commentId: string): Promise<string | null> {
    return this.database.transaction(async (sql) => {
      const comment = (
        await sql.query<{ issueId: string; body: string; author: string }>(
          `SELECT c.issue_id AS "issueId",c.body,u.name AS author FROM cloud_comments c JOIN cloud_users u ON u.id=c.author_id
          WHERE c.organization_id=$1 AND c.id=$2 AND c.author_id=$3 AND NOT c.deleted`,
          [actor.organizationId, commentId, actor.userId],
        )
      ).rows[0];
      if (!comment)
        throw new CloudError(404, "not_found", "Comment is unavailable.");
      const prompt = relayedPrompt(comment.body);
      return prompt
        ? this.start(sql, actor, {
            prompt,
            author: comment.author,
            context: [{ kind: "issue", id: comment.issueId }],
            origin: { source: "issue_comment", commentId },
          })
        : null;
    });
  }

  pullRequestComment(
    organizationId: string,
    comment: PullRequestComment,
  ): Promise<string | null> {
    const prompt = relayedPrompt(comment.body);
    if (!prompt) return Promise.resolve(null);
    return this.database.transaction(async (sql) => {
      const userId = (
        await usersForLogins(
          sql,
          organizationId,
          comment.provider,
          comment.apiUrl,
          [comment.login],
        )
      ).get(comment.login.toLowerCase());
      const pullRequest = (
        await sql.query<{ id: string }>(
          "SELECT id FROM cloud_git_pull_requests WHERE organization_id=$1 AND repository_id=$2 AND number=$3",
          [organizationId, comment.repositoryId, comment.number],
        )
      ).rows[0];
      if (!userId || !pullRequest) return null;
      return this.start(
        sql,
        { organizationId, userId },
        {
          prompt,
          author: comment.login,
          context: [{ kind: "pull_request", id: pullRequest.id }],
          origin: {
            source: "pull_request_comment",
            pullRequestId: pullRequest.id,
            url: comment.url,
          },
        },
      );
    });
  }

  private async start(
    sql: CloudSql,
    actor: CloudActor,
    input: {
      prompt: string;
      author: string;
      context: ChatContextReference[];
      origin: RelayOrigin;
    },
  ): Promise<string> {
    const { origin } = input;
    const commentId =
      origin.source === "issue_comment" ? origin.commentId : null;
    const pullRequestId =
      origin.source === "pull_request_comment" ? origin.pullRequestId : null;
    const url = origin.source === "pull_request_comment" ? origin.url : null;
    await lockInference(sql, actor.organizationId);
    await requireMembership(sql, actor, "ai.chat");
    const existing = (
      await sql.query<{ chat_id: string }>(
        `SELECT t.chat_id FROM cloud_agent_relays r JOIN cloud_chat_turns t ON t.organization_id=r.organization_id AND t.id=r.turn_id
        WHERE r.organization_id=$1 AND (r.comment_id=$2 OR r.external_url=$3)`,
        [actor.organizationId, commentId, url],
      )
    ).rows[0];
    if (existing) return existing.chat_id;
    await reapInference(sql, actor.organizationId);
    const model = await relayModel(sql, actor);
    const chatId = randomUUID();
    await sql.query(
      "INSERT INTO cloud_chats (organization_id,id,user_id,title) VALUES ($1,$2,$3,$4)",
      [
        actor.organizationId,
        chatId,
        actor.userId,
        input.prompt.split("\n", 1)[0]!.slice(0, 120),
      ],
    );
    const { turnId } = await reserveMessage(
      sql,
      actor,
      chatId,
      {
        ...model,
        prompt: input.prompt,
        context: input.context,
        attachmentIds: [],
      },
      this.files,
    );
    await sql.query(
      "INSERT INTO cloud_agent_relays (organization_id,turn_id,source,author,comment_id,pull_request_id,external_url) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [
        actor.organizationId,
        turnId,
        origin.source,
        input.author.slice(0, 200),
        commentId,
        pullRequestId,
        url,
      ],
    );
    return chatId;
  }
}
