import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../lib/cloud-contract";
import type {
  CloudLabel,
  CloudIssueLabels,
  LabelInput,
  LabelUpdate,
  IssueLabelsUpdate,
} from "../../lib/cloud-label-contract";
import {
  checkRevision,
  CloudError,
  command,
  recordEvent,
  requireTeam,
} from "./access";
import type { CloudDatabase, CloudSql } from "./database";
import { readIssue } from "./planning";

const columns =
  'l.id,l.team_id AS "teamId",l.name,l.color,l.archived,l.revision';

async function checkName(
  sql: CloudSql,
  actor: CloudActor,
  teamId: string,
  name: string,
  id: string | null,
) {
  const existing = await sql.query(
    "SELECT id FROM cloud_labels WHERE organization_id=$1 AND team_id=$2 AND lower(name)=lower($3) AND ($4::uuid IS NULL OR id<>$4)",
    [actor.organizationId, teamId, name, id],
  );
  if (existing.rows.length)
    throw new CloudError(
      409,
      "label_name_exists",
      "A label with this name exists. Choose another name or restore the existing label.",
    );
}

export class CloudLabels {
  constructor(private readonly database: CloudDatabase) {}

  list(actor: CloudActor, teamId: string): Promise<CloudLabel[]> {
    return this.database.transaction(async (sql) => {
      await requireTeam(sql, actor, teamId);
      return (
        await sql.query<CloudLabel & Record<string, unknown>>(
          `SELECT ${columns} FROM cloud_labels l WHERE organization_id=$1 AND team_id=$2 ORDER BY lower(name),id`,
          [actor.organizationId, teamId],
        )
      ).rows;
    });
  }

