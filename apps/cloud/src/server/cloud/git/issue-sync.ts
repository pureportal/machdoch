import { automationMarker } from "../../../lib/git-events";
import type { SettingsCipher } from "../../settings-crypto";
import { isCloudError } from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import { gitConnection, type GitConnectionRecord } from "./connections";
import {
  gitClient,
  type GitIssueState,
  type GitIssueUpdate,
} from "./git-client";
import {
  organizationAccess,
  type ActingAccess,
  type GitIdentities,
} from "./identity";
import { syncedIssueColumns, type SyncedIssue } from "./issue-sync-inbound";

const retryDelay = "5 minutes";

const dirtySyncedIssue = `i.revision<>s.issue_revision
OR EXISTS (SELECT 1 FROM cloud_issue_labels a JOIN cloud_labels l ON l.organization_id=a.organization_id AND l.id=a.label_id
  WHERE a.organization_id=s.organization_id AND a.issue_id=s.issue_id AND NOT EXISTS (
  SELECT 1 FROM cloud_git_synced_issue_labels x WHERE x.organization_id=s.organization_id AND x.issue_id=s.issue_id AND x.name=lower(l.name)))
OR EXISTS (SELECT 1 FROM cloud_git_synced_issue_labels x WHERE x.organization_id=s.organization_id AND x.issue_id=s.issue_id AND NOT EXISTS (
  SELECT 1 FROM cloud_issue_labels a JOIN cloud_labels l ON l.organization_id=a.organization_id AND l.id=a.label_id
  WHERE a.organization_id=s.organization_id AND a.issue_id=s.issue_id AND lower(l.name)=x.name))
OR EXISTS (SELECT 1 FROM cloud_comments c WHERE c.organization_id=s.organization_id AND c.issue_id=s.issue_id AND NOT c.deleted AND c.created_at>s.linked_at
  AND NOT EXISTS (SELECT 1 FROM cloud_git_synced_comments m WHERE m.organization_id=c.organization_id AND m.comment_id=c.id))`;

interface ClaimedIssue {
  organizationId: string;
  issueId: string;
  connectionId: string;
  fullName: string;
  number: number;
}

interface OutgoingComment {
  id: string;
  body: string;
  author: string;
  acting: ActingAccess;
}

interface IssuePush {
  connection: GitConnectionRecord;
  revision: number;
  update: GitIssueUpdate;
  snapshot: Pick<
    SyncedIssue,
    "title" | "body" | "state" | "assignee" | "assigneeId"
  >;
  comments: OutgoingComment[];
}

function externalState(state: string): GitIssueState {
  return state === "complete"
    ? "completed"
    : state === "canceled"
      ? "not_planned"
      : "open";
}

function changed(update: GitIssueUpdate): boolean {
  return (
    Object.keys(update).some(
      (key) => key !== "addLabels" && key !== "removeLabels",
    ) ||
    update.addLabels.length > 0 ||
    update.removeLabels.length > 0
  );
}

function attributedComment(comment: OutgoingComment): string {
  return comment.acting.personal
    ? `${comment.body}\n\n${automationMarker}`
    : `*${comment.author}* via machdoch\n\n${comment.body}\n\n${automationMarker}`;
}

