import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  GitStatusRuleInput,
  GitTeamStatusRules,
} from "../../../lib/cloud-git-contract";
import {
  automationStatus,
  automationStatusCategories,
  gitStatusEvents,
  type AutomationStatus,
  type GitStatusEvent,
} from "../../../lib/git-automation";
import { CloudError, recordEvent, requireMembership } from "../access";
import type { CloudDatabase, CloudSql } from "../database";

type TeamStatus = AutomationStatus & { team_id: string; name: string };

export async function readStatusRules(
  sql: CloudSql,
  organizationId: string,
): Promise<GitTeamStatusRules[]> {
  const teams = (
    await sql.query<{ id: string; key: string; name: string }>(
      "SELECT id,key,name FROM cloud_teams WHERE organization_id=$1 ORDER BY name,id",
      [organizationId],
    )
  ).rows;
  const statuses = (
    await sql.query<TeamStatus & Record<string, unknown>>(
      "SELECT id,team_id,name,category,position,archived FROM cloud_workflow_statuses WHERE organization_id=$1 ORDER BY position",
      [organizationId],
    )
  ).rows;
  const rules = (
    await sql.query<{
      team_id: string;
      event: GitStatusEvent;
      status_id: string | null;
    }>(
      "SELECT team_id,event,status_id FROM cloud_git_status_rules WHERE organization_id=$1",
      [organizationId],
    )
  ).rows;
  return teams.map((team) => {
    const own = statuses.filter((status) => status.team_id === team.id);
    return {
      team,
      statuses: own
        .filter(
          (status) =>
            !status.archived &&
            (automationStatusCategories as readonly string[]).includes(
              status.category,
            ),
        )
        .map(({ id, name, category }) => ({ id, name, category })),
      rules: Object.fromEntries(
        gitStatusEvents.map((event) => {
          const rule = rules.find(
            (entry) => entry.team_id === team.id && entry.event === event,
          );
          return [
            event,
            automationStatus(event, rule ? rule.status_id : undefined, own)
              ?.id ?? null,
          ];
        }),
      ) as GitTeamStatusRules["rules"],
    };
  });
}

export class CloudGitStatusRules {
  constructor(private readonly database: CloudDatabase) {}

  set(actor: CloudActor, input: GitStatusRuleInput): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.manage");
      const connected = await sql.query(
        "SELECT 1 FROM cloud_git_connections WHERE organization_id=$1 LIMIT 1",
        [actor.organizationId],
      );
      if (!connected.rows.length)
        throw new CloudError(
          409,
          "git_unconfigured",
          "Connect GitHub or GitLab first.",
        );
      const team = await sql.query(
        "SELECT 1 FROM cloud_teams WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, input.teamId],
      );
      if (!team.rows.length)
        throw new CloudError(404, "not_found", "Team is unavailable.");
      if (input.statusId) {
        const status = await sql.query(
          `SELECT 1 FROM cloud_workflow_statuses WHERE organization_id=$1 AND team_id=$2 AND id=$3
          AND NOT archived AND category=ANY($4::text[])`,
          [
            actor.organizationId,
            input.teamId,
            input.statusId,
            automationStatusCategories,
          ],
        );
        if (!status.rows.length)
          throw new CloudError(
            422,
            "status_unavailable",
            "Choose an active status of this team.",
          );
      }
      await sql.query(
        `INSERT INTO cloud_git_status_rules (organization_id,team_id,event,status_id) VALUES ($1,$2,$3,$4)
        ON CONFLICT (organization_id,team_id,event) DO UPDATE SET status_id=$4`,
        [actor.organizationId, input.teamId, input.event, input.statusId],
      );
      await recordEvent(
        sql,
        actor,
        "git.status_rule_changed",
        input.teamId,
        1,
        { event: input.event, statusId: input.statusId },
      );
    });
  }
}
