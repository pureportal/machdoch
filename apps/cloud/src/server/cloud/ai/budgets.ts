import type { CloudAiProvider } from "@machdoch/fleet-protocol/cloud-providers";
import type { ProviderBudget } from "../../../lib/cloud-chat-contract";
import { CloudError } from "../access";
import type { CloudSql } from "../database";
import { providerColumns } from "./providers";

export async function readInferenceProvider(
  sql: CloudSql,
  organizationId: string,
  id: string,
  allowDisabled = false,
): Promise<CloudAiProvider> {
  const provider = (
    await sql.query<CloudAiProvider & Record<string, unknown>>(
      `SELECT ${providerColumns} FROM cloud_ai_providers WHERE organization_id=$1 AND id=$2 AND (enabled OR $3) FOR SHARE`,
      [organizationId, id, allowDisabled],
    )
  ).rows[0];
  if (!provider)
    throw new CloudError(404, "not_found", "AI provider is unavailable.");
  return provider;
}

export async function readProviderBudget(
  sql: CloudSql,
  organizationId: string,
  provider: CloudAiProvider,
  excludingId: string | null = null,
): Promise<ProviderBudget> {
  const usage = (
    await sql.query<{
      budgetDay: string;
      usedTokens: number;
      reservedTokens: number;
      activeRequests: number;
    }>(
      `WITH budget_window AS MATERIALIZED (SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date AS day)
    SELECT to_char((SELECT day FROM budget_window),'YYYY-MM-DD') AS "budgetDay",
    COALESCE(sum(actual_tokens) FILTER (WHERE budget_day=(SELECT day FROM budget_window)),0)::double precision AS "usedTokens",
    COALESCE(sum(reserved_tokens) FILTER (WHERE actual_tokens IS NULL AND budget_day=(SELECT day FROM budget_window)),0)::double precision AS "reservedTokens",
    count(*) FILTER (WHERE state IN ('queued','running','cancel_requested') OR (state<>'complete' AND actual_tokens IS NULL AND request_started_at IS NOT NULL AND deadline_at>clock_timestamp()))::integer AS "activeRequests"
    FROM cloud_inference_calls WHERE organization_id=$1 AND provider_id=$2 AND ($3::uuid IS NULL OR id<>$3)`,
      [organizationId, provider.id, excludingId],
    )
  ).rows[0]!;
  return {
    providerId: provider.id,
    ...usage,
    dailyTokenBudget: provider.dailyTokenBudget,
    maxConcurrentRequests: provider.maxConcurrentRequests,
  };
}

export function requireInferenceCapacity(
  budget: ProviderBudget,
  reservation: number,
): void {
  if (
    budget.usedTokens + budget.reservedTokens + reservation >
    budget.dailyTokenBudget
  )
    throw new CloudError(
      409,
      "budget_exceeded",
      "The provider's daily token budget is exhausted. Ask an administrator to adjust it or try after the next UTC day begins.",
    );
  if (budget.activeRequests >= budget.maxConcurrentRequests)
    throw new CloudError(
      409,
      "provider_busy",
      "This provider has no request slots available. Wait for an existing request to finish or expire.",
    );
}
