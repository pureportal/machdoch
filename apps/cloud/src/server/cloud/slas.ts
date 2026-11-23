import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../lib/cloud-contract";
import type { CloudSlaPolicy, SlaPolicyInput } from "../../lib/issue-sla";
import {
  CloudError,
  command,
  requireMembership,
  requireTeam,
  teamVisibility,
} from "./access";
import type { CloudDatabase, CloudSql } from "./database";
import { notifySlaBreach } from "./notifications";

const policyColumns = `p.id,p.team_id AS "teamId",p.priority,p.label_id AS "labelId",l.name AS "labelName",p.hours`;
const policyFrom = `cloud_sla_policies p LEFT JOIN cloud_labels l ON l.organization_id=p.organization_id AND l.id=p.label_id`;
export const slaSweepBatchSize = 50;

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

async function readPolicy(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
): Promise<CloudSlaPolicy> {
  const policy = (
    await sql.query<CloudSlaPolicy & Record<string, unknown>>(
      `SELECT ${policyColumns} FROM ${policyFrom} WHERE p.organization_id=$1 AND p.id=$2`,
      [actor.organizationId, id],
    )
  ).rows[0];
  if (!policy) throw new CloudError(404, "not_found", "SLA is unavailable.");
  return policy;
}

export class CloudSlas {
  constructor(private readonly database: CloudDatabase) {}

  list(actor: CloudActor): Promise<CloudSlaPolicy[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<CloudSlaPolicy & Record<string, unknown>>(
          `SELECT ${policyColumns} FROM ${policyFrom}
          JOIN cloud_teams t ON t.organization_id=p.organization_id AND t.id=p.team_id
          JOIN cloud_memberships m ON m.organization_id=t.organization_id AND m.user_id=$2
          WHERE p.organization_id=$1 AND ${teamVisibility}
          ORDER BY t.name,p.priority NULLS LAST,l.name NULLS FIRST,p.id`,
          [actor.organizationId, actor.userId],
        )
      ).rows;
    });
  }

  create(
    actor: CloudActor,
    commandId: string,
    input: SlaPolicyInput,
  ): Promise<{ policy: CloudSlaPolicy }> {
    return this.database.transaction(async (sql) => {
      await requireTeam(sql, actor, input.teamId, "settings.manage");
      return command(sql, actor, commandId, input, async () => {
        if (input.labelId) {
          const label = await sql.query(
            "SELECT 1 FROM cloud_labels WHERE organization_id=$1 AND team_id=$2 AND id=$3",
            [actor.organizationId, input.teamId, input.labelId],
          );
          if (!label.rows.length)
            throw new CloudError(404, "not_found", "Label is unavailable.");
        }
        const id = randomUUID();
        await sql.query("SAVEPOINT sla_policy");
        try {
          await sql.query(
            "INSERT INTO cloud_sla_policies (organization_id,id,team_id,priority,label_id,hours) VALUES ($1,$2,$3,$4,$5,$6)",
            [
              actor.organizationId,
              id,
              input.teamId,
              input.priority,
              input.labelId,
              input.hours,
            ],
          );
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          await sql.query("ROLLBACK TO SAVEPOINT sla_policy");
          throw new CloudError(
            409,
            "conflict",
            "An SLA for this priority and label already exists.",
          );
        }
        return { policy: await readPolicy(sql, actor, id) };
      });
    });
  }

  update(
    actor: CloudActor,
    id: string,
    hours: number,
  ): Promise<CloudSlaPolicy> {
    return this.database.transaction(async (sql) => {
      const policy = await readPolicy(sql, actor, id);
      await requireTeam(sql, actor, policy.teamId, "settings.manage");
      await sql.query(
        "UPDATE cloud_sla_policies SET hours=$3 WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id, hours],
      );
      return { ...policy, hours };
    });
  }

  remove(actor: CloudActor, id: string): Promise<void> {
    return this.database.transaction(async (sql) => {
      const policy = await readPolicy(sql, actor, id);
      await requireTeam(sql, actor, policy.teamId, "settings.manage");
      await sql.query(
        "DELETE FROM cloud_sla_policies WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id],
      );
    });
  }

  sweep(): Promise<number> {
    return this.database.transaction(async (sql) => {
      const breaches = (
        await sql.query<{
          organizationId: string;
          issueId: string;
          teamId: string;
          dueAt: Date;
        }>(
          `SELECT i.organization_id AS "organizationId",i.id AS "issueId",i.team_id AS "teamId",d.due AS "dueAt"
          FROM cloud_issues i CROSS JOIN LATERAL (SELECT cloud_issue_sla_due(i.organization_id,i.id) AS due) d
          WHERE NOT i.archived AND i.state NOT IN ('complete','canceled')
          AND EXISTS (SELECT 1 FROM cloud_sla_policies p WHERE p.organization_id=i.organization_id AND p.team_id=i.team_id)
          AND d.due<=clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM cloud_issue_sla_breaches b WHERE b.organization_id=i.organization_id AND b.issue_id=i.id AND b.due_at=d.due)
          ORDER BY d.due LIMIT $1 FOR UPDATE OF i SKIP LOCKED`,
          [slaSweepBatchSize],
        )
      ).rows;
      for (const breach of breaches) {
        await sql.query(
          "INSERT INTO cloud_issue_sla_breaches (organization_id,issue_id,due_at) VALUES ($1,$2,$3)",
          [breach.organizationId, breach.issueId, breach.dueAt],
        );
        await notifySlaBreach(sql, breach);
      }
      return breaches.length;
    });
  }
}
