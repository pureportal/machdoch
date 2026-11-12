import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  AiActivityEntry,
  AiActivityFeed,
  AiActivityQuery,
} from "../../../lib/cloud-activity-contract";
import { requireMembership, teamVisibility } from "../access";
import type { CloudDatabase } from "../database";

const pageSize = 50;
const filterKinds = {
  all: null,
  agent: ["agent"],
  tasks: ["task", "step"],
  model: ["model"],
  clients: ["client"],
} as const;

type ActivityRow = Omit<AiActivityEntry, "run" | "issue" | "client"> & {
  instanceId: string | null;
  instanceName: string | null;
  runTitle: string | null;
  runId: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
};

export class CloudAiActivity {
  constructor(private readonly database: CloudDatabase) {}

  list(actor: CloudActor, query: AiActivityQuery): Promise<AiActivityFeed> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      const kinds = filterKinds[query.filter];
      const rows = (
        await sql.query<ActivityRow & Record<string, unknown>>(
          `SELECT a.id,a.sequence::double precision AS sequence,a.kind,a.status,a.title,a.detail,
          to_char(a.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt",
          COALESCE(u.name,a.instance_name,'Unknown member') AS "actorName",a.model,a.provider,a.tokens,a.duration_ms AS "durationMs",
          r.id AS "runId",r.title AS "runTitle",i.id AS "issueId",i.identifier AS "issueIdentifier",
          CASE WHEN a.actor_id=$2 THEN a.chat_id END AS "chatId",a.instance_id AS "instanceId",a.instance_name AS "instanceName"
          FROM cloud_ai_activity a
          JOIN cloud_memberships m ON m.organization_id=a.organization_id AND m.user_id=$2
          LEFT JOIN cloud_users u ON u.id=a.actor_id
          LEFT JOIN cloud_runs r ON r.organization_id=a.organization_id AND r.id=a.run_id
          LEFT JOIN cloud_teams t ON t.organization_id=r.organization_id AND t.id=r.team_id
          LEFT JOIN cloud_issues i ON i.organization_id=r.organization_id AND i.id=r.issue_id
          WHERE a.organization_id=$1
          AND (m.role IN ('owner','admin') OR a.actor_id=$2 OR (r.id IS NOT NULL AND ${teamVisibility}))
          AND ($3::text[] IS NULL OR a.kind=ANY($3::text[]))
          AND (NOT $4::boolean OR a.status IN ('failed','warning'))
          AND ($5::uuid IS NULL OR a.run_id=$5)
          AND ($6::bigint IS NULL OR a.sequence<$6)
          AND ($7::text IS NULL OR a.instance_id=$7)
          ORDER BY a.sequence DESC LIMIT ${pageSize + 1}`,
          [
            actor.organizationId,
            actor.userId,
            kinds,
            query.problems === "true",
            query.runId ?? null,
            query.before ?? null,
            query.clientId ?? null,
          ],
        )
      ).rows;
      const page = rows.slice(0, pageSize);
      const delivery = (
        await sql.query<{
          url: string;
          enabled: boolean;
          deliveredAt: string | null;
          pending: number;
          failing: boolean;
        }>(
          `SELECT c.url,c.enabled,to_char(c.delivered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "deliveredAt",
          c.failures>0 AS failing,
          (SELECT count(*)::integer FROM cloud_ai_activity a WHERE a.organization_id=c.organization_id AND a.exported_at IS NULL AND a.occurred_at>=c.connected_at) AS pending
          FROM cloud_mimorii_connections c WHERE c.organization_id=$1`,
          [actor.organizationId],
        )
      ).rows[0];
      return {
        entries: page.map(
          ({
            runId,
            runTitle,
            issueId,
            issueIdentifier,
            instanceId,
            instanceName,
            ...entry
          }) => ({
            ...entry,
            client:
              instanceId && instanceName
                ? { id: instanceId, name: instanceName }
                : null,
            run: runId && runTitle ? { id: runId, title: runTitle } : null,
            issue:
              issueId && issueIdentifier
                ? { id: issueId, identifier: issueIdentifier }
                : null,
          }),
        ),
        before: rows.length > pageSize ? (page.at(-1)?.sequence ?? null) : null,
        mimorii: delivery ?? null,
      };
    });
  }
}
