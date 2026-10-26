import type { CloudActor } from "../../lib/cloud-contract";
import type {
  CloudTeamWorkflow,
  WorkflowDefinition,
  WorkflowImpact,
  WorkflowUpdate,
} from "../../lib/cloud-workflow-contract";
import {
  CloudError,
  command,
  recordEvent,
  requireMembership,
  requireTeam,
} from "./access";
import type { CloudDatabase } from "./database";
import { lockExecution } from "./execution/records";
import { issueColumns } from "./planning-queries";
import { readTeamWorkflows } from "./workflow-records";
import { workflowImpact } from "./workflow-impact";
import { recordSchedule } from "./automation/schedule-records";

export class CloudWorkflows {
  constructor(private readonly database: CloudDatabase) {}

  get(actor: CloudActor, teamId: string): Promise<CloudTeamWorkflow> {
    return this.database.transaction(async (sql) => {
      const team = await requireTeam(sql, actor, teamId);
      return (
        await readTeamWorkflows(sql, actor.organizationId, [team.id])
      )[0]!;
    });
  }

  preview(
    actor: CloudActor,
    teamId: string,
    definition: WorkflowDefinition,
  ): Promise<WorkflowImpact> {
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      await requireMembership(sql, actor, "admin");
      const team = await requireTeam(sql, actor, teamId);
      const current = (
        await readTeamWorkflows(sql, actor.organizationId, [team.id])
      )[0]!;
      const { scheduleIds: _, ...impact } = await workflowImpact(
        sql,
        actor,
        current,
        definition,
      );
      return impact;
    });
  }

  update(
    actor: CloudActor,
    key: string,
    teamId: string,
    input: WorkflowUpdate,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      await requireMembership(sql, actor, "admin");
      const team = await requireTeam(sql, actor, teamId, true);
      const current = (
        await readTeamWorkflows(sql, actor.organizationId, [team.id])
      )[0]!;
      return command(
        sql,
        actor,
        key,
        { kind: "workflow.update", teamId, input },
        async () => {
          const impact = await workflowImpact(
            sql,
            actor,
            current,
            input.definition,
          );
          if (impact.digest !== input.impactDigest)
            throw new CloudError(
              409,
              "workflow_impact_changed",
              "The affected planning changed. Review the impact again before saving.",
            );
          const { statuses, defaultStatusId } = input.definition;
          if (
            current.defaultStatusId === defaultStatusId &&
            current.statuses.length === statuses.length &&
            current.statuses.every((status, position) => {
              const next = statuses[position]!;
              return (
                status.id === next.id &&
                status.name === next.name &&
                status.category === next.category &&
                status.archived === next.archived
              );
            })
          )
            return { id: team.id };
          for (const [position, status] of statuses.entries()) {
            await sql.query(
              `INSERT INTO cloud_workflow_statuses(organization_id,team_id,id,name,category,archived,position) VALUES($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (organization_id,id) DO UPDATE SET name=excluded.name,category=excluded.category,archived=excluded.archived,position=excluded.position,
              revision=cloud_workflow_statuses.revision+CASE WHEN cloud_workflow_statuses.category<>excluded.category OR cloud_workflow_statuses.archived<>excluded.archived THEN 1 ELSE 0 END`,
              [
                actor.organizationId,
                team.id,
                status.id,
                status.name,
                status.category,
                status.archived,
                position,
              ],
            );
          }
          await sql.query(
            `WITH changed AS (
            UPDATE cloud_issues i SET state=s.category,revision=i.revision+1,updated_at=clock_timestamp()
            FROM cloud_workflow_statuses s WHERE i.organization_id=$1 AND i.team_id=$2 AND s.organization_id=i.organization_id AND s.id=i.status_id AND i.state<>s.category RETURNING i.*
          ), snapshots AS (SELECT ${issueColumns} FROM changed i), history AS (
            INSERT INTO cloud_issue_history(organization_id,issue_id,revision,actor_id,snapshot,status_name) SELECT $1,s.id,s.revision,$3,to_jsonb(s),s."statusName" FROM snapshots s
          ) INSERT INTO cloud_outbox(id,organization_id,actor_id,kind,subject_id,revision,payload)
            SELECT gen_random_uuid(),$1,$3,'issue.changed',id,revision,jsonb_build_object('state',state,'cycleId',cycle_id) FROM changed`,
            [actor.organizationId, team.id, actor.userId],
          );
          for (const id of impact.scheduleIds) {
            await sql.query(
              "UPDATE cloud_schedules SET enabled=false,next_at=NULL,error='The workflow changed. Review the scheduled status or task subject before enabling it.',revision=revision+1 WHERE organization_id=$1 AND id=$2",
              [actor.organizationId, id],
            );
            await recordSchedule(sql, actor, id);
          }
          await sql.query(
            "UPDATE cloud_team_workflows SET default_status_id=$3,revision=revision+1 WHERE organization_id=$1 AND team_id=$2",
            [actor.organizationId, team.id, defaultStatusId],
          );
          const updated = (
            await readTeamWorkflows(sql, actor.organizationId, [team.id])
          )[0]!;
          await sql.query(
            "INSERT INTO cloud_workflow_revisions(organization_id,team_id,revision,actor_id,snapshot) VALUES($1,$2,$3,$4,$5)",
            [
              actor.organizationId,
              team.id,
              updated.revision,
              actor.userId,
              JSON.stringify(updated),
            ],
          );
          await recordEvent(
            sql,
            actor,
            "workflow.changed",
            team.id,
            updated.revision,
            {},
          );
          return { id: team.id };
        },
      );
    });
  }
}
