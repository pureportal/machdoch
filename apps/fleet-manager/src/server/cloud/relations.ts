import type { CloudActor } from "../../lib/cloud-contract";
import type {
  ChildIssueInput,
  CloudIssueRelation,
  RelationInput,
} from "../../lib/cloud-relation-contract";
import {
  checkRevision,
  CloudError,
  command,
  requireMembership,
  requireTeam,
  teamVisibility,
} from "./access";
import type { CloudDatabase } from "./database";
import { lockExecution } from "./execution/records";
import { insertIssueRelation, recordIssueRelation } from "./issue-graph";
import { createIssueInTransaction, readIssue } from "./planning";

export class CloudIssueRelations {
  constructor(private readonly database: CloudDatabase) {}

  list(actor: CloudActor, issueId: string): Promise<CloudIssueRelation[]> {
    return this.database.transaction(async (sql) => {
      const issue = await readIssue(sql, actor, issueId);
      const rows = (
        await sql.query<CloudIssueRelation & Record<string, unknown>>(
          `SELECT r.id,CASE WHEN r.kind='parent' THEN CASE WHEN r.source_id=$3 THEN 'child' ELSE 'parent' END
          WHEN r.kind='blocks' THEN CASE WHEN r.source_id=$3 THEN 'blocks' ELSE 'blocked_by' END ELSE 'related' END AS kind,
          jsonb_build_object('id',i.id,'identifier',i.identifier,'title',i.title,'state',i.state,'statusName',s.name,'archived',i.archived,'revision',i.revision) AS issue
        FROM cloud_issue_relations r JOIN cloud_issues i ON i.organization_id=r.organization_id AND i.id=CASE WHEN r.source_id=$3 THEN r.target_id ELSE r.source_id END
        JOIN cloud_workflow_statuses s ON s.organization_id=i.organization_id AND s.id=i.status_id
        JOIN cloud_teams t ON t.organization_id=i.organization_id AND t.id=i.team_id JOIN cloud_memberships m ON m.organization_id=i.organization_id AND m.user_id=$2
        WHERE r.organization_id=$1 AND r.removed_at IS NULL AND (r.source_id=$3 OR r.target_id=$3) AND ${teamVisibility}
        ORDER BY r.created_at,r.id`,
          [actor.organizationId, actor.userId, issue.id],
        )
      ).rows;
      return rows;
    });
  }

  add(
    actor: CloudActor,
    key: string,
    issueId: string,
    input: RelationInput,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      await requireMembership(sql, actor, "write");
      const source = await readIssue(sql, actor, issueId);
      const target = await readIssue(sql, actor, input.targetId);
      return command(
        sql,
        actor,
        key,
        { kind: "relation.add", issueId, input },
        async () => {
          checkRevision(source.revision, input.sourceRevision);
          checkRevision(target.revision, input.targetRevision);
          if (source.archived || target.archived)
            throw new CloudError(
              409,
              "issue_archived",
              "Restore the issues before adding a link.",
            );
          const reversed =
            input.kind === "parent" || input.kind === "blocked_by";
          const kind =
            input.kind === "child"
              ? "parent"
              : input.kind === "blocked_by"
                ? "blocks"
                : input.kind;
          return insertIssueRelation(
            sql,
            actor,
            kind,
            reversed ? target.id : source.id,
            reversed ? source.id : target.id,
          );
        },
      );
    });
  }

  remove(
    actor: CloudActor,
    key: string,
    issueId: string,
    relationId: string,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      await requireMembership(sql, actor, "write");
      const issue = await readIssue(sql, actor, issueId);
      const relation = (
        await sql.query<{
          source_id: string;
          target_id: string;
          removed_at: string | null;
        }>(
          "SELECT source_id,target_id,removed_at FROM cloud_issue_relations WHERE organization_id=$1 AND id=$2 AND (source_id=$3 OR target_id=$3)",
          [actor.organizationId, relationId, issue.id],
        )
      ).rows[0];
      if (!relation)
        throw new CloudError(404, "not_found", "Issue link is unavailable.");
      await readIssue(
        sql,
        actor,
        relation.source_id === issue.id
          ? relation.target_id
          : relation.source_id,
      );
      return command(
        sql,
        actor,
        key,
        { kind: "relation.remove", issueId, relationId },
        async () => {
          if (!relation.removed_at) {
            await sql.query(
              "UPDATE cloud_issue_relations SET removed_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
              [actor.organizationId, relationId],
            );
            await recordIssueRelation(
              sql,
              actor,
              relationId,
              relation.source_id,
              relation.target_id,
              true,
            );
          }
          return { id: relationId };
        },
      );
    });
  }

  createChild(
    actor: CloudActor,
    key: string,
    parentId: string,
    input: ChildIssueInput,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      const team = await requireTeam(sql, actor, input.issue.teamId, true);
      const parent = await readIssue(sql, actor, parentId);
      return command(
        sql,
        actor,
        key,
        { kind: "issue.create_child", parentId, input },
        async () => {
          checkRevision(parent.revision, input.parentRevision);
          if (parent.archived)
            throw new CloudError(
              409,
              "issue_archived",
              "Restore the parent issue before adding a sub-issue.",
            );
          const child = await createIssueInTransaction(
            sql,
            actor,
            team,
            input.issue,
          );
          await insertIssueRelation(sql, actor, "parent", parent.id, child.id);
          return child;
        },
      );
    });
  }
}
