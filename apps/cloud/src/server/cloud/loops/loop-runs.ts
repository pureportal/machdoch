import type { AutomationOutcome } from "../../../lib/cloud-automation-contract";
import { loopCostCents, shouldPauseLoop } from "../../../lib/loop-guardrails";
import type { CloudSql } from "../database";

export async function recordTurnTokens(
  sql: CloudSql,
  organizationId: string,
  runId: string,
  turnId: string,
): Promise<void> {
  await sql.query(
    `UPDATE cloud_automation_runs SET tokens=tokens+COALESCE((SELECT sum(actual_tokens) FROM cloud_inference_calls
      WHERE organization_id=$1 AND turn_id=$3),0) WHERE organization_id=$1 AND id=$2`,
    [organizationId, runId, turnId],
  );
}

export async function settleLoopRun(
  sql: CloudSql,
  run: { organizationId: string; id: string; automationId: string },
  state: AutomationOutcome,
): Promise<{ pause: boolean }> {
  const usage = (
    await sql.query<{ tokens: string; rate: number; dryRun: boolean }>(
      `SELECT r.tokens::text AS tokens,r.dry_run AS "dryRun",COALESCE(s.cents_per_thousand_tokens,1) AS rate
      FROM cloud_automation_runs r LEFT JOIN cloud_loop_settings s ON s.organization_id=r.organization_id
      WHERE r.organization_id=$1 AND r.id=$2`,
      [run.organizationId, run.id],
    )
  ).rows[0];
  if (!usage) return { pause: false };
  await sql.query(
    "UPDATE cloud_automation_runs SET cost_cents=$3,reserved_cents=0 WHERE organization_id=$1 AND id=$2",
    [
      run.organizationId,
      run.id,
      loopCostCents(Number(usage.tokens), usage.rate),
    ],
  );
  if (usage.dryRun || state === "skipped") return { pause: false };
  const loop = (
    await sql.query<{
      consecutiveFailures: number;
      pauseAfterFailures: number | null;
    }>(
      `UPDATE cloud_loops SET consecutive_failures=CASE WHEN $3 THEN consecutive_failures+1 ELSE 0 END
      WHERE organization_id=$1 AND automation_id=$2
      RETURNING consecutive_failures AS "consecutiveFailures",pause_after_failures AS "pauseAfterFailures"`,
      [run.organizationId, run.automationId, state === "failed"],
    )
  ).rows[0];
  return {
    pause:
      !!loop &&
      shouldPauseLoop(loop.consecutiveFailures, loop.pauseAfterFailures),
  };
}
