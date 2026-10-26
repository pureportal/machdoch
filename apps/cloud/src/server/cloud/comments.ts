import { randomUUID } from "node:crypto";
import type {
  CloudComment,
  CommentUpdate,
} from "../../lib/cloud-comment-contract";
import type { CloudActor } from "../../lib/cloud-contract";
import {
  checkRevision,
  CloudError,
  command,
  recordEvent,
  requireMembership,
} from "./access";
import type { CloudDatabase, CloudSql } from "./database";
import { readIssue } from "./planning";

async function recordComment(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
  kind: string,
) {
  const comment = (
    await sql.query<{
      issue_id: string;
      revision: number;
      body: string;
      deleted: boolean;
    }>(
      "SELECT issue_id,revision,body,deleted FROM cloud_comments WHERE organization_id=$1 AND id=$2",
      [actor.organizationId, id],
    )
  ).rows[0]!;
  await sql.query(
    "INSERT INTO cloud_comment_history (organization_id,comment_id,revision,actor_id,body,deleted) VALUES ($1,$2,$3,$4,$5,$6)",
    [
      actor.organizationId,
      id,
      comment.revision,
      actor.userId,
      comment.body,
      comment.deleted,
    ],
  );
  await recordEvent(sql, actor, kind, id, comment.revision, {
    issueId: comment.issue_id,
  });
}

export class CloudComments {
  constructor(private readonly database: CloudDatabase) {}

  list(
    actor: CloudActor,
    issueId: string,
    before: string | null = null,
  ): Promise<CloudComment[]> {
    return this.database.transaction(async (sql) => {
      await readIssue(sql, actor, issueId);
      return (
        await sql.query<CloudComment & Record<string, unknown>>(
          `SELECT c.id,c.issue_id AS "issueId",c.author_id AS "authorId",u.name AS author,CASE WHEN c.deleted THEN '' ELSE c.body END AS body,c.revision,c.deleted,
        to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
        to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
        FROM cloud_comments c JOIN cloud_users u ON u.id=c.author_id WHERE c.organization_id=$1 AND c.issue_id=$2
        AND ($3::uuid IS NULL OR (c.created_at,c.id)<(SELECT created_at,id FROM cloud_comments WHERE organization_id=$1 AND issue_id=$2 AND id=$3))
        ORDER BY c.created_at DESC,c.id DESC LIMIT 50`,
          [actor.organizationId, issueId, before],
        )
      ).rows;
    });
  }

  create(
    actor: CloudActor,
    key: string,
    issueId: string,
    body: string,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      const issue = await readIssue(sql, actor, issueId, true);
      return command(
        sql,
        actor,
        key,
        { kind: "comment.create", issueId, body },
        async () => {
          if (issue.archived)
            throw new CloudError(
              409,
              "issue_archived",
              "Restore the issue before adding a comment.",
            );
          const id = randomUUID();
          await sql.query(
            "INSERT INTO cloud_comments (organization_id,id,issue_id,author_id,body) VALUES ($1,$2,$3,$4,$5)",
            [actor.organizationId, id, issueId, actor.userId, body],
          );
          await recordComment(sql, actor, id, "comment.created");
          return { id };
        },
      );
    });
  }

  update(
    actor: CloudActor,
    key: string,
    id: string,
    input: CommentUpdate,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      const reference = (
        await sql.query<{ issue_id: string }>(
          "SELECT issue_id FROM cloud_comments WHERE organization_id=$1 AND id=$2",
          [actor.organizationId, id],
        )
      ).rows[0];
      if (!reference)
        throw new CloudError(404, "not_found", "Comment is unavailable.");
      const issue = await readIssue(sql, actor, reference.issue_id, true);
      const role = await requireMembership(sql, actor, "write");
      const comment = (
        await sql.query<{
          author_id: string;
          revision: number;
          deleted: boolean;
        }>(
          "SELECT author_id,revision,deleted FROM cloud_comments WHERE organization_id=$1 AND id=$2 FOR UPDATE",
          [actor.organizationId, id],
        )
      ).rows[0]!;
      if (
        comment.author_id !== actor.userId &&
        !(input.kind === "delete" && ["owner", "admin"].includes(role))
      )
        throw new CloudError(
          403,
          "author_required",
          "Only the author can edit this comment. Administrators can remove it.",
        );
      return command(
        sql,
        actor,
        key,
        { kind: "comment.update", id, input },
        async () => {
          checkRevision(comment.revision, input.revision);
          if (comment.deleted)
            throw new CloudError(
              409,
              "comment_deleted",
              "This comment has been deleted.",
            );
          if (issue.archived && input.kind === "edit")
            throw new CloudError(
              409,
              "issue_archived",
              "Restore the issue before editing its comments.",
            );
          await sql.query(
            "UPDATE cloud_comments SET body=CASE WHEN $3::text IS NULL THEN body ELSE $3 END,deleted=$4,revision=revision+1,updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
            [
              actor.organizationId,
              id,
              input.kind === "edit" ? input.body : null,
              input.kind === "delete",
            ],
          );
          await recordComment(
            sql,
            actor,
            id,
            input.kind === "edit" ? "comment.edited" : "comment.deleted",
          );
          return { id };
        },
      );
    });
  }
}