  create(
    actor: CloudActor,
    key: string,
    teamId: string,
    input: LabelInput,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await requireTeam(sql, actor, teamId, true);
      return command(
        sql,
        actor,
        key,
        { kind: "label.create", teamId, input },
        async () => {
          await checkName(sql, actor, teamId, input.name, null);
          const count = (
            await sql.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM cloud_labels WHERE organization_id=$1 AND team_id=$2",
              [actor.organizationId, teamId],
            )
          ).rows[0]!.count;
          if (count >= 200)
            throw new CloudError(
              409,
              "label_limit",
              "This team has 200 labels. Reuse an existing label.",
            );
          const id = randomUUID();
          await sql.query(
            "INSERT INTO cloud_labels (organization_id,id,team_id,name,color) VALUES ($1,$2,$3,$4,$5)",
            [actor.organizationId, id, teamId, input.name, input.color],
          );
          await recordEvent(sql, actor, "label.created", id, 1, { teamId });
          return { id };
        },
      );
    });
  }

  update(
    actor: CloudActor,
    key: string,
    id: string,
    input: LabelUpdate,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      const identity = (
        await sql.query<{ team_id: string }>(
          "SELECT team_id FROM cloud_labels WHERE organization_id=$1 AND id=$2",
          [actor.organizationId, id],
        )
      ).rows[0];
      if (!identity)
        throw new CloudError(404, "not_found", "Label is unavailable.");
      await requireTeam(sql, actor, identity.team_id, true);
      const label = (
        await sql.query<CloudLabel & Record<string, unknown>>(
          `SELECT ${columns} FROM cloud_labels l WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
          [actor.organizationId, id],
        )
      ).rows[0]!;
      return command(
        sql,
        actor,
        key,
        { kind: "label.update", id, input },
        async () => {
          checkRevision(label.revision, input.revision);
          if (
            label.name === input.name &&
            label.color === input.color &&
            label.archived === input.archived
          )
            return { id };
          await checkName(sql, actor, label.teamId, input.name, id);
          await sql.query(
            "UPDATE cloud_labels SET name=$3,color=$4,archived=$5,revision=revision+1 WHERE organization_id=$1 AND id=$2",
            [actor.organizationId, id, input.name, input.color, input.archived],
          );
          await recordEvent(
            sql,
            actor,
            "label.changed",
            id,
            label.revision + 1,
            { teamId: label.teamId, archived: input.archived },
          );
          return { id };
        },
      );
    });
  }

  getIssue(actor: CloudActor, issueId: string): Promise<CloudIssueLabels> {
    return this.database.transaction(async (sql) => {
      await readIssue(sql, actor, issueId);
      const set = (
        await sql.query<{ revision: number }>(
          "SELECT revision FROM cloud_issue_label_sets WHERE organization_id=$1 AND issue_id=$2",
          [actor.organizationId, issueId],
        )
      ).rows[0];
      const labels = (
        await sql.query<CloudLabel & Record<string, unknown>>(
          `SELECT ${columns} FROM cloud_issue_labels a JOIN cloud_labels l ON l.organization_id=a.organization_id AND l.id=a.label_id WHERE a.organization_id=$1 AND a.issue_id=$2 ORDER BY lower(l.name),l.id`,
          [actor.organizationId, issueId],
        )
      ).rows;
      return { revision: set?.revision ?? 1, labels };
    });
  }

  setIssue(
    actor: CloudActor,
    key: string,
    issueId: string,
    input: IssueLabelsUpdate,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      const issue = await readIssue(sql, actor, issueId, true);
      return command(
        sql,
        actor,
        key,
        { kind: "issue.labels", issueId, input },
        async () => {
          if (issue.archived)
            throw new CloudError(
              409,
              "issue_archived",
              "Restore the issue before changing its labels.",
            );
          await sql.query(
            "INSERT INTO cloud_issue_label_sets (organization_id,issue_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
            [actor.organizationId, issueId],
          );
          const set = (
            await sql.query<{ revision: number }>(
              "SELECT revision FROM cloud_issue_label_sets WHERE organization_id=$1 AND issue_id=$2 FOR UPDATE",
              [actor.organizationId, issueId],
            )
          ).rows[0]!;
          checkRevision(set.revision, input.revision);
          const previous = (
            await sql.query<{ label_id: string }>(
              "SELECT label_id FROM cloud_issue_labels WHERE organization_id=$1 AND issue_id=$2",
              [actor.organizationId, issueId],
            )
          ).rows.map((row) => row.label_id);
          const valid = await sql.query(
            "SELECT id FROM cloud_labels WHERE organization_id=$1 AND team_id=$2 AND id=ANY($3::uuid[]) AND (NOT archived OR id=ANY($4::uuid[]))",
            [actor.organizationId, issue.teamId, input.labelIds, previous],
          );
          if (valid.rows.length !== input.labelIds.length)
            throw new CloudError(
              422,
              "label_unavailable",
              "A selected label is unavailable. Reopen Labels to refresh the choices.",
            );
          if (
            previous.length === input.labelIds.length &&
            previous.every((id) => input.labelIds.includes(id))
          )
            return { id: issueId };
          await sql.query(
            "DELETE FROM cloud_issue_labels WHERE organization_id=$1 AND issue_id=$2 AND NOT (label_id=ANY($3::uuid[]))",
            [actor.organizationId, issueId, input.labelIds],
          );
          await sql.query(
            "INSERT INTO cloud_issue_labels (organization_id,issue_id,team_id,label_id) SELECT $1,$2,$3,id FROM unnest($4::uuid[]) AS id ON CONFLICT DO NOTHING",
            [actor.organizationId, issueId, issue.teamId, input.labelIds],
          );
          await sql.query(
            "UPDATE cloud_issue_label_sets SET revision=revision+1 WHERE organization_id=$1 AND issue_id=$2",
            [actor.organizationId, issueId],
          );
          await recordEvent(
            sql,
            actor,
            "issue.labels_changed",
            issueId,
            set.revision + 1,
            { labelIds: input.labelIds },
          );
          return { id: issueId };
        },
      );
    });
  }
}
