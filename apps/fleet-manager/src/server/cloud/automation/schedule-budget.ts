import type { CloudSql } from "../database";

export async function refreshScheduleUsage(
  sql: CloudSql,
  organizationId: string,
  ids: string[],
): Promise<Map<string, { usedTokens: number; reservedTokens: number }>> {
  const result = await sql.query<{
    id: string;
    usedTokens: number;
    reservedTokens: number;
  }>(
    `WITH measured AS MATERIALIZED (
      SELECT o.schedule_id,o.revision,o.nominal_at,o.used_tokens AS old_used,o.reserved_tokens AS old_reserved,
        COALESCE(usage.used,0)::bigint AS used,
        CASE WHEN r.state IN ('succeeded','failed','canceled','timed_out') THEN e.occurred_at ELSE NULL END AS completed_at,
        CASE WHEN r.state IN ('succeeded','failed','canceled','timed_out') THEN COALESCE(usage.uncertain,0)
          ELSE GREATEST((r.manifest->'profile'->>'maxTokens')::bigint-COALESCE(usage.used,0),COALESCE(usage.uncertain,0)) END::bigint AS reserved
      FROM cloud_schedule_occurrences o JOIN cloud_runs r ON r.organization_id=o.organization_id AND r.id=o.run_id
      LEFT JOIN cloud_run_events e ON e.organization_id=r.organization_id AND e.run_id=r.id AND e.revision=r.revision
      LEFT JOIN LATERAL (SELECT sum(actual_tokens) AS used,sum(reserved_tokens) FILTER(WHERE actual_tokens IS NULL AND request_started_at IS NOT NULL) AS uncertain
        FROM cloud_inference_calls i WHERE i.organization_id=o.organization_id AND i.run_id=o.run_id) usage ON true
      WHERE o.organization_id=$1 AND o.schedule_id=ANY($2::uuid[]) AND o.budget_dirty
    ), changed AS (
      UPDATE cloud_schedule_occurrences o SET used_tokens=m.used,reserved_tokens=m.reserved,budget_dirty=false,completed_at=COALESCE(o.completed_at,m.completed_at)
      FROM measured m WHERE o.organization_id=$1 AND o.schedule_id=m.schedule_id AND o.revision=m.revision AND o.nominal_at=m.nominal_at
      RETURNING m.schedule_id,m.used-m.old_used AS used_delta,m.reserved-m.old_reserved AS reserved_delta
    ), totals AS (SELECT schedule_id,sum(used_delta) AS used_delta,sum(reserved_delta) AS reserved_delta FROM changed GROUP BY schedule_id)
    UPDATE cloud_schedules s SET used_tokens=s.used_tokens+t.used_delta,reserved_tokens=s.reserved_tokens+t.reserved_delta
    FROM totals t WHERE s.organization_id=$1 AND s.id=t.schedule_id
    RETURNING s.id,s.used_tokens::float8 AS "usedTokens",s.reserved_tokens::float8 AS "reservedTokens"`,
    [organizationId, ids],
  );
  return new Map(
    result.rows.map((row) => [
      row.id,
      { usedTokens: row.usedTokens, reservedTokens: row.reservedTokens },
    ]),
  );
}
