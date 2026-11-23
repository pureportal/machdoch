import type {
  CodeAccessMode,
  LoopCapability,
  LoopOverlapPolicy,
  LoopPlacement,
} from "../../../lib/cloud-loop-contract";
import { checkLoopCapabilities } from "../../../lib/loop-capabilities";
import { admitLoopRun, type LoopAdmission } from "../../../lib/loop-guardrails";
import type { CloudSql } from "../database";

export interface LoopRunOrigin {
  originRunId?: string | null;
  dryRun?: boolean;
}

interface AdmissionRow extends Record<string, unknown> {
  loopsEnabled: boolean;
  killed: boolean;
  overlap: LoopOverlapPolicy;
  runBudgetCents: number | null;
  monthBudgetCents: number | null;
  runBudgetCapCents: number | null;
  monthBudgetCapCents: number | null;
  maxDurationMinutes: number;
  dailyUsed: number;
  activeRuns: number;
  loopMonthCents: number;
  workspaceMonthCents: number;
  chainAutomationIds: string[];
  placement: LoopPlacement;
  capabilities: LoopCapability[];
  codeAccess: CodeAccessMode;
  allowedRepositoryIds: string[];
  repositoryIds: string[];
}

const committed = "COALESCE(sum(r.cost_cents+r.reserved_cents),0)::integer";

export async function admitAutomationRun(
  sql: CloudSql,
  organizationId: string,
  automation: { id: string; dailyLimit: number },
  origin: LoopRunOrigin,
): Promise<LoopAdmission & { maxDurationMinutes: number }> {
  const row = (
    await sql.query<AdmissionRow>(
      `WITH RECURSIVE chain(id,automation_id,origin_run_id) AS (
        SELECT id,automation_id,origin_run_id FROM cloud_automation_runs WHERE organization_id=$1 AND id=$3
        UNION SELECT r.id,r.automation_id,r.origin_run_id FROM cloud_automation_runs r JOIN chain c ON r.organization_id=$1 AND r.id=c.origin_run_id)
      SELECT COALESCE(s.enabled,true) AS "loopsEnabled",l.killed_at IS NOT NULL AS killed,l.overlap,
        l.run_budget_cents AS "runBudgetCents",l.month_budget_cents AS "monthBudgetCents",
        s.run_budget_cap_cents AS "runBudgetCapCents",s.month_budget_cap_cents AS "monthBudgetCapCents",l.max_duration_minutes AS "maxDurationMinutes",
        (SELECT count(*)::integer FROM cloud_automation_runs r WHERE r.organization_id=$1 AND r.automation_id=$2 AND r.state<>'skipped' AND NOT r.dry_run
          AND r.created_at>clock_timestamp()-interval '1 day') AS "dailyUsed",
        (SELECT count(*)::integer FROM cloud_automation_runs r WHERE r.organization_id=$1 AND r.automation_id=$2 AND NOT r.dry_run
          AND r.state IN ('queued','running','waiting')) AS "activeRuns",
        (SELECT ${committed} FROM cloud_automation_runs r WHERE r.organization_id=$1 AND r.automation_id=$2
          AND r.created_at>=date_trunc('month',clock_timestamp())) AS "loopMonthCents",
        (SELECT ${committed} FROM cloud_automation_runs r WHERE r.organization_id=$1
          AND r.created_at>=date_trunc('month',clock_timestamp())) AS "workspaceMonthCents",
        ARRAY(SELECT DISTINCT automation_id::text FROM chain) AS "chainAutomationIds",l.placement,
        ARRAY(SELECT c.capability FROM cloud_loop_capabilities c WHERE c.organization_id=l.organization_id AND c.loop_id=l.id) AS capabilities,
        COALESCE(s.code_access,'all') AS "codeAccess",
        ARRAY(SELECT cr.repository_id::text FROM cloud_loop_code_repositories cr WHERE cr.organization_id=l.organization_id) AS "allowedRepositoryIds",
        ARRAY(SELECT cs.repository_id::text FROM cloud_loop_context_sources cs WHERE cs.organization_id=l.organization_id AND cs.loop_id=l.id AND cs.repository_id IS NOT NULL
          UNION SELECT jsonb_array_elements_text(a.trigger->'repositoryIds') FROM cloud_automations a WHERE a.organization_id=l.organization_id AND a.id=l.automation_id
            AND jsonb_typeof(a.trigger->'repositoryIds')='array') AS "repositoryIds"
      FROM cloud_loops l LEFT JOIN cloud_loop_settings s ON s.organization_id=l.organization_id
      WHERE l.organization_id=$1 AND l.automation_id=$2`,
      [organizationId, automation.id, origin.originRunId ?? null],
    )
  ).rows[0];
  if (!row)
    return {
      admitted: false,
      code: "unavailable",
      reason: "The loop is unavailable.",
      maxDurationMinutes: 60,
    };
  const capability = checkLoopCapabilities({
    placement: row.placement,
    required: row.capabilities,
    repositoryIds: row.repositoryIds,
    codeAccess: { mode: row.codeAccess, repositoryIds: row.allowedRepositoryIds },
  });
  if (!capability.available && row.loopsEnabled && !row.killed)
    return {
      admitted: false,
      code: "capability",
      reason: capability.reason,
      maxDurationMinutes: row.maxDurationMinutes,
    };
  return {
    ...admitLoopRun({
      ...row,
      automationId: automation.id,
      dryRun: origin.dryRun ?? false,
      dailyLimit: automation.dailyLimit,
    }),
    maxDurationMinutes: row.maxDurationMinutes,
  };
}

export async function cancelActiveRuns(
  sql: CloudSql,
  organizationId: string,
  automationId: string,
): Promise<void> {
  await sql.query(
    `UPDATE cloud_automation_runs SET state='skipped',error='A newer run replaced this run.',turn_id=NULL,reserved_cents=0,
    updated_at=clock_timestamp(),finished_at=clock_timestamp()
    WHERE organization_id=$1 AND automation_id=$2 AND NOT dry_run AND state IN ('queued','running','waiting')`,
    [organizationId, automationId],
  );
}
