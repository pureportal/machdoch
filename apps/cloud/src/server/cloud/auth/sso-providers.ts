import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  OidcConfiguration,
  OidcProvider,
  OidcSave,
  SsoAdministration,
  SsoMember,
} from "../../../lib/cloud-sso-contract";
import type { SettingsCipher } from "../../settings-crypto";
import {
  CloudError,
  checkRevision,
  command,
  recordEvent,
  requireMembership,
} from "../access";
import { lockAdministration } from "../administration";
import { requireCredentialStorage } from "../credential-storage";
import type { CloudDatabase, CloudSql } from "../database";
import { validateOidcConfiguration } from "./oidc-protocol";
import { runOidcJob } from "./oidc";

export interface SsoProviderRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  configuration: OidcConfiguration;
  secret: Uint8Array;
  enabled: boolean;
  revision: number;
  verified_revision: number | null;
  authentication_epoch: string;
}
export function ssoSecretContext(
  row: Pick<SsoProviderRow, "organization_id" | "id" | "configuration">,
): Buffer {
  const config = row.configuration;
  return Buffer.from(
    JSON.stringify([
      "cloud.oidc",
      row.organization_id.toLowerCase(),
      row.id.toLowerCase(),
      config.metadata.issuer,
      config.clientId,
      config.authentication,
      config.metadata.token_endpoint,
    ]),
  );
}
export function publicSsoProvider(row: SsoProviderRow): OidcProvider {
  return {
    ...row.configuration,
    id: row.id,
    enabled: row.enabled,
    revision: row.revision,
    verified: row.verified_revision === row.revision,
  };
}