export class CloudGitIssueSync {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly identities: GitIdentities,
    private readonly transport: typeof fetch,
  ) {}

  async tick(): Promise<number> {
    if (!this.cipher) return 0;
    const claimed = await this.database.transaction(async (sql) => {
      const row = (
        await sql.query<ClaimedIssue & Record<string, unknown>>(
          `SELECT s.organization_id AS "organizationId",s.issue_id AS "issueId",r.connection_id AS "connectionId",r.full_name AS "fullName",s.number
          FROM cloud_git_synced_issues s
          JOIN cloud_git_repositories r ON r.organization_id=s.organization_id AND r.id=s.repository_id
          JOIN cloud_issues i ON i.organization_id=s.organization_id AND i.id=s.issue_id
          WHERE r.issue_sync AND (s.attempted_at IS NULL OR s.attempted_at<clock_timestamp()-interval '${retryDelay}') AND (${dirtySyncedIssue})
          ORDER BY s.attempted_at NULLS FIRST,s.linked_at LIMIT 1 FOR UPDATE OF s SKIP LOCKED`,
        )
      ).rows[0];
      if (row)
        await sql.query(
          "UPDATE cloud_git_synced_issues SET attempted_at=clock_timestamp() WHERE organization_id=$1 AND issue_id=$2",
          [row.organizationId, row.issueId],
        );
      return row;
    });
    if (!claimed) return 0;
    const push = await this.database.transaction((sql) =>
      this.plan(sql, claimed),
    );
    const posted: { id: string; externalId: string }[] = [];
    let pushed = false;
    let failure: unknown = null;
    try {
      if (changed(push.update))
        await gitClient(push.connection, this.transport).updateIssue(
          claimed.fullName,
          claimed.number,
          push.update,
        );
      pushed = true;
      for (const comment of push.comments)
        posted.push({
          id: comment.id,
          externalId: await this.postComment(push, claimed, comment),
        });
    } catch (error) {
      failure = error;
    }
    await this.database.transaction((sql) =>
      this.record(sql, claimed, push, pushed, posted, failure),
    );
    if (failure && !isCloudError(failure)) throw failure;
    return 1;
  }

  private async postComment(
    push: IssuePush,
    claimed: ClaimedIssue,
    comment: OutgoingComment,
  ): Promise<string> {
    const send = (outgoing: OutgoingComment) =>
      gitClient(outgoing.acting, this.transport).commentOnIssue(
        claimed.fullName,
        claimed.number,
        attributedComment(outgoing),
      );
    try {
      return await send(comment);
    } catch (error) {
      if (
        !comment.acting.personal ||
        !isCloudError(error) ||
        error.code !== "git_token"
      )
        throw error;
      return send({ ...comment, acting: organizationAccess(push.connection) });
    }
  }

  private async plan(sql: CloudSql, claimed: ClaimedIssue): Promise<IssuePush> {
    const { organizationId, issueId } = claimed;
    const connection = await gitConnection(
      sql,
      this.cipher,
      organizationId,
      claimed.connectionId,
    );
    const synced = (
      await sql.query<SyncedIssue & Record<string, unknown>>(
        `SELECT ${syncedIssueColumns} FROM cloud_git_synced_issues s WHERE s.organization_id=$1 AND s.issue_id=$2`,
        [organizationId, issueId],
      )
    ).rows[0]!;
    const issue = (
      await sql.query<{
        title: string;
        description: string;
        state: string;
        assigneeId: string | null;
        assigneeLogin: string | null;
        revision: number;
      }>(
        `SELECT i.title,i.description,i.state,i.assignee_id AS "assigneeId",i.revision,
        (SELECT a.login FROM cloud_git_accounts a WHERE a.organization_id=i.organization_id AND a.user_id=i.assignee_id AND a.provider=$3 AND a.api_url=$4) AS "assigneeLogin"
        FROM cloud_issues i WHERE i.organization_id=$1 AND i.id=$2`,
        [organizationId, issueId, connection.provider, connection.apiUrl],
      )
    ).rows[0]!;
    const labels = (
      await sql.query<{ name: string }>(
        `SELECT l.name FROM cloud_issue_labels a JOIN cloud_labels l ON l.organization_id=a.organization_id AND l.id=a.label_id
        WHERE a.organization_id=$1 AND a.issue_id=$2 ORDER BY lower(l.name)`,
        [organizationId, issueId],
      )
    ).rows.map((row) => row.name);
    const current = new Set(labels.map((name) => name.toLowerCase()));
    const state = externalState(issue.state);
    const update: GitIssueUpdate = {
      ...(issue.title === synced.title ? {} : { title: issue.title }),
      ...(issue.description === synced.body ? {} : { body: issue.description }),
      ...(state === synced.state ? {} : { state }),
      addLabels: labels.filter(
        (name) => !synced.labels.includes(name.toLowerCase()),
      ),
      removeLabels: synced.labels.filter((name) => !current.has(name)),
    };
    const assignee =
      issue.assigneeId === synced.assigneeId
        ? synced.assignee
        : issue.assigneeId
          ? (issue.assigneeLogin ?? synced.assignee)
          : null;
    if (assignee !== synced.assignee) update.assignee = assignee;
    const pending = (
      await sql.query<{
        id: string;
        body: string;
        authorId: string;
        author: string;
      }>(
        `SELECT c.id,c.body,c.author_id AS "authorId",u.name AS author FROM cloud_comments c JOIN cloud_users u ON u.id=c.author_id
        JOIN cloud_git_synced_issues s ON s.organization_id=c.organization_id AND s.issue_id=c.issue_id
        WHERE c.organization_id=$1 AND c.issue_id=$2 AND NOT c.deleted AND c.created_at>s.linked_at
        AND NOT EXISTS (SELECT 1 FROM cloud_git_synced_comments m WHERE m.organization_id=c.organization_id AND m.comment_id=c.id)
        ORDER BY c.created_at,c.id LIMIT 20`,
        [organizationId, issueId],
      )
    ).rows;
    const comments: OutgoingComment[] = [];
    for (const comment of pending)
      comments.push({
        id: comment.id,
        body: comment.body,
        author: comment.author,
        acting: await this.acting(sql, connection, comment.authorId),
      });
    return {
      connection,
      revision: issue.revision,
      update,
      snapshot: {
        title: issue.title,
        body: issue.description,
        state,
        assignee,
        assigneeId: issue.assigneeId,
      },
      comments,
    };
  }

  private async acting(
    sql: CloudSql,
    connection: GitConnectionRecord,
    userId: string,
  ): Promise<ActingAccess> {
    try {
      return await this.identities.acting(
        sql,
        connection,
        userId,
        "personal_first",
      );
    } catch (error) {
      if (!isCloudError(error) || error.code !== "git_account_expired")
        throw error;
      return organizationAccess(connection);
    }
  }

  private async record(
    sql: CloudSql,
    claimed: ClaimedIssue,
    push: IssuePush,
    pushed: boolean,
    posted: { id: string; externalId: string }[],
    failure: unknown,
  ): Promise<void> {
    const { organizationId, issueId } = claimed;
    if (pushed) {
      await sql.query(
        `UPDATE cloud_git_synced_issues SET title=$3,body=$4,state=$5,assignee=$6,assignee_id=$7,issue_revision=$8
        WHERE organization_id=$1 AND issue_id=$2`,
        [
          organizationId,
          issueId,
          push.snapshot.title,
          push.snapshot.body,
          push.snapshot.state,
          push.snapshot.assignee,
          push.snapshot.assigneeId,
          push.revision,
        ],
      );
      await sql.query(
        "DELETE FROM cloud_git_synced_issue_labels WHERE organization_id=$1 AND issue_id=$2 AND name=ANY($3::text[])",
        [organizationId, issueId, push.update.removeLabels],
      );
      await sql.query(
        "INSERT INTO cloud_git_synced_issue_labels (organization_id,issue_id,name) SELECT $1,$2,lower(unnest($3::text[])) ON CONFLICT DO NOTHING",
        [organizationId, issueId, push.update.addLabels],
      );
    }
    for (const comment of posted)
      await sql.query(
        "INSERT INTO cloud_git_synced_comments (organization_id,comment_id,issue_id,external_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [organizationId, comment.id, issueId, comment.externalId],
      );
    await sql.query(
      `UPDATE cloud_git_synced_issues SET attempted_at=CASE WHEN $3::text IS NULL THEN NULL ELSE attempted_at END,last_error=$3
      WHERE organization_id=$1 AND issue_id=$2`,
      [
        organizationId,
        issueId,
        failure
          ? (failure instanceof Error
              ? failure.message
              : String(failure)
            ).slice(0, 500)
          : null,
      ],
    );
  }
}
