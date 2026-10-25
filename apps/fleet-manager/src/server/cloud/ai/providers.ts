import { randomUUID } from "node:crypto";
import { fenceRun, lockExecution, readRun } from "../execution/records";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  CloudAiProvider,
  CloudProviderSettings,
  ProviderInput,
  ProviderUpdate,
} from "@machdoch/fleet-protocol/cloud-providers";
import type { ModelConnection } from "@machdoch/model-runtime/connections";
import type { SettingsCipher } from "../../settings-crypto";
import {
  checkRevision,
  CloudError,
  command,
  recordEvent,
  requireMembership,
} from "../access";
import type { CloudDatabase } from "../database";
import { providerSecretContext } from "./credential-storage";
import { requireCredentialStorage } from "../credential-storage";

export const providerColumns = `id,name,provider,region,models,max_output_tokens AS "maxOutputTokens",daily_token_budget AS "dailyTokenBudget",max_concurrent_requests AS "maxConcurrentRequests",revision,inference_revision AS "inferenceRevision",enabled`;

export class CloudAiProviders {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
  ) {}

  list(
    actor: CloudActor,
    administration = false,
  ): Promise<CloudProviderSettings> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, administration ? "admin" : "read");
      const providers = (
        await sql.query<CloudAiProvider & Record<string, unknown>>(
          `SELECT ${providerColumns} FROM cloud_ai_providers WHERE organization_id=$1 AND ($2 OR enabled) ORDER BY name,id`,
          [actor.organizationId, administration],
        )
      ).rows;
      return { providers, credentialStorageAvailable: this.cipher !== null };
    });
  }

  create(
    actor: CloudActor,
    key: string,
    input: ProviderInput,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      const cipher = await requireCredentialStorage(sql, this.cipher);
      return command(
        sql,
        actor,
        key,
        {
          kind: "ai_provider.create",
          input: {
            ...input,
            apiKey: cipher.fingerprint(
              Buffer.from(input.apiKey),
              Buffer.from(`cloud.provider.command/${actor.organizationId}`),
            ),
          },
        },
        async () => {
          const id = randomUUID();
          const secret = cipher.encrypt(
            Buffer.from(input.apiKey),
            providerSecretContext(actor.organizationId, id, input.provider),
          );
          await sql.query(
            "INSERT INTO cloud_ai_providers (organization_id,id,name,provider,region,models,max_output_tokens,daily_token_budget,max_concurrent_requests,secret) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
            [
              actor.organizationId,
              id,
              input.name,
              input.provider,
              input.region,
              JSON.stringify(input.models),
              input.maxOutputTokens,
              input.dailyTokenBudget,
              input.maxConcurrentRequests,
              secret,
            ],
          );
          await recordEvent(sql, actor, "ai_provider.created", id, 1, {
            provider: input.provider,
          });
          return { id };
        },
      );
    });
  }

  update(
    actor: CloudActor,
    key: string,
    id: string,
    input: ProviderUpdate,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      await requireMembership(sql, actor, "admin");
      const cipher = await requireCredentialStorage(sql, this.cipher);
      const current = (
        await sql.query<CloudAiProvider & Record<string, unknown>>(
          `SELECT ${providerColumns} FROM cloud_ai_providers WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
          [actor.organizationId, id],
        )
      ).rows[0];
      if (!current)
        throw new CloudError(404, "not_found", "AI provider is unavailable.");
      return command(
        sql,
        actor,
        key,
        {
          kind: "ai_provider.update",
          id,
          input: {
            ...input,
            apiKey:
              input.apiKey === undefined
                ? undefined
                : cipher.fingerprint(
                    Buffer.from(input.apiKey),
                    Buffer.from(
                      `cloud.provider.command/${actor.organizationId}`,
                    ),
                  ),
          },
        },
        async () => {
          checkRevision(current.revision, input.revision);
          if ((current.provider === "langdock") !== (input.region !== null))
            throw new CloudError(
              422,
              "provider_region",
              "Select a region only for Langdock.",
            );
          const secret =
            input.apiKey === undefined
              ? null
              : cipher.encrypt(
                  Buffer.from(input.apiKey),
                  providerSecretContext(
                    actor.organizationId,
                    id,
                    current.provider,
                  ),
                );
          await sql.query(
            "UPDATE cloud_ai_providers SET name=$3,region=$4,models=$5,max_output_tokens=$6,daily_token_budget=$7,max_concurrent_requests=$8,secret=COALESCE($9,secret),enabled=$10,revision=revision+1,inference_revision=inference_revision+CASE WHEN $9::bytea IS NOT NULL OR region IS DISTINCT FROM $4 OR enabled IS DISTINCT FROM $10 OR NOT (models <@ $5::jsonb) THEN 1 ELSE 0 END WHERE organization_id=$1 AND id=$2",
            [
              actor.organizationId,
              id,
              input.name,
              input.region,
              JSON.stringify(input.models),
              input.maxOutputTokens,
              input.dailyTokenBudget,
              input.maxConcurrentRequests,
              secret,
              input.enabled,
            ],
          );
          await recordEvent(
            sql,
            actor,
            "ai_provider.changed",
            id,
            input.revision + 1,
            { enabled: input.enabled, keyChanged: input.apiKey !== undefined },
          );
          if (
            input.apiKey !== undefined ||
            input.region !== current.region ||
            input.enabled !== current.enabled ||
            current.models.some((model) => !input.models.includes(model))
          ) {
            const runs = await sql.query<{ id: string }>(
              `SELECT r.id FROM cloud_runs r JOIN cloud_execution_profiles p ON p.organization_id=r.organization_id AND p.id=r.profile_id
              WHERE r.organization_id=$1 AND p.provider_id=$2 AND r.state NOT IN ('succeeded','failed','canceled','timed_out') ORDER BY r.id`,
              [actor.organizationId, id],
            );
            for (const run of runs.rows)
              await fenceRun(
                sql,
                actor.organizationId,
                await readRun(sql, actor.organizationId, run.id),
                "failed",
                "AI provider access changed",
              );
          }
          return { id };
        },
      );
    });
  }

  resolve(
    actor: CloudActor,
    id: string,
    model: string,
  ): Promise<{ configuration: CloudAiProvider; connection: ModelConnection }> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "write");
      const cipher = await requireCredentialStorage(sql, this.cipher);
      const row = (
        await sql.query<
          CloudAiProvider & { secret: Uint8Array } & Record<string, unknown>
        >(
          `SELECT ${providerColumns},secret FROM cloud_ai_providers WHERE organization_id=$1 AND id=$2 AND enabled FOR SHARE`,
          [actor.organizationId, id],
        )
      ).rows[0];
      if (!row)
        throw new CloudError(404, "not_found", "AI provider is unavailable.");
      if (!row.models.includes(model))
        throw new CloudError(
          422,
          "model_unavailable",
          "Choose a configured model for this provider.",
        );
      let apiKey: string;
      try {
        apiKey = cipher
          .decrypt(
            Buffer.from(row.secret),
            providerSecretContext(actor.organizationId, id, row.provider),
          )
          .toString("utf8");
      } catch {
        throw new CloudError(
          503,
          "credential_storage",
          "Provider credentials cannot be unlocked. Contact your administrator.",
        );
      }
      const { secret: _, ...configuration } = row;
      return {
        configuration,
        connection: {
          provider: row.provider,
          apiKey,
          model,
          ...(row.region ? { region: row.region } : {}),
        },
      };
    });
  }
}