export class CloudSsoProviders {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly origin: string,
  ) {}

  account(actor: CloudActor) {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<{
          id: string;
          name: string;
          issuer: string;
          enabled: boolean;
          subject: string | null;
        }>(
          `SELECT p.id,p.configuration->>'name' AS name,p.configuration->'metadata'->>'issuer' AS issuer,p.enabled,i.subject
        FROM cloud_sso_providers p LEFT JOIN cloud_sso_mappings i ON i.provider_id=p.id AND i.organization_id=p.organization_id AND i.user_id=$2
        WHERE p.organization_id=$1 AND (p.enabled OR i.user_id IS NOT NULL) ORDER BY p.configuration->>'name',p.id`,
          [actor.organizationId, actor.userId],
        )
      ).rows;
    });
  }

  async discover(actor: CloudActor, issuer: string, signal?: AbortSignal) {
    await this.database.transaction((sql) =>
      requireMembership(sql, actor, "admin"),
    );
    const metadata = await runOidcJob(
      actor.organizationId,
      { kind: "discover", issuer },
      signal,
    );
    await this.database.transaction((sql) =>
      requireMembership(sql, actor, "admin"),
    );
    return metadata;
  }

  get(actor: CloudActor): Promise<SsoAdministration> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      const rows = await sql.query<SsoProviderRow>(
        "SELECT * FROM cloud_sso_providers WHERE organization_id=$1 ORDER BY configuration->>'name',id",
        [actor.organizationId],
      );
      return {
        providers: rows.rows.map(publicSsoProvider),
        linkedProviderIds: (
          await sql.query<{ provider_id: string }>(
            "SELECT provider_id FROM cloud_sso_mappings WHERE organization_id=$1 AND user_id=$2",
            [actor.organizationId, actor.userId],
          )
        ).rows.map((row) => row.provider_id),
        credentialStorageAvailable: !!this.cipher,
        redirectUri: `${this.origin}/api/v1/auth/sso/callback`,
      };
    });
  }

  save(
    actor: CloudActor,
    key: string,
    id: string,
    input: OidcSave,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      if ((await lockAdministration(sql, actor)) !== "owner")
        throw new CloudError(
          403,
          "owner_required",
          "Only an owner can configure sign-in providers.",
        );
      const storage = await requireCredentialStorage(sql, this.cipher);
      const { secret, revision, enabled, ...configuration } = input;
      try {
        validateOidcConfiguration(configuration);
      } catch {
        throw new CloudError(
          422,
          "sso_configuration",
          "The provider does not support these settings. Check its discovery document.",
        );
      }
      return command(
        sql,
        actor,
        key,
        {
          kind: "sso.provider.save",
          id,
          input: {
            ...input,
            secret: secret
              ? storage.fingerprint(
                  Buffer.from(secret),
                  Buffer.from("cloud.oidc"),
                )
              : null,
          },
        },
        async () => {
          const current = (
            await sql.query<SsoProviderRow>(
              "SELECT * FROM cloud_sso_providers WHERE organization_id=$1 AND id=$2 FOR UPDATE",
              [actor.organizationId, id],
            )
          ).rows[0];
          checkRevision(current?.revision ?? 0, revision);
          if (
            current &&
            (current.configuration.metadata.issuer !==
              configuration.metadata.issuer ||
              current.configuration.clientId !== configuration.clientId)
          )
            throw new CloudError(
              422,
              "sso_identity_immutable",
              "Create a new provider to change the issuer or client ID.",
            );
          if (current) {
            const required = (
              await sql.query(
                "SELECT 1 FROM cloud_signin_policies WHERE organization_id=$1 AND required_sso",
                [actor.organizationId],
              )
            ).rows.length;
            const spare = (
              await sql.query(
                "SELECT id FROM cloud_sso_providers WHERE organization_id=$1 AND id<>$2 AND enabled AND verified_revision=revision LIMIT 1",
                [actor.organizationId, id],
              )
            ).rows.length;
            if (required && current.enabled && !spare)
              throw new CloudError(
                409,
                "sso_last_provider",
                "Test another enabled provider or turn off required SSO before editing this provider.",
              );
          } else if (
            (
              await sql.query(
                "SELECT id FROM cloud_sso_providers WHERE organization_id=$1",
                [actor.organizationId],
              )
            ).rows.length >= 10
          )
            throw new CloudError(
              409,
              "sso_provider_limit",
              "This organization already has 10 sign-in providers.",
            );
          const row = {
            organization_id: actor.organizationId,
            id,
            configuration,
          };
          if (
            !secret &&
            (!current ||
              !ssoSecretContext(current).equals(ssoSecretContext(row)))
          )
            throw new CloudError(
              422,
              "sso_secret_required",
              "Enter the client secret for this token endpoint and authentication method.",
            );
          const encrypted = secret
            ? storage.encrypt(Buffer.from(secret), ssoSecretContext(row))
            : current!.secret;
          await sql.query(
            current
              ? "UPDATE cloud_sso_providers SET configuration=$3,secret=$4,enabled=$5,revision=revision+1,verified_revision=NULL,authentication_epoch=nextval('cloud_authentication_generation') WHERE id=$1 AND organization_id=$2"
              : "INSERT INTO cloud_sso_providers(id,organization_id,configuration,secret,enabled) VALUES($1,$2,$3,$4,$5)",
            [
              id,
              actor.organizationId,
              JSON.stringify(configuration),
              encrypted,
              enabled,
            ],
          );
          await recordEvent(
            sql,
            actor,
            "sso.provider.changed",
            id,
            revision + 1,
            { enabled },
          );
          return { id };
        },
      );
    });
  }

  mappings(actor: CloudActor, providerId: string) {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      return (
        await sql.query<{ userId: string; subject: string; email: string }>(
          'SELECT m.user_id AS "userId",m.subject,u.email FROM cloud_sso_mappings m JOIN cloud_users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.provider_id=$2 ORDER BY u.email',
          [actor.organizationId, providerId],
        )
      ).rows;
    });
  }

  map(
    actor: CloudActor,
    key: string,
    providerId: string,
    userId: string,
    subject: string,
  ) {
    return this.database.transaction(async (sql) => {
      const role = await lockAdministration(sql, actor);
      return command(
        sql,
        actor,
        key,
        { kind: "sso.identity.map", providerId, userId, subject },
        async () => {
          const member = (
            await sql.query<{ role: string }>(
              "SELECT role FROM cloud_memberships WHERE organization_id=$1 AND user_id=$2 AND active FOR UPDATE",
              [actor.organizationId, userId],
            )
          ).rows[0];
          if (
            !member ||
            (role !== "owner" && ["owner", "admin"].includes(member.role))
          )
            throw new CloudError(
              403,
              "sso_mapping_denied",
              "An owner must map this account.",
            );
          const existing = (
            await sql.query<{ subject: string }>(
              "SELECT subject FROM cloud_sso_mappings WHERE organization_id=$1 AND provider_id=$2 AND user_id=$3",
              [actor.organizationId, providerId, userId],
            )
          ).rows[0];
          if (existing)
            throw new CloudError(
              409,
              "sso_mapping_exists",
              "This account already has an identity for this provider. Remove that mapping first.",
            );
          await insertSsoMapping(sql, actor, providerId, userId, subject);
          return { userId };
        },
      );
    });
  }

  addMember(
    actor: CloudActor,
    key: string,
    providerId: string,
    input: SsoMember,
  ) {
    return this.database.transaction(async (sql) => {
      const role = await lockAdministration(sql, actor);
      if (input.role === "admin" && role !== "owner")
        throw new CloudError(
          403,
          "owner_required",
          "Only an owner can add administrators.",
        );
      return command(
        sql,
        actor,
        key,
        { kind: "sso.member.add", providerId, input },
        async () => {
          await sql.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [`user:${input.email}`],
          );
          if (
            (
              await sql.query("SELECT id FROM cloud_users WHERE email=$1", [
                input.email,
              ])
            ).rows.length
          )
            throw new CloudError(
              409,
              "sso_existing_account",
              "This account must join through an authenticated invitation before it can be mapped.",
            );
          if (
            !(
              await sql.query(
                "SELECT id FROM cloud_sso_providers WHERE organization_id=$1 AND id=$2 AND enabled AND verified_revision=revision FOR SHARE",
                [actor.organizationId, providerId],
              )
            ).rows.length
          )
            throw new CloudError(
              409,
              "sso_test_required",
              "Test sign-in through this provider before adding members.",
            );
          const userId = randomUUID();
          await sql.query(
            "INSERT INTO cloud_users(id,email,name,password_hash) VALUES($1,$2,$3,NULL)",
            [userId, input.email, input.name],
          );
          await sql.query(
            "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,$3)",
            [actor.organizationId, userId, input.role],
          );
          await insertSsoMapping(sql, actor, providerId, userId, input.subject);
          await recordEvent(sql, actor, "member.added", userId, 1, {
            role: input.role,
            providerId,
          });
          return { userId };
        },
      );
    });
  }

  unmap(
    actor: CloudActor,
    key: string,
    providerId: string,
    userId: string,
    subject: string,
  ) {
    return this.database.transaction(async (sql) => {
      const role = await lockAdministration(sql, actor);
      return command(
        sql,
        actor,
        key,
        { kind: "sso.identity.remove", providerId, userId, subject },
        async () => {
          const member = (
            await sql.query<{ role: string }>(
              "SELECT role FROM cloud_memberships WHERE organization_id=$1 AND user_id=$2 FOR UPDATE",
              [actor.organizationId, userId],
            )
          ).rows[0];
          if (
            !member ||
            (role !== "owner" && ["owner", "admin"].includes(member.role))
          )
            throw new CloudError(
              403,
              "sso_mapping_denied",
              "An owner must remove this identity mapping.",
            );
          const required = (
            await sql.query(
              "SELECT 1 FROM cloud_signin_policies WHERE organization_id=$1 AND required_sso",
              [actor.organizationId],
            )
          ).rows.length;
          if (required && member.role === "owner") {
            const otherOwner = await sql.query(
              `SELECT 1 FROM cloud_sso_mappings i JOIN cloud_memberships m ON m.organization_id=i.organization_id AND m.user_id=i.user_id JOIN cloud_users u ON u.id=m.user_id JOIN cloud_sso_providers p ON p.id=i.provider_id
            WHERE i.organization_id=$1 AND m.role='owner' AND m.active AND NOT u.disabled AND p.enabled AND p.verified_revision=p.revision AND NOT(i.provider_id=$2 AND i.user_id=$3) LIMIT 1`,
              [actor.organizationId, providerId, userId],
            );
            if (!otherOwner.rows.length)
              throw new CloudError(
                409,
                "sso_last_owner",
                "Link another owner or turn off required SSO before removing this identity.",
              );
          }
          const removed = await sql.query(
            "DELETE FROM cloud_sso_mappings WHERE organization_id=$1 AND provider_id=$2 AND user_id=$3 AND subject=$4 RETURNING user_id",
            [actor.organizationId, providerId, userId, subject],
          );
          if (!removed.rows.length)
            throw new CloudError(
              409,
              "sso_mapping_changed",
              "This mapping changed. Reload the identities before removing it.",
            );
          await sql.query(
            "UPDATE cloud_memberships SET authentication_epoch=nextval('cloud_authentication_generation') WHERE organization_id=$1 AND user_id=$2",
            [actor.organizationId, userId],
          );
          await recordEvent(
            sql,
            actor,
            "sso.identity.removed",
            randomUUID(),
            1,
            { providerId, userId },
          );
          return { userId };
        },
      );
    });
  }
}

export async function insertSsoMapping(
  sql: CloudSql,
  actor: CloudActor,
  providerId: string,
  userId: string,
  subject: string,
) {
  await sql.query(
    "INSERT INTO cloud_sso_mappings(organization_id,provider_id,user_id,subject) VALUES($1,$2,$3,$4)",
    [actor.organizationId, providerId, userId, subject],
  );
  await sql.query(
    "UPDATE cloud_memberships SET authentication_epoch=nextval('cloud_authentication_generation') WHERE organization_id=$1 AND user_id=$2",
    [actor.organizationId, userId],
  );
  await recordEvent(sql, actor, "sso.identity.linked", randomUUID(), 1, {
    providerId,
    userId,
  });
}
