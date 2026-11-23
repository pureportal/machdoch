import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  LoopSettings,
  LoopSettingsInput,
} from "../../../lib/cloud-loop-contract";
import { checkRevision, requireMembership } from "../access";
import type { CloudSql } from "../database";
import { requireRepositories } from "../automation/automation-validation";

export async function readLoopSettings(
  sql: CloudSql,
  organizationId: string,
): Promise<LoopSettings> {
  return (
    await sql.query<LoopSettings & Record<string, unknown>>(
      `SELECT COALESCE(s.enabled,true) AS enabled,COALESCE(s.code_access,'all') AS "codeAccess",
        ARRAY(SELECT cr.repository_id::text FROM cloud_loop_code_repositories cr WHERE cr.organization_id=o.id ORDER BY cr.repository_id) AS "repositoryIds",
        COALESCE(s.default_placement,'automatic') AS "defaultPlacement",s.default_target_id AS "defaultTargetId",
        s.run_budget_cap_cents AS "runBudgetCapCents",s.month_budget_cap_cents AS "monthBudgetCapCents",
        COALESCE(s.retention_days,90) AS "retentionDays",COALESCE(s.cents_per_thousand_tokens,1)::float AS "centsPerThousandTokens",
        COALESCE(s.revision,1) AS revision,
        (SELECT jsonb_build_object('runs',count(*) FILTER (WHERE r.state<>'skipped'),'tokens',COALESCE(sum(r.tokens),0),'costCents',COALESCE(sum(r.cost_cents),0))
          FROM cloud_automation_runs r WHERE r.organization_id=o.id AND NOT r.dry_run AND r.created_at>=date_trunc('month',clock_timestamp())) AS usage
      FROM cloud_organizations o LEFT JOIN cloud_loop_settings s ON s.organization_id=o.id WHERE o.id=$1`,
      [organizationId],
    )
  ).rows[0]!;
}

export async function writeLoopSettings(
  sql: CloudSql,
  actor: CloudActor,
  revision: number,
  settings: LoopSettingsInput,
): Promise<void> {
  await requireMembership(sql, actor, "ai.manage");
  await sql.query(
    "INSERT INTO cloud_loop_settings (organization_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [actor.organizationId],
  );
  const current = (
    await sql.query<{ revision: number }>(
      "SELECT revision FROM cloud_loop_settings WHERE organization_id=$1 FOR UPDATE",
      [actor.organizationId],
    )
  ).rows[0]!;
  checkRevision(current.revision, revision);
  const repositoryIds = [...new Set(settings.repositoryIds)];
  await requireRepositories(sql, actor, repositoryIds);
  await sql.query(
    "DELETE FROM cloud_loop_code_repositories WHERE organization_id=$1",
    [actor.organizationId],
  );
  await sql.query(
    `INSERT INTO cloud_loop_code_repositories (organization_id,repository_id)
    SELECT $1,repository_id FROM unnest($2::uuid[]) AS repository_id`,
    [actor.organizationId, repositoryIds],
  );
  await sql.query(
    `UPDATE cloud_loop_settings SET enabled=$2,code_access=$3,default_placement=$4,default_target_id=$5,run_budget_cap_cents=$6,
      month_budget_cap_cents=$7,retention_days=$8,revision=revision+1 WHERE organization_id=$1`,
    [
      actor.organizationId,
      settings.enabled,
      settings.codeAccess,
      settings.defaultPlacement,
      settings.defaultTargetId,
      settings.runBudgetCapCents,
      settings.monthBudgetCapCents,
      settings.retentionDays,
    ],
  );
}
